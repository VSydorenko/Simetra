import pg from "pg"
import { loadSqlParser, type Node, type SqlParser } from "simetra/compiler"

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

const OUTSIDE = "target query outside a read-only transaction"
const SESSION =
  "target session setting refused: a session-level SET or RESET outlives the transaction; use SET LOCAL"
const READ_WRITE = "target transaction must stay read-only"
const CHAIN = "target transaction chaining refused: AND CHAIN is not allowed"

/** Налаштування, якими транзакція перестала б бути лише для читання. */
const READ_ONLY_SETTINGS = new Set([
  "transaction_read_only",
  "default_transaction_read_only",
])

export type VettedQuery =
  | {
      ok: true
      /** Текст до відправки: голий `BEGIN` отримує `READ ONLY`. */
      text: string
      /** Чи відкрита транзакція після цього запиту. */
      inTransaction: boolean
    }
  | { ok: false; reason: string }

/** Режим доступу з опцій `BEGIN`/`SET TRANSACTION`: `undefined` — не заданий. */
function readOnlyOption(
  options: readonly Node[] | undefined
): boolean | undefined {
  for (const option of options ?? []) {
    if (!("DefElem" in option)) continue
    if (option.DefElem.defname !== "transaction_read_only") continue
    const arg = option.DefElem.arg
    // `READ ONLY` — ціле 1, `READ WRITE` — 0 (поле `ival` порожнє)
    return arg !== undefined && "A_Const" in arg
      ? arg.A_Const.ival?.ival === 1
      : false
  }
  return undefined
}

/**
 * Перевірка запиту до цілі: увесь текст розбирається тим самим парсером, що
 * й класи кроків, бо простий протокол виконує кілька операторів через `;`, і
 * кожен оператор проходить ту саму перевірку зі станом транзакції, який
 * лишили попередні.
 *
 * - Поза транзакцією — лише її початок; без режиму доступу він отримує
 *   `READ ONLY` (так відкриває транзакцію двигун: голий `BEGIN` у
 *   `probeUnmodeledIdentitiesPinned`). Неявна транзакція оператора поза
 *   `BEGIN` не лише для читання, тож такий оператор — відмова.
 * - `READ WRITE` у `BEGIN`/`START TRANSACTION`/`SET TRANSACTION`, будь-який
 *   `SET` `transaction_read_only` чи `default_transaction_read_only` (навіть
 *   `LOCAL`) — відмова: транзакція перестала б бути лише для читання.
 * - `SET`/`RESET` без `LOCAL` — відмова: сесійний стан (рішення 14.1).
 * - `COMMIT`/`ROLLBACK AND CHAIN` — відмова.
 *
 * Модель загрози — випадковий запис нашим кодом чи двигуном, а не зловмисник.
 * Поза досяжністю сторожа свідомо лишаються: `set_config('transaction_read_only',
 * 'off', …)` чи `set_config(…, false)` у виразі `SELECT`, іменовані prepared
 * statements, сесійні advisory lock, `LISTEN`. Такі запити — не випадковість,
 * а обхід, і ловить їх перегляд коду, а не розбір.
 */
