import pg from "pg"
import {
  ApplyConnectionLost,
  ApplyDbError,
  type ApplyDatabase,
  type ApplyTransaction,
} from "simetra/schema"

/**
 * Помилку з драйвера — у помилку порту. Без SQLSTATE помилка прийшла не від
 * сервера (обрив сокета), а клас `08` і `57P01` (адмін-завершення backend)
 * означають те саме: результат транзакції невідомий, відкочувати нічим.
 */
function normalize(error: unknown): ApplyDbError | ApplyConnectionLost {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: unknown }).code
      : undefined
  const sqlstate =
    typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined
  if (
    sqlstate === undefined ||
    sqlstate.startsWith("08") ||
    sqlstate === "57P01"
  )
    return new ApplyConnectionLost(message)
  return new ApplyDbError(message, sqlstate)
}

/**
 * Реалізація порту на `pg`. Гарантії живуть у транзакції, а не в сесії
 * (рішення 14 плану П3-1): жодного сесійного `SET`, режим читання задає
 * `BEGIN READ ONLY`. Пул створюється на виклик і закривається в `finally`.
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
        const run = async (
          sql: string,
          params?: readonly unknown[]
        ): Promise<Record<string, unknown>[]> => {
          try {
            const result = await client.query(sql, params as unknown[])
            return result.rows as Record<string, unknown>[]
          } catch (error) {
            const normalized = normalize(error)
            if (normalized instanceof ApplyConnectionLost) lost = true
            throw normalized
          }
        }
        const tx: ApplyTransaction = {
          query: async <R extends Record<string, unknown>>(
            sql: string,
            params?: readonly unknown[]
          ) => (await run(sql, params)) as R[],
        }
        try {
          await run(o.readOnly ? "BEGIN READ ONLY" : "BEGIN")
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
