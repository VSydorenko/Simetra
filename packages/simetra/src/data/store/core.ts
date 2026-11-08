import { FILTER_IN_MAX, READ_LIMIT_MAX, type CatalogIndex } from "simetra/model"
import { fieldInfoOf, filterCollator } from "./filter"
import { keyId } from "./epoch"
import { createObjectStore } from "./object-store"
import { createSectionStore } from "./section-store"
import { createSession, type Scope } from "./session"
import { createRowViews, purgedSnapshot } from "./snapshot"
import { readKeys, type CoreSource } from "./source"
import type { ObjectState } from "./forms"
import type { StoreOps } from "./readers"
import { createRegistry, type SubsetRegistry } from "./subsets"
import {
  DEFAULT_CORE_LIMITS,
  type CloseReason,
  type CoreLimits,
  type CoreLogEntry,
  type GenerationToken,
  type Key,
  type ObjectName,
  type ViewHandle,
  type ViewSnapshot,
  type ViewSpec,
  type Writer,
} from "./types"

/*
 * Ядро даних T4 (спека П4-B §6): сесія, сховища об'єктів, реєстр виглядів і
 * хвостове перечитування над одним `CoreSource`. Запис приймача сигналів
 * (`commit` з `Writer`, `activeViews`, `setVisible`, `revalidate`) додає
 * задача 8 плану П4-B3-2 поверх `CoreInternals`.
 */

/** A view the signal receiver re-reads (Task 8). */
export interface ActiveView {
  readonly spec: ViewSpec
  readonly keys: readonly Key[]
  readonly visible: boolean
}

/** The data core of one user session (P4-B spec §6.1). */
export interface CoreSession {
  readonly subject: string
  /** A memoized handle; throws synchronously on a refused form (`data.unsupported-predicate`, `command.invalid`). */
  view(spec: ViewSpec): ViewHandle
  /**
   * Holds the form until the first subscription or `ttlMs` (default
   * `preloadTtlMs`); resolves after its first load. Throws `data.views-limit`
   * synchronously, before the promise.
   */
  preload(spec: ViewSpec, options?: { ttlMs?: number }): Promise<void>
  /** The session token: invalid after `close`. */
  token(): GenerationToken
  /** The current session epoch: a read started now carries it. */
  readEpoch(): number
  commit(fn: (writer: Writer) => void, token: GenerationToken): boolean
  activeViews(object: ObjectName): readonly ActiveView[]
  setVisible(spec: ViewSpec, visible: boolean): void
  revalidate(
    object: ObjectName,
    options: { visibleOnly: boolean }
  ): Promise<void>
  /**
   * Purges every key in one notification batch, after which every handle —
   * new ones included — returns one stable `purged` snapshot with `reason`;
   * no request goes out and no response is written afterwards.
   */
  close(reason: CloseReason): void
}

/** Defect flags of the model test's self-check (Task 10 adds them). */
export type DefectFlag = never

/** Test-only inspection of a core. */
export interface CoreInspection {
  /** Broken invariants of ownership and service maps; empty when sound. */
  violations(): string[]
  owners(object: ObjectName, key: Key): number
  rowCount(): number
  readonly defects: Set<DefectFlag>
}

const inspections = new WeakMap<CoreSession, CoreInspection>()
const internals = new WeakMap<CoreSession, CoreInternals>()

/** The inspection of a core created by {@link createCore} (tests only). */
export function inspectCore(session: CoreSession): CoreInspection {
  const found = inspections.get(session)
  if (found === undefined) throw new TypeError("not a core session")
  return found
}

const KEYS_PER_REQUEST_MAX = Math.min(READ_LIMIT_MAX, FILTER_IN_MAX)

// Нуль чи дріб у межі тихо вимикає її (горизонт без кошиків пропускає все):
// межі перевіряються до створення сесії.
function limitsOf(overrides: Partial<CoreLimits> | undefined): CoreLimits {
  const limits = { ...DEFAULT_CORE_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`limits.${name} must be a positive integer`)
    }
  }
  if (limits.fullPageSize > READ_LIMIT_MAX)
    throw new TypeError(`limits.fullPageSize must not exceed ${READ_LIMIT_MAX}`)
  if (limits.keysPerRequest > KEYS_PER_REQUEST_MAX)
    throw new TypeError(
      `limits.keysPerRequest must not exceed ${KEYS_PER_REQUEST_MAX}`
    )
  return limits
}

/**
 * Internals of a core shared with the Task 8 writer: the stores, the store
 * operations that keep views in step, the registry and the tail.
 */
export interface CoreInternals {
  readonly objects: ReadonlyMap<ObjectName, ObjectState>
  readonly ops: StoreOps
  readonly registry: SubsetRegistry
  /** Makes tail re-reads of the object in flight unable to write (П12). */
  invalidateTail(object: ObjectName): void
}

