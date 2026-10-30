import { describe, expect, it } from "vitest"
import { CATALOG_FUNCTIONS } from "../../src/compiler/operations/promote/catalog-functions"
import { withRollback } from "./connection"

/**
 * Знімок доведено детермінованих функцій каталогу проти живого Postgres стеку: дрейф версії, що зробив би
 * ім'я STABLE, VOLATILE чи функцією множини або змінив його вид, — червоний
 * тест, а не мовчазний дозвіл у кроці `fill`.
 */
describe("catalog function snapshot", () => {
  it("names only IMMUTABLE, non-set-returning functions of pg_catalog", async () => {
    const names = Object.values(CATALOG_FUNCTIONS).flat()
    const rows = await withRollback(async (client) => {
      const result = await client.query<{
        name: string
        immutable: boolean
        kinds: string[]
      }>(
        `SELECT proname AS name,
                bool_and(provolatile = 'i' AND NOT proretset) AS immutable,
                array_agg(DISTINCT prokind::text) AS kinds
         FROM pg_proc
         WHERE pronamespace = 'pg_catalog'::regnamespace AND oid < 16384
           AND proname = ANY($1)
         GROUP BY proname`,
        [names]
      )
      return result.rows
    })
    const live = new Map(rows.map((row) => [row.name, row]))
    const drift = Object.entries(CATALOG_FUNCTIONS).flatMap(([kind, list]) =>
      list.flatMap((name) => {
        const row = live.get(name)
        if (row === undefined) return [`${name}: missing`]
        if (!row.immutable) return [`${name}: not IMMUTABLE`]
        const actual = row.kinds.includes("w")
          ? "w"
          : row.kinds.includes("a")
            ? "a"
            : "f"
        return actual === kind ? [] : [`${name}: kind ${actual}, not ${kind}`]
      })
    )
    expect(drift).toEqual([])
  })
})
