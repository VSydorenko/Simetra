import { describe, expect, it } from "vitest"
import { localize } from "simetra/compiler"
import {
  ApplyDbError,
  CheckNameTaken,
  isRetryable,
  FUNCTION_ERROR_LIMIT,
  FUNCTION_SCOPE_SQL,
  newFunctionErrors,
  planFunctionChecks,
  PlpgsqlCheckUnavailable,
  readBlindFunctions,
  readPlpgsqlErrors,
  readValidatorErrors,
  RETRYABLE_SQLSTATES,
  UNAPPLIED_FUNCTION_SETTINGS,
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
    // Обидві помилки «після» збігаються з єдиною помилкою базової лінії: та,
    // що з іншим oid, — за сигнатурою, та, що з тим самим, — за oid. Один
    // жадібний прохід за порядком віддав би базову лінію першій і назвав би
    // новою помилку функції, яка її мала
    const extra = e({ oid: "300" })
    const same = e({ oid: "100" })
    expect(newFunctionErrors([e({ oid: "100" })], [extra, same])).toEqual([
      extra,
    ])
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

/** Факти `plpgsql_check` цілі: типово нічого немає й нічого не можна. */
const facts = (over: Record<string, unknown> = {}) => ({
  installed: false,
  schema: null,
  schemaUsage: false,
  functionExecute: false,
  available: false,
  trusted: false,
  superuser: false,
  createOnDatabase: false,
  checkSchemaTaken: false,
  ...over,
})

const factsTx = (over: Record<string, unknown> = {}) =>
  fakeTx((sql) =>
    sql.includes("pg_available_extension_versions") ? [facts(over)] : []
  ).tx

describe("planFunctionChecks", () => {
  const mode = async (
    over: Record<string, unknown>,
    installable: readonly string[] = []
  ) =>
    (await planFunctionChecks(factsTx(over), { promotion: false, installable }))
      .mode

  it("refuses a promotion without the extension", async () => {
    expect(
      await planFunctionChecks(factsTx(), { promotion: true, installable: [] })
    ).toMatchObject({
      mode: "unavailable",
      diagnostics: [
        { code: "plan.plpgsql-check-unavailable", severity: "error" },
      ],
    })
  })

  it("warns another plan without the extension", async () => {
    const out = await planFunctionChecks(factsTx(), {
      promotion: false,
      installable: [],
    })
    expect(out.mode).toBe("unavailable")
    expect(out.diagnostics).toHaveLength(1)
    expect(out.diagnostics[0]).toMatchObject({
      code: "plan.plpgsql-check-unavailable",
      severity: "warning",
    })
  })

  it("needs CREATE on the database to install it", async () =>
    expect(
      await mode({ available: true, trusted: true }, ["plpgsql_check"])
    ).toBe("unavailable"))

  it("installs an untrusted extension only when the role may", async () => {
    const may = { available: true, createOnDatabase: true }
    expect(await mode(may)).toBe("unavailable")
    expect(await mode(may, ["plpgsql_check"])).toBe("transient")
    expect(await mode({ ...may, trusted: true })).toBe("transient")
    expect(await mode({ ...may, superuser: true })).toBe("transient")
  })

  it("does not use an installed extension without the rights", async () => {
    const installed = {
      installed: true,
      schema: "ext",
      available: true,
      createOnDatabase: true,
      superuser: true,
    }
    expect(await mode({ ...installed, functionExecute: true })).toBe(
      "unavailable"
    )
    expect(await mode({ ...installed, schemaUsage: true })).toBe("unavailable")
  })

  it("uses an installed extension with the rights", async () =>
    expect(
      await planFunctionChecks(
        factsTx({
          installed: true,
          schema: "ext",
          schemaUsage: true,
          functionExecute: true,
        }),
        { promotion: true, installable: [] }
      )
    ).toEqual({ mode: "installed", diagnostics: [] }))
})

/** Група `plpgsql_check`: `n` однакових помилок. */
const group = (over: Record<string, unknown> = {}) => ({
  oid: "100",
  signature: "app.fp()",
  relationOid: null,
  relation: null,
  sqlstate: "42703",
  message: 'column "a" does not exist',
  n: 1,
  ...over,
})

describe("readPlpgsqlErrors", () => {
  const firstLines = (log: { sql: string }[]) =>
    log.map((l) => l.sql.split("\n")[0]!)

  it("skips the check for a plan without the extension", async () => {
    const { tx, log } = fakeTx(() => [])
    expect(await readPlpgsqlErrors(tx, "unavailable")).toBe("skipped")
    expect(log).toEqual([])
  })

  it("installs the extension in a savepoint and rolls it back", async () => {
    const { tx, log } = fakeTx((sql) =>
      sql.includes("pg_available_extension_versions")
        ? [facts({ available: true })]
        : sql.includes("plpgsql_check_function_tb(p.oid")
          ? [group({ n: 2 }), group({ oid: "101", signature: "app.g()" })]
          : []
    )
    const result = await readPlpgsqlErrors(tx, "transient")
    expect(result).toEqual({
      total: 3,
      errors: [
        e({ signature: "app.fp()" }),
        e({ signature: "app.fp()" }),
        e({ oid: "101", signature: "app.g()" }),
      ],
    })
    expect(firstLines(log)).toEqual([
      "SAVEPOINT simetra_plpgsql_check",
      "SELECT e.oid IS NOT NULL AS installed,",
      "CREATE SCHEMA simetra_plpgsql_check",
      "CREATE EXTENSION plpgsql_check SCHEMA simetra_plpgsql_check",
      "SELECT p.oid::text AS oid, p.oid::pg_catalog.regprocedure::text AS signature,",
      "ROLLBACK TO SAVEPOINT simetra_plpgsql_check",
      "RELEASE SAVEPOINT simetra_plpgsql_check",
    ])
    expect(log[4]!.sql).toContain(
      "simetra_plpgsql_check.plpgsql_check_function_tb("
    )
    expect(log[4]!.sql).toContain(`LIMIT ${FUNCTION_ERROR_LIMIT + 1}`)
  })

  it("uses an installed extension in place, in a savepoint", async () => {
    const { tx, log } = fakeTx((sql) =>
      sql.includes("pg_available_extension_versions")
        ? [
            facts({
              installed: true,
              schema: "Ext",
              schemaUsage: true,
              functionExecute: true,
            }),
          ]
        : []
    )
    expect(await readPlpgsqlErrors(tx, "installed")).toEqual({
      total: 0,
      errors: [],
    })
    expect(log.some((l) => l.sql.startsWith("CREATE"))).toBe(false)
    expect(log[2]!.sql).toContain('"Ext".plpgsql_check_function_tb(')
    expect(firstLines(log).at(-2)).toBe(
      "ROLLBACK TO SAVEPOINT simetra_plpgsql_check"
    )
  })

  it("throws when the role has no rights on the installed extension", async () => {
    const { tx, log } = fakeTx((sql) =>
      sql.includes("pg_available_extension_versions")
        ? [facts({ installed: true, schema: "ext", functionExecute: true })]
        : []
    )
    const error = await readPlpgsqlErrors(tx, "installed").catch((x) => x)
    expect(error).toBeInstanceOf(PlpgsqlCheckUnavailable)
    expect(error).toMatchObject({ sqlstate: "42501" })
    expect(firstLines(log).slice(-2)).toEqual([
      "ROLLBACK TO SAVEPOINT simetra_plpgsql_check",
      "RELEASE SAVEPOINT simetra_plpgsql_check",
    ])
  })

  it("throws with the SQLSTATE when the extension cannot be created, after rolling back", async () => {
    const { tx, log } = fakeTx((sql) => {
      if (sql.startsWith("CREATE EXTENSION"))
        throw new ApplyDbError("permission denied to create extension", "42501")
      return sql.includes("pg_available_extension_versions")
        ? [facts({ available: true })]
        : []
    })
    const error = await readPlpgsqlErrors(tx, "transient").catch((x) => x)
    expect(error).toBeInstanceOf(PlpgsqlCheckUnavailable)
    expect(error).toMatchObject({
      sqlstate: "42501",
      message: "permission denied to create extension",
    })
    expect(firstLines(log).slice(-2)).toEqual([
      "ROLLBACK TO SAVEPOINT simetra_plpgsql_check",
      "RELEASE SAVEPOINT simetra_plpgsql_check",
    ])
  })

  it("lets a lock timeout of the installation through as it is", async () => {
    const timeout = new ApplyDbError("lock timeout", "55P03")
    const { tx } = fakeTx((sql) => {
      if (sql.startsWith("CREATE SCHEMA")) throw timeout
      return sql.includes("pg_available_extension_versions")
        ? [facts({ available: true })]
        : []
    })
    await expect(readPlpgsqlErrors(tx, "transient")).rejects.toBe(timeout)
  })

  it("refuses a taken check schema", async () => {
    const { tx, log } = fakeTx((sql) =>
      sql.includes("pg_available_extension_versions")
        ? [facts({ available: true, checkSchemaTaken: true })]
        : []
    )
    const error = await readPlpgsqlErrors(tx, "transient").catch((x) => x)
    expect(error).toBeInstanceOf(CheckNameTaken)
    expect(error).toMatchObject({ taken: "simetra_plpgsql_check" })
    expect(log.some((l) => l.sql.startsWith("CREATE"))).toBe(false)
  })

  it("marks a list cut past the limit of groups", async () => {
    const { tx } = fakeTx((sql) =>
      sql.includes("pg_available_extension_versions")
        ? [facts({ available: true })]
        : sql.includes("plpgsql_check_function_tb(p.oid")
          ? Array.from({ length: FUNCTION_ERROR_LIMIT + 1 }, (_, i) =>
              group({ oid: String(i) })
            )
          : []
    )
    const result = await readPlpgsqlErrors(tx, "transient")
    expect(result).not.toBe("skipped")
    if (result === "skipped") return
    expect(result.total).toBe(FUNCTION_ERROR_LIMIT + 1)
    expect(result.errors).toHaveLength(FUNCTION_ERROR_LIMIT)
  })
})

describe("function check scope", () => {
  // Обсяг перевірки тіл — один фрагмент SQL у трьох запитах: розбіжність
  // обсягів лишила б функцію і неперевіреною, і не названою сліпою
  it("is the same fragment in the validators, the blind functions and plpgsql_check", async () => {
    const { tx, log } = fakeTx((sql) => {
      if (sql.startsWith("DO "))
        throw new ApplyDbError('{"total":0,"errors":[]}', "SIMFE")
      return sql.includes("pg_available_extension_versions")
        ? [facts({ available: true })]
        : []
    })
    await readValidatorErrors(tx)
    await readBlindFunctions(tx, "available", [])
    await readPlpgsqlErrors(tx, "transient")
    const queries = [
      log.find((l) => l.sql.startsWith("DO "))!,
      log.find((l) => l.sql.includes("AS expected"))!,
      log.find((l) => l.sql.includes("plpgsql_check_function_tb(p.oid"))!,
    ]
    for (const q of queries) expect(q.sql).toContain(FUNCTION_SCOPE_SQL)
  })
})

describe("readBlindFunctions", () => {
  it("separates the functions the provider preset expects", async () => {
    const { tx, log } = fakeTx(() => [
      { signature: "pgbouncer.get_auth(text)", expected: true },
      { signature: "pgbouncer.other(text)", expected: false },
      { signature: "app.fh()", expected: false },
    ])
    expect(
      await readBlindFunctions(tx, "available", ["pgbouncer.get_auth(text)"])
    ).toEqual({
      blind: ["app.fh()", "pgbouncer.other(text)"],
      expected: ["pgbouncer.get_auth(text)"],
    })
    expect(log[0]!.params).toEqual([true, ["pgbouncer.get_auth(text)"]])
  })
})

describe("validator block settings", () => {
  // Налаштування функції, які блок не застосовує, — один перелік; тайм-аути
  // функції не мають підмінити тайм-аути раннера
  it("does not apply the unapplied keys of the function's proconfig", async () => {
    expect(UNAPPLIED_FUNCTION_SETTINGS).toEqual([
      "check_function_bodies",
      "lock_timeout",
      "statement_timeout",
    ])
    const { tx, log } = fakeTx((sql) => {
      if (sql.startsWith("DO "))
        throw new ApplyDbError('{"total":0,"errors":[]}', "SIMFE")
      return []
    })
    await readValidatorErrors(tx)
    expect(log[1]!.sql).toContain(
      "CONTINUE WHEN pg_catalog.split_part(kv, '=', 1) IN ('check_function_bodies', 'lock_timeout', 'statement_timeout');"
    )
  })
})

describe("isRetryable", () => {
  it("is true only for a database error with a retryable SQLSTATE", () => {
    for (const s of RETRYABLE_SQLSTATES)
      expect(isRetryable(new ApplyDbError("x", s))).toBe(true)
    expect(isRetryable(new ApplyDbError("x", "42501"))).toBe(false)
    expect(isRetryable(new ApplyDbError("x", undefined))).toBe(false)
    expect(isRetryable(new Error("55P03"))).toBe(false)
  })
})

describe("plan.plpgsql-check-unavailable hint", () => {
  // На копії розширення бракує серверу копій доказу, а не цілі
  it("names the server of the copies for the copy and the database for the target", () => {
    const hint = (on: string, locale: "en" | "uk") =>
      localize(
        {
          code: "plan.plpgsql-check-unavailable",
          params: { on, sqlstate: "58P01", error: "x" },
        },
        locale
      ).hint
    expect(hint("copy", "en")).toContain("shadowBase")
    expect(hint("copy", "uk")).toContain("shadowBase")
    expect(hint("target", "en")).toContain("on the database")
    expect(hint("target", "en")).not.toContain("shadowBase")
    expect(hint("target", "uk")).not.toContain("shadowBase")
  })
})
