import pg from "pg"
import {
  ApplyConnectionLost,
  ApplyDbError,
  type ApplyDatabase,
  type ApplyTransaction,
} from "simetra/schema"
import { extractOnTransactionClient } from "./pg-delta/adapter"

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
 * Помилку з драйвера — у помилку порту. Втрата з'єднання — лише клас `08`,
 * `57P01` (адмін-завершення backend) і збій транспорту без SQLSTATE: тоді
 * результат транзакції невідомий, відкочувати нічим. Інша помилка без
 * SQLSTATE — помилка програми (`TypeError` від параметра, що не
 * серіалізується): вона летить як є, а не маскується під обрив, після якого
 * раннер шукав би застосування в ledger.
 */
function normalize(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const code = (error as { code?: unknown }).code
  if (
    typeof code === "string" &&
    /^[0-9A-Z]{5}$/.test(code) &&
    !NETWORK_CODE.test(code)
  )
    return code.startsWith("08") || code === "57P01"
      ? new ApplyConnectionLost(error.message)
      : new ApplyDbError(error.message, code)
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
          // Ізоляція — явно, не з налаштувань бази: кожен оператор бачить
          // коміти, зроблені до нього. На цьому стоять читання відбитка
          // після `LOCK TABLE` і пошук `applyId` після advisory lock: за
          // `REPEATABLE READ` знімок узяв би перший оператор транзакції
          await run(
            o.readOnly
              ? "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY"
              : "BEGIN ISOLATION LEVEL READ COMMITTED"
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
  }
}
