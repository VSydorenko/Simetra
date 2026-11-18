import { FILTER_IN_MAX, READ_LIMIT_MAX, type CatalogIndex } from "simetra/model"
import type { DefectFlag } from "./defects"
import { fieldInfoOf, filterCollator } from "./filter"
import { keyId } from "./epoch"
import { createObjectStore } from "./object-store"
import {
  createOverlay,
  type JournalInspection,
  type UpdateOptions,
} from "./overlay"
import { createSectionStore } from "./section-store"
import { createSession, type Scope } from "./session"
import { applySnapshot, dehydrate, parseSnapshot, type SsrContext } from "./ssr"
import { createRowViews, purgedSnapshot } from "./snapshot"
import { readKeys, tracked, type CoreReadItem, type CoreSource } from "./source"
import type { ObjectState } from "./forms"
import type { StoreOps } from "./readers"
import { createRegistry, type Subset, type SubsetRegistry } from "./subsets"
import {
  activeViews,
  createWriter,
  revalidate,
  revalidateHolders,
  revalidateHydrated,
  rereadKey,
  setVisible,
  type WriterContext,
} from "./writer"
import {
  DEFAULT_CORE_LIMITS,
  type ActiveView,
  type CloseReason,
  type CoreLimits,
  type CoreLogEntry,
  type CoreSnapshot,
  type GenerationToken,
  type Key,
  type Mutation,
  type ObjectName,
  type Values,
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
  /**
   * The list strategy of an object (P4-B spec §5.1, Рд19): what the runtime
   * settings say, `window` by default. A host picks `full` or `window` forms
   * by it.
   */
  residencyOf(object: ObjectName): "full" | "window"
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
  /**
   * Starts an `update` with the `await` policy (P4-B spec §7.1, plan
   * B3-4-Л): one mutation per key in the journal, one `run`. Throws
   * synchronously, before the journal and the transport, only for a caller
   * error: `TypeError` for a name outside the catalog, `DataError`
   * `data.version-required`. `data.mutation-pending` (the key has a
   * `pending` mutation) and `data.journal-full` settle the mutation failed
   * with that `DataError`. After `close` it settles with the close reason.
   */
  update(
    object: ObjectName,
    key: Key,
    values: Values,
    options: UpdateOptions
  ): Mutation
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
   * by the same rule (composition kept). `minAgeMs` skips a view whose
   * freshness mark — the start of its last settled read — is younger.
   */
  revalidate(
    object: ObjectName,
    options: { visibleOnly: boolean; minAgeMs?: number }
  ): Promise<void>
  /**
   * Purges every key in one notification batch, after which every handle —
   * new ones included — returns one stable `purged` snapshot with `reason`;
   * no request goes out and no response is written afterwards. Every
   * mutation not yet settled settles with the close.
   */
  close(reason: CloseReason): void
  /**
   * Asks the server for the catalog version (P4-B spec §10) and re-marks the
   * stale objects by the answer. Single-flight with one tail: calls before the
   * request goes out (one microtask) make one request, calls while it flies
   * make exactly one more after it.
   */
  requestVersion(): void
  /**
   * Internal, for the runtime: the `serverHash` of a response that passed the
   * closed check. A change against the last seen hash asks for the version —
   * unless the response carried the `version` part itself, which only updates
   * the hash (no ping-pong between instances of two catalogs).
   */
  serverHash(hash: string, versionPart: boolean): void
  /**
   * Internal, for the runtime and the write journal: the one entry of the
   * sticky `stale-client` mark (P4-B spec §10), whatever the cause of the
   * refusal. On the transition only: hides every row of the object and of its
   * owners' sections (`Writer.hide`), makes its views `isStale`, stops its
   * reads, calls `onStaleClient(object)` once and asks for the version. A
   * mark already set, or a closed core, does nothing.
   */
  staleClient(object: ObjectName): void
  /**
   * The snapshot of the ready held views (P4-B spec §6.6): their rows,
   * compositions and tabular section lines, and no value of a row the views
   * do not show (`hidden`, `removed`). Throws `TypeError` once the core is
   * closed, and while the journal of mutations is not empty (an SSR runtime
   * writes nothing).
   */
  dehydrate(): CoreSnapshot
  /**
   * Takes a snapshot into an empty core before its first render (§6.6): every
   * view of it is held, loaded and ready, and a subscription to one starts no
   * read. Throws `TypeError`, writing nothing, for a snapshot of another
   * `format` or catalog, or when the core was hydrated or already holds a
   * view. Does nothing after `close`.
   */
  hydrate(snapshot: CoreSnapshot): void
  /**
   * Ends the hydration, once (a repeat does nothing): releases the views no
   * subscription took after `releaseDelayMs`, asks for the catalog version
   * and re-reads the visible views of every object — synchronously, so the
   * requests leave in one microtask (plan B3-6a, Р6).
   */
  endHydration(): void
  /** Whether the host shows the application (`resume` sets, `suspend` clears). */
  readonly visible: boolean
  /** Marks the application hidden; idempotent, sends nothing (plan B3-6a, Р12). */
  suspend(): void
  /**
   * Marks the application visible. A call less than `RESUME_COALESCE_MS`
   * after the last accepted one does nothing more. An accepted call asks for
   * the catalog version and re-reads the visible views whose freshness mark is
   * older than `limits.resumeMinIntervalMs` or missing, synchronously (Р11).
   */
  resume(): void
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
    hidden: number
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
    /** Mutations in the journal plus attempts not yet settled. */
    journal: number
    /** Section store maps, summed over objects. */
    sectionOwners: number
    sectionOwnerVersions: number
  }
  /** Deliberate defects of the model test's self-check; empty by default. */
  readonly defects: Set<DefectFlag>
  /** The version epoch state of the session (P4-B spec §6.2). */
  versionEpochs(): {
    current: string | null
    previous: string | null
    discards: number
    unavailable: boolean
  }
  /**
   * Subscribes to the moments a fresh "row absent" answer re-marks a slot that
   * is already `removed`; the model then expects no older read to lift it.
   */
  watchRemarks(listener: (object: ObjectName, key: Key) => void): void
  /** The mutations in the journal of own mutations. */
  mutations(): JournalInspection[]
}

