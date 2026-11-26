import {
  CommandFailure,
  FILTER_IN_MAX,
  LIMIT_REASONS,
  READ_BATCH_MAX,
  READ_LIMIT_MAX,
  WireDecodeError,
  changesFromWire,
  decodeRow,
  errorFromWire,
  operationToWire,
  readPartToWire,
  readResultFromWire,
  rightsValueSchema,
  versionValueSchema,
  wireRunResultSchema,
  type CatalogEntry,
  type CatalogIndex,
  type Change,
  type CommandError,
  type KnownMarker,
  type KnownVersions,
  type MetadataRef,
  type Operation,
  type ReadQuery,
  type ReadRows,
  type RightsValue,
  type SourceAdapter,
  type VersionValue,
  type WireOperation,
  type WireQueryPart,
  type WireReadPart,
  type WireReadParts,
} from "simetra/model"
import { DataError } from "../errors"
import { effectiveEpoch } from "./epoch"
import {
  recordOf,
  type Flight,
  type Gate,
  type ReadRecord,
} from "./sync/flight"
import type { Key, KnownSnapshot, ObjectName, ServerRow } from "./types"

// Причини `command.unavailable` частини, яку сервер не виконав (П4-B §4.5).
const BATCH_ABORTED = "batch-aborted"
const BATCH_BUDGET = "batch-budget"

/** A logical read the core sends: every form but the counts. */
export type RowsQuery = Exclude<ReadQuery, { count: true }>

/**
 * The refusal of a read the limiter never started: it was queued or asked
 * for after {@link ReadLimiter.close}. The core ignores it — its session is
 * already closed.
 */
export class ReadLimiterClosed extends Error {
  constructor() {
    super("read limiter is closed")
    this.name = "ReadLimiterClosed"
  }
}

/**
 * Bounds the reads in flight (P4-B spec §8.4): at most `parallel` tasks run
 * at once, the rest wait in FIFO order; a settled task — resolved or
 * rejected — frees its slot.
 */
export interface ReadLimiter {
  /**
   * Runs `task` when a slot is free. Not reentrant: a task must not await
   * another `run` of the same limiter, or a full limiter deadlocks.
   */
  run<T>(task: () => Promise<T>): Promise<T>
  /**
   * Closes the limiter (session close, `dispose()`): queued tasks never
   * start and reject with {@link ReadLimiterClosed}, as does every later
   * `run`; tasks in flight finish normally.
   */
  close(): void
}

/** Creates a {@link ReadLimiter} of `parallel` slots shared by every read. */
export function createReadLimiter(parallel: number): ReadLimiter {
  if (!Number.isSafeInteger(parallel) || parallel < 1) {
    throw new RangeError("readParallel must be a positive integer")
  }
  let active = 0
  let closed = false
  const queue: { start: () => void; refuse: () => void }[] = []
  const release = () => {
    active--
    queue.shift()?.start()
  }
  return {
    close() {
      closed = true
      // Після закриття жодного нового запиту: черга відмовляє, не стартуючи.
      for (const waiting of queue.splice(0)) waiting.refuse()
    },
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (closed) {
          reject(new ReadLimiterClosed())
          return
        }
        const start = () => {
          active++
          // Синхронний кидок задачі — теж відмова: слот звільняється так само.
          let promise: Promise<T>
          try {
            promise = task()
          } catch (error) {
            promise = Promise.reject(error)
          }
          promise.then(resolve, reject).finally(release)
        }
        if (active < parallel) start()
        else
          queue.push({ start, refuse: () => reject(new ReadLimiterClosed()) })
      })
    },
  }
}

/**
 * A part of a core read (P4-B spec §6.7): a rows query, with the rows the
 * core already holds (`known`), the catalog `version` or the rights snapshot
 * (`known` — the `rightsVersion` the core holds). A part without an object
 * goes first in its request.
 */
export type CorePart =
  | { type: "query"; query: RowsQuery; known?: KnownVersions }
  | { type: "version" }
  | { type: "rights"; known?: string }

/** The outcome of one read part, in the order of the parts asked for. */
export type CoreReadItem =
  | CoreRowsItem
  | { ok: true; type: "version"; version: VersionValue }
  | { ok: true; type: "rights"; value: RightsValue }

// Запит до сервера, яким прийшла відповідь частини: правило першого знімка
// (Р5а) відрізняє частини запиту `rights` від частин інших запитів пакета.
// Окрема мапа, а не поле відповіді: форма відповіді частини не змінюється.
const requestOfItem = new WeakMap<CoreReadItem, number>()

/**
 * The server request (a number per source, in the order of sending) that
 * answered the item; `undefined` — the item was not answered by a request
 * (a refusal of the source, a part the core answered itself).
 */
export const requestOf = (item: CoreReadItem): number | undefined =>
  requestOfItem.get(item)

