import type pg from "pg"
import type { SqlParser } from "simetra/compiler"
import {
  readOnlyQuery,
  refuseQuery,
  statementStart,
  textOf,
  withText,
  type RawQuery,
} from "./read-only"

/**
 * Витяг двигуна всередині відкритої транзакції застосування (рішення 8 плану
 * П3-2b-1). Двигун відкриває й закриває власну транзакцію, а тут вона вже є:
 * `BEGIN` стає точкою збереження, `COMMIT`/`ROLLBACK` — її відкатом і
 * звільненням. Відкат, а не просте звільнення: `SET LOCAL` двигуна
 * (`search_path = pg_catalog`) у звільненій точці дожив би до кінця
 * транзакції раннера, а витяг нічого не мусить лишити.
 */

const SAVEPOINT = "simetra_extract"
const OPEN = `SAVEPOINT ${SAVEPOINT}`
const CLOSE = `ROLLBACK TO SAVEPOINT ${SAVEPOINT}; RELEASE SAVEPOINT ${SAVEPOINT}`

const OUTSIDE = "extract query outside its savepoint: only BEGIN opens it"
const NESTED = "extract savepoint is already open: a second BEGIN is refused"
const CHAIN = "extract transaction chaining refused: AND CHAIN is not allowed"
const SESSION =
  "extract session setting refused: a session-level SET or RESET outlives the transaction; use SET LOCAL"
const TRANSACTION_SETTING =
  "extract SET TRANSACTION refused: the transaction belongs to the apply runner"
const ROW_LOCK = "extract read refused: row locks (FOR …) are not reads"
const INTO = "extract read refused: SELECT INTO writes a table"
const WRITE = "extract read refused: it carries a data-modifying statement"

/** Оператори, що пишуть, де б вони не стояли: у CTE `SELECT` теж. */
const WRITES = new Set(["InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"])

/**
 * Функції, яким у витягу не місце.
 *
 * - `pg_export_snapshot` Postgres у підтранзакції однаково відхиляє, і
 *   помилка аварійно закрила б точку збереження; сторож називає причину до
 *   сервера.
 * - `nextval` і `setval`: зсув послідовності не відкочує ні `ROLLBACK TO`,
 *   ні `ROLLBACK`, тож витяг лишив би слід на цілі.
 * - Сесійні advisory-замки: замок переживає і точку збереження, і
 *   транзакцію раннера, а за пулером — і саму сесію застосування.
 *   Транзакційні `*_xact_*` знімає кінець транзакції, їх дозволено.
 *
 * Старий шлях витягу (`READ ONLY`-транзакція) ці функції блокував сам
 * Postgres; точка збереження `READ ONLY` не буває, тож межу тримає сторож.
 */
const REFUSED_FUNCTIONS = new Set([
  "pg_export_snapshot",
  "nextval",
  "setval",
  "pg_advisory_lock",
  "pg_advisory_lock_shared",
  "pg_try_advisory_lock",
  "pg_try_advisory_lock_shared",
])

export type VettedSavepointQuery =
  | {
      ok: true
      /** Текст до відправки: керування транзакцією двигуна замінено. */
      text: string
      /** Чи відкрита точка збереження після цього запиту. */
      inSavepoint: boolean
    }
  | { ok: false; reason: string }

/**
 * Перевірка запиту витягу за деревом розбору. Поза точкою збереження —
 * лише `BEGIN` у будь-якій формі (його опції не мають значення: ізоляцію й
 * режим має транзакція раннера, а читання тримає цей сторож, бо точка
 * збереження не буває `READ ONLY`). Усередині — `SELECT` без блокувань
 * рядків, `INTO` і операторів запису на будь-якій глибині, `SHOW`,
 * `SET LOCAL`, і `COMMIT`/`ROLLBACK` без `AND CHAIN`. Решта — відмова.
 * Заміна — за позиціями операторів, тож решта тексту пакета лишається
 * байт у байт.
 *
 * Модель загрози та сама, що в `vetTargetQuery`: випадковий запис двигуном
 * чи нашим кодом, а не зловмисник; функції з побічними ефектами в `SELECT`
 * сторож не перелічує, крім названих.
 */
export function vetSavepointQuery(
  text: string,
  inSavepoint: boolean,
  parse: SqlParser
): VettedSavepointQuery {
  const parsed = parse(text)
  if (!parsed.ok)
    return {
      ok: false,
      reason: `extract query does not parse: ${parsed.message}`,
    }
  let open = inSavepoint
  const rewrites: { from: number; to: number; text: string }[] = []
  for (const { stmt, start, end } of parsed.statements) {
    const from = statementStart(text, start)
    if (!open) {
      if (
        "TransactionStmt" in stmt &&
        stmt.TransactionStmt.kind === "TRANS_STMT_BEGIN"
      ) {
        rewrites.push({ from, to: end, text: OPEN })
        open = true
        continue
      }
      return { ok: false, reason: OUTSIDE }
    }
    if ("TransactionStmt" in stmt) {
      const t = stmt.TransactionStmt
      switch (t.kind) {
        case "TRANS_STMT_BEGIN":
        case "TRANS_STMT_START":
          return { ok: false, reason: NESTED }
        case "TRANS_STMT_COMMIT":
        case "TRANS_STMT_ROLLBACK":
          if (t.chain === true) return { ok: false, reason: CHAIN }
          rewrites.push({ from, to: end, text: CLOSE })
          open = false
          continue
        default:
          return {
            ok: false,
            reason: `extract transaction statement refused: ${t.kind}`,
          }
      }
    }
    if ("VariableSetStmt" in stmt) {
      const v = stmt.VariableSetStmt
      // `SET [LOCAL] TRANSACTION …` і `SET TRANSACTION SNAPSHOT` міняли б
      // транзакцію раннера, а не точку збереження
      if (
        v.kind === "VAR_SET_MULTI" &&
        (v.name ?? "").startsWith("TRANSACTION")
      )
        return { ok: false, reason: TRANSACTION_SETTING }
      if (v.is_local !== true) return { ok: false, reason: SESSION }
      continue
    }
    if ("VariableShowStmt" in stmt) continue
    if ("SelectStmt" in stmt) {
      const refusal = readRefusal(stmt)
      if (refusal !== undefined) return { ok: false, reason: refusal }
      continue
    }
    return {
      ok: false,
      reason: `extract statement refused: ${Object.keys(stmt)[0]}`,
    }
  }
  let out = text
  for (const r of rewrites.reverse())
    out = `${out.slice(0, r.from)}${r.text}${out.slice(r.to)}`
  return { ok: true, text: out, inSavepoint: open }
}

