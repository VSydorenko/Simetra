// Окремо від connection.ts: той вантажать globalSetup і прибиральник стеку, і
// він не має тягнути за собою `src/schema`.
import pg from "pg"
import {
  readFingerprint,
  type ApplyTransaction,
  type CatalogFingerprint,
  type EngineScope,
} from "../../src/schema"

/**
 * Відбиток каталогу, яким він став би після `steps`: ті самі кроки в тій самій
 * базі-цілі, у транзакції, яку завжди відкочують. Окрема база для бажаного
 * стану давала б відбиток, який залежить від того, як вона відтворила ціль, а
 * не від самої цілі. `bodiesOff` — кроки під вимкненою валідацією тіл, як під
 * преамбулою плану.
 */
export async function fingerprintAfterSteps(
  url: string,
  scope: EngineScope,
  steps: readonly { sql: string }[],
  o: { bodiesOff?: boolean } = {}
): Promise<CatalogFingerprint> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query("BEGIN")
    try {
      if (o.bodiesOff === true)
        await client.query("SET LOCAL check_function_bodies = off")
      for (const step of steps) await client.query(step.sql)
      const tx: ApplyTransaction = {
        query: async <R extends Record<string, unknown>>(
          sql: string,
          params?: readonly unknown[]
        ) => (await client.query(sql, params as unknown[])).rows as R[],
        extract: () => {
          throw new Error("fingerprintAfterSteps: the extract is not provided")
        },
      }
      return await readFingerprint(tx, scope)
    } finally {
      // Відкат після збою кроку може сам впасти — це не має затирати причину
      await client.query("ROLLBACK").catch(() => undefined)
    }
  } finally {
    await client.end()
  }
}