/** The outcome of a rows part: the result of a `query` part is never a version. */
export type CoreRowsItem =
  | { ok: true; rows: ReadRows; epoch: string | null }
  | { ok: false; error: CommandError }

/** The outcomes of {@link CoreSource.read}: one item per part. */
export interface CoreReadResult {
  items: CoreReadItem[]
}

/**
 * What the core sends past the source adapters (P4-B spec §5.1): a write and
 * the catalog version go only through the data transport, whichever adapter
 * reads the object. Rejects with `CommandFailure` when the whole request is
 * refused.
 */
export interface ServerPort {
  /** Sends one `run` request of one operation; resolves with the raw value. */
  run(request: {
    operation: WireOperation
    kernels: Record<string, string>
  }): Promise<unknown>
  /**
   * Sends one `read` request through the Server Function: the parts of the
   * objects it serves and the parts without an object. The adapter of those
   * objects is the one whose `read` is this very function (see
   * `serverFunctionAdapter`), so their parts and `version` share a request.
   */
  read(items: readonly WireReadPart[]): Promise<WireReadParts>
}

/**
 * The outcome of {@link CoreSource.run}: per operation its confirmed row, or
 * `undefined` when the answer carries none (over the response budget), the
 * change set and the row version epoch of the command transaction.
 */
export type CoreRunResult =
  | {
      ok: true
      rows: (ServerRow | undefined)[]
      changes: Change[]
      epoch: string
    }
  | { ok: false; error: CommandError }

/** What the core passes to every {@link CoreSource.read}. */
export interface ReadOptions {
  /** `Session.sleep`: wakes at once when the session closes. */
  readonly sleep: (ms: number) => Promise<void>
  /**
   * Called when a request carrying the `rights` part actually goes out: a
   * read slot was free (P4-B spec §8.4, the deadline counts from sending).
   */
  readonly onRightsSent?: () => void
  /**
   * The flight of each part by slot (the length of the `parts` of the call);
   * `undefined` in a slot — a part without a flight, which gives no event.
   * Flights follow the slot, not the identity of the part: the core copies
   * parts (`include` cut, `known` set) and the copy keeps its slot.
   */
  readonly origins?: readonly (Flight | undefined)[]
  /**
   * Called when a read request gets its number, once per live part of the
   * request, before the request goes out (the `watchReads` event).
   */
  readonly onRead?: (event: ReadEvent) => void
  /**
   * Whether a flight belongs to the gate of the session this source serves; an
   * event is made only for such a flight. Without it (a source called
   * directly by a test) every flight with a registry record gives an event.
   */
  readonly ownFlight?: (flight: Flight) => boolean
  /**
   * The late refusal of the gate (`stale-object`, P4-B spec §10): asked for
   * each part at the start of its limiter task, after grouping. A part of an
   * object it names goes out as `command.stale-client` without a request.
   * Without it (a source called directly by a test) no part is refused.
   */
  readonly staleObject?: (object: ObjectName) => boolean
}

/**
 * The event of one live part of one server request: the origin of the read
 * and the number of the request, the same that {@link requestOf} returns for
 * the answer of the part. Neither the `caller` nor the `lease` of the flight
 * goes into it: they are the core's, not a diagnostic.
 */
export type ReadEvent = ReadRecord & { readonly request: number }

// Причину, ціль і код беремо із запису шлюзу за тотожністю польоту, а не з
// його полів (Р-SK1-11): політ, якого шлюз не видавав, події не дає.
const readEvent = (flight: Flight, request: number): ReadEvent | undefined => {
  const record = recordOf(flight)
  if (record === undefined) return undefined
  return record.reason === "requirement"
    ? {
        reason: record.reason,
        requirement: record.requirement,
        target: record.target,
        site: record.site,
        ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
        request,
      }
    : {
        reason: record.reason,
        target: record.target,
        site: record.site,
        ...(record.attempt === undefined ? {} : { attempt: record.attempt }),
        request,
      }
}

/**
 * The source the store modules read through: a {@link CoreSource} whose
 * `read` already carries the session's {@link ReadOptions} (the core binds
 * them in one place).
 */
export interface StoreSource extends Omit<CoreSource, "read"> {
  read(parts: readonly CorePart[], flight: Flight): Promise<CoreReadResult>
  /** The admission gate of the session: every flight of a read comes from it. */
  readonly admit: Gate["admit"]
  /** The settle consequence past the discard limit, asked of the gate. */
  readonly settledPastBound: Gate["settledPastBound"]
  /** A new write lease for one flight; only the settle pass releases it. */
  lease(): WriteLease
}

/**
 * A {@link StoreSource} with one flight bound in: the readers read through
 * it (reads inside a flight continue the flight, so they take the flight of
 * the row that started it, Appendix Б «Спільне», п. 3). A source without a
 * flight is not a `BoundSource`, so a reader cannot be handed one.
 */
