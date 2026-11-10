import {
  CommandFailure,
  FILTER_IN_MAX,
  LIMIT_REASONS,
  READ_BATCH_MAX,
  READ_LIMIT_MAX,
  WireDecodeError,
  errorFromWire,
  readQueryToWire,
  readResultFromWire,
  type CatalogEntry,
  type CatalogIndex,
  type CommandError,
  type KnownMarker,
  type MetadataRef,
  type ReadQuery,
  type ReadRows,
  type SourceAdapter,
  type WireQueryPart,
  type WireReadParts,
  type WireRowsQuery,
} from "simetra/model"
import { DataError } from "../errors"
import type { Key, ServerRow } from "./types"

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

/** The outcome of one read part, in the order of the parts asked for. */
export type CoreReadItem =
  | { ok: true; rows: ReadRows; epoch: string | null }
  | { ok: false; error: CommandError }

/** The outcomes of {@link CoreSource.read}: one item per part. */
export interface CoreReadResult {
  items: CoreReadItem[]
}

/**
 * The core's read source over the per-object source adapters: maps logical
 * queries to the wire form, groups them into requests per adapter, reads
 * through the shared limiter and decodes the answers back to logical names.
 */
export interface CoreSource {
  /**
   * Reads parts: parts of one adapter go in requests of at most
   * `READ_BATCH_MAX` parts, a request takes one limiter slot. The epoch is
   * the answer's, per part. A failed part is its own `ok: false` item, as is
   * every part of a request the adapter rejected with `CommandFailure`.
   */
  read(parts: readonly RowsQuery[]): Promise<CoreReadResult>
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

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const internal = (): CoreReadItem => ({
  ok: false,
  error: { code: "command.internal" },
})

const retryReason = (item: CoreReadItem): string | undefined =>
  !item.ok &&
  item.error.code === "command.unavailable" &&
  (item.error.reason === BATCH_ABORTED || item.error.reason === BATCH_BUDGET)
    ? item.error.reason
    : undefined

/**
 * Creates the core read source. A query the mapping refuses never reaches the
 * adapter: an untranslatable value is `CommandFailure` `command.invalid` with
 * its logical `path`, a name outside the catalog is `DataError`
 * `data.unsupported-predicate`. An answer of the wrong form, a count or
 * version value for a rows part, or a marker in a part that sent no `known`
 * is `command.internal` of that part.
 *
 * Parts the server did not run (`batch-aborted` after a failed part,
 * `batch-budget`) go again as a next request through the limiter, the first
 * after a pause that doubles every round. `response-too-large` is not
 * retried: the caller halves its keys.
 */
export function createCoreSource(
  sourceFor: (object: MetadataRef) => SourceAdapter,
  index: CatalogIndex,
  limiter: ReadLimiter
): CoreSource {
  const decode = (
    query: RowsQuery,
    item: WireReadParts["items"][number],
    epoch: string | null
  ): CoreReadItem => {
    if (!item.ok) return { ok: false, error: errorFromWire(index, item.error) }
    if (!("rows" in item.value)) return internal()
    try {
      const value = readResultFromWire(index, query, item.value)
      if (!("rows" in value)) return internal()
      const entry = index.byRef.get(`${query.object.kind}.${query.object.name}`)
      // Маркер без `known`: ядро його не слало (B3-3 починає), тож сервер
      // порушив контракт. Рядок ТЧ маркером бути не може.
      if (
        entry !== undefined &&
        !("tabularSection" in query) &&
        value.rows.some(
          (row) => !Object.hasOwn(row, entry.keyName) && "known" in row
        )
      ) {
        return internal()
      }
      return { ok: true, rows: value as ReadRows, epoch }
    } catch (error) {
      // Сира форма відповіді — дефект джерела, а не вводу ядра: назовні
      // йде код, як у будь-якої відмови сервера.
      if (error instanceof WireDecodeError) return internal()
      throw error
    }
  }

  // Один запит — один слот обмежувача; відмова всього запиту (CommandFailure
  // адаптера: транспорт, `session-changed`) стає відмовою кожної його частини.
  const send = async (
    adapter: SourceAdapter,
    queries: readonly RowsQuery[],
    wires: readonly WireQueryPart[]
  ): Promise<CoreReadItem[]> => {
    let answer: WireReadParts
    try {
      answer = await limiter.run(() => adapter.read(wires))
    } catch (error) {
      if (!(error instanceof CommandFailure)) throw error
      return queries.map(() => ({ ok: false, error: error.error }))
    }
    const { epoch, items } = answer
    // Рівно по відповіді на частину: інакше порядок не співставити.
    if (items.length !== queries.length) return queries.map(internal)
    return queries.map((query, i) => decode(query, items[i]!, epoch))
  }

  const group = async (
    adapter: SourceAdapter,
    slots: readonly number[],
    queries: readonly RowsQuery[],
    wires: readonly WireQueryPart[],
    out: CoreReadItem[]
  ): Promise<void> => {
    let pending = slots
    for (let round = 0; pending.length > 0; round++) {
      const requests: number[][] = []
      for (let i = 0; i < pending.length; i += READ_BATCH_MAX) {
        requests.push(pending.slice(i, i + READ_BATCH_MAX))
      }
      const again: number[] = []
      let aborted = false
      await Promise.all(
        requests.map(async (request) => {
          const items = await send(
            adapter,
            request.map((slot) => queries[slot]!),
            request.map((slot) => wires[slot]!)
          )
          request.forEach((slot, i) => {
            out[slot] = items[i]!
            const reason = retryReason(items[i]!)
            if (reason === undefined) return
            again.push(slot)
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

  return {
    close: () => limiter.close(),
    async read(parts) {
      const wires = parts.map((query): WireQueryPart => {
        const mapped = readQueryToWire(index, query)
        if (!mapped.ok) {
          if ("invalid" in mapped) throw new CommandFailure(mapped.invalid)
          throw new DataError("data.unsupported-predicate")
        }
        return { type: "query", query: mapped.value as WireRowsQuery }
      })
      // Адаптер обирається на кожну частину: застосунок може дати окреме
      // джерело кожному об'єкту (§5.1); частини одного адаптера йдуть разом.
      const groups = new Map<SourceAdapter, number[]>()
      parts.forEach((query, slot) => {
        const adapter = sourceFor(query.object)
        groups.set(adapter, [...(groups.get(adapter) ?? []), slot])
      })
      const items: CoreReadItem[] = []
      await Promise.all(
        [...groups].map(([adapter, slots]) =>
          group(adapter, slots, parts, wires, items)
        )
      )
      return { items }
    },
  }
}

/**
 * Reads one part and returns its rows; a failed part is `CommandFailure` of
 * its error. For the callers that read one query at a time.
 */
export async function readOne(
  source: CoreSource,
  query: RowsQuery
): Promise<ReadRows & { epoch: string | null }> {
  const [item] = (await source.read([query])).items
  if (item === undefined || !item.ok) {
    throw new CommandFailure(item?.error ?? { code: "command.internal" })
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
export type ReadKeysOptions =
  | { readonly form?: "list"; readonly keysPerRequest: number }
  | { readonly form: "card" }

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
 * Reads rows of the object of `entry` by keys (P4-B spec §6.1, form `keys`) — the single
 * path of every re-read by key. The list form goes by `keysPerRequest` keys
 * per request; on `response-too-large` a chunk is halved down to one key,
 * and one key over the budget passes the failure on. A key without a row in
 * the answer is absent from the result.
 */
export async function readKeys(
  source: CoreSource,
  entry: CatalogEntry,
  keys: readonly Key[],
  options: ReadKeysOptions
): Promise<ServerRow[]> {
  // Об'єкт — із запису каталогу: окремий параметр міг би з ним розійтися.
  const object: MetadataRef = { kind: entry.kind, name: entry.name }
  const toRows = (result: ReadRows, epoch: string | null) =>
    result.rows.map((values) => serverRow(entry, values, epoch))
  // Усі частини — одним викликом: запити по `READ_BATCH_MAX` і слот на запит
  // вирішує джерело. Перша відмова за порядком частин — відмова читання.
  const readAll = async (queries: readonly RowsQuery[]) => {
    const { items } = await source.read(queries)
    const failed = items.find((item) => !item.ok)
    if (failed !== undefined && !failed.ok) {
      throw new CommandFailure(failed.error)
    }
    return items
  }
  if (options.form === "card") {
    // Форма картки читає один ключ: ділити нічого, понад бюджет — відмова.
    const items = await readAll(keys.map((id) => ({ object, id })))
    return items.flatMap((item) =>
      item.ok ? toRows(item.rows, item.epoch) : []
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
    const { items } = await source.read(chunks.map(queryOf))
    const rows: ServerRow[][] = []
    const halves: Key[][] = []
    const halved: number[] = []
    for (const [at, item] of items.entries()) {
      const chunk = chunks[at]!
      if (item.ok) {
        rows[at] = toRows(item.rows, item.epoch)
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
