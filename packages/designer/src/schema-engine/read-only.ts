import pg from "pg"

/**
 * Читання бази лише в транзакціях `READ ONLY` (рішення 14.1 плану П3-1,
 * спека designer §3.2). Гарантія живе в транзакції, а не в з'єднанні: за
 * пулером у режимі транзакцій сесійне налаштування губиться між
 * транзакціями або осідає на спільному backend чужого клієнта, тож на цілі
 * немає жодного сесійного стану.
 */

/**
 * Ізоляція — явно, як у порту виконання (`apply-database.ts`), а не з
 * налаштувань бази чи ролі: кожен оператор хелпера бачить коміти, зроблені до
 * нього, незалежно від того, куди підключено.
 */
const BEGIN_READ_ONLY = "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"

const OUTSIDE = "target query outside a read-only transaction"
const SESSION =
  "target session setting refused: a session-level SET outlives the transaction; use SET LOCAL"

/** Одна транзакція `BEGIN READ ONLY` на одному клієнті; COMMIT, при винятку ROLLBACK. */
export async function readOnlyQuery<R>(
  pool: pg.Pool,
  run: (client: pg.ClientBase) => Promise<R>
): Promise<R> {
  const client = await pool.connect()
  // Обрив backend між запитами — подія `error` клієнта; без слухача вона
  // валила б процес, а причина й так дійде до виклику через запит
  const ignore = () => {}
  client.on("error", ignore)
  let broken = false
  try {
    await client.query(BEGIN_READ_ONLY)
    const value = await run(client)
    await client.query("COMMIT")
    return value
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {
      broken = true
    })
    throw error
  } finally {
    client.removeListener("error", ignore)
    // Після невдалого ROLLBACK стан сесії невідомий: з'єднання знищується,
    // а не повертається в пул
    client.release(broken)
  }
}

/** Текст оператора без провідних пробілів і коментарів. */
function leading(text: string): string {
  return text.replace(/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "")
}

const BEGIN = /^(?:begin|start\s+transaction)\b/i
/** Кінець транзакції; `ROLLBACK TO` і `… AND CHAIN` транзакцію не закінчують. */
const END =
  /^(?:commit|end|rollback|abort)\b(?!\s+(?:(?:work|transaction)\s+)?(?:to\b|and\s+chain\b))/i
/** `SET` без `LOCAL` чи `RESET` живуть до кінця сесії, а не транзакції. */
const SESSION_SETTING =
  /^(?:set\b(?!\s+(?:local|transaction|constraints)\b)|reset\b)/i

/**
 * Початок транзакції з режимом лише читання. Без режиму доступу — додається
 * `READ ONLY`: так відкриває транзакцію двигун (`probeUnmodeledIdentitiesPinned`
 * шле голий `BEGIN`), і гарантію дає транзакція, а не текст викликача.
 * `READ WRITE` — відмова.
 */
function readOnlyBegin(statement: string): string | undefined {
  const end = statement.indexOf(";")
  const head = end === -1 ? statement : statement.slice(0, end)
  if (/\bread\s+write\b/i.test(head)) return undefined
  if (/\bread\s+only\b/i.test(head)) return statement
  return `${head.trimEnd()} READ ONLY${end === -1 ? "" : statement.slice(end)}`
}

function textOf(query: unknown): string | undefined {
  if (typeof query === "string") return query
  if (typeof query === "object" && query !== null && "text" in query) {
    const text = (query as { text: unknown }).text
    if (typeof text === "string") return text
  }
  return undefined
}

function withText(args: unknown[], text: string): unknown[] {
  const [query, ...rest] = args
  return [
    typeof query === "string" ? text : { ...(query as object), text },
    ...rest,
  ]
}

type RawQuery = (...args: unknown[]) => unknown

const guarded = new WeakSet<pg.PoolClient>()

/**
 * Сторож клієнта: перший оператор поза транзакцією — лише її початок у режимі
 * читання, далі все до `COMMIT`/`ROLLBACK`. Перевіряється провідний оператор
 * кожного запиту: двигун шле пакет, що починається з `BEGIN`, а кінець
 * транзакції — окремим запитом. Стан — на клієнті: пул віддає той самий
 * клієнт наступним викликам.
 */
function guard(client: pg.PoolClient): pg.PoolClient {
  if (guarded.has(client)) return client
  guarded.add(client)
  const query = client.query.bind(client) as RawQuery
  let inTransaction = false
  const checked: RawQuery = (...args) => {
    const text = textOf(args[0])
    if (text === undefined) return Promise.reject(new Error(OUTSIDE))
    const statement = leading(text)
    if (SESSION_SETTING.test(statement))
      return Promise.reject(new Error(SESSION))
    if (END.test(statement)) {
      inTransaction = false
      return query(...args)
    }
    if (inTransaction) return query(...args)
    const begin = BEGIN.test(statement) ? readOnlyBegin(statement) : undefined
    if (begin === undefined) return Promise.reject(new Error(OUTSIDE))
    inTransaction = true
    return query(...(begin === statement ? args : withText(args, begin)))
  }
  client.query = checked as pg.PoolClient["query"]
  return client
}

type Done = (release?: Error | boolean) => void
type ConnectCallback = (
  error: Error | undefined,
  client: pg.PoolClient | undefined,
  done: Done
) => void

/**
 * Пул цілі для pg-delta без сесійного стану: `query()` іде через `readOnlyQuery`;
 * клієнт із `connect()` пропускає перший оператор лише якщо це `BEGIN`/`START
 * TRANSACTION` з `READ ONLY` (без режиму доступу — додає його) і далі — до
 * `COMMIT`/`ROLLBACK`; інакше кидає
 * `Error("target query outside a read-only transaction")`. Сесійний `SET`
 * відмовляє й усередині транзакції. Цим самим пулом читається й тінь.
 */
export function readOnlyTransactionPool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url })
  // Помилка простого клієнта (рестарт сервера) не має валити процес: пул
  // закривається в `finally` виклику
  pool.on("error", () => {})
  const checkout = pool.connect.bind(pool) as () => Promise<pg.PoolClient>
  // Двигун бере клієнта з колбеком (`connectWithErrorListener`), наш код —
  // через проміс: обидві форми віддають клієнта лише під сторожем
  function connect(): Promise<pg.PoolClient>
  function connect(callback: ConnectCallback): void
  function connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const client = checkout().then(guard)
    if (callback === undefined) return client
    client.then(
      (c) => callback(undefined, c, c.release),
      (error: Error) => callback(error, undefined, () => {})
    )
  }
  pool.connect = connect as pg.Pool["connect"]
  pool.query = ((...args: unknown[]) =>
    readOnlyQuery(pool, async (client) =>
      (client.query as RawQuery).apply(client, args)
    )) as pg.Pool["query"]
  return pool
}