export interface BoundSource extends Omit<StoreSource, "read"> {
  read(parts: readonly CorePart[]): Promise<CoreReadResult>
}

/** Binds `flight` into `source`: every read of the result carries it. */
export function bound(source: StoreSource, flight: Flight): BoundSource {
  return {
    close: () => source.close(),
    run: (operation) => source.run(operation),
    admit: source.admit,
    settledPastBound: source.settledPastBound,
    lease: () => source.lease(),
    read: (parts) => source.read(parts, flight),
  }
}

/**
 * The write lease of one flight (P4-B spec §8.4, rule 2): the source issues
 * it at dispatch, by the parts of each read, for every object whose rows the
 * answer may write; the entry of a released channel of such an object is
 * kept while the lease exists. Released once, by the settle pass
 * (`sync/settle-pass.ts`, step 9).
 */
export interface WriteLease {
  issue(objects: ReadonlySet<ObjectName>): void
  release(): void
}

/**
 * The core's source over the per-object source adapters and the server
 * port: maps logical queries and operations to the wire form, groups reads
 * into requests per adapter, reads through the shared limiter and decodes the
 * answers back to logical names.
 */
export interface CoreSource {
  /**
   * Reads parts: parts of one adapter go in requests of at most
   * `READ_BATCH_MAX` parts, a request takes one limiter slot. The epoch is
   * the answer's, per part. A failed part is its own `ok: false` item, as is
   * every part of a request the adapter rejected with `CommandFailure`. A
   * `version` part goes in the request of the Server Function, first; an
   * answer of the wrong form is `command.internal`. The pause between the
   * re-sends sleeps through `options.sleep` — the session's (B5c, Р13): the
   * source has no timer of its own, so a closed session leaves none.
   */
  read(
    parts: readonly CorePart[],
    options: ReadOptions
  ): Promise<CoreReadResult>
  /**
   * Runs one operation through the server port with the kernel hash of its
   * object, outside the read limiter. A value the mapping cannot encode is
   * `command.invalid` with its logical `path` and never reaches the port; a
   * name outside the catalog throws `TypeError` (a defect of the caller). An
   * answer of the wrong form — the epoch missing or `null` included — is
   * `command.internal`; a refused request is its error.
   */
  run(operation: Operation): Promise<CoreRunResult>
  /**
   * Closes the read limiter of the source (session close): a read still
   * queued never goes out and rejects with {@link ReadLimiterClosed}.
   */
  close(): void
}

/** The pause before the first re-send of parts a batch aborted. */
export const BATCH_RETRY_PAUSE_MS = 50
/** How many times parts the server did not run are re-sent. */
export const BATCH_RETRY_MAX = 5

const internal = (): { ok: false; error: CommandError } => ({
  ok: false,
  error: { code: "command.internal" },
})

/**
 * Відповідь порту: сире значення чи відмова всього запиту. Інший виняток —
 * не відмова сервера, а дефект: він виходить назовні, як і в читанні.
 */
async function answerOf(
  request: () => Promise<unknown>
): Promise<{ ok: true; value: unknown } | { ok: false; error: CommandError }> {
  try {
    return { ok: true, value: await request() }
  } catch (error) {
    if (error instanceof CommandFailure)
      return { ok: false, error: error.error }
    throw error
  }
}

const retryReason = (item: CoreReadItem): string | undefined =>
  !item.ok &&
  item.error.code === "command.unavailable" &&
  (item.error.reason === BATCH_ABORTED || item.error.reason === BATCH_BUDGET)
    ? item.error.reason
    : undefined

// Маркер у логічній формі відрізняє від рядка відсутність ключа (Рд40).
const isMarker = (entry: CatalogEntry, row: object) =>
  !Object.hasOwn(row, entry.keyName) && "known" in row

// Імена, які частковий маркер мусить нести: колонки `copy` об'єкта й колонки
// посилань `include` частини.
const carriedNames = (entry: CatalogEntry, query: RowsQuery): string[] => [
  ...entry.attributes.filter((a) => a.copy === true).map((a) => a.name),
  ...("include" in query ? (query.include ?? []) : []),
]

const carries = (row: object, names: readonly string[]) => {
  const copies = (row as { copies?: Record<string, unknown> }).copies
  return names.every(
    (name) => copies !== undefined && Object.hasOwn(copies, name)
  )
}

const inKnown = (row: object, known: KnownVersions) => {
  const at = (row as { known?: unknown }).known
  return (
    Number.isSafeInteger(at) &&
    (at as number) >= 0 &&
    (at as number) < known.keys.length
  )
}