export function createCore(options: {
  subject: string
  source: CoreSource
  index: CatalogIndex
  limits?: Partial<CoreLimits>
  strict?: boolean
  log?: (e: CoreLogEntry) => void
}): CoreSession {
  const limits = limitsOf(options.limits)
  const { source, index } = options
  // Збій журналу не змінює результату.
  const log = (entry: CoreLogEntry) => {
    try {
      options.log?.(entry)
    } catch {
      // Журнал недоступний.
    }
  }
  const session = createSession({ subject: options.subject, limits, log })
  const rowViews = createRowViews()
  const dirtySections = new Map<ObjectName, Set<Key>>()
  let closed: ViewSnapshot | undefined

  const objects = new Map<ObjectName, ObjectState>()
  for (const entry of index.byRef.values()) {
    const name = `${entry.kind}.${entry.name}`
    const rows = createObjectStore({ object: name, entry, session, log })
    objects.set(name, {
      name,
      ref: { kind: entry.kind, name: entry.name },
      entry,
      info: fieldInfoOf(entry),
      lazyFields: entry.attributes
        .filter((a) => a.load === "lazy")
        .map((a) => a.name),
      rows,
      sections: createSectionStore({ object: name, session, rows }),
    })
  }
  const objectOf = (name: ObjectName): ObjectState => {
    const o = objects.get(name)
    if (o === undefined) throw new TypeError(`unknown object ${name}`)
    return o
  }

  const touchSection = (o: ObjectState, owner: Key) => {
    const owners = dirtySections.get(o.name) ?? new Set<Key>()
    owners.add(owner)
    dirtySections.set(o.name, owners)
  }

  // Ключі, записані поточним `commit`: `sweep` прибирає ті, що лишились
  // без власника; очищується на кожному сповіщенні.
  const written: Array<readonly [ObjectState, Key]> = []
  const ops: StoreOps = {
    put(scope, o, row, readEpoch, lazyRead) {
      const result = o.rows.put(scope, row, readEpoch, lazyRead)
      if (result !== "rejected") {
        rowViews.touch(o.name, row.key)
        written.push([o, row.key])
      }
      return result
    },
    sweep(scope) {
      for (const [o, key] of written.splice(0)) {
        if (o.rows.get(key)?.owners !== 0) continue
        o.rows.disown(scope, key)
        rowViews.touch(o.name, key)
      }
    },
    remove(scope, o, key, readEpoch) {
      o.rows.remove(scope, key, readEpoch)
      rowViews.touch(o.name, key)
      // `removed` стирає й рядки ТЧ власника (§6.2, правило 5).
      if (o.rows.get(key)?.removed !== undefined) {
        o.sections.clearOwner(scope, key)
        touchSection(o, key)
      }
    },
    own: (scope, o, key) => o.rows.own(scope, key),
    disown(scope, o, key) {
      o.rows.disown(scope, key)
      rowViews.touch(o.name, key)
    },
    putSection(
      scope,
      o,
      owner,
      section,
      lines,
      ownerVersion,
      readEpoch,
      ownerScope
    ) {
      const result = o.sections.put(
        scope,
        owner,
        section,
        lines,
        ownerVersion,
        readEpoch,
        ownerScope,
        "owner-section"
      )
      if (result === "written") touchSection(o, owner)
    },
    clearOwner(scope, o, owner) {
      o.sections.clearOwner(scope, owner)
      touchSection(o, owner)
    },
  }

  const registry = createRegistry({
    session,
    source,
    index,
    limits,
    strict: options.strict ?? false,
    filterCollator: filterCollator(),
    // Порядок `full` — мовою користувача (Рд29).
    userCollator: new Intl.Collator(),
    log,
    ops,
    rowViews,
    objectOf,
    dirtySections: () => dirtySections,
    closedSnapshot: () => closed,
  })

  // ------------------------------------------------------------ хвіст

  /*
   * Хвостове перечитування ключів, що повернули `stale-inserted` (зокрема
   * сховані горизонтом), чи розбіжний `remove`: single-flight на об'єкт через
   * `readKeys`. Результат пишеться лише для ключів, що на мить `commit` мають
   * власника (§8.4): звільнений вигляд рядка не повертає.
   */
  const tails = new Map<
    ObjectState,
    { pending: Set<Key>; flying: boolean; gen: number }
  >()

  function runTail(o: ObjectState) {
    const tail = tails.get(o)
    if (tail === undefined || tail.flying || session.closed !== undefined)
      return
    const keys = [...tail.pending]
    tail.pending.clear()
    if (keys.length === 0) return
    tail.flying = true
    const gen = tail.gen
    const token = session.childToken(() => tail.gen === gen)
    const readEpoch = session.epochs.now()
    readKeys(source, o.entry, keys, { keysPerRequest: limits.keysPerRequest })
      .then(
        (rows) => {
          session.commit(
            (scope) => {
              const got = new Set<Key>()
              for (const row of rows) {
                got.add(row.key)
                // Ключ без запису — і перший запис без колонки скоупу (П11),
                // недосяжний: проєкція завжди несе scopeColumn (§10).
                if ((o.rows.get(row.key)?.owners ?? 0) > 0)
                  ops.put(scope, o, row, readEpoch, false)
              }
              for (const key of keys) {
                if (!got.has(key) && (o.rows.get(key)?.owners ?? 0) > 0)
                  ops.remove(scope, o, key, readEpoch)
              }
            },
            token,
            `tail ${o.name}`
          )
        },
        // Без автоповтору (§6.3): рядок лишається `stale` до наступного читання.
        () => {}
      )
      .finally(() => {
        tail.flying = false
        runTail(o)
      })
  }

  function scheduleTail(o: ObjectState, keys: readonly Key[]) {
    const tail = tails.get(o) ?? {
      pending: new Set<Key>(),
      flying: false,
      gen: 0,
    }
    tails.set(o, tail)
    for (const key of keys) tail.pending.add(key)
    runTail(o)
  }

  // ------------------------------------------------------------ сповіщення

  session.onFlush(() => {
    written.length = 0
    const closing = closed !== undefined
    if (!closing) {
      for (const o of objects.values()) {
        const keys = o.rows.drainTail()
        if (keys.length > 0) scheduleTail(o, keys)
      }
    }
    const notify = registry.afterCommit(closing)
    // Ревізії й кеш `RowView` — лише для рядків, що є в сховищі.
    rowViews.settle(
      (object, key) => objectOf(object).rows.get(key) !== undefined
    )
    dirtySections.clear()
    for (const s of notify) {
      for (const listener of [...s.listeners]) {
        // Слухач міг закрити ядро: далі нікого не сповіщаємо.
        if (session.closed !== undefined) return
        try {
          listener.fn()
        } catch (error) {
          log({ kind: "listener-failed", error })
        }
      }
    }
  })

  session.onClose(() => {
    written.length = 0
    registry.close()
    rowViews.clear()
    dirtySections.clear()
    tails.clear()
  })

  const notImplemented = (): never => {
    throw new Error("not implemented")
  }

  const core: CoreSession = {
    subject: options.subject,
    view: (spec) => registry.view(spec),
    preload: (spec, preloadOptions) => registry.preload(spec, preloadOptions),
    token: () => session.token(),
    readEpoch: () => session.epochs.now(),
    commit: notImplemented,
    activeViews: notImplemented,
    setVisible: notImplemented,
    revalidate: notImplemented,
    close(reason) {
      if (closed !== undefined) return
      closed = purgedSnapshot(reason)
      try {
        // Одна пачка: кожен підписаний вигляд отримує знімок `purged`.
        session.close(reason, (scope: Scope) => scope.assert())
      } catch (error) {
        closed = undefined
        throw error
      }
      // Черга обмежувача: жодного запиту після закриття.
      source.close()
    },
  }

  internals.set(core, {
    objects,
    ops,
    registry,
    invalidateTail(object) {
      const tail = tails.get(objectOf(object))
      if (tail !== undefined) tail.gen++
    },
  })

  inspections.set(core, {
    defects: new Set<DefectFlag>(),
    owners: (object, key) => objectOf(object).rows.get(key)?.owners ?? 0,
    rowCount: () => [...objects.values()].reduce((n, o) => n + o.rows.size, 0),
    violations() {
      const out: string[] = []
      const holders = new Map<string, number>()
      const hold = (o: ObjectState, key: Key, by: string) => {
        if (o.rows.get(key) === undefined)
          out.push(`${by}: owns ${o.name}/${key} without an entry`)
        const id = keyId(o.name, key)
        holders.set(id, (holders.get(id) ?? 0) + 1)
      }
      let held = 0
      for (const s of registry.subsets()) {
        held++
        const by = `view ${s.form.specKey}`
        if (!s.alive) out.push(`${by}: released but registered`)
        for (const key of s.owned) hold(s.form.object, key, by)
        for (const [name, keys] of s.included) {
          for (const key of keys) hold(objectOf(name), key, by)
        }
      }
      if (held > limits.viewsMax)
        out.push(`views: ${held} > ${limits.viewsMax}`)
      for (const o of objects.values()) {
        for (const key of o.rows.keys()) {
          const e = o.rows.get(key)!
          const n = holders.get(keyId(o.name, key)) ?? 0
          if (e.owners !== n)
            out.push(`${o.name}/${key}: owners ${e.owners} != holders ${n}`)
          if (n === 0) out.push(`${o.name}/${key}: held by nobody`)
          if (
            e.removed !== undefined &&
            (e.row !== undefined || e.lazyVersions.size > 0)
          )
            out.push(`${o.name}/${key}: values on a removed slot`)
        }
      }
      for (const { object, key } of rowViews.ids()) {
        if (objectOf(object).rows.get(key) === undefined)
          out.push(`${object}/${key}: revision or row view without a row`)
      }
      return out
    },
  })
  return core
}

/** The internals of a core for the Task 8 writer (not exported from `simetra/data`). */
export function coreInternals(session: CoreSession): CoreInternals {
  const found = internals.get(session)
  if (found === undefined) throw new TypeError("not a core session")
  return found
}
