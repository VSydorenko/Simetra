/**
 * One connection taken from a pool: bound text parameters only, unnamed
 * statements (P4 spec Рт19).
 */
export interface DatabaseClient {
  /** Column values are the Postgres text form (or `null`), whatever the pool parses. */
  query(
    text: string,
    params?: readonly (string | null)[]
  ): Promise<{ rows: Record<string, unknown>[]; command: string }>
  /** Returns the connection; `true` destroys it instead. */
  release(destroy?: boolean): void
}

/** The database port of the command runtime (P4 spec §6.4). */
export interface CommandDatabase {
  connect(): Promise<DatabaseClient>
}

/**
 * The shape of `pg.Pool` the runtime uses. Структурний тип замість імпорту
 * `pg`: серверний ярус не тягне драйвер у свій бандл (Рт17), host передає
 * будь-який пул з такою формою.
 */
export interface PgPoolLike {
  connect(): Promise<{
    query(config: {
      text: string
      values: readonly (string | null)[]
      types: typeof RAW_TYPES
    }): Promise<{ rows: Record<string, unknown>[]; command: string }>
    release(destroy?: boolean): void
    on(event: "error", listener: (error: Error) => void): unknown
    on(event: "end", listener: () => void): unknown
    removeListener(event: "error", listener: (error: Error) => void): unknown
    removeListener(event: "end", listener: () => void): unknown
  }>
}

/**
 * Парсери типів на рівні запиту: текст Postgres без перетворень. Інакше
 * парсери, які host поставив на пул (`types` у `pg.Pool`), змінили б рядок
 * ядра ще до `decodeRow` — і значення залежали б від налаштувань host-а.
 */
const RAW_TYPES = {
  getTypeParser: () => (value: string) => value,
}

/**
 * Помилки, які порт бачив разом з утратою з'єднання (подія `error`/`end`
 * клієнта, відмова `pool.connect()`): без SQLSTATE лише порт знає, що це обрив,
 * а не вада драйвера чи T3. Слабка множина — помилку не тримає й не змінює.
 */
const LOST = new WeakSet<object>()

const markLost = (error: unknown): unknown => {
  if (typeof error === "object" && error !== null) LOST.add(error)
  return error
}

/** Adapts a `pg` pool to the runtime port. */
export function fromPgPool(pool: PgPoolLike): CommandDatabase {
  return {
    async connect() {
      let client: Awaited<ReturnType<PgPoolLike["connect"]>>
      try {
        client = await pool.connect()
      } catch (error) {
        throw markLost(error)
      }
      // pg-pool знімає свого слухача `error` при видачі клієнта: `FATAL`
      // простоюючого з'єднання (напр. `25P03` між операторами, поки хук
      // чекає) без слухача став би необробленою подією й валив би процес.
      // Після першої помилки `pg` відхиляє запити загальною «not queryable»
      // без SQLSTATE — тож відхиляємо саму першу помилку з її кодом.
      let failure: { error: Error } | undefined
      let ended = false
      const onError = (error: Error) => {
        failure ??= { error }
      }
      const onEnd = () => {
        ended = true
      }
      client.on("error", onError)
      client.on("end", onEnd)
      return {
        async query(text, params) {
          if (failure !== undefined) throw markLost(failure.error)
          try {
            // Без `name`: іменований оператор `pg` готує на з'єднанні, а
            // пулер у режимі транзакцій міняє з'єднання між транзакціями.
            const { rows, command } = await client.query({
              text,
              values: params ?? [],
              types: RAW_TYPES,
            })
            return { rows, command }
          } catch (error) {
            // Подія — до відмови запиту (pg 8.23.1, `lib/client.js`):
            // `Client#_handleErrorEvent` ставить відмову кожного запиту в
            // `process.nextTick` (`_errorAllQueries`) і вже потім синхронно
            // шле `error`; обрив сокета (`con.once('end')` у
            // `Client#_connect`) іде через `_handleErrorEvent`, а подія `end`
            // клієнта — теж `process.nextTick`, після відмов. Черга
            // `nextTick` вичерпується до мікрозадач, тож продовження цього
            // `await` бачить обидві події. Відмова запиту без події (вада
            // драйвера, `TypeError` значень) — не обрив.
            throw failure !== undefined || ended ? markLost(error) : error
          }
        },
        release(destroy) {
          // Повернений у пул клієнт знову слухає сам пул; наші слухачі тримали
          // б замикання порту й копилися б з кожною видачею.
          client.removeListener("error", onError)
          client.removeListener("end", onEnd)
          client.release(destroy)
        },
      }
    },
  }
}

/** A database error reduced to the fields the runtime reads. */
export interface DatabaseError {
  code?: string
  message: string
  detail?: string
  hint?: string
  constraint?: string
  table?: string
  column?: string
  /**
   * The connection is gone (P4 spec §6.5): `command.unavailable`. Помилка без
   * SQLSTATE, що не обрив, теж знищує з'єднання ({@link destroysConnection}),
   * але назовні — `command.internal`.
   */
  connectionLost: boolean
}

// SQLSTATE — п'ять символів; `code` мережевої помилки Node (`ECONNRESET`)
// кодом бази не є, хоч `EPIPE` і має його форму — тож мережеві коди першими.
const SQLSTATE = /^[0-9A-Z]{5}$/
const ADMIN_SHUTDOWN = new Set(["57P01", "57P02", "57P03"])
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
])

/**
 * Normalizes whatever the driver threw (P4 spec §6.5). SQLSTATE вирішує сам:
 * клас `08` і `57P01`–`57P03` — обрив. Без SQLSTATE обрив — лише мережевий
 * код Node, відмова `connect()` (`connecting`) чи помилка, яку порт бачив з
 * подією `error`/`end` клієнта; решта (вада драйвера чи T3) — не обрив.
 */
export function normalizeError(
  error: unknown,
  connecting = false
): DatabaseError {
  // Читання полів не має кидати: кинути можна будь-що, зокрема відкликаний
  // `Proxy` чи об'єкт з геттером, що кидає.
  const text = (key: string): string | undefined => {
    try {
      const value: unknown =
        typeof error === "object" && error !== null
          ? (error as Record<string, unknown>)[key]
          : undefined
      return typeof value === "string" ? value : undefined
    } catch {
      return undefined
    }
  }
  const raw = text("code")
  const network = raw !== undefined && NETWORK_CODES.has(raw)
  const code =
    raw !== undefined && !network && SQLSTATE.test(raw) ? raw : undefined
  const fields = {
    detail: text("detail"),
    hint: text("hint"),
    constraint: text("constraint"),
    table: text("table"),
    column: text("column"),
  }
  return {
    ...(code === undefined ? {} : { code }),
    message: text("message") ?? describe(error),
    ...Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined)
    ),
    connectionLost:
      code === undefined
        ? network || connecting || isLost(error)
        : code.startsWith("08") || ADMIN_SHUTDOWN.has(code),
  }
}

const isLost = (error: unknown) =>
  typeof error === "object" && error !== null && LOST.has(error)

/**
 * Whether the connection must be destroyed: it is gone, or the error has no
 * SQLSTATE — без відповіді бази стан з'єднання невідомий, і довіри до нього
 * немає (P4 spec §6.5).
 */
export const destroysConnection = (error: DatabaseError): boolean =>
  error.connectionLost || error.code === undefined

/** `String()` кидає на об'єкті без прототипу й на відкликаному `Proxy`. */
function describe(error: unknown): string {
  try {
    return String(error)
  } catch {
    return "unknown error"
  }
}