/**
 * Creates the core read source. A query the mapping refuses never reaches the
 * adapter: an untranslatable value is `CommandFailure` `command.invalid` with
 * its logical `path`, a name outside the catalog is `DataError`
 * `data.unsupported-predicate`. An answer of the wrong form, a count or
 * version value for a rows part, or a marker in a part that sent no `known`
 * is `command.internal` of that part.
 *
 * Parts the server did not run (`batch-aborted` after a failed part,
 * `batch-budget`) go again through the limiter: `batch-aborted` parts in a
 * next request, the first after a pause that doubles every round; a
 * `batch-budget` part in a request of its own, where no other part shares
 * the budget. `response-too-large` is not
 * retried: the caller halves its keys.
 */
export function createCoreSource(
  sourceFor: (object: MetadataRef) => SourceAdapter,
  index: CatalogIndex,
  limiter: ReadLimiter,
  server: ServerPort
): CoreSource {
  const decode = (
    part: CorePart,
    item: WireReadParts["items"][number],
    epoch: string | null
  ): CoreReadItem => {
    if (!item.ok) return { ok: false, error: errorFromWire(index, item.error) }
    if (part.type === "version") {
      const version = versionValueSchema.safeParse(item.value)
      return version.success
        ? { ok: true, type: "version", version: version.data }
        : internal()
    }
    if (part.type === "rights") {
      const rights = rightsValueSchema.safeParse(item.value)
      return rights.success
        ? { ok: true, type: "rights", value: rights.data }
        : internal()
    }
    const { query } = part
    if (!("rows" in item.value)) return internal()
    try {
      const value = readResultFromWire(index, query, item.value)
      if (!("rows" in value)) return internal()
      const entry = index.byRef.get(`${query.object.kind}.${query.object.name}`)
      if (entry !== undefined && !("tabularSection" in query)) {
        const markers = value.rows.filter((row) => isMarker(entry, row))
        // Маркер без `known`: ядро його не слало, тож сервер порушив
        // контракт. Рядок ТЧ маркером бути не може.
        if (markers.length > 0 && part.known === undefined) return internal()
        // Маркер — лише в епосі `known`, і його позиція — у межах `known`.
        if (
          part.known !== undefined &&
          markers.length > 0 &&
          (epoch !== part.known.epoch ||
            markers.some((row) => !inKnown(row, part.known!)))
        ) {
          return internal()
        }
        // Маркер несе кожну колонку `copy` і кожну колонку посилання `include`
        // частини: без них клієнт лишив би в тримуваному рядку стару копію чи
        // не знайшов би цілей (Рд40, І6).
        const carried = carriedNames(entry, query)
        if (markers.some((row) => !carries(row, carried))) return internal()
      }
      return { ok: true, rows: value as ReadRows, epoch }
    } catch (error) {
      // Сира форма відповіді — дефект джерела, а не вводу ядра: назовні
      // йде код, як у будь-якої відмови сервера.
      if (error instanceof WireDecodeError) return internal()
      throw error
    }
  }

  // Лічильник запитів джерела (`requestOf`).
  let requests = 0

  // Об'єкт частини; частина без об'єкта — рівня каталогу.
  const objectOf = (part: CorePart): MetadataRef | undefined =>
    part.type === "query" ? part.query.object : undefined

  // Пізня відмова шлюзу (`stale-client`, §10, Р-SK1-6): частина, що вже
  // стоїть у черзі обмежувача, не йде на сервер, коли дійде черга. Липкість
  // дає позначка ядра, власної множини джерело не тримає.
  const isRefused = (
    part: CorePart,
    staleObject: ReadOptions["staleObject"]
  ): boolean => {
    const object = objectOf(part)
    return (
      object !== undefined &&
      staleObject?.(`${object.kind}.${object.name}`) === true
    )
  }
  const refusal = (part: CorePart): CoreReadItem => ({
    ok: false,
    error: { code: "command.stale-client", object: objectOf(part)! },
  })

  // Адаптер Server Function приймає й частини без об'єкта; адаптер-
  // перевизначення — лише частини запитів. Групи без адаптера (`null`) —
  // самі частини каталогу, коли жоден об'єкт не читає Server Function.
  const readVia = (
    adapter: SourceAdapter | null,
    wires: readonly WireReadPart[]
  ): Promise<WireReadParts> =>
    adapter === null || adapter.read === server.read
      ? server.read(wires)
      : adapter.read(
          wires.filter((wire): wire is WireQueryPart => wire.type === "query")
        )

  // Один запит — один слот обмежувача; відмова всього запиту (CommandFailure
  // адаптера: транспорт, `session-changed`) стає відмовою кожної його частини.
  const send = async (
    adapter: SourceAdapter | null,
    queries: readonly CorePart[],
    wires: readonly WireReadPart[],
    origins: readonly (Flight | undefined)[],
    { onRightsSent, onRead, ownFlight, staleObject }: ReadOptions
  ): Promise<CoreReadItem[]> => {
    let answer: WireReadParts | undefined
    // Частини, що справді пішли: добираються на старті задачі, не при постановці.
    let live: number[] = []
    let request = 0
    try {
      answer = await limiter.run(() => {
        live = queries.flatMap((part, i) =>
          isRefused(part, staleObject) ? [] : [i]
        )
        request = ++requests
        // Подія — на кожну живу частину, у мить номера запиту: частину,
        // відмовлену без запиту (`stale-object`, закритий обмежувач), задача
        // сюди не доводить.
        for (const i of live) {
          const flight = origins[i]
          const event =
            flight === undefined || ownFlight?.(flight) === false
              ? undefined
              : readEvent(flight, request)
          if (event !== undefined) onRead?.(event)
        }
        // Строк знімка — від справжньої відправки, а не від черги слотів:
        // інакше знімок після довгої черги приходив би вже простроченим.
        if (live.some((i) => queries[i]!.type === "rights")) onRightsSent?.()
        return live.length === 0
          ? Promise.resolve(undefined)
          : readVia(
              adapter,
              live.map((i) => wires[i]!)
            )
      })
    } catch (error) {
      if (!(error instanceof CommandFailure)) throw error
      return numbered(
        queries.map(() => ({ ok: false, error: error.error })),
        live,
        request
      )
    }
    if (answer === undefined) return queries.map(refusal)
    const { epoch, items } = answer
    // Рівно по відповіді на частину: інакше порядок не співставити.
    if (items.length !== live.length)
      return numbered(queries.map(internal), live, request)
    return queries.map((part, i) => {
      const at = live.indexOf(i)
      if (at < 0) return refusal(part)
      const item = decode(part, items[at]!, epoch)
      requestOfItem.set(item, request)
      return item
    })
  }

  // Відмова вже надісланого запиту — теж відповідь цього запиту: подія
  // `watchReads` його живих частин має номер, тож `requestOf` їхніх відмов
  // мусить його дати (значення відмов не змінюються).
  const numbered = (
    items: CoreReadItem[],
    live: readonly number[],
    request: number
  ): CoreReadItem[] => {
    for (const i of live) requestOfItem.set(items[i]!, request)
    return items
  }

  const group = async (
    adapter: SourceAdapter | null,
    slots: readonly number[],
    queries: readonly CorePart[],
    wires: readonly WireReadPart[],
    out: CoreReadItem[],
    options: ReadOptions
  ): Promise<void> => {
    const { sleep, origins } = options
    let pending = slots
    // Частини, що отримали `batch-budget`: наступного разу кожна йде
    // окремим запитом. Сама в запиті частина не ділить бюджет ні з ким і
    // `batch-budget` вже не отримає; той самий склад запиту знову не вмістив
    // би її (резерв невиконаних частин) чи пропускав би по одній за прохід.
    const apart = new Set<number>()
    for (let round = 0; pending.length > 0; round++) {
      const requests: number[][] = []
      const together = pending.filter((slot) => !apart.has(slot))
      for (let i = 0; i < together.length; i += READ_BATCH_MAX) {
        requests.push(together.slice(i, i + READ_BATCH_MAX))
      }
      for (const slot of pending) if (apart.has(slot)) requests.push([slot])
      const again: number[] = []
      let aborted = false
      await Promise.all(
        requests.map(async (request) => {
          const items = await send(
            adapter,
            request.map((slot) => queries[slot]!),
            request.map((slot) => wires[slot]!),
            request.map((slot) => origins?.[slot]),
            options
          )
          request.forEach((slot, i) => {
            out[slot] = items[i]!
            const reason = retryReason(items[i]!)
            if (reason === undefined) return
            again.push(slot)
            if (reason === BATCH_BUDGET) apart.add(slot)
            aborted ||= reason === BATCH_ABORTED
          })
        })
      )
      if (round >= BATCH_RETRY_MAX) return
      pending = again.sort((a, b) => a - b)
      // Збій бази в попередній частині: пауза росте, щоб не бити в неї
      // повторами; `batch-budget` — просто не вмістилось, пауза не потрібна.
      if (aborted && pending.length > 0) {
        await sleep(BATCH_RETRY_PAUSE_MS * 2 ** round)
      }
    }
  }

  /**
   * Рядки результату `run` за операціями. Значення — від сервера: хибна форма
   * рядка, зміни поза каталогом чи рядків не стільки, скільки операцій, —
   * дефект сервера, а не вводу ядра.
   */
  const decodeRun = (
    entry: CatalogEntry,
    id: string | undefined,
    value: unknown
  ): CoreRunResult => {
    const parsed = wireRunResultSchema.safeParse(value)
    if (!parsed.success) return internal()
    const { rows, changes, epoch } = parsed.data
    const mapped = changesFromWire(index, changes)
    if (!mapped.ok) return internal()
    // Без `rows` — відповідь понад бюджет: рядок ядро перечитує за ключем.
    if (rows === undefined) {
      return { ok: true, rows: [undefined], changes: mapped.value, epoch }
    }
    if (rows.length !== 1) return internal()
    try {
      const row = serverRow(entry, decodeRow(entry, rows[0]!), epoch)
      // Рядок чужого ключа write-back записав би не туди: це дефект сервера.
      if (id !== undefined && row.key.toLowerCase() !== id.toLowerCase()) {
        return internal()
      }
      return { ok: true, rows: [row], changes: mapped.value, epoch }
    } catch (error) {
      if (error instanceof WireDecodeError || error instanceof CommandFailure) {
        return internal()
      }
      throw error
    }
  }

  return {
    close: () => limiter.close(),
    async run(operation) {
      const entry = index.byRef.get(
        `${operation.object.kind}.${operation.object.name}`
      )
      if (entry === undefined) {
        throw new TypeError("run: object outside the catalog")
      }
      const mapped = operationToWire(index, operation)
      if (!mapped.ok) {
        if ("invalid" in mapped) return { ok: false, error: mapped.invalid }
        throw new TypeError("run: name outside the catalog")
      }
      // Хеш ядра лише об'єкта операції: за ним сервер звіряє контракт, з
      // яким клієнт зібрав команду (Рд12). Запис не займає слота читання.
      const answer = await answerOf(() =>
        server.run({
          operation: mapped.value,
          kernels: { [entry.id]: entry.kernelHash },
        })
      )
      const id = "id" in operation ? operation.id : undefined
      return answer.ok ? decodeRun(entry, id, answer.value) : answer
    },
    async read(requested, options) {
      // Адаптер без `capabilities.include` не віддає `included`: частина йде
      // без `include`, а цілі ядро дочитує само (Р8).
      const parts = requested.map((part): CorePart => {
        if (part.type !== "query" || !("include" in part.query)) return part
        if (sourceFor(part.query.object).capabilities.include) return part
        const query = { ...part.query }
        delete (query as { include?: unknown }).include
        return { ...part, query }
      })
      const wires = parts.map((part): WireReadPart => {
        if (part.type === "version") return { type: "version" }
        if (part.type === "rights") {
          return part.known === undefined
            ? { type: "rights" }
            : { type: "rights", known: part.known }
        }
        const mapped = readPartToWire(index, part)
        if (!mapped.ok) {
          if ("invalid" in mapped) throw new CommandFailure(mapped.invalid)
          throw new DataError("data.unsupported-predicate")
        }
        return mapped.value
      })
      // Адаптер обирається на кожну частину: застосунок може дати окреме
      // джерело кожному об'єкту (§5.1); частини одного адаптера йдуть разом.
      const groups = new Map<SourceAdapter | null, number[]>()
      parts.forEach((part, slot) => {
        const object = objectOf(part)
        if (object === undefined) return
        const adapter = sourceFor(object)
        groups.set(adapter, [...(groups.get(adapter) ?? []), slot])
      })
      // Частини каталогу ідуть у запиті Server Function; якщо жоден об'єкт її
      // не читає, вони йдуть самі.
      const catalogue = [...groups.keys()].find(
        (adapter) => adapter?.read === server.read
      )
      parts.forEach((part, slot) => {
        if (objectOf(part) !== undefined) return
        const key = catalogue ?? null
        groups.set(key, [...(groups.get(key) ?? []), slot])
      })
      const items: CoreReadItem[] = []
      await Promise.all(
        [...groups].map(([adapter, slots]) =>
          group(
            adapter,
            // Частини без об'єкта першими (§6.7): помилка бази в частині
            // даних їх не скасовує.
            [...slots].sort(
              (a, b) =>
                Number(objectOf(parts[a]!) !== undefined) -
                  Number(objectOf(parts[b]!) !== undefined) || a - b
            ),
            parts,
            wires,
            items,
            options
          )
        )
      )
      return { items }
    },
  }
}