const inspections = new WeakMap<CoreSession, CoreInspection>()
const internals = new WeakMap<CoreSession, CoreInternals>()

/** The inspection of a core created by {@link createCore} (tests only). */
export function inspectCore(session: CoreSession): CoreInspection {
  const found = inspections.get(session)
  if (found === undefined) throw new TypeError("not a core session")
  return found
}

/** `resume()` closer than this to the last accepted one does nothing (Р11). */
const RESUME_COALESCE_MS = 1_000

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
  const explicit = Object.fromEntries(set) as Partial<CoreLimits>
  const limits: CoreLimits = {
    ...DEFAULT_CORE_LIMITS,
    // Типова межа `resume()` не перевищує інтервал звірки: host з коротким
    // `revalidateIntervalMs` не мусить знати про нову межу.
    resumeMinIntervalMs: Math.min(
      DEFAULT_CORE_LIMITS.resumeMinIntervalMs,
      explicit.revalidateIntervalMs ?? DEFAULT_CORE_LIMITS.revalidateIntervalMs
    ),
    ...explicit,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`limits.${name} must be a positive integer`)
    }
  }
  if (limits.fullPageSize > READ_LIMIT_MAX)
    throw new TypeError(`limits.fullPageSize must not exceed ${READ_LIMIT_MAX}`)
  if (limits.windowPage > READ_LIMIT_MAX)
    throw new TypeError(`limits.windowPage must not exceed ${READ_LIMIT_MAX}`)
  if (limits.keysPerRequest > KEYS_PER_REQUEST_MAX)
    throw new TypeError(
      `limits.keysPerRequest must not exceed ${KEYS_PER_REQUEST_MAX}`
    )
  // Лише для явної межі: типова вже не більша за інтервал.
  if (limits.resumeMinIntervalMs > limits.revalidateIntervalMs)
    throw new TypeError(
      `limits.resumeMinIntervalMs (${limits.resumeMinIntervalMs}) must not exceed limits.revalidateIntervalMs (${limits.revalidateIntervalMs})`
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
  /** The list strategy by object id; an object not named is `window`. */
  residency?: ReadonlyMap<string, "full" | "window">
  log?: (e: CoreLogEntry) => void
  /** The `snapshotHash` of the client catalog: the first hash to compare with. */
  snapshotHash?: string
  /** Host callback: once per object, on its transition to stale-client. */
  onStaleClient?: (object: ObjectName) => void
  /** Initial `visible` (default `true`). */
  visible?: boolean
  /** The monotonic clock in ms; tests substitute it, hosts never do. */
  now?: () => number
}): CoreSession {
  const limits = limitsOf(options.limits)
  const { index } = options
  const now = options.now ?? (() => performance.now())
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
  // Журнал створюється після ядра (йому потрібен `commit`); вигляд рядка
  // бере з нього мутацію лише після створення.
  const rowViews = createRowViews((object, key, e) =>
    overlay.mutationOf(object, key, e)
  )
  const dirtySections = new Map<ObjectName, Set<Key>>()
  // Липка позначка «застарілий» об'єкта (§10): її ставить кожна відмова
  // `stale-client` і відповідь `version`, знімає лише перезавантаження;
  // `dirtyObjects` — об'єкти, чия позначка змінилась у цьому commit.
  const staleObjects = new Set<ObjectName>()
  const dirtyObjects = new Set<ObjectName>()
  // Читання несумісного об'єкта (§10) ядро не шле й не приймає: клієнт не
  // може перевірити його права, тож і відповідь, що вже летить, нічого не
  // пише. Відмова — той самий `stale-client`, що дав би сервер.
  const source: CoreSource = {
    close: () => options.source.close(),
    refuse: (object) => options.source.refuse?.(object),
    run: (operation) => options.source.run(operation),
    version: () => options.source.version(),
    async read(parts) {
      const isLive = (part: (typeof parts)[number]) => {
        const { kind, name } = part.object
        return !staleObjects.has(`${kind}.${name}`)
      }
      const refused = (part: (typeof parts)[number]): CoreReadItem => {
        return {
          ok: false,
          error: { code: "command.stale-client", object: part.object },
        }
      }
      const sent = parts.map(isLive)
      const forward = parts.filter((_, slot) => sent[slot])
      const answered =
        forward.length === 0
          ? { items: [] as CoreReadItem[] }
          : await options.source.read(forward)
      let next = 0
      const items = parts.map((part, slot): CoreReadItem => {
        if (!sent[slot]) return refused(part)
        const item = answered.items[next++]!
        // Об'єкт став несумісним, поки відповідь летіла: вона вже не діє.
        return isLive(part) ? item : refused(part)
      })
      return { items }
    },
  }

  let lastHash = options.snapshotHash
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
      // Читання, що вже закінчилось і чекає свого `commit` (вікно після
      // `include`), не вносить значень несумісного об'єкта (§10).
      if (staleObjects.has(o.name)) return "rejected"
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
      // Перехід у `removed` стирає поля мутації ключа тим самим `commit` (Р11).
      if (o.rows.get(key)?.removed !== undefined) overlay.erase(o.name, key)
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
      if (staleObjects.has(o.name)) return
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
      // читає наново, коли ревізія шапки змінилась.
      if (result === "stale") {
        touchSection(o, owner)
        if (o.rows.get(owner) !== undefined) rowViews.touch(o.name, owner)
      }
    },
    clearOwner(scope, o, owner) {
      o.sections.clearOwner(scope, owner)
      touchSection(o, owner)
    },
    restore(scope, o, row, at) {
      o.rows.restore(scope, row, at)
      rowViews.touch(o.name, row.key)
      // Слот без вигляду-власника (знімок, чий вигляд не прийнято) знімає `sweep`.
      written.push([o, row.key])
    },
    restoreSection(scope, o, owner, section, entry) {
      o.sections.restore(scope, owner, section, entry)
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
    dirtyObjects: () => dirtyObjects,
    isStale: (object) => staleObjects.has(object),
    closedSnapshot: () => closed,
    defects,
    now,
    readHydrated: (s) => readHydrated(s),
  })

  // ------------------------------------------------------------ знімок SSR

  const ssr: SsrContext = {
    session,
    objects,
    registry,
    ops,
    limits,
    defects,
  }
  // Гідратація одноразова: `endHydration` повторюється під StrictMode, а
  // другий знімок змішався б із першим.
  let hydration: "none" | "hydrated" | "ended" = "none"
  let visible = options.visible ?? true
  let lastResumeAt: number | undefined

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
              // Відкинута відповідь не пише нічого; без автоповтору
              // (§6.3) ключі перечитує вигляд.
              if (session.acceptEpochs(read.epochs, readEpoch) === "discard")
                return
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
      // `hide` (права): види, що тримають сховані ключі, перечитуються після
      // `commit`, з епохою старту не меншою за позначку.
      const hiddenNow = [...hiddenKeys]
      hiddenKeys.clear()
      for (const [name, keys] of hiddenNow) {
        // Несумісний об'єкт не перечитується: його значення не повертаються.
        if (staleObjects.has(name)) continue
        revalidateHolders(writerContext, name, keys).catch((error: unknown) =>
          log({ kind: "listener-failed", error })
        )
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
    dirtyObjects.clear()
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
    hiddenKeys.clear()
    rowViews.clear()
    dirtySections.clear()
    dirtyObjects.clear()
    tails.clear()
    purges.clear()
    for (const timer of switchTimers.values()) clearTimeout(timer)
    switchTimers.clear()
    staleObjects.clear()
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
  const hiddenKeys = new Map<ObjectName, Set<Key>>()

  // Перемикання епохи: кожен рядок уже `stale` (сховища позначили), а
  // видимі вигляди перечитуються з розкидом — рестарт primary перемикає
  // всіх клієнтів одночасно, і миттєве перечитування було б шквалом.
  const switchTimers = new Map<ObjectName, ReturnType<typeof setTimeout>>()
  session.onSwitch(() => {
    for (const o of objects.values()) {
      for (const key of o.rows.keys()) rowViews.touch(o.name, key)
      // Несумісний об'єкт не перечитується (§10): його вигляди лишаються в
      // стані `isStale`, а не переходять в `error`.
      if (staleObjects.has(o.name)) continue
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

  /**
   * Довіра до значень — факт РЯДКА: рядок, який записала лише гідратація
   * (`writtenEpoch` < епохи гідратації), не читався після неї (§6.6). Вигляд
   * над таким рядком — власним чи `include` — стає видимим після `endHydration`
   * (пізня підписка чи `setVisible(true)`) і читається зараз, поодинці, доки
   * читання, що стартувало після гідратації, не перезапише рядок. ТЧ міряється
   * епохою свого читання (`sectionRead`). До кінця гідратації читання робить
   * `endHydration` разом з усіма.
   */
  let hydrationEpoch = 0
  // Лише для самотесту: вигляди, які знімок тримав сам (дефект
  // `hydrated-row-not-reread` читає тільки їх, як колишній прапор вигляду).
  const heldBySnapshot = new Set<Subset>()

  function overHydratedRows(s: Subset): boolean {
    if (s.form.spec.kind === "section")
      return s.sectionRead !== undefined && s.sectionRead < hydrationEpoch
    const stale = (o: ObjectState, keys: Iterable<Key>) => {
      for (const key of keys) {
        const e = o.rows.get(key)
        if (e !== undefined && e.writtenEpoch < hydrationEpoch) return true
      }
      return false
    }
    if (stale(s.form.object, s.owned)) return true
    for (const [name, keys] of s.included)
      if (stale(objectOf(name), keys)) return true
    return false
  }

  function readHydrated(s: Subset) {
    if (hydration !== "ended") return
    if (defects.has("late-hydrated-not-reread")) return
    if (staleObjects.has(s.form.object.name)) return
    if (!(s.visible ?? s.listeners.size > 0)) return
    if (defects.has("hydrated-row-not-reread") && !heldBySnapshot.has(s)) return
    if (!overHydratedRows(s)) return
    revalidateHydrated(writerContext, s).catch((error: unknown) =>
      log({ kind: "listener-failed", error })
    )
  }

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
    now,
    hiddenKeys,
    journal: {
      erase: (object, key) => overlay.erase(object, key),
      eraseScope: (object, scope) => overlay.eraseScope(object, scope),
    },
  }

  // ------------------------------------------------------------ версія

  const notifyStaleClient = (object: ObjectName) => {
    try {
      options.onStaleClient?.(object)
    } catch (error) {
      // Збій колбека host-а не ламає ядро й не підміняє результат запису.
      log({ kind: "listener-failed", error })
    }
  }

  // Липка позначка «застарілий» (§10): єдиний вхід — і `version`, і відмова
  // `stale-client` частини читання чи запису. Позначка не знімається до
  // перезавантаження: клієнт не може перевірити права несумісного об'єкта,
  // тож закриває його, а не показує. Значення рядків і ТЧ їхніх власників
  // ховає наявний `Writer.hide`; повернути їх може лише читання, а читань
  // об'єкта більше немає (`source` вище).
  const markStale = (scope: Scope, o: ObjectState): boolean => {
    if (staleObjects.has(o.name)) return false
    staleObjects.add(o.name)
    dirtyObjects.add(o.name)
    // Частини, що вже стоять у черзі обмежувача, теж не підуть.
    source.refuse?.(o.name)
    // Власник із рядками ТЧ може не мати шапки в сховищі (`disown`).
    createWriter(writerContext, scope).hide(o.name, [
      ...new Set([...o.rows.keys(), ...o.sections.owners()]),
    ])
    return true
  }

  // Позначки за відповіддю `version`: об'єкт, якого сервер не знає, чи з
  // іншим kernelHash, — застарілий; збіг хеша позначку НЕ знімає.
  function applyVersion(objectsOfServer: Readonly<Record<string, string>>) {
    const token = session.token()
    const turned: ObjectName[] = []
    session.commit(
      (scope) => {
        try {
          for (const o of objects.values()) {
            const stale = objectsOfServer[o.entry.id] !== o.entry.kernelHash
            if (stale && markStale(scope, o)) turned.push(o.name)
            else if (
              !stale &&
              defects.has("stale-mark-lifts") &&
              staleObjects.delete(o.name)
            )
              dirtyObjects.add(o.name)
          }
        } finally {
          ops.sweep(scope)
        }
      },
      token,
      "version"
    )
    // Колбек — після commit: host не бачить напівзастосованого стану.
    for (const object of turned) notifyStaleClient(object)
  }

  // Один запит `version` за раз і не більше одного хвоста: перед відправкою
  // (мікрозадача) виклики зливаються, під час польоту — один хвіст.
  let versionState: "idle" | "scheduled" | "flying" = "idle"
  let versionTail = false
  function startVersion() {
    versionState = "flying"
    const token = session.token()
    source
      .version()
      .then(
        (result) => {
          if (token.valid && result.ok) applyVersion(result.version.objects)
        },
        (error: unknown) => log({ kind: "listener-failed", error })
      )
      .finally(() => {
        versionState = "idle"
        if (!versionTail) return
        versionTail = false
        core.requestVersion()
      })
  }

  const core: CoreSession = {
    subject: options.subject,
    signal: session.signal,
    view: (spec) => registry.view(spec),
    preload: (spec, preloadOptions) => registry.preload(spec, preloadOptions),
    residencyOf: (object) =>
      options.residency?.get(objectOf(object).entry.id) ?? "window",
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
    requestVersion() {
      if (!session.token().valid) return
      if (versionState === "flying") versionTail = true
      else if (versionState === "idle") {
        versionState = "scheduled"
        queueMicrotask(() => {
          if (session.token().valid) startVersion()
          else versionState = "idle"
        })
      }
    },
    serverHash(hash, versionPart) {
      const changed = lastHash !== undefined && hash !== lastHash
      lastHash = hash
      if (changed && !versionPart) core.requestVersion()
    },
    staleClient(object) {
      const o = objects.get(object)
      if (o === undefined || !session.token().valid) return
      const token = session.token()
      let turned = false
      session.commit(
        (scope) => {
          try {
            turned = markStale(scope, o)
          } finally {
            ops.sweep(scope)
          }
        },
        token,
        "stale-client"
      )
      if (!turned) return
      notifyStaleClient(object)
      core.requestVersion()
    },
    dehydrate() {
      if (closed !== undefined || !session.token().valid)
        throw new TypeError("the core is closed")
      // SSR-рантайм нічого не пише: знімок після запису — помилка host-а, а
      // журнал мутацій у знімок не переходить.
      if (overlay.size() > 0)
        throw new TypeError("the journal of mutations is not empty")
      return dehydrate(ssr)
    },
    hydrate(snapshot) {
      if (closed !== undefined || !session.token().valid) return
      if (hydration !== "none" || [...registry.subsets()].length > 0)
        throw new TypeError("the core is hydrated or already holds views")
      const parsed = parseSnapshot(ssr, snapshot)
      hydration = "hydrated"
      session.commit(
        (scope) => {
          try {
            applySnapshot(ssr, scope, parsed)
          } finally {
            // Слот, якого не взяв жоден вигляд, не лишається без власника.
            ops.sweep(scope)
          }
        },
        session.token(),
        "hydrate"
      )
      // Свіжіша за епоху записаних рядків: читання, що стартувало після
      // гідратації, має епоху не нижчу й пише рядки вже «довіреними».
      hydrationEpoch = session.epochs.next()
      if (defects.has("hydrated-row-not-reread"))
        for (const s of registry.subsets()) heldBySnapshot.add(s)
    },
    endHydration() {
      if (hydration !== "hydrated") return
      hydration = "ended"
      if (!session.token().valid) return
      registry.endHydration()
      // Звірка (Р6): запити йдуть синхронно, без `await` між об'єктами, тож
      // збирач пакета читань зіллє їх, а цей код не зміниться.
      core.requestVersion()
      if (defects.has("hydrate-without-revalidate")) return
      for (const o of objects.values()) {
        // Несумісний об'єкт не читається (§10): перечитування перевело б
        // його вигляди в `error` замість показати `isStale`.
        if (staleObjects.has(o.name)) continue
        if (!activeViews(writerContext, o.name).some((v) => v.visible)) continue
        revalidate(writerContext, o.name, { visibleOnly: true }).catch(
          (error: unknown) => log({ kind: "listener-failed", error })
        )
      }
    },
    get visible() {
      return visible
    },
    suspend() {
      visible = false
    },
    resume() {
      visible = true
      if (!session.token().valid) return
      // Злиття: подвійний сигнал повернення (focus + visibilitychange) — одна
      // звірка; відлік іде від останнього прийнятого, а не від кожного виклику.
      const at = now()
      if (lastResumeAt !== undefined && at - lastResumeAt < RESUME_COALESCE_MS)
        return
      lastResumeAt = at
      // Як в `endHydration`: усе синхронно, без `await` між об'єктами.
      core.requestVersion()
      for (const o of objects.values()) {
        // Як в `endHydration`: несумісний об'єкт не перечитується.
        if (staleObjects.has(o.name)) continue
        revalidate(writerContext, o.name, {
          visibleOnly: true,
          minAgeMs: limits.resumeMinIntervalMs,
        }).catch((error: unknown) => log({ kind: "listener-failed", error }))
      }
    },
    update: (object, key, values, updateOptions) =>
      overlay.update(object, key, values, updateOptions),
    activeViews: (object) => activeViews(writerContext, object),
    setVisible(spec, visible) {
      setVisible(writerContext, spec, visible)
      if (!visible) return
      const s = registry.find(spec)
      if (s !== undefined) readHydrated(s)
    },
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
      overlay.close(reason)
    },
  }

  const overlay = createOverlay({
    session,
    source,
    index,
    objectOf,
    rowViews,
    commit: core.commit,
    isStale: (object) => staleObjects.has(object),
    staleClient: (object) => core.staleClient(object),
    reread(object, key, rereadOptions) {
      rereadKey(writerContext, object, key, rereadOptions).catch(
        (error: unknown) => log({ kind: "listener-failed", error })
      )
    },
    log,
    defects,
  })

  internals.set(core, { objects, ops, registry })

  inspections.set(core, {
    defects,
    watchRemarks(listener) {
      remarkListener = listener
    },
    mutations: () => overlay.entries(),
    versionEpochs: () => ({
      current: session.versions.current(),
      previous: session.versions.previous(),
      discards: session.versions.discards(),
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
        journal: overlay.size(),
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
        // Вікно тримає лише склад: його сторінки — ключі в тому порядку, у
        // якому показано список, без повторів і порожніх сторінок (Р8, Р9).
        if (s.window !== undefined) {
          const keys = s.window.pages.flatMap((page) => [...page.keys])
          if (keys.join() !== s.layout.join())
            out.push(`${by}: layout differs from the keys of its pages`)
          if (new Set(keys).size !== keys.length)
            out.push(`${by}: a key in two pages`)
          if (s.window.pages.some((page) => page.keys.length === 0))
            out.push(`${by}: an empty page`)
          for (const key of keys) {
            if (!s.owned.has(key)) out.push(`${by}: page key ${key} not owned`)
          }
        }
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
