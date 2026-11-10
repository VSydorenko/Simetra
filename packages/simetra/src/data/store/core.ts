import { FILTER_IN_MAX, READ_LIMIT_MAX, type CatalogIndex } from "simetra/model"
import type { DefectFlag } from "./defects"
import { fieldInfoOf, filterCollator } from "./filter"
import { keyId } from "./epoch"
import { createObjectStore } from "./object-store"
import { createSectionStore } from "./section-store"
import { createSession, type Scope } from "./session"
import { createRowViews, purgedSnapshot } from "./snapshot"
import { readKeys, tracked, type CoreSource } from "./source"
import type { ObjectState } from "./forms"
import type { StoreOps } from "./readers"
import { createRegistry, type SubsetRegistry } from "./subsets"
import {
  activeViews,
  createWriter,
  revalidate,
  setVisible,
  type WriterContext,
} from "./writer"
import {
  DEFAULT_CORE_LIMITS,
  type ActiveView,
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
 * Ядро даних T4 (спека П4-B §6): сесія, сховища об'єктів, реєстр виглядів,
 * хвостове перечитування й API приймача сигналів (`writer.ts`) над одним
 * `CoreSource`.
 */

/** The data core of one user session (P4-B spec §6.1). */
export interface CoreSession {
  readonly subject: string
  /** Aborted when the session closes; internal, for the write transport. */
  readonly signal: AbortSignal
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
  /**
   * Runs `fn` with a {@link Writer} when `token` is valid (one notification
   * batch) and returns `true`; otherwise returns `false` without calling it.
   * A throw of `fn` is passed on; rows it wrote stay only with an owner.
   */
  commit(fn: (writer: Writer) => void, token: GenerationToken): boolean
  /** Held views of the object, visible first. */
  activeViews(object: ObjectName): readonly ActiveView[]
  /**
   * Sets the visibility of a held view (unset — visible while subscribed).
   * Call it after `subscribe` / `preload`: a form without a held subset is
   * ignored.
   */
  setVisible(spec: ViewSpec, visible: boolean): void
  /**
   * Re-reads the object's views by the stability rule (P4-B spec §8.4): all
   * reads first, then one `commit`; `visibleOnly` skips invisible views.
   * Views that never loaded are skipped (their first read is a load); a
   * purge after the start drops the results and re-reads those views again
   * by the same rule (composition kept).
   */
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

export type { DefectFlag } from "./defects"

/** Test-only inspection of a core. */
export interface CoreInspection {
  /** Broken invariants of ownership and service maps; empty when sound. */
  violations(): string[]
  owners(object: ObjectName, key: Key): number
  rowCount(): number
  /** Sizes of the service maps that must not outlive their rows or the session. */
  serviceSizes(): {
    seen: number
    tombstones: number
    horizon: number
    pairBurials: number
    revisions: number
    rowViews: number
    /** Keys waiting for or in flight in the tail re-reads. */
    tails: number
    purges: number
    /** Release timers and preload timers of the held view forms. */
    releaseTimers: number
    preloadTimers: number
    /** Re-reads scheduled by a version epoch switch, per object. */
    switchTimers: number
    /** Section store maps, summed over objects. */
    sectionOwners: number
    sectionOwnerVersions: number
  }
  /** Deliberate defects of the model test's self-check; empty by default. */
  readonly defects: Set<DefectFlag>
  /** The version epoch state of the session (P4-B plan B1c). */
  versionEpochs(): {
    current: string | null
    previous: string | null
    unavailable: boolean
  }
  /**
   * Subscribes to the moments a fresh "row absent" answer re-marks a slot that
   * is already `removed`; the model then expects no older read to lift it.
   */
  watchRemarks(listener: (object: ObjectName, key: Key) => void): void
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
// межі перевіряються до створення сесії. Явне `undefined` — типове значення,
// як і відсутнє поле.
/**
 * Merges `overrides` with {@link DEFAULT_CORE_LIMITS} (an `undefined` field
 * takes the default) and checks them; a limit that is not a positive
 * integer is a `TypeError`.
 */
export function limitsOf(
  overrides: Partial<CoreLimits> | undefined
): CoreLimits {
  const set = Object.entries(overrides ?? {}).filter(
    ([, value]) => value !== undefined
  )
  const limits: CoreLimits = {
    ...DEFAULT_CORE_LIMITS,
    ...(Object.fromEntries(set) as Partial<CoreLimits>),
  }
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
 * Internals of a core for tests: the stores, the store operations that keep
 * views in step and the registry.
 */
export interface CoreInternals {
  readonly objects: ReadonlyMap<ObjectName, ObjectState>
  readonly ops: StoreOps
  readonly registry: SubsetRegistry
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
  // Прапорці самотесту: модулі тримають той самий набір, тож прапорець,
  // доданий через `inspectCore` після створення, діє одразу.
  const defects = new Set<DefectFlag>()
  let remarkListener: ((object: ObjectName, key: Key) => void) | undefined
  const session = createSession({
    subject: options.subject,
    limits,
    log,
    defects,
  })
  const rowViews = createRowViews()
  const dirtySections = new Map<ObjectName, Set<Key>>()
  let closed: ViewSnapshot | undefined

  const objects = new Map<ObjectName, ObjectState>()
  for (const entry of index.byRef.values()) {
    const name = `${entry.kind}.${entry.name}`
    const rows = createObjectStore({
      object: name,
      entry,
      session,
      log,
      defects,
      onRemark: (key) => remarkListener?.(name, key),
    })
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
      if (defects.has("absent-row-ignored")) return
      o.rows.remove(scope, key, readEpoch)
      rowViews.touch(o.name, key)
      // `removed` стирає й рядки ТЧ власника (§6.2, правило 5); власник без
      // шапки в сховищі — теж: його рядкам ТЧ нема чим лишатись видимими.
      // Епоху читання рядків ТЧ не порівнюємо навмисно: епоха старту на
      // клієнті не впорядковує серверних знімків (П15), тож відсутній рядок
      // ховає завжди; рядки повертає наступне читання ТЧ.
      const e = o.rows.get(key)
      if (defects.has("removed-keeps-sections")) return
      if (e === undefined || e.removed !== undefined) {
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
      versionEpoch,
      readEpoch,
      ownerScope
    ) {
      const result = o.sections.put(
        scope,
        owner,
        section,
        lines,
        ownerVersion,
        versionEpoch,
        readEpoch,
        ownerScope,
        "owner-section"
      )
      if (result === "written") touchSection(o, owner)
      // Позначені рядки ТЧ перечитує змонтований вигляд: перевірка вигляду
      // читає наново, коли ревізія шапки змінилась (Р13).
      if (result === "stale") {
        touchSection(o, owner)
        if (o.rows.get(owner) !== undefined) rowViews.touch(o.name, owner)
      }
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
    { pending: Set<Key>; flying: readonly Key[] | undefined; gen: number }
  >()

  function runTail(o: ObjectState) {
    const tail = tails.get(o)
    if (
      tail === undefined ||
      tail.flying !== undefined ||
      !session.token().valid
    )
      return
    const keys = [...tail.pending]
    tail.pending.clear()
    if (keys.length === 0) return
    tail.flying = keys
    const gen = tail.gen
    const token = session.childToken(() => tail.gen === gen)
    const readEpoch = session.epochs.now()
    const read = tracked(source)
    readKeys(read.source, o.entry, keys, {
      keysPerRequest: limits.keysPerRequest,
    })
      .then(
        (rows) => {
          session.commit(
            (scope) => {
              // Відкинута відповідь (Р7, Р12) не пише нічого; без автоповтору
              // (§6.3) ключі перечитує вигляд.
              for (const epoch of read.epochs) {
                if (session.acceptEpoch(epoch, readEpoch) === "discard") return
              }
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
        tail.flying = undefined
        runTail(o)
      })
  }

  function scheduleTail(o: ObjectState, keys: readonly Key[]) {
    const tail = tails.get(o) ?? {
      pending: new Set<Key>(),
      flying: undefined,
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
    // Хвостове читання не стартує з flush пачки закриття (токен недійсний
    // із `closing`, а `closed` сесії ще не виставлено).
    if (!closing && session.token().valid) {
      for (const o of objects.values()) {
        const keys = o.rows.drainTail()
        if (keys.length > 0) scheduleTail(o, keys)
      }
    }
    const notify = registry.afterCommit(closing)
    // Ревізії й кеш `RowView` — лише для рядків, що є в сховищі.
    rowViews.settle(
      (object, key) =>
        defects.has("revision-survives-row") ||
        objectOf(object).rows.get(key) !== undefined
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
    purges.clear()
    for (const timer of switchTimers.values()) clearTimeout(timer)
    switchTimers.clear()
  })

  // Хвіст у польоті під час purge: його відповідь могла нести рядок, якого на
  // мить purge у сховищі не було (П12); ключі перечитуються наново.
  function invalidateTail(o: ObjectState) {
    const tail = tails.get(o)
    if (tail === undefined) return
    tail.gen++
    for (const key of tail.flying ?? []) tail.pending.add(key)
  }

  const purges = new Map<ObjectName, number>()

  // Перемикання епохи (Р8): кожен рядок уже `stale` (сховища позначили), а
  // видимі вигляди перечитуються з розкидом — рестарт primary перемикає
  // всіх клієнтів одночасно, і миттєве перечитування було б шквалом.
  const switchTimers = new Map<ObjectName, ReturnType<typeof setTimeout>>()
  session.onSwitch(() => {
    for (const o of objects.values()) {
      for (const key of o.rows.keys()) rowViews.touch(o.name, key)
      if (switchTimers.has(o.name)) continue
      if (!activeViews(writerContext, o.name).some((v) => v.visible)) continue
      const delay = Math.floor(Math.random() * limits.revalidateIntervalMs)
      switchTimers.set(
        o.name,
        setTimeout(() => {
          switchTimers.delete(o.name)
          revalidate(writerContext, o.name, { visibleOnly: true }).catch(
            (error: unknown) => log({ kind: "listener-failed", error })
          )
        }, delay)
      )
    }
  })

  const writerContext: WriterContext = {
    session,
    source,
    limits,
    strict: options.strict ?? false,
    log,
    ops,
    objectOf,
    registry,
    rowViews,
    objects,
    purges,
    invalidateTail,
    defects,
  }

  const core: CoreSession = {
    subject: options.subject,
    signal: session.signal,
    view: (spec) => registry.view(spec),
    preload: (spec, preloadOptions) => registry.preload(spec, preloadOptions),
    token: () => session.token(),
    readEpoch: () => session.epochs.now(),
    commit(fn, token) {
      return session.commit(
        (scope) => {
          try {
            fn(createWriter(writerContext, scope))
          } finally {
            // Збій fn посеред запису не лишає рядка без власника.
            ops.sweep(scope)
          }
        },
        token,
        "writer"
      )
    },
    activeViews: (object) => activeViews(writerContext, object),
    setVisible: (spec, visible) => setVisible(writerContext, spec, visible),
    revalidate: (object, revalidateOptions) =>
      revalidate(writerContext, object, revalidateOptions),
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

  internals.set(core, { objects, ops, registry })

  inspections.set(core, {
    defects,
    watchRemarks(listener) {
      remarkListener = listener
    },
    versionEpochs: () => ({
      current: session.versions.current(),
      previous: session.versions.previous(),
      unavailable: session.versions.unavailable(),
    }),
    serviceSizes() {
      const views = rowViews.sizes()
      const subs = [...registry.subsets()]
      const sections = [...objects.values()].map((o) => o.sections.sizes())
      return {
        ...session.epochs.sizes(),
        revisions: views.revisions,
        rowViews: views.views,
        tails: [...tails.values()].reduce(
          (n, t) => n + t.pending.size + (t.flying?.length ?? 0),
          0
        ),
        purges: purges.size,
        releaseTimers: subs.filter((s) => s.releaseTimer !== undefined).length,
        preloadTimers: subs.reduce((n, s) => n + s.preloadTimers.size, 0),
        switchTimers: switchTimers.size,
        sectionOwners: sections.reduce((n, x) => n + x.owners, 0),
        sectionOwnerVersions: sections.reduce((n, x) => n + x.ownerVersions, 0),
      }
    },
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

/** The internals of a core (tests only; not exported from `simetra/data`). */
export function coreInternals(session: CoreSession): CoreInternals {
  const found = internals.get(session)
  if (found === undefined) throw new TypeError("not a core session")
  return found
}