/**
 * A view of `source` that records the epoch of every answered part, in the
 * order of arrival: a read applies only after the session accepted every
 * epoch it carries (P4-B spec §6.2) — a key absent from an answer has no
 * row to carry it. Its reads carry `flight`.
 */
export function tracked(
  source: StoreSource,
  flight: Flight
): {
  source: BoundSource
  epochs: Set<string | null>
} {
  const epochs = new Set<string | null>()
  const inner = bound(source, flight)
  return {
    epochs,
    source: {
      ...inner,
      async read(parts) {
        const result = await inner.read(parts)
        for (const item of result.items)
          if (item.ok && "epoch" in item) epochs.add(item.epoch)
        return result
      },
    },
  }
}

/**
 * Reads one part and returns its rows; a failed part is `CommandFailure` of
 * its error. For the callers that read one query at a time.
 */
export async function readOne(
  source: BoundSource,
  query: RowsQuery
): Promise<ReadRows & { epoch: string | null }> {
  const [item] = (await source.read([{ type: "query", query }])).items
  if (item === undefined || !item.ok || !("rows" in item)) {
    throw new CommandFailure(
      item !== undefined && !item.ok ? item.error : { code: "command.internal" }
    )
  }
  return { ...item.rows, epoch: item.epoch }
}

/**
 * The row a partial marker stands for (P4-B spec §4.1): the held row with the
 * values of the `copy` attributes the marker carries. Only those attributes
 * are taken — key, version and the rest of `copies` are ignored, because a
 * defective server must not move a row's version through a marker.
 */