export function vetTargetQuery(
  text: string,
  inTransaction: boolean,
  parse: SqlParser
): VettedQuery {
  const parsed = parse(text)
  if (!parsed.ok)
    return {
      ok: false,
      reason: `target query does not parse: ${parsed.message}`,
    }
  let open = inTransaction
  /** Позиції після ключового слова голих `BEGIN`, куди дописати `READ ONLY`. */
  const readOnlyAt: number[] = []
  for (const { stmt, start } of parsed.statements) {
    if ("TransactionStmt" in stmt) {
      const t = stmt.TransactionStmt
      switch (t.kind) {
        case "TRANS_STMT_BEGIN":
        case "TRANS_STMT_START": {
          const readOnly = readOnlyOption(t.options)
          if (readOnly === false) return { ok: false, reason: READ_WRITE }
          // `BEGIN` у відкритій транзакції Postgres лише попереджає: її режим
          // уже перевірено, коли вона відкривалась
          if (!open && readOnly === undefined)
            readOnlyAt.push(afterBeginKeyword(text, start))
          open = true
          continue
        }
        case "TRANS_STMT_COMMIT":
        case "TRANS_STMT_ROLLBACK":
          if (t.chain === true) return { ok: false, reason: CHAIN }
          open = false
          continue
        case "TRANS_STMT_SAVEPOINT":
        case "TRANS_STMT_RELEASE":
        case "TRANS_STMT_ROLLBACK_TO":
          if (!open) return { ok: false, reason: OUTSIDE }
          continue
        default:
          // Двофазні транзакції лишають стан поза з'єднанням
          return {
            ok: false,
            reason: `target transaction statement refused: ${t.kind}`,
          }
      }
    }
    if ("VariableSetStmt" in stmt) {
      const v = stmt.VariableSetStmt
      if (READ_ONLY_SETTINGS.has(v.name ?? ""))
        return { ok: false, reason: READ_WRITE }
      // `SET TRANSACTION …` діє лише на поточну транзакцію, хоч і без `LOCAL`
      const transactionScoped =
        v.kind === "VAR_SET_MULTI" && (v.name ?? "").startsWith("TRANSACTION")
      if (transactionScoped && readOnlyOption(v.args) === false)
        return { ok: false, reason: READ_WRITE }
      if (!transactionScoped && v.is_local !== true)
        return { ok: false, reason: SESSION }
    }
    if (!open) return { ok: false, reason: OUTSIDE }
  }
  let out = text
  for (const at of readOnlyAt.reverse())
    out = `${out.slice(0, at)} READ ONLY${out.slice(at)}`
  return { ok: true, text: out, inTransaction: open }
}

/**
 * Місце одразу після `BEGIN [WORK | TRANSACTION]` чи `START TRANSACTION`:
 * режими транзакції йдуть у будь-якому порядку, а кінець оператора може
 * бути всередині хвостового коментаря.
 */
function afterBeginKeyword(text: string, start: number): number {
  const rest = text.slice(start)
  const lead = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/.exec(rest)![0]
  const keyword =
    /^(?:begin(?:\s+(?:work|transaction)\b)?|start\s+transaction)\b/i.exec(
      rest.slice(lead.length)
    )
  if (keyword === null) throw new Error("transaction start without its keyword")
  return start + lead.length + keyword[0].length
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
 * Сторож клієнта: кожен запит проходить `vetTargetQuery`. Стан транзакції —
 * на клієнті: пул віддає той самий клієнт наступним викликам. Парсер уже
 * завантажено в `connect()`, тож перевірка синхронна й не міняє порядку
 * запитів.
 */
function guard(client: pg.PoolClient, parse: SqlParser): pg.PoolClient {
  if (guarded.has(client)) return client
  guarded.add(client)
  const query = client.query.bind(client) as RawQuery
  let inTransaction = false
  const checked: RawQuery = (...args) => {
    const text = textOf(args[0])
    if (text === undefined) return Promise.reject(new Error(OUTSIDE))
    const vetted = vetTargetQuery(text, inTransaction, parse)
    if (!vetted.ok) return Promise.reject(new Error(vetted.reason))
    inTransaction = vetted.inTransaction
    return query(...(vetted.text === text ? args : withText(args, vetted.text)))
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
 * Пул цілі для pg-delta без сесійного стану: `query()` іде через
 * `readOnlyQuery`; клієнт із `connect()` пропускає лише запити, які приймає
 * `vetTargetQuery`, інакше кидає (поза транзакцією —
 * `Error("target query outside a read-only transaction")`). Цим самим пулом
 * читається й тінь.
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
    // Парсер — до клієнта: збій завантаження не лишить взятого з'єднання
    const client = loadSqlParser().then(async (parse) =>
      guard(await checkout(), parse)
    )
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
