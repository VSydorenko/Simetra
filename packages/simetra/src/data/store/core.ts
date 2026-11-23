import {
  FILTER_IN_MAX,
  READ_LIMIT_MAX,
  type CatalogIndex,
  type SignalTransport,
} from "simetra/model"
import type { DefectFlag } from "./defects"
import { fieldInfoOf, filterCollator } from "./filter"
import { keyId, pairId, type Epochs, type PairBarrier } from "./epoch"
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
import { createBatcher } from "./batcher"
import {
  deniesSomePair,
  readAllowed,
  readNarrowed,
  reopenedPairs,
} from "./rights"
import {
  ReadLimiterClosed,
  readKeys,
  requestOf,
  settle,
  tracked,
  type CorePart,
  type CoreReadItem,
  type CoreReadResult,
  type CoreSource,
  type ReadEvent,
  type ReadOrigin,
  type StoreSource,
} from "./source"
import type { ReadCause, ReadIntent, ReadWhy } from "./sync/vocabulary"
import type { ObjectState } from "./forms"
import type { StoreOps } from "./readers"
import {
  REJOIN_JITTER_MS,
  createReceiver,
  type Receiver,
  type SignalRead,
} from "./receiver"
import { createScheduler } from "./scheduler"
import {
  createRegistry,
  requirementPending,
  type Subset,
  type SubsetRegistry,
} from "./subsets"
import {
  activeViews,
  createWriter,
  deniedPairs,
  hasDueViews,
  nextViewDue,
  revalidate,
  revalidateTargets,
  revalidateHolders,
  revalidateHydrated,
  revalidateNarrowed,
  holdersOf,
  invalidateLoads,
  singleFlight,
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
  type RightsState,
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
  /**
   * The seam of the freshness scheduler for the rights block (B5b): reads
   * and early due times in the one scheduler of the core.
   */
  readonly freshness: {
    /**
     * The `now` of the start of the last tick that read something; a tick
     * without targets leaves it. `undefined` before the first one.
     */
    lastTickAt(): number | undefined
    /**
     * Puts the objects' due time at `now + U[0, jitterMs)`; a due time that
     * has come (`jitterMs` 0 included) is read by the merged re-plan of the
     * microtask, without a timer — the calls of one turn make one batch.
     */
    requestReread(
      objects: readonly ObjectName[],
      options: { jitterMs: number }
    ): void
  }
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
   * Starts an `update` with the `await` policy (P4-B spec §7.1): one mutation per key in the journal, one `run`. Throws
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
   * Asks the server for the rights snapshot (P4-B spec §9.3) with the
   * `rightsVersion` the core holds. Single-flight with one tail, as
   * {@link CoreSession.requestVersion}. Does nothing when the client catalog
   * has no `rightsSnapshot`.
   */
  requestRights(): void
  /**
   * Internal: the rights snapshot of the session with its epochs, `undefined`
   * until the first one arrives (or without `rightsSnapshot` in the catalog).
   */
  rights(): RightsState | undefined
  /**
   * Internal, for the runtime: the `serverHash` of a response that passed the
   * closed check. A change against the last seen hash asks for the version —
   * unless the response carried the `version` part itself, which only updates
   * the hash (no ping-pong between instances of two catalogs). A response
   * that carried the `rights` part asks only for the version: its snapshot
   * already comes from the server with the new hash.
   */
  serverHash(
    hash: string,
    parts: { readonly version: boolean; readonly rights: boolean }
  ): void
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
   * requests leave in one microtask.
   */
  endHydration(): void
  /**
   * Internal, for the runtime: stops the signal receiver at once, even
   * inside a `commit` (where `close` is deferred), so it never subscribes
   * on a transport the runtime has closed. Does nothing without a receiver.
   */
  stopSignals(): void
  /** Whether the host shows the application (`resume` sets, `suspend` clears). */
  readonly visible: boolean
  /** Marks the application hidden; idempotent, sends nothing. */
  suspend(): void
  /**
   * Marks the application visible. A call less than `RESUME_COALESCE_MS`
   * after the last accepted one does nothing more. An accepted call asks for
   * the catalog version and re-reads the visible views whose freshness mark is
   * older than `limits.resumeMinIntervalMs` or missing, synchronously.
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
    /** Objects with a due time of a switch re-read or of a discarded answer. */
    scheduledObjects: number
    /** 1 while the scheduler holds its single timer, else 0. */
    schedulerTimers: number
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
  /**
   * Subscribes to the moment right before the pass of a rights snapshot
   * replacement: the model reads the store the pass is about to judge.
   */
  watchRightsPass(listener: () => void): void
  /**
   * Subscribes to the reads the signal receiver starts: a batch acting on an
   * object and a rejoin wave re-reading it. The model judges each by the
   * signals and joins it sent (no request of a purged pair's signal).
   */
  watchSignalReads(
    listener: (object: ObjectName, read: SignalRead) => void
  ): void
  /**
   * Subscribes to the reads the core sends: one event per live part of each
   * server request, with the origin of the read and the request number
   * (`requestOf` of its answer). Any number of listeners; the result
   * unsubscribes. Keys appear only here, never in `log`.
   */
  watchReads(listener: (event: ReadEvent) => void): () => void
  /** The mutations in the journal of own mutations. */
  mutations(): JournalInspection[]
  /** The plans the scheduler made (calls of one turn merge into one). */
  schedulerPlans(): number
  /** The earliest due time the scheduler would plan; `undefined` — no target. */
  schedulerDueAt(): number | undefined
  /** The due time of the objects with a deferred re-read (epoch switch, discarded answer). */
  scheduledDue(): ReadonlyMap<ObjectName, number>
}

const inspections = new WeakMap<CoreSession, CoreInspection>()
const internals = new WeakMap<CoreSession, CoreInternals>()

/** The inspection of a core created by {@link createCore} (tests only). */
export function inspectCore(session: CoreSession): CoreInspection {
  const found = inspections.get(session)
  if (found === undefined) throw new TypeError("not a core session")
  return found
}

/** `resume()` closer than this to the last accepted one does nothing. */
const RESUME_COALESCE_MS = 1_000

