import { describe, expect, it } from "vitest"
import {
  ApplyDbError,
  FUNCTION_ERROR_LIMIT,
  newFunctionErrors,
  readValidatorErrors,
  RETRYABLE_SQLSTATES,
  withLocalSettings,
  type ApplyTransaction,
  type FunctionError,
} from "simetra/schema"

/**
 * Ревалідація тіл функцій (рішення 2–4 плану П3-2b-1) на фейковій
 * транзакції: порівняння з базовою лінією, налаштування в межах транзакції
 * й транспорт результату DO-блоку. Справжня база —
 * `function-checks.db.test.ts` designer.
 */

const e = (over: Partial<FunctionError> = {}): FunctionError => ({
  oid: "100",
  signature: "app.f(integer)",
  relationOid: null,
  relation: null,
  sqlstate: "42703",
  message: 'column "a" does not exist',
  ...over,
})

describe("newFunctionErrors", () => {
  it("keeps an error that was there before", () =>
    expect(newFunctionErrors([e()], [e()])).toEqual([]))

  it("matches a recreated function by signature", () =>
    expect(newFunctionErrors([e()], [e({ oid: "200" })])).toEqual([]))

  it("matches a renamed trigger table by its oid", () =>
    expect(
      newFunctionErrors(
        [e({ relationOid: "7", relation: "app.old" })],
        [e({ relationOid: "7", relation: "app.new" })]
      )
    ).toEqual([]))

  it("reports a new message", () =>
    expect(
      newFunctionErrors([e()], [e({ message: 'column "b" does not exist' })])
    ).toHaveLength(1))

  it("counts duplicates as a multiset", () =>
    expect(newFunctionErrors([e()], [e(), e()])).toHaveLength(1))

  it("reports another function with the same message", () =>
    expect(
      newFunctionErrors([e()], [e({ oid: "300", signature: "app.g()" })])
    ).toHaveLength(1))

  it("lets a match by oid win over a match by signature", () => {
    // Перестворена функція з тією самою сигнатурою стоїть першою: жадібний
    // збіг за сигнатурою забрав би елемент, потрібний збігу за oid
    const recreated = e({ oid: "200" })
    const kept = e({ oid: "100", message: "other" })
    expect(
      newFunctionErrors(
        [e({ oid: "100", message: "other" })],
        [recreated, kept]
      )
    ).toEqual([recreated])
  })

  it("tells a trigger function checked with another table apart", () =>
    expect(
      newFunctionErrors(
        [e({ relationOid: "7", relation: "app.a" })],
        [e({ relationOid: "8", relation: "app.b" })]
      )
    ).toHaveLength(1))
})

/** Фейкова транзакція: журнал запитів і відповідь на кожен. */
function fakeTx(
  answer: (sql: string, params?: readonly unknown[]) => unknown[]
): {
  tx: ApplyTransaction
  log: { sql: string; params?: readonly unknown[] }[]
} {
  const log: { sql: string; params?: readonly unknown[] }[] = []
  return {
    log,
    tx: {
      query: async <R extends Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[]
      ): Promise<R[]> => {
        log.push({ sql, params })
        return answer(sql, params) as R[]
      },
    },
  }
}

describe("withLocalSettings", () => {
  it("reads, sets, runs and restores within the transaction", async () => {
    const { tx, log } = fakeTx((sql) =>
      sql.includes("current_setting")
        ? [{ value: '"$user", public' }, { value: "on" }]
        : []
    )
    const result = await withLocalSettings(
      tx,
      [
        { name: "search_path", value: "pg_catalog" },
        { name: "check_function_bodies", value: "off" },
      ],
      async () => {
        await tx.query("RUN")
        return 42
      }
    )
    expect(result).toBe(42)
    expect(
      log.map(
        (l) =>
          l.sql.split(/\s/)[0] + (l.sql.includes("set_config") ? " set" : "")
      )
    ).toEqual(["SELECT", "SELECT set", "RUN", "SELECT set"])
    expect(log[0]!.params).toEqual([["search_path", "check_function_bodies"]])
    expect(log[1]!.params).toEqual([
      ["search_path", "check_function_bodies"],
      ["pg_catalog", "off"],
    ])
    expect(log[3]!.params).toEqual([
      ["search_path", "check_function_bodies"],
      ['"$user", public', "on"],
    ])
    // Лише налаштування транзакції: сесійне значення осіло б за пулером
    for (const { sql } of log.filter((l) => l.sql.includes("set_config")))
      expect(sql).toMatch(/set_config\([^)]*, true\)/)
    expect(log.some((l) => /set_config\([^)]*false\)/.test(l.sql))).toBe(false)
  })

  it("runs without a query when there is nothing to set", async () => {
    const { tx, log } = fakeTx(() => [])
    expect(await withLocalSettings(tx, [], async () => "x")).toBe("x")
    expect(log).toEqual([])
  })

  it("lets an error of the run through without restoring", async () => {
    const { tx, log } = fakeTx((sql) =>
      sql.includes("current_setting") ? [{ value: "on" }] : []
    )
    await expect(
      withLocalSettings(
        tx,
        [{ name: "check_function_bodies", value: "off" }],
        async () => {
          throw new Error("boom")
        }
      )
    ).rejects.toThrow("boom")
    // Спроба зупиняється, транзакцію відкочено: повертати нічого
    expect(log).toHaveLength(2)
  })
})

describe("readValidatorErrors", () => {
  const result = {
    total: 2,
    errors: [
      {
        oid: "100",
        signature: "app.f()",
        sqlstate: "42703",
        message: 'column "a" does not exist',
      },
      { oid: "101", signature: "app.g()", sqlstate: "42P01", message: "x" },
    ],
  }

  it("parses the result the block raises and rolls back its savepoint", async () => {
    const { tx, log } = fakeTx((sql) => {
      if (sql.startsWith("DO "))
        throw new ApplyDbError(JSON.stringify(result), "SIMFE")
      return []
    })
    expect(await readValidatorErrors(tx)).toEqual({
      total: 2,
      errors: result.errors.map((r) => ({
        ...r,
        relationOid: null,
        relation: null,
      })),
    })
    expect(log.map((l) => l.sql.split("\n")[0])).toEqual([
      "SAVEPOINT simetra_revalidate",
      "DO $simetra$",
      "ROLLBACK TO SAVEPOINT simetra_revalidate",
      "RELEASE SAVEPOINT simetra_revalidate",
    ])
  })

  it("re-raises the retryable SQLSTATEs and keeps the error limit in the block", async () => {
    const { tx, log } = fakeTx((sql) => {
      if (sql.startsWith("DO "))
        throw new ApplyDbError(JSON.stringify(result), "SIMFE")
      return []
    })
    await readValidatorErrors(tx)
    const block = log[1]!.sql
    for (const s of RETRYABLE_SQLSTATES) expect(block).toContain(`'${s}'`)
    expect(block).toContain(`IF total <= ${FUNCTION_ERROR_LIMIT} THEN`)
  })

  it("lets a lock timeout through as it is", async () => {
    const timeout = new ApplyDbError(
      "canceling statement due to lock timeout",
      "55P03"
    )
    const { tx, log } = fakeTx((sql) => {
      if (sql.startsWith("DO ")) throw timeout
      return []
    })
    await expect(readValidatorErrors(tx)).rejects.toBe(timeout)
    expect(log.some((l) => l.sql.startsWith("ROLLBACK TO"))).toBe(false)
  })

  it("throws when the block ends without its result", async () => {
    const { tx } = fakeTx(() => [])
    await expect(readValidatorErrors(tx)).rejects.toThrow(/without its result/)
  })
})