export function rowFromMarker(
  entry: CatalogEntry,
  held: ServerRow,
  marker: KnownMarker
): ServerRow {
  const values = { ...held.values }
  for (const attribute of entry.attributes) {
    if (
      attribute.copy === true &&
      marker.copies !== undefined &&
      Object.hasOwn(marker.copies, attribute.name)
    ) {
      values[attribute.name] = marker.copies[attribute.name]
    }
  }
  return { ...held, values }
}

/** The most keys one list request by keys may carry. */
const KEYS_PER_REQUEST_MAX = Math.min(READ_LIMIT_MAX, FILTER_IN_MAX)

/**
 * Options of {@link readKeys}: the list form reads keys in chunks of
 * `keysPerRequest` (1 to `READ_LIMIT_MAX`); `form: "card"` reads each key by
 * the card form, lazy columns included.
 */
export type ReadKeysOptions = (
  | { readonly form?: "list"; readonly keysPerRequest: number }
  | { readonly form: "card" }
) & {
  /**
   * The `known` of a read of these keys (P4-B spec §6.7); asked for each
   * request, the halves of a split one included. Without it no part
   * carries `known`.
   */
  readonly known?: (keys: readonly Key[]) => KnownSnapshot | undefined
}

const isTooLarge = (error: CommandError): boolean =>
  error.code === "command.invalid" &&
  error.reason === LIMIT_REASONS.responseTooLarge