// Причини службових читань і рядків, які створює саме ядро (Додаток Б).
const RIGHTS_UNCONFIRMED: ReadCause = {
  reason: "requirement",
  requirement: "rights-unconfirmed",
}
const HYDRATION_TRUST: ReadWhy = {
  reason: "requirement",
  requirement: "hydration-trust",
  site: "R5",
}
const INJECTED_RIGHTS: ReadIntent = {
  ...RIGHTS_UNCONFIRMED,
  target: { kind: "service", service: "rights" },
  site: "S3",
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
  /** The session epochs: the channel registers of the signal receiver (§8.4). */
  readonly epochs: Epochs
  readonly ops: StoreOps
  readonly registry: SubsetRegistry
  /** Write leases on rows of the object not yet settled (§8.4, rule 2). */
  readonly pendingWrites: (object: ObjectName) => number
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
  /**
   * The client catalog has `rightsSnapshot` (1-Р6): only then the core sends
   * the `rights` part; without it nothing about rights is read or applied.
   */
  rightsSnapshot?: boolean
  /**
   * The signal transport of the runtime's subject (P4-B spec §8.5); with
   * `rightsSnapshot` the core creates the signal receiver over it. The
   * runtime owns the transport and closes it; the core only unsubscribes.
   */
  signals?: SignalTransport
  /** Called, outside any `commit`, when a snapshot replaces the current one. */
  onRightsReplaced?: (prev: RightsState | undefined, next: RightsState) => void
  /**
   * Called, outside any `commit` and before any part of the answer is
   * written, when a `rights` answer names another user than the snapshot
   * held (both not `null`): the session changed (plan B5b-2 Р7). The runtime
   * closes itself here; a core left open closes with `session-changed`.
   */
  onSessionChanged?: () => void
  /**
   * Called, outside any `commit`, when the signal transport refused the
   * connection for good (`SignalError.final`). The runtime closes itself
   * here; a core left open closes with `connection-refused`.
   */
  onConnectionRefused?: () => void
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
  let rightsPassListener: (() => void) | undefined
  const readListeners = new Set<(event: ReadEvent) => void>()
  let signalReadListener:
    ((object: ObjectName, read: SignalRead) => void) | undefined
  // Приймач сигналів: створюється після `writerContext`, а реєстр і потік
  // `commit` кличуть його вже з його допомогою.
  let receiver: Receiver | undefined
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
  // Збирач (§6.7) стоїть під цим фільтром: через нього йдуть усі читання, а
  // значення `version` відповіді застосовується до видачі її частин даних.
  const batcher = createBatcher(options.source, {
    // Сон сесії йде в кожне читання джерела: власного таймера джерело не має.
    sleep: session.sleep,
    // Строк знімка (Р2) — від справжньої відправки частини: пакет може
    // чекати вільного слота читань довше за I (§8.4).
    onRightsSent: () => {
      rightsSentAt = now()
    },
    // Слухач — діагностика: його виняток не може зірвати читання (задача
    // обмежувача), тож тут ковтається.
    onRead: (event) => {
      for (const listener of [...readListeners]) {
        try {
          listener(event)
        } catch {
          // Діагностика не змінює поведінки.
        }
      }
    },
    onVersion(version) {
      if (session.token().valid) applyVersion(version.objects)
    },
    onRights: (item) => acceptRights(item),
  })
  // Оренди запису за об'єктами (§8.4, правило 2): запис відпущеного каналу
  // тримається, поки існує оренда на запис рядків його об'єкта. Видає її
  // читання в мить відправки — за частинами (план читання); знімає лише
  // `settle` польоту, що записав відповідь одним `commit` чи відкинув її.
  const pendingWrites = new Map<ObjectName, number>()
  const source: StoreSource = {
    close: () => batcher.close(),
    refuse: (object) => batcher.refuse?.(object),
    run: (operation) => batcher.run(operation),
    lease: () => {
      let held: ObjectName[] | undefined = []
      return {
        issue(objects) {
          // Читання після осідання польоту писало б без оренди.
          if (held === undefined)
            throw new Error("a write lease is issued after its release")
          for (const object of objects) {
            pendingWrites.set(object, (pendingWrites.get(object) ?? 0) + 1)
            held.push(object)
          }
        },
        release() {
          if (held === undefined) return
          for (const object of held) {
            const left = pendingWrites.get(object)! - 1
            if (left > 0) pendingWrites.set(object, left)
            else pendingWrites.delete(object)
          }
          held = undefined
        },
      }
    },
    read: (parts, origin) => {
      const plan = writesOf(parts)
      if (plan.size > 0) {
        // Шлях, що пише рядки без оренди, — дефект: запис каналу забувся б.
        if (origin.lease === undefined)
          return Promise.reject(
            new Error("a read of rows without a write lease")
          )
        origin.lease.issue(plan)
      }
      return dispatch(parts, origin)
    },
  }
  // Об'єкти, рядки яких можуть записати частини читання: об'єкт частини й
  // цілі її `include`.
  const writesOf = (parts: readonly CorePart[]): Set<ObjectName> => {
    const objects = new Set<ObjectName>()
    for (const part of parts) {
      if (part.type !== "query") continue
      const { kind, name } = part.query.object
      const object = `${kind}.${name}` as ObjectName
      objects.add(object)
      const entry = index.byRef.get(object)
      const include = "include" in part.query ? part.query.include : undefined
      for (const attribute of include ?? []) {
        const ref = entry?.attributes.find((a) => a.name === attribute)?.ref
        const target =
          ref === undefined ? undefined : index.byId.get(ref.object)
        if (target !== undefined)
          objects.add(`${target.kind}.${target.name}` as ObjectName)
      }
    }
    return objects
  }
  async function dispatch(
    parts: readonly CorePart[],
    origin: ReadOrigin
  ): Promise<CoreReadResult> {
    const { caller } = origin
    // Старт читання частин виклику: правило першого знімка (Р5а) порівнює
    // його з епохою застосування знімка.
    const startEpoch = session.epochs.now()
    // Частина без об'єкта (`version`) несумісності не має.
    const isLive = (part: (typeof parts)[number]) => {
      if (part.type !== "query") return true
      const { kind, name } = part.query.object
      return !staleObjects.has(`${kind}.${name}`)
    }
    const refused = (part: (typeof parts)[number]): CoreReadItem => {
      return {
        ok: false,
        error: {
          code: "command.stale-client",
          object: (part as Extract<typeof part, { type: "query" }>).query
            .object,
        },
      }
    }
    // Несумісна ціль `include` (§10) не просить `include`: ціль — не об'єкт
    // частини, її мітку звіряємо окремо (Р8, І9); рядки, що вже прийшли,
    // відкидає `applyIncluded` на мить застосування.
    const targetOf = (part: (typeof parts)[number], attribute: string) => {
      if (part.type !== "query") return undefined
      const { kind, name } = part.query.object
      const ref = index.byRef
        .get(`${kind}.${name}`)
        ?.attributes.find((a) => a.name === attribute)?.ref
      const target = ref === undefined ? undefined : index.byId.get(ref.object)
      return target === undefined ? undefined : `${target.kind}.${target.name}`
    }
    const withLiveInclude = (part: (typeof parts)[number]) => {
      if (part.type !== "query" || !("include" in part.query)) return part
      const { include, ...rest } = part.query
      const live = (include ?? []).filter((attribute) => {
        const target = targetOf(part, attribute)
        return target === undefined || !staleObjects.has(target)
      })
      return {
        ...part,
        query: live.length === 0 ? rest : { ...rest, include: live },
      } as typeof part
    }
    const sent = parts.map(isLive)
    const forward = parts.filter((_, slot) => sent[slot]).map(withLiveInclude)
    // Перший пакет рантайму несе `rights` без `known` (Р1); частину
    // додає ядро, тож її результат викликач не бачить.
    const injected =
      rightsEnabled &&
      !rightsFirstSent &&
      !forward.some((part) => part.type === "rights")
    // Походження йде за слотом: частина, яку додало ядро, має свій рядок
    // інвентаря (S3), решта — походження виклику.
    const origins: ReadIntent[] = forward.map(() => origin)
    if (injected) {
      forward.unshift({ type: "rights" })
      origins.unshift(INJECTED_RIGHTS)
    }
    const rightsAt = forward.findIndex((part) => part.type === "rights")
    let answered: { items: CoreReadItem[] } = { items: [] }
    if (rightsAt < 0) {
      if (forward.length > 0) answered = await batcher.read(forward, origins)
    } else {
      // Знімок один за раз: відправка бере `rightsEpoch` і `known` (Р4).
      // `rightsEpoch` лише впорядковує знімки між собою, а частина `rights`
      // летить одна й черга слотів — FIFO, тож епоха постановки дає той
      // самий порядок, що й епоха відправки. Строк (Р2) — інша річ: його
      // рахує `onRightsSent` збирача від справжньої відправки.
      const sentRights = {
        token: session.token(),
        epoch: session.epochs.next(),
        known: rights?.rightsVersion,
      }
      forward[rightsAt] =
        sentRights.known === undefined
          ? { type: "rights" }
          : { type: "rights", known: sentRights.known }
      rightsFirstSent = true
      rightsFlying = true
      rightsSent = sentRights
      try {
        answered = await batcher.read(forward, origins)
      } catch (error) {
        if (sentRights.token.valid) log({ kind: "rights-failed" })
        throw error
      } finally {
        rightsFlying = false
        // Відповідь без заміни знімка нічого не комітить: строк, що повернувся
        // після польоту, планувальнику треба показати самому.
        if (!defects.has("scheduler-no-reschedule")) scheduler.request()
        // Хвіст читає з причиною першого виклику, що його поставив (Р4).
        const tail = rightsTail
        if (tail !== undefined) {
          rightsTail = undefined
          requestRightsFor(tail)
        }
      }
      if (injected) answered = { items: answered.items.slice(1) }
    }
    let next = 0
    const items = parts.map((part, slot): CoreReadItem => {
      if (!sent[slot]) return refused(part)
      const item = answered.items[next++]!
      // Об'єкт став несумісним, поки відповідь летіла: вона вже не діє.
      return isLive(part) ? item : refused(part)
    })
    if (rightsEnabled) noteAnswered(parts, items, startEpoch, caller)
    return { items }
  }

  // Знімок прав сесії (Р1, Р4, Р8): стан і одноразовий запит у польоті.
  const rightsEnabled = options.rightsSnapshot === true
  let rights: RightsState | undefined
  let rightsFirstSent = false
  let rightsFlying = false
  let rightsTail: ReadCause | undefined
  // Мить ВІДПРАВКИ останньої частини `rights` (Р2): від неї рахується строк
  // знімка; поки частина в польоті, строку немає.
  let rightsSentAt: number | undefined
  let rightsSent:
    | { token: GenerationToken; epoch: number; known: string | undefined }
    | undefined
  // Перший знімок сесії (Р5а): епоха застосування й запит, яким він прийшов.
  let firstRights:
    { appliedEpoch: number; request: number | undefined } | undefined
  // Вигляди (і об'єкти читань без вигляду), чиї частини осіли до першого
  // знімка: їх уже не порівняти з ним.
  const beforeFirst = {
    views: new Set<Subset>(),
    objects: new Set<ObjectName>(),
  }
  // Вигляди звужених об'єктів, перечитування яких ще не почалось: один
  // прохід на хід, тож вигляд, що тримає два звужені об'єкти, читається раз.
  const narrowing = new Set<Subset>()

  // Пара (скоуп, об'єкт), якої знімок не дозволяє читати (§6.2 правило 4).
  const deniedBy =
    (snapshot: RightsState["snapshot"]) =>
    (object: ObjectName, scope: string | null): boolean => {
      const entry = objects.get(object)?.entry
      return (
        entry !== undefined &&
        entry.rights !== undefined &&
        !readAllowed(snapshot, { scope }, entry)
      )
    }

  const barrierOf = (state: RightsState): PairBarrier => ({
    appliedEpoch: state.appliedEpoch,
    denies: deniedBy(state.snapshot),
    guards: (object) => {
      const entry = objects.get(object)?.entry
      return entry?.rights !== undefined && entry.scopeColumn !== undefined
    },
  })

  // Частини `query`, що стартували до першого знімка й пішли іншим запитом,
  // ніж частина `rights` (Р5а): їхні рядки могли передувати звуженню
  // всередині дозволеної пари, а знімка, з яким їх порівняти, клієнт не має.
  // Перечитується вигляд, що читав; читання без вигляду (хвіст за ключем) —
  // усі вигляди його об'єкта.
  function noteAnswered(
    parts: readonly CorePart[],
    items: readonly CoreReadItem[],
    startEpoch: number,
    caller: Subset | undefined
  ) {
    const objects = new Set<ObjectName>()
    parts.forEach((part, slot) => {
      const item = items[slot]!
      if (part.type !== "query" || !item.ok) return
      if (
        firstRights !== undefined &&
        (startEpoch >= firstRights.appliedEpoch ||
          requestOf(item) === firstRights.request)
      )
        return
      objects.add(`${part.query.object.kind}.${part.query.object.name}`)
    })
    if (objects.size === 0) return
    if (firstRights === undefined) {
      if (caller !== undefined) beforeFirst.views.add(caller)
      else for (const name of objects) beforeFirst.objects.add(name)
      return
    }
    narrow(
      caller !== undefined
        ? [caller]
        : [...objects].flatMap((name) => holdersOf(writerContext, name)),
      firstRights.appliedEpoch
    )
  }

  // Перечитування виглядів після звуження: перше завантаження, що стартувало
  // до знімка, скасовується одразу (до `commit` його відповіді), а прохід
  // виглядів — один на хід.
  function narrow(views: readonly Subset[], appliedEpoch: number) {
    if (!session.token().valid || views.length === 0) return
    invalidateLoads(views, appliedEpoch)
    if (narrowing.size === 0) {
      queueMicrotask(() => {
        const pending = [...narrowing]
        narrowing.clear()
        revalidateNarrowed(writerContext, pending, {
          reason: "requirement",
          requirement: "access-narrowed",
          site: "R11",
        }).catch(catchNarrow)
      })
    }
    for (const s of views) narrowing.add(s)
  }
  const catchNarrow = (error: unknown) => {
    if (!(error instanceof ReadLimiterClosed))
      log({ kind: "listener-failed", error })
  }

  // Інший користувач у відповіді `rights` — не заміна знімка, а зміна сесії
  // (Р7): поза `commit`, до запису будь-якої частини пакета.
  function rightsSessionChanged() {
    try {
      options.onSessionChanged?.()
    } catch (error) {
      log({ kind: "listener-failed", error })
    }
    if (session.token().valid) core.close("session-changed")
  }

  // Відповідь частини `rights`; її кличе збирач синхронно, до того як хоч
  // один виклик пакета отримав відповідь, тож перевірка користувача (Р7,
  // задача 2) бачить знімок до будь-якого `commit` з частин того ж пакета.
  function acceptRights(item: CoreReadItem) {
    const sentRights = rightsSent
    if (sentRights === undefined || !sentRights.token.valid) return
    if (!item.ok || !("type" in item) || item.type !== "rights") {
      log({ kind: "rights-failed" })
      return
    }
    const { rightsVersion, snapshot } = item.value
    const current = rights
    if (snapshot === undefined) {
      // Без `snapshot` сервер підтвердив `known`: лишається лише зафіксувати
      // `rightsVersion`. Підтвердження без поточного знімка чи з іншою
      // версією — дефект сервера.
      if (
        current === undefined ||
        sentRights.known !== current.rightsVersion ||
        rightsVersion !== current.rightsVersion
      ) {
        log({ kind: "rights-failed" })
        return
      }
      rights = { ...current, rightsVersion }
      return
    }
    // Інший не-`null` користувач — зміна сесії, а не заміна (Р7): що б не
    // несла відповідь, з неї нічого не пишеться.
    if (
      current !== undefined &&
      current.snapshot.userId !== null &&
      snapshot.userId !== null &&
      current.snapshot.userId !== snapshot.userId
    ) {
      rightsSessionChanged()
      return
    }
    // Знімок замінює поточний лише з більшою `rightsEpoch` (Р4). Сьогодні
    // перевірка недосяжна: `requestRights` — один запит у польоті з хвостом,
    // тож старша відповідь не приходить після новішої; вона лишається
    // запобіжником для шляху, що колись надішле дві частини `rights` разом.
    if (current !== undefined && sentRights.epoch <= current.rightsEpoch) return
    const next: RightsState = {
      snapshot,
      rightsVersion,
      rightsEpoch: sentRights.epoch,
      appliedEpoch: session.epochs.next(),
    }
    rights = next
    if (!defects.has("rights-no-barrier"))
      session.epochs.setBarrier(barrierOf(next))
    replaceRights(current, next, item)
    try {
      options.onRightsReplaced?.(current, next)
    } catch (error) {
      log({ kind: "listener-failed", error })
    }
    receiver?.snapshotReplaced()
  }

  // Правило втрати доступу й звуження на заміні знімка (§6.2 правило 4):
  // прохід пар сховища одним `commit`, потім перечитування звужених об'єктів.
  // Перший знімок порівняти нема з чим: звужені — об'єкти частин інших
  // запитів, що стартували до нього (Р5а).
  function replaceRights(
    prev: RightsState | undefined,
    next: RightsState,
    item: CoreReadItem
  ) {
    rightsPassListener?.()
    const denied = deniedBy(next.snapshot)
    const deniedBefore =
      prev === undefined || !defects.has("rights-pass-by-diff")
        ? undefined
        : deniedBy(prev.snapshot)
    const pairs =
      prev === undefined && defects.has("rights-first-no-pass")
        ? []
        : deniedPairs(
            writerContext,
            deniedBefore === undefined
              ? denied
              : (object, scope) =>
                  denied(object, scope) && !deniedBefore(object, scope)
          )
    // Дефект самотесту: прохід прибирає кожну пару об'єкта, що втратив хоч одну.
    const judged = defects.has("rights-pass-purges-allowed")
      ? deniedPairs(writerContext, (object) =>
          pairs.some((p) => p.object === object)
        )
      : pairs
    const denying = [...objects.values()].filter((o) =>
      deniesSomePair(next.snapshot, o.entry)
    )
    // Рядки ТЧ власників з невідомим скоупом (без шапки в сховищі чи з
    // шапкою іншої версії чи епохи версій, ніж ТЧ) не судяться за парою: їх
    // прибирає кожна заміна, чий знімок забороняє хоч одну пару об'єкта, — як
    // прохід прибирає рядки шапки кожної забороненої пари, а не лише щойно
    // втраченої; повертає наступне читання. На причинність сервера (читання
    // після знімка судила RLS) правило не покладається: репліка могла
    // відставати в правах.
    const headerless = denying.flatMap((o) =>
      o.sections
        .owners()
        .filter((owner) =>
          o.entry.tabularSections.some(
            (t) => o.sections.get(owner, t.name)?.scope === "unknown"
          )
        )
        .map((owner) => ({ o, owner }))
    )
    if (judged.length > 0 || headerless.length > 0) {
      session.commit(
        (scope) => {
          try {
            const writer = createWriter(writerContext, scope)
            for (const { object, scope: pair } of judged)
              writer.purge(object, { scope: pair }, { rights: true })
            for (const { o, owner } of headerless) {
              ops.clearOwner(scope, o, owner)
              // Позначка `hide` власника — той самий шлях, що й `hide` прав:
              // вигляд ТЧ без слухача (preload, gcTime) перечитує рядки при
              // монтуванні (`hiddenSinceRead`), а старше за позначку читання
              // ТЧ їх не запише. Ревізія шапки тут не годиться: вона будила б
              // вигляди шапки й не зупиняла б старших відповідей.
              session.epochs.hide(keyId(o.name, owner))
            }
          } finally {
            ops.sweep(scope)
          }
        },
        session.token(),
        "rights"
      )
    }
    if (prev === undefined) {
      firstRights = {
        appliedEpoch: next.appliedEpoch,
        request: requestOf(item),
      }
      narrow(
        [
          ...beforeFirst.views,
          ...[...beforeFirst.objects].flatMap((name) =>
            holdersOf(writerContext, name)
          ),
        ],
        next.appliedEpoch
      )
      beforeFirst.views.clear()
      beforeFirst.objects.clear()
      return
    }
    // Пари, які попередній знімок забороняв, а новий дозволяє: читання,
    // старше за попередній знімок, і далі їх не пише (бар'єр замінено).
    for (const o of objects.values()) {
      const reopened = reopenedPairs(prev.snapshot, next.snapshot, o.entry)
      if (reopened === "all")
        session.epochs.buryObject(o.name, prev.appliedEpoch)
      else
        for (const scope of reopened)
          session.epochs.bury(pairId(o.name, scope), prev.appliedEpoch)
    }
    narrow(
      [...objects.values()]
        .filter((o) => readNarrowed(prev.snapshot, next.snapshot, o.entry))
        .flatMap((o) => holdersOf(writerContext, o.name)),
      next.appliedEpoch
    )
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
      // Перехід у `removed` стирає поля мутації ключа тим самим `commit`.
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
      if (staleObjects.has(o.name)) return undefined
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
      // ТЧ власника без шапки, відкинута бар'єром знімка: читання могло йти
      // тим самим запитом, що й `rights`, тож вигляд читає її ще раз — уже
      // після знімка, тож бар'єр її не судить.
      if (
        result === "rejected" &&
        ownerScope === "unknown" &&
        rights !== undefined &&
        readEpoch < rights.appliedEpoch
      ) {
        barredSections.add(`${o.name}\u0000${owner}`)
        return "barred"
      }
      // Позначені рядки ТЧ перечитує змонтований вигляд: перевірка вигляду
      // читає наново, коли ревізія шапки змінилась.
      if (result === "stale") {
        touchSection(o, owner)
        if (o.rows.get(owner) !== undefined) rowViews.touch(o.name, owner)
      }
      return undefined
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

  // Один збирач фільтрів на рантайм: реєстр і приймач сигналів ділять кеш
  // скомпільованих фільтрів (він ключується за ідентичністю збирача).
  const collator = filterCollator()
  const registry = createRegistry({
    session,
    tabVisible: () => visible,
    source,
    index,
    limits,
    strict: options.strict ?? false,
    filterCollator: collator,
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
    becameVisible: (s) => becameVisible(s),
    readRequirement: (s) => readRequirement(s),
    touchSchedule: () => scheduler.request(),
    touchSubscriptions: () => receiver?.touch(),
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
    const lease = source.lease()
    const read = tracked(source, {
      reason: "requirement",
      requirement: "row-unfinished",
      target: { kind: "keys", object: o.name },
      site: "K3",
      lease,
    })
    readKeys(read.source, o.entry, keys, {
      keysPerRequest: limits.keysPerRequest,
    })
      .then(
        (rows) =>
          settle(lease, () =>
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
          ),
        // Без автоповтору (§6.3): рядок лишається `stale` до наступного читання.
        () => settle(lease, () => {})
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
      const barredNow = [...barredSections]
      barredSections.clear()
      rereadBarred(barredNow)
      const hiddenNow = [...hiddenKeys]
      hiddenKeys.clear()
      for (const [name, keys] of hiddenNow) {
        // Несумісний об'єкт не перечитується: його значення не повертаються.
        if (staleObjects.has(name)) continue
        revalidateHolders(writerContext, name, keys, {
          reason: "requirement",
          requirement: "value-hidden",
          site: "R10",
        }).catch((error: unknown) => log({ kind: "listener-failed", error }))
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
    barredSections.clear()
    rowViews.clear()
    dirtySections.clear()
    dirtyObjects.clear()
    tails.clear()
    purges.clear()
    scheduled.clear()
    wave = undefined
    scheduler.stop()
    staleObjects.clear()
    receiver?.stop()
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
  // ТЧ (`"<object>\u0000<owner>"`), відкинуті бар'єром знімка в цьому `commit`.
  const barredSections = new Set<string>()
  function rereadBarred(barred: readonly string[]) {
    if (barred.length === 0) return
    const wanted = new Set(barred)
    const groups = new Map<ObjectState, Subset[]>()
    for (const s of registry.subsets()) {
      const spec = s.form.spec
      if (spec.kind !== "section" || !s.alive || s.purged) continue
      if (s.listeners.size === 0) continue
      if (!wanted.has(`${s.form.object.name}\u0000${spec.owner}`)) continue
      groups.set(s.form.object, [...(groups.get(s.form.object) ?? []), s])
    }
    for (const [o, views] of groups)
      singleFlight(writerContext, o, views, {
        visibleOnly: false,
        why: {
          reason: "requirement",
          requirement: "target-behind-header",
          site: "R12",
        },
      }).done.catch(catchNarrow)
  }

  // Строки об'єктів у планувальнику (§8.4): перемикання епохи (Р5) і повтор
  // відкинутої відповіді (Р6). Таймера на об'єкт немає: строк виконує такт, а
  // на прихованій вкладці — `resume()`. Два строки одного об'єкта незалежні:
  // перемикання перечитує всі його видимі вигляди, повтор — лише відкинуті.
  // `cause` строку — причина читання, яке він виконає; два строки, що
  // зливаються, лишають причину першого (черга пам'ятає, хто її поставив).
  const scheduled = new Map<
    ObjectName,
    {
      whole?: { at: number; cause: ReadCause }
      retry?: { at: number; cause: ReadCause; views: Set<Subset> }
    }
  >()
  function schedule(
    object: ObjectName,
    delayMs: number,
    cause: ReadCause,
    views?: ReadonlySet<Subset>
  ) {
    // Несумісний об'єкт не читається (§10): строк йому не ставимо.
    if (staleObjects.has(object)) return
    const at = now() + delayMs
    const held = scheduled.get(object) ?? {}
    scheduled.set(object, held)
    if (views === undefined) {
      // Строк, що зливається, лишає причину першого.
      if (held.whole === undefined) held.whole = { at, cause }
      else held.whole.at = Math.min(held.whole.at, at)
    } else if (held.retry === undefined)
      held.retry = { at, cause, views: new Set(views) }
    else {
      held.retry.at = Math.min(held.retry.at, at)
      for (const s of views) held.retry.views.add(s)
    }
    scheduler.request()
  }

  // Хвиля приєднання (§8.4, Р10): об'єкти каналів, що (пере)підписались,
  // перечитуються разом, з одним строком на хвилю — рестарт Centrifugo не дає
  // шквалу. Хвиля лише планує: свіжість після розриву доводять епохи
  // (`Epochs.channelProven`) у мить застосування відповіді, а не хвиля.
  // Строк хвилі — доданок `schedulerDue`, тож власного таймера немає: на
  // прихованій вкладці хвилю бере `resume()`.
  let wave: { at: number; readonly objects: Set<ObjectName> } | undefined
  let lastWaveAt: number | undefined
  function joinWave(object: ObjectName) {
    if (!session.token().valid || staleObjects.has(object)) return
    if (wave === undefined) {
      const at = Math.floor(Math.random() * REJOIN_JITTER_MS) + now()
      wave = {
        // Нова хвиля не раніше ніж через вікно після попередньої: флапання
        // не дає запитів частіше.
        at:
          lastWaveAt === undefined
            ? at
            : Math.max(at, lastWaveAt + REJOIN_JITTER_MS),
        objects: new Set(),
      }
    }
    wave.objects.add(object)
    scheduler.request()
  }

  // Спрацювання хвилі — один синхронний хід (збирач зливає читання в один
  // пакет). Позначок хвиля не знімає: їх знімає застосована відповідь.
  // Кожному вигляду об'єкта — видимому й невидимому — вимога «склад не
  // підтверджено з миті спрацювання» (§8.4, п. 7); видимість вирішує лише,
  // коли читати: видимий — зараз, невидимий — на переході у видимість.
  // Шлях, що читання не зробив (хвіст вигляду, який тим часом сховали), її
  // просто не знімає.
  function fireWave() {
    const fired = wave
    wave = undefined
    if (fired === undefined || !session.token().valid) return
    const token = session.token()
    lastWaveAt = now()
    // Наступна епоха: читання хвилі стартують з неї, а ті, що вже в польоті, —
    // раніше, тож вимоги не знімуть.
    const since = session.epochs.next()
    core.requestVersion()
    core.requestRights()
    const marked: ObjectName[] = []
    let reads = 0
    let readViews = 0
    for (const object of fired.objects) {
      if (staleObjects.has(object)) continue
      const views = activeViews(writerContext, object)
      marked.push(object)
      if (views.some((v) => v.visible)) {
        readViews += views.filter((v) => v.visible).length
        reads++
        signalReadListener?.(object, {
          by: "wave",
          views: revalidateTargets(writerContext, object, {
            visibleOnly: true,
          }),
        })
        revalidate(writerContext, object, {
          visibleOnly: true,
          why: {
            reason: "requirement",
            requirement: "channel-rejoin",
            site: "R4",
          },
        }).catch((error: unknown) => log({ kind: "listener-failed", error }))
      }
    }
    // Сплеск (Р13): хвиля, що справді перечитує; без читань запису немає.
    if (reads > 0)
      log({
        kind: "revalidate-burst",
        objects: reads,
        views: readViews,
      })
    if (marked.length > 0)
      core.commit((w) => {
        for (const object of marked)
          w.markViews(object, { unconfirmedSince: since })
      }, token)
  }

  // Рантайм чи ядро закривається, коли транспорт відмовив назавжди (`final`).
  function connectionRefused() {
    try {
      options.onConnectionRefused?.()
    } catch (error) {
      log({ kind: "listener-failed", error })
    }
    if (session.token().valid) core.close("connection-refused")
  }

  // Бере строки, що настали, й перечитує їх зараз (тільки на видимій вкладці:
  // кличуть такт і `resume()`). Істина — чи було читання.
  function runDue(): boolean {
    let ran = false
    dropDeferredWhenUnavailable()
    const catchLog = (error: unknown) => log({ kind: "listener-failed", error })
    for (const [name, held] of [...scheduled]) {
      if (held.whole !== undefined && held.whole.at <= now()) {
        const { cause } = held.whole
        held.whole = undefined
        // Строк об'єкта без видимих виглядів нічого не читає: такту з читанням
        // він не робить.
        // `lastTickAt` — лише коли такт справді послав читання (§8.4).
        if (hasDueViews(writerContext, name)) ran = true
        revalidate(writerContext, name, {
          visibleOnly: true,
          why: { ...cause, site: "R1" },
        }).catch(catchLog)
      }
      if (held.retry !== undefined && held.retry.at <= now()) {
        const views = [...held.retry.views].filter((s) => s.alive && !s.purged)
        const cause = held.retry.cause
        held.retry = undefined
        // Повтор іде тим самим single-flight шляхом, що й явний `revalidate`.
        const flight = singleFlight(writerContext, objectOf(name), views, {
          visibleOnly: false,
          why: { ...cause, site: "R3" },
        })
        if (flight.started > 0) ran = true
        flight.done.catch(catchLog)
      }
      if (held.whole === undefined && held.retry === undefined)
        scheduled.delete(name)
    }
    return ran
  }

  // Перемикання епохи: кожен рядок уже `stale` (сховища позначили), а
  // видимі вигляди перечитуються з розкидом — рестарт primary перемикає
  // всіх клієнтів одночасно, і миттєве перечитування було б шквалом.
  session.onSwitch(() => {
    for (const o of objects.values()) {
      for (const key of o.rows.keys()) rowViews.touch(o.name, key)
      // Несумісний об'єкт не перечитується (§10): його вигляди лишаються в
      // стані `isStale`, а не переходять в `error`.
      if (staleObjects.has(o.name)) continue
      if (scheduled.get(o.name)?.whole !== undefined) continue
      if (!activeViews(writerContext, o.name).some((v) => v.visible)) continue
      schedule(
        o.name,
        Math.floor(Math.random() * limits.revalidateIntervalMs),
        { reason: "requirement", requirement: "version-epoch-switched" }
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
        // `removed` не лишає недовірених значень; слот `hidden` (без значень)
        // лишається: лише читання після гідратації знімає позначку.
        if (
          e !== undefined &&
          e.removed === undefined &&
          e.writtenEpoch < hydrationEpoch
        )
          return true
      }
      return false
    }
    if (stale(s.form.object, s.owned)) return true
    for (const [name, keys] of s.included)
      if (stale(objectOf(name), keys)) return true
    return false
  }

  // Вигляд став видимим: читається, якщо тримає рядки лише з гідратації чи
  // його склад не підтверджено (`unconfirmedSince`, §8.4, п. 7) — читання, як
  // на монтуванні; вимогу знімає лише його успіх. `needsRefresh` банера нових
  // рядків лишається за `refresh()`.
  function becameVisible(s: Subset) {
    readHydrated(s)
    readRequirement(s)
  }

  // Знімок виводить `needsRefresh` з вимоги й видимості вкладки (§8.4,
  // п. 7): перехід вкладки його змінює й без запису.
  function touchRequirements() {
    for (const s of registry.subsets())
      if (s.unconfirmedSince !== undefined) s.dirty = true
  }

  const requirementEnv = {
    versions: session.versions,
    tabVisible: () => visible,
  }

  // Одна умова з точками осідання (§8.4, п. 7): вимога стоїть, вигляд видимий
  // на видимій вкладці, і її ніхто інший не прочитає — ні читання з епохи
  // вимоги в польоті чи в черзі, ні пауза збоїв, ні межа відкинутих.
  function readRequirement(s: Subset) {
    if (!s.alive || s.purged || !s.loaded) return
    if (staleObjects.has(s.form.object.name)) return
    if (!requirementPending(s, requirementEnv)) return
    singleFlight(writerContext, s.form.object, [s], {
      visibleOnly: false,
      why: {
        reason: "requirement",
        requirement: "composition-unconfirmed",
        site: "R13",
      },
    }).done.catch((error: unknown) => log({ kind: "listener-failed", error }))
  }

  function readHydrated(s: Subset) {
    if (hydration !== "ended") return
    if (defects.has("late-hydrated-not-reread")) return
    if (staleObjects.has(s.form.object.name)) return
    if (!(s.visible ?? s.listeners.size > 0)) return
    if (defects.has("hydrated-row-not-reread") && !heldBySnapshot.has(s)) return
    if (!overHydratedRows(s)) return
    // Читання, що стартувало після гідратації, уже в польоті (звірка чи `revalidate`):
    // його відповідь зробить рядки довіреними; власне завантаження ловить
    // `revalidateHydrated` (`flight`).
    if (s.rereadEpochs.some((at) => at >= hydrationEpoch)) return
    revalidateHydrated(writerContext, s, {
      reason: "requirement",
      requirement: "hydration-trust",
      site: "R14",
    }).catch((error: unknown) => log({ kind: "listener-failed", error }))
  }

  // Сесія вичерпала межу відкинутих: кожна відповідь до нової сесії
  // відкидається, тож відкладені строки (перемикання епохи, повтор відкинутої
  // відповіді) були б читаннями без шансу й без паузи.
  // Запит скидає `scheduled`: після межі відкинутих жодне відкладене читання
  // не має виконатися (§6.2).
  function dropDeferredWhenUnavailable() {
    if (!session.versions.unavailable()) return
    scheduled.clear()
    wave = undefined
  }

  function schedulerDue(): number | undefined {
    let due: number | undefined
    dropDeferredWhenUnavailable()
    // Після межі відкинутих планувальник нічого не читає до нової сесії (§6.2).
    if (
      session.versions.unavailable() &&
      !defects.has("scheduler-reads-unavailable")
    )
      return undefined
    for (const held of scheduled.values()) {
      for (const at of [held.whole?.at, held.retry?.at])
        if (at !== undefined && (due === undefined || at < due)) due = at
    }
    for (const o of objects.values()) {
      if (staleObjects.has(o.name)) continue
      const at = nextViewDue(writerContext, o.name)
      if (at !== undefined && (due === undefined || at < due)) due = at
    }
    const rightsAt = rightsDueAt()
    if (rightsAt !== undefined && (due === undefined || rightsAt < due))
      due = rightsAt
    if (wave !== undefined && (due === undefined || wave.at < due))
      due = wave.at
    return due
  }

  // Строк знімка прав (Р2): `rightsAt + I` лише на видимій вкладці, коли
  // частина не летить (інакше прострочений строк давав би такти з таймером
  // 0 мс) і сховище не порожнє.
  function rightsDueAt(): number | undefined {
    if (!rightsEnabled || !visible || rightsFlying) return undefined
    if (rightsSentAt === undefined) return undefined
    if (![...objects.values()].some((o) => o.rows.size > 0)) return undefined
    return rightsSentAt + limits.revalidateIntervalMs
  }
  let lastTickAt: number | undefined
  // Один таймер на ядро (§6.7). Такт — звірка з вікном `0,1 × I`, але без
  // частини `version`: версію каталогу звіряють гідратація, `resume()` і
  // `serverHash` (Р8).
  const scheduler = createScheduler({
    now,
    visible: () => visible,
    closed: () => closed !== undefined || !session.token().valid,
    dueAt: schedulerDue,
    tick() {
      if (
        session.versions.unavailable() &&
        !defects.has("scheduler-reads-unavailable")
      ) {
        scheduled.clear()
        return
      }
      const minAgeMs = 0.9 * limits.revalidateIntervalMs
      // Такт без цілей `lastTickAt` не рухає (шов B5b, Р10).
      let read = false
      for (const o of objects.values())
        if (
          !staleObjects.has(o.name) &&
          hasDueViews(writerContext, o.name, minAgeMs)
        )
          read = true
      if (runDue()) read = true
      if (wave !== undefined && wave.at <= now()) fireWave()
      receiver?.tick()
      if (read) lastTickAt = now()
      // Знімок має власний строк; без видимих виглядів пакет несе лише його.
      const rightsAt = rightsDueAt()
      reconcile(
        { reason: "interval", site: "R2" },
        { minAgeMs },
        undefined,
        // Строк знімка бере те саме вікно `0,1 × I`, що й вигляди: інакше
        // `refreshedAt` виду трохи раніший за `rightsSentAt` розколов би такт.
        rightsAt !== undefined &&
          rightsAt <= now() + 0.1 * limits.revalidateIntervalMs
          ? ["rights"]
          : [],
        { reason: "interval" }
      )
    },
    defects,
  })
  // Кожен `commit` (осідання читання, запис, звільнення, purge) міг змінити
  // набір цілей чи строк: перепланування зливається в одне на мікрозадачу.
  session.onFlush(() => {
    if (!defects.has("scheduler-no-reschedule")) scheduler.request()
  })

  const writerContext: WriterContext = {
    session,
    readRequirement: (s) => readRequirement(s),
    tabVisible: () => visible,
    source,
    limits,
    strict: options.strict ?? false,
    log,
    ops,
    objectOf,
    registry,
    rowViews,
    isStale: (object) => staleObjects.has(object),
    objects,
    purges,
    invalidateTail,
    onPurge: (object, target) => receiver?.purged(object, target),
    defects,
    now,
    hiddenKeys,
    pendingWrites: (object) => pendingWrites.get(object) ?? 0,
    schedule,
    journal: {
      erase: (object, key) => overlay.erase(object, key),
      eraseScope: (object, scope) => overlay.eraseScope(object, scope),
    },
  }

  if (options.signals !== undefined && rightsEnabled) {
    receiver = createReceiver({
      transport: options.signals,
      index,
      writer: writerContext,
      rights: () => rights,
      visible: () => visible,
      commit: (fn, token) => core.commit(fn, token),
      filterCollator: collator,
      joinWave,
      requestVersion: () => core.requestVersion(),
      connectionRefused,
      signalReads: () => signalReadListener,
    })
    // Кожен `commit` міг змінити активні вигляди чи скоупи їхніх рядків.
    session.onFlush(() => receiver?.touch())
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
    // Строк перемикання епохи не перечитає несумісний об'єкт: `revalidate` у
    // ньому перевів би вигляди в `error` замість `isStale`.
    scheduled.delete(o.name)
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

  // Один запит `version` за раз і не більше одного хвоста: частина, що ще
  // стоїть у черзі збирача, зливає виклики (вона вийде з наступним пакетом),
  // під час польоту — один хвіст.
  let versionFlying = false
  let versionTail = false
  function startVersion() {
    versionFlying = true
    const token = session.token()
    source
      .read([{ type: "version" }], {
        reason: "requirement",
        requirement: "version-unconfirmed",
        target: { kind: "service", service: "version" },
        site: "S1",
      })
      .then(
        () => {
          // Значення застосував збирач синхронно з відповіддю (бар'єр Р3).
        },
        (error: unknown) => {
          if (token.valid) log({ kind: "listener-failed", error })
        }
      )
      .finally(() => {
        versionFlying = false
        if (!versionTail) return
        versionTail = false
        core.requestVersion()
      })
  }

  type ServicePart = "version" | "rights"

  // `cause` — чому знімок потрібен: вимога чи строк такту (рядок S2).
  function requestRightsFor(cause: ReadCause) {
    if (!rightsEnabled || !session.token().valid) return
    if (!rightsFlying) {
      // Збій частини вже в журналі (`rights-failed`) — повтору немає (Р8).
      source
        .read([{ type: "rights" }], {
          ...cause,
          target: { kind: "service", service: "rights" },
          site: "S2",
        })
        .catch(() => {})
    } else if (!batcher.hasQueuedRights()) rightsTail ??= cause
  }

  // Звірка (§6.7): версія каталогу й перечитування видимих виглядів живих
  // об'єктів. Усе синхронно, без `await` між об'єктами, тож збирач пакета
  // читань зливає їх в один запит. Її кличуть `endHydration` і `resume`.
  function reconcile(
    why: ReadWhy,
    reconcileOptions: { minAgeMs?: number } = {},
    snapshotViews?: ReadonlySet<Subset>,
    // Склад службових частин (Р2): `endHydration` і `resume()` шлють
    // `version` і `rights`, такт — `rights`, коли настав строк знімка.
    services: readonly ServicePart[] = ["version", "rights"],
    rightsCause: ReadCause = RIGHTS_UNCONFIRMED
  ) {
    if (services.includes("version")) core.requestVersion()
    if (services.includes("rights")) requestRightsFor(rightsCause)
    for (const o of objects.values()) {
      // Несумісний об'єкт не читається (§10): перечитування перевело б його
      // вигляди в `error` замість показати `isStale`.
      if (staleObjects.has(o.name)) continue
      if (
        !activeViews(writerContext, o.name).some((v) => v.visible) &&
        !(snapshotViews !== undefined && holdsAny(o, snapshotViews))
      )
        continue
      revalidate(writerContext, o.name, {
        visibleOnly: true,
        why,
        ...(snapshotViews === undefined ? {} : { alsoViews: snapshotViews }),
        ...reconcileOptions,
      }).catch((error: unknown) => log({ kind: "listener-failed", error }))
    }
  }

  const holdsAny = (o: ObjectState, views: ReadonlySet<Subset>) =>
    [...views].some((s) => s.form.object === o)

  const core: CoreSession = {
    subject: options.subject,
    freshness: {
      lastTickAt: () => lastTickAt,
      requestReread(names, { jitterMs }) {
        if (!session.token().valid) return
        for (const name of names)
          schedule(name, Math.floor(Math.random() * jitterMs), {
            reason: "requirement",
            requirement: "composition-unconfirmed",
          })
      },
    },
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
      if (!versionFlying) startVersion()
      else if (!batcher.hasQueuedVersion()) versionTail = true
    },
    requestRights: () => requestRightsFor(RIGHTS_UNCONFIRMED),
    rights: () => rights,
    serverHash(hash, parts) {
      const changed = lastHash !== undefined && hash !== lastHash
      lastHash = hash
      // Знімок прав слідує за `version` (Р9): одна мікрозадача — один запит, а
      // відповідь з частиною `version` нового запиту не запускає нічого (§10),
      // тож два хеші, що чергуються, не дають пінг-понгу. Знімок відповіді з
      // частиною `rights` уже від нового сервера: другий запит `rights` за
      // ним (хвіст частини в польоті) був би зайвим.
      if (changed && !parts.version) {
        core.requestVersion()
        if (!parts.rights) core.requestRights()
      }
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
      // Вигляди знімка — те, що показав SSR: звірка читає їх усі, зокрема ті,
      // на які ще ніхто не підписався, одним пакетом з `version`. Вигляд, на
      // який ніхто не підпишеться, звільняється як і раніше: читання
      // утримання не продовжує.
      const fromSnapshot = new Set(
        [...registry.subsets()].filter((s) => s.hydrated)
      )
      registry.endHydration()
      if (defects.has("hydrate-without-revalidate")) core.requestVersion()
      // Дефекти самотесту дають колишню звірку лише видимих: без них довіра до
      // рядків знімка тримається на пізньому читанні, яке вони вимикають.
      else if (
        defects.has("late-hydrated-not-reread") ||
        defects.has("hydrated-row-not-reread")
      )
        reconcile(HYDRATION_TRUST)
      else reconcile(HYDRATION_TRUST, {}, fromSnapshot)
    },
    get visible() {
      return visible
    },
    stopSignals: () => receiver?.stop(),
    suspend() {
      visible = false
      touchRequirements()
      scheduler.suspend()
    },
    resume() {
      visible = true
      touchRequirements()
      scheduler.request()
      if (!session.token().valid) return
      // Строки, що настали на прихованій вкладці (перемикання епохи, повтор
      // відкинутої відповіді), беруться незалежно від `minAgeMs`: їхні рядки
      // вже `stale`, а свіжість тут не міра.
      runDue()
      // Хвиля, що чекала на прихованій вкладці, іде першою: звірка нижче вигляд
      // у польоті не бере. Вікно `REJOIN_JITTER_MS` після попередньої хвилі тут не
      // діє: воно береже від шквалу подій, а `resume()` — одна подія вкладки.
      fireWave()
      // Вимога, що лишилась на прихованій вкладці (`needsRefresh` замість
      // повтору, §8.4, п. 7), — читання на `resume()`, після строків і хвилі:
      // вигляд, який вони вже читають з епохи вимоги, вдруге не читається.
      for (const s of registry.subsets()) readRequirement(s)
      // Злиття: подвійний сигнал повернення (focus + visibilitychange) — одна
      // звірка; відлік іде від останнього прийнятого, а не від кожного виклику.
      const at = now()
      if (lastResumeAt !== undefined && at - lastResumeAt < RESUME_COALESCE_MS)
        return
      lastResumeAt = at
      reconcile(
        { reason: "interval", site: "R6" },
        { minAgeMs: limits.resumeMinIntervalMs }
      )
    },
    update: (object, key, values, updateOptions) =>
      overlay.update(object, key, values, updateOptions),
    activeViews: (object) => activeViews(writerContext, object),
    setVisible(spec, visible) {
      setVisible(writerContext, spec, visible)
      scheduler.request()
      if (!visible) return
      const s = registry.find(spec)
      if (s !== undefined) becameVisible(s)
    },
    revalidate: (object, revalidateOptions) =>
      revalidate(writerContext, object, {
        ...revalidateOptions,
        why: { reason: "user", site: "R7" },
      }),
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

  internals.set(core, {
    objects,
    ops,
    registry,
    epochs: session.epochs,
    pendingWrites: writerContext.pendingWrites,
  })

  inspections.set(core, {
    defects,
    watchRemarks(listener) {
      remarkListener = listener
    },
    watchRightsPass(listener) {
      rightsPassListener = listener
    },
    watchSignalReads(listener) {
      signalReadListener = listener
    },
    watchReads(listener) {
      readListeners.add(listener)
      return () => {
        readListeners.delete(listener)
      }
    },
    mutations: () => overlay.entries(),
    schedulerPlans: () => scheduler.plans(),
    schedulerDueAt: schedulerDue,
    scheduledDue: () =>
      new Map(
        [...scheduled].flatMap(([name, held]) => {
          const at = Math.min(
            held.whole?.at ?? Number.POSITIVE_INFINITY,
            held.retry?.at ?? Number.POSITIVE_INFINITY
          )
          return Number.isFinite(at) ? [[name, at] as const] : []
        })
      ),
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
        scheduledObjects: scheduled.size,
        schedulerTimers: scheduler.timers(),
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
        // якому показано список, без повторів і порожніх сторінок (спека П4-B §6.4).
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
