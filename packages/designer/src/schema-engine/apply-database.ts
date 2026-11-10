import pg from "pg"
import {
  ApplyConnectionLost,
  ApplyDbError,
  ENGINE_SESSION_TIMEOUTS,
  type ApplyDatabase,
  type ApplyTransaction,
} from "simetra/schema"
import { extractOnTransactionClient } from "./pg-delta/adapter"

/**
 * Прелюдія оператора `statement` (окреме з'єднання без транзакції, тому `SET`,
 * а не `SET LOCAL`). Таймаути беруться з `ENGINE_SESSION_TIMEOUTS`, тим самим
 * переліком, що й прелюдія транзакції кластера.
 */
export const STATEMENT_PRELUDE: readonly string[] = [
  "SET ROLE NONE",
  "SET search_path = pg_catalog, pg_temp",
  "SET default_transaction_read_only = off",
  ...ENGINE_SESSION_TIMEOUTS.map((guc) => `SET ${guc} = 0`),
]

/**
 * Збій транспорту без SQLSTATE, який кидає сам драйвер `pg`: сокет закрито,
 * з'єднання вже непридатне чи протокол розсинхронізовано. Текст лише
 * розпізнається, ніколи не цитується далі.
 */
const TRANSPORT_MESSAGE =
  /^(?:Connection terminated|timeout expired|Query read timeout|Received unexpected )|is not queryable$/

/** Мережеві коди Node (`ECONNRESET`, `EPIPE`); `ERR_*` — помилки програми. */
const NETWORK_CODE = /^E[A-Z]+$/

/**
 * Поля помилки сервера, які порт передає далі: лише рядкові значення, бо
 * `pg` лишає неіснуючі поля відсутніми, а не `null`. Текст `message` і
 * `detail` назовні ідуть тільки через білий список споживача.
 */
function errorFields(
  error: Error
): ConstructorParameters<typeof ApplyDbError>[2] {
  const source = error as unknown as Record<string, unknown>
  const pick = (key: string): string | undefined =>
    typeof source[key] === "string" ? source[key] : undefined
  return {
    detail: pick("detail"),
    column: pick("column"),
    constraint: pick("constraint"),
    table: pick("table"),
  }
}

/**
 * Помилку з драйвера — у помилку порту. Втрата з'єднання — лише клас `08`,
 * `57P01` (адмін-завершення backend) і збій транспорту без SQLSTATE: тоді
 * результат транзакції невідомий, відкочувати нічим. Інша помилка без
 * SQLSTATE — помилка програми (`TypeError` від параметра, що не
 * серіалізується): вона летить як є, а не маскується під обрив, після якого
 * раннер шукав би застосування в ledger.
 */
export function normalize(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const code = (error as { code?: unknown }).code
  if (
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !NETWORK_CODE.test(code)
  )
    return code.startsWith("08") || code === "57P01"
      ? new ApplyConnectionLost(error.message)
      : new ApplyDbError(error.message, code, errorFields(error))
  const transport =
    typeof code === "string"
      ? NETWORK_CODE.test(code)
      : !(
          error instanceof TypeError ||
          error instanceof RangeError ||
          error instanceof ReferenceError ||
          error instanceof SyntaxError
        ) && TRANSPORT_MESSAGE.test(error.message)
  return transport ? new ApplyConnectionLost(error.message) : error
}

/**
 * Реалізація порту на `pg`. Гарантії живуть у транзакції, а не в сесії
 * (спека промоції §7.2): жодного сесійного `SET`, ізоляцію й режим читання
 * задає `BEGIN`. Пул створюється на виклик і закривається в `finally`.
 */
export function createApplyDatabase(o: { readOnly: boolean }): ApplyDatabase {
  return {
    async transaction(db, end, fn) {
      const pool = new pg.Pool({ connectionString: db.url, max: 1 })
      // Помилка простого клієнта (обрив backend) не має валити процес: вона
      // вже дійде до виклику через запит у транзакції
      pool.on("error", () => {})
      try {
        // Помилки підключення (ще немає з'єднання) прокидаються як є: їх
        // класифікує `withDatabase`
        const client = await pool.connect()
        // Взятий з пулу клієнт не має слухача `error` від пулу: обрив backend
        // без нього був би необробленою подією; причина йде через запит
        client.on("error", () => {})
        let lost = false
        /** Помилку драйвера — у помилку порту; обрив позначає з'єднання втраченим. */
        const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
          try {
            return await call()
          } catch (error) {
            const normalized = normalize(error)
            if (normalized instanceof ApplyConnectionLost) lost = true
            throw normalized
          }
        }
        const run = (
          sql: string,
          params?: readonly unknown[]
        ): Promise<Record<string, unknown>[]> =>
          guarded(
            async () =>
              (await client.query(sql, params as unknown[])).rows as Record<
                string,
                unknown
              >[]
          )
        const tx: ApplyTransaction = {
          query: async <R extends Record<string, unknown>>(
            sql: string,
            params?: readonly unknown[]
          ) => (await run(sql, params)) as R[],
          extract: (scope) =>
            guarded(() => extractOnTransactionClient(client, scope)),
        }
        try {
          // Режим запису теж явний: база з `default_transaction_read_only` не
          // має ховати запис за налаштуванням. Ізоляція також явна, не з
          // налаштувань бази: кожен оператор бачить коміти, зроблені до нього.
          // На цьому стоять читання відбитка після `LOCK TABLE` і пошук
          // `applyId` після advisory lock: за `REPEATABLE READ` знімок узяв би
          // перший оператор транзакції
          await run(
            o.readOnly
              ? "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"
              : "BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE"
          )
          const value = await fn(tx)
          await run(end === "commit" ? "COMMIT" : "ROLLBACK")
          return value
        } catch (error) {
          // Втрачене з'єднання не відкочується: вторинна помилка `ROLLBACK`
          // замаскувала б причину
          if (!lost) await run("ROLLBACK").catch(() => {})
          throw error
        } finally {
          // `true` знищує з'єднання, а не повертає в пул: після обриву чи
          // невдалого `ROLLBACK` стан сесії невідомий
          client.release(lost)
        }
      } finally {
        await pool.end()
      }
    },
    async statement(db, sql) {
      if (o.readOnly)
        throw new Error("statement is not allowed on a read-only port")
      // Окремий клієнт без `BEGIN`: `CREATE DATABASE` не живе в транзакції.
      // Прелюдія знімає сесійні налаштування, які цільова база чи роль
      // могли б підмінити (читання, таймаути, шлях пошуку, роль)
      const client = new pg.Client({ connectionString: db.url })
      client.on("error", () => {})
      await client.connect()
      try {
        for (const prelude of STATEMENT_PRELUDE) await client.query(prelude)
        await client.query(sql)
      } catch (error) {
        throw normalize(error)
      } finally {
        await client.end().catch(() => {})
      }
    },
  }
}