/**
 * A confirmed row of `entry` from logical values; a row without its key or
 * version breaks the source contract and is `CommandFailure` `command.internal`.
 */
export function serverRow(
  entry: CatalogEntry,
  values: Record<string, unknown>,
  versionEpoch: string | null
): ServerRow {
  const key = values[entry.keyName]
  const version = values[entry.versionName]
  if (typeof key !== "string" || typeof version !== "number") {
    throw new CommandFailure({ code: "command.internal" })
  }
  return { key, version, versionEpoch, values }
}

/**
 * The rows of an answer. A marker of a part with `known` becomes the held row
 * it stands for plus its copies, with `marker` set: the store applies it as a
 * confirmation, not as new values (`ObjectStore.applyMarker`). A marker
 * outside `snapshot` is a defect of the source.
 */
export function rowsOf(
  entry: CatalogEntry,
  rows: ReadRows["rows"],
  versionEpoch: string | null,
  snapshot?: KnownSnapshot
): ServerRow[] {
  return rows.map((values) =>
    snapshot === undefined || !isMarker(entry, values)
      ? serverRow(entry, values, versionEpoch)
      : markedRow(entry, snapshot, values, versionEpoch)
  )
}

function markedRow(
  entry: CatalogEntry,
  snapshot: KnownSnapshot,
  marker: object,
  versionEpoch: string | null
): ServerRow {
  const held = snapshot.held[(marker as { known: number }).known]
  if (held === undefined) {
    throw new CommandFailure({ code: "command.internal" })
  }
  const resolved = rowFromMarker(entry, held, marker as KnownMarker)
  return {
    key: resolved.key,
    version: resolved.version,
    versionEpoch: effectiveEpoch(versionEpoch, held.versionEpoch),
    values: resolved.values,
    marker: held,
  }
}

/**
 * Reads one rows part of the object of `entry` and returns its rows in
 * answer order (markers resolved, see {@link rowsOf}); a failed part is
 * `CommandFailure` of its error. `snapshot` is the `known` the part carries.
 */
export async function readRows(
  source: BoundSource,
  entry: CatalogEntry,
  query: RowsQuery,
  snapshot?: KnownSnapshot
): Promise<{
  rows: ServerRow[]
  /** The raw `included` of the answer, keyed `"<kind>.<name>"`. */
  included: ReadRows["included"]
  more: boolean
  epoch: string | null
}> {
  const [item] = (
    await source.read([
      {
        type: "query",
        query,
        ...(snapshot === undefined ? {} : { known: snapshot.known }),
      },
    ])
  ).items
  if (item === undefined || !item.ok || !("rows" in item)) {
    throw new CommandFailure(
      item !== undefined && !item.ok ? item.error : { code: "command.internal" }
    )
  }
  return {
    rows: rowsOf(entry, item.rows.rows, item.epoch, snapshot),
    included: item.rows.included,
    more: item.rows.more === true,
    epoch: item.epoch,
  }
}