/**
 * Що робить `SELECT` не читанням, на будь-якій глибині дерева: підзапит з
 * `FOR UPDATE` блокує рядки так само, а CTE з `DELETE` пише.
 */
function readRefusal(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const refusal = readRefusal(item)
      if (refusal !== undefined) return refusal
    }
    return undefined
  }
  if (typeof node !== "object" || node === null) return undefined
  for (const [key, value] of Object.entries(node)) {
    if (key === "lockingClause" && Array.isArray(value) && value.length > 0)
      return ROW_LOCK
    if (key === "intoClause") return INTO
    if (WRITES.has(key)) return WRITE
    if (key === "FuncCall") {
      const name = functionName(value)
      if (name !== undefined && REFUSED_FUNCTIONS.has(name))
        return `extract read refused: ${name}() is not allowed`
    }
    const refusal = readRefusal(value)
    if (refusal !== undefined) return refusal
  }
  return undefined
}

/** Ім'я функції без схеми; некваліфіковане парсер уже звів до нижнього регістру. */
function functionName(call: unknown): string | undefined {
  const parts = (call as { funcname?: unknown }).funcname
  if (!Array.isArray(parts) || parts.length === 0) return undefined
  const last = parts[parts.length - 1] as { String?: { sval?: unknown } }
  const name = last.String?.sval
  return typeof name === "string" ? name : undefined
}

/** Стан точки збереження пулу-обгортки: для закриття після витягу. */
const states = new WeakMap<pg.Pool, { open: boolean; query: RawQuery }>()

type Done = (release?: Error | boolean) => void
type ConnectCallback = (
  error: Error | undefined,
  client: pg.PoolClient | undefined,
  done: Done
) => void

const noop = () => {}

/**
 * Пул-обгортка над клієнтом відкритої транзакції для витягу двигуна. Нові
 * об'єкти, а не правка клієнта: pg-delta (`connectWithErrorListener`) і
 * `readOnlyQuery` викликають `on` і `removeListener` та перепризначають
 * `release`, а транзакційний клієнт раннера далі потрібен як був.
 *
 * - Клієнт: `query` — через `vetSavepointQuery`; `on`, `removeListener`,
 *   `release` — нічого не роблять.
 * - Пул: `connect` у формі промісу й колбека (колбек отримує порожній
 *   `done`); `query` — `readOnlyQuery` цього пулу, як у
 *   `readOnlyTransactionPool`, бо pg-delta кличе `pool.query` напряму
 *   (`resolveProfile`); `end` і `on` нічого не роблять.
 *
 * На відміну від `guard` у `read-only.ts`, помилка оператора всередині точки
 * збереження лишає її відкритою: підтранзакцію закриває лише відкат, тож
 * наступний `ROLLBACK` двигуна сторож мусить прийняти й замінити. `trace`
 * збирає кожну заміну як «оригінал → заміна».
 */
export function savepointPool(
  client: pg.PoolClient,
  parse: SqlParser,
  trace?: string[]
): pg.Pool {
  const raw = client.query.bind(client) as RawQuery
  const state = { open: false, query: raw }
  const query: RawQuery = (...args) => {
    const text = textOf(args[0])
    if (text === undefined) return refuseQuery(args, new Error(OUTSIDE))
    const vetted = vetSavepointQuery(text, state.open, parse)
    if (!vetted.ok) return refuseQuery(args, new Error(vetted.reason))
    const rewritten = vetted.text !== text
    if (rewritten) trace?.push(`${text} → ${vetted.text}`)
    // Стан — до відповіді сервера, і помилка сервера його не скидає
    state.open = vetted.inSavepoint
    return raw(...(rewritten ? withText(args, vetted.text) : args))
  }
  // Новий клієнт на кожне взяття: перепризначений двигуном `release` не
  // переходить до наступного виклику
  const checkout = () =>
    ({
      query,
      on: noop,
      removeListener: noop,
      release: noop,
    }) as unknown as pg.PoolClient
  function connect(): Promise<pg.PoolClient>
  function connect(callback: ConnectCallback): void
  function connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    const taken = checkout()
    if (callback === undefined) return Promise.resolve(taken)
    process.nextTick(() => callback(undefined, taken, noop))
  }
  const pool = {
    connect,
    query: (...args: unknown[]) =>
      readOnlyQuery(pool, async (c) => (c.query as RawQuery).apply(c, args)),
    end: async () => {},
    on: noop,
  } as unknown as pg.Pool
  states.set(pool, state)
  return pool
}

/**
 * Закриває точку збереження, яку двигун лишив відкритою (виняток між
 * `BEGIN` і `ROLLBACK`); закриту не чіпає.
 */
export async function closeSavepoint(pool: pg.Pool): Promise<void> {
  const state = states.get(pool)
  if (state === undefined) throw new Error("not a savepoint pool")
  if (!state.open) return
  state.open = false
  await state.query(CLOSE)
}
