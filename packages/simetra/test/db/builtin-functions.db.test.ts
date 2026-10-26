import { describe, expect, it } from "vitest"
import {
  BUILTIN_EXCLUSIONS,
  HEAD_EXCLUDED_BUILTINS,
  REGCLASS_PARAMETER_QUERY,
  excludedBuiltin,
} from "../../src/compiler/sql/builtin-exclusions"
import {
  BUILTIN_FUNCTIONS,
  REGCLASS_BUILTINS,
} from "../../src/compiler/sql/builtin-functions"
import { withRollback } from "./connection"

/**
 * Дозвільний перелік вбудованих (Р2c1-20) проти каталогу закріпленої версії
 * Postgres — причина DB-рівня: новий мажор, що додав чи прибрав вбудовану,
 * — червоний тест і регенерація з переглядом diff, а не мовчазний дозвіл.
 */
describe("builtin function allowlist", () => {
  it("matches pg_catalog minus the exclusions, and every excluded name exists", async () => {
    const { live, regclass } = await withRollback(async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `SELECT proname AS name
         FROM pg_proc
         WHERE pronamespace = 'pg_catalog'::regnamespace AND oid < 16384
         GROUP BY proname`
      )
      const derived = await client.query<{ name: string }>(
        REGCLASS_PARAMETER_QUERY
      )
      return {
        live: new Set(rows.map((row) => row.name)),
        regclass: new Set(derived.rows.map((row) => row.name)),
      }
    })
    // Виведений клас «аргумент `regclass`» збігається з каталогом в обидва
    // боки: перелік, згенерований над іншою версією, — червоний тест.
    expect([...REGCLASS_BUILTINS].sort()).toEqual([...regclass].sort())
    const expected = new Set(
      [...live].filter((name) => !excludedBuiltin(name, regclass))
    )
    const listed = new Set(BUILTIN_FUNCTIONS)
    expect({
      extra: BUILTIN_FUNCTIONS.filter((name) => !expected.has(name)),
      missing: [...expected].filter((name) => !listed.has(name)).sort(),
    }).toEqual({ extra: [], missing: [] })
    // Точне ім'я, якого немає в каталозі, — опечатка: виключення нічого б не
    // виключило, а справжня функція лишилася б у переліку.
    expect(
      [
        ...BUILTIN_EXCLUSIONS.flatMap((e) => e.names),
        ...HEAD_EXCLUDED_BUILTINS,
      ].filter((n) => !live.has(n))
    ).toEqual([])
  })
})