/**
 * Reads rows of the object of `entry` by keys (P4-B spec §6.1, form `keys`) — the single
 * path of every re-read by key. The list form goes by `keysPerRequest` keys
 * per request; on `response-too-large` a chunk is halved down to one key,
 * and one key over the budget passes the failure on. A key without a row in
 * the answer is absent from the result.
 */
export async function readKeys(
  source: BoundSource,
  entry: CatalogEntry,
  keys: readonly Key[],
  options: ReadKeysOptions
): Promise<ServerRow[]> {
  // Об'єкт — із запису каталогу: окремий параметр міг би з ним розійтися.
  const object: MetadataRef = { kind: entry.kind, name: entry.name }
  const toRows = (
    result: ReadRows,
    epoch: string | null,
    snapshot: KnownSnapshot | undefined
  ) => rowsOf(entry, result.rows, epoch, snapshot)
  // Усі частини — одним викликом: запити по `READ_BATCH_MAX` і слот на запит
  // вирішує джерело. Перша відмова за порядком частин — відмова читання.
  const readParts = async (
    queries: readonly RowsQuery[],
    snapshots: readonly (KnownSnapshot | undefined)[]
  ) => {
    const { items } = await source.read(
      queries.map((query, at): CorePart => {
        const snapshot = snapshots[at]
        return {
          type: "query",
          query,
          ...(snapshot === undefined ? {} : { known: snapshot.known }),
        }
      })
    )
    return items.map((item): CoreRowsItem => {
      if (!item.ok) return item
      if (!("rows" in item)) {
        throw new CommandFailure({ code: "command.internal" })
      }
      return item
    })
  }
  const readAll = async (
    queries: readonly RowsQuery[],
    snapshots: readonly (KnownSnapshot | undefined)[]
  ) => {
    const items = await readParts(queries, snapshots)
    const failed = items.find((item) => !item.ok)
    if (failed !== undefined && !failed.ok) {
      throw new CommandFailure(failed.error)
    }
    return items
  }
  if (options.form === "card") {
    // Форма картки читає один ключ: ділити нічого, понад бюджет — відмова.
    const snapshots = keys.map((id) => options.known?.([id]))
    const items = await readAll(
      keys.map((id) => ({ object, id })),
      snapshots
    )
    return items.flatMap((item, at) =>
      item.ok && "rows" in item
        ? toRows(item.rows, item.epoch, snapshots[at])
        : []
    )
  }
  const { keysPerRequest } = options
  if (
    !Number.isSafeInteger(keysPerRequest) ||
    keysPerRequest < 1 ||
    keysPerRequest > KEYS_PER_REQUEST_MAX
  ) {
    throw new RangeError(
      `keysPerRequest must be an integer from 1 to ${KEYS_PER_REQUEST_MAX}`
    )
  }
  const queryOf = (chunk: readonly Key[]): RowsQuery => ({
    object,
    where: { attribute: entry.keyName, op: "in", value: [...chunk] },
    limit: chunk.length,
  })
  // Частини, що не вмістились у бюджет відповіді, діляться навпіл і йдуть
  // наступним викликом; один ключ понад бюджет — відмова назовні. Рядки —
  // по частині, щоб склеїти половини в порядку ключів.
  const readChunks = async (
    chunks: readonly (readonly Key[])[]
  ): Promise<ServerRow[][]> => {
    const snapshots = chunks.map((chunk) => options.known?.(chunk))
    const items = await readParts(chunks.map(queryOf), snapshots)
    const rows: ServerRow[][] = []
    const halves: Key[][] = []
    const halved: number[] = []
    for (const [at, item] of items.entries()) {
      const chunk = chunks[at]!
      if (item.ok && "rows" in item) {
        rows[at] = toRows(item.rows, item.epoch, snapshots[at])
      } else if (isTooLarge(item.error) && chunk.length > 1) {
        const half = Math.ceil(chunk.length / 2)
        halved.push(at)
        halves.push(chunk.slice(0, half), chunk.slice(half))
      } else {
        throw new CommandFailure(item.error)
      }
    }
    if (halves.length > 0) {
      const again = await readChunks(halves)
      halved.forEach((at, i) => {
        rows[at] = [...again[2 * i]!, ...again[2 * i + 1]!]
      })
    }
    return rows
  }
  const chunks: Key[][] = []
  for (let i = 0; i < keys.length; i += keysPerRequest) {
    chunks.push(keys.slice(i, i + keysPerRequest))
  }
  return (await readChunks(chunks)).flat()
}
