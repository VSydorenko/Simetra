import {
  CommandFailure,
  FILTER_IN_MAX,
  LIMIT_REASONS,
  READ_LIMIT_MAX,
  WireDecodeError,
  readQueryToWire,
  readResultFromWire,
  type CatalogEntry,
  type CatalogIndex,
  type MetadataRef,
  type ReadQuery,
  type ReadRows,
  type SourceAdapter,
} from "simetra/model"
import { DataError } from "../errors"
import type { Key, ServerRow } from "./types"

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
 * The core's read source over the per-object source adapters: maps a logical
 * query to the wire form, reads through the shared limiter and decodes the
 * answer back to logical names.
 */
export interface CoreSource {
  read(query: RowsQuery): Promise<ReadRows>
  /**
   * Closes the read limiter of the source (session close): a read still
   * queued never goes out and rejects with {@link ReadLimiterClosed}.
   */
  close(): void
}

/**
 * Creates the core read source. A query the mapping refuses never reaches the
 * adapter: an untranslatable value is `CommandFailure` `command.invalid` with
 * its logical `path`, a name outside the catalog is `DataError`
 * `data.unsupported-predicate`. An answer of the wrong form is
 * `CommandFailure` `command.internal`.
 */
export function createCoreSource(
  sourceFor: (object: MetadataRef) => SourceAdapter,
  index: CatalogIndex,
  limiter: ReadLimiter
): CoreSource {
  return {
    close: () => limiter.close(),
    async read(query) {
      const mapped = readQueryToWire(index, query)
      if (!mapped.ok) {
        if ("invalid" in mapped) throw new CommandFailure(mapped.invalid)
        throw new DataError("data.unsupported-predicate")
      }
      // Адаптер обирається на кожне читання: застосунок може дати окреме
      // джерело кожному об'єкту (§5.1).
      const adapter = sourceFor(query.object)
      const wire = await limiter.run(() =>
        adapter.read(mapped.value as Parameters<SourceAdapter["read"]>[0])
      )
      try {
        return readResultFromWire(index, query, wire) as ReadRows
      } catch (error) {
        // Сира форма відповіді — дефект джерела, а не вводу ядра: назовні
        // йде код, як у будь-якої відмови сервера.
        if (error instanceof WireDecodeError) {
          throw new CommandFailure({ code: "command.internal" })
        }
        throw error
      }
    },
  }
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

const isTooLarge = (error: unknown): boolean =>
  error instanceof CommandFailure &&
  error.error.code === "command.invalid" &&
  error.error.reason === LIMIT_REASONS.responseTooLarge

/**
 * A confirmed row of `entry` from logical values; a row without its key or
 * version breaks the source contract and is `CommandFailure` `command.internal`.
 */
export function serverRow(
  entry: CatalogEntry,
  values: Record<string, unknown>
): ServerRow {
  const key = values[entry.keyName]
  const version = values[entry.versionName]
  if (typeof key !== "string" || typeof version !== "number") {
    throw new CommandFailure({ code: "command.internal" })
  }
  return { key, version, values }
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
  const toRows = (result: ReadRows) =>
    result.rows.map((values) => serverRow(entry, values))
  if (options.form === "card") {
    // Форма картки читає один ключ: ділити нічого, понад бюджет — відмова.
    const results = await Promise.all(
      keys.map((id) => source.read({ object, id }))
    )
    return results.flatMap(toRows)
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
  const one = async (chunk: readonly Key[]): Promise<ServerRow[]> => {
    try {
      return toRows(
        await source.read({
          object,
          where: { attribute: entry.keyName, op: "in", value: [...chunk] },
          limit: chunk.length,
        })
      )
    } catch (error) {
      if (!isTooLarge(error) || chunk.length === 1) throw error
      const half = Math.ceil(chunk.length / 2)
      const [a, b] = await Promise.all([
        one(chunk.slice(0, half)),
        one(chunk.slice(half)),
      ])
      return [...a, ...b]
    }
  }
  const chunks: Key[][] = []
  for (let i = 0; i < keys.length; i += keysPerRequest) {
    chunks.push(keys.slice(i, i + keysPerRequest))
  }
  // Паралельність тримає спільний обмежувач джерела, а не цей цикл.
  return (await Promise.all(chunks.map(one))).flat()
}
