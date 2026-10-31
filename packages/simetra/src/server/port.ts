/**
 * One connection taken from a pool: bound text parameters only, unnamed
 * statements (P4 spec Рт19).
 */
export interface DatabaseClient {
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
    }): Promise<{ rows: Record<string, unknown>[]; command: string }>
    release(destroy?: boolean): void
  }>
}

/** Adapts a `pg` pool to the runtime port. */
export function fromPgPool(pool: PgPoolLike): CommandDatabase {
  return {
    async connect() {
      const client = await pool.connect()
      return {
        async query(text, params) {
          // Без `name`: іменований оператор `pg` готує на з'єднанні, а
          // пулер у режимі транзакцій міняє з'єднання між транзакціями.
          const { rows, command } = await client.query({
            text,
            values: params ?? [],
          })
          return { rows, command }
        },
        release(destroy) {
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
  /** The connection is gone or unusable: the client must be destroyed. */
  connectionLost: boolean
}

// SQLSTATE — п'ять символів; `code` мережевої помилки Node (`ECONNRESET`)
// кодом бази не є.
const SQLSTATE = /^[0-9A-Z]{5}$/
const ADMIN_SHUTDOWN = new Set(["57P01", "57P02", "57P03"])

/**
 * Normalizes whatever the driver threw. Помилка без SQLSTATE — обрив чи
 * збій драйвера до відповіді бази: з'єднанню вже не можна вірити.
 */
export function normalizeError(error: unknown): DatabaseError {
  const source: Record<string, unknown> =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {}
  const text = (key: string) =>
    typeof source[key] === "string" ? (source[key] as string) : undefined
  const raw = text("code")
  const code = raw !== undefined && SQLSTATE.test(raw) ? raw : undefined
  const fields = {
    detail: text("detail"),
    hint: text("hint"),
    constraint: text("constraint"),
    table: text("table"),
    column: text("column"),
  }
  return {
    ...(code === undefined ? {} : { code }),
    message: text("message") ?? String(error),
    ...Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined)
    ),
    connectionLost:
      code === undefined || code.startsWith("08") || ADMIN_SHUTDOWN.has(code),
  }
}
