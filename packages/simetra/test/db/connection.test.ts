import { readFileSync } from "node:fs"
import {
  PROVIDER_OWNER_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
} from "simetra/model"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  asSessionLogin,
  asStackSuperuser,
  expectClientRole,
  isRunTag,
  loginUrl,
  newRunTag,
  RUN_TAG_ENV,
  runObjectPatterns,
  runObjectStatementPattern,
  runTag,
  runTagOf,
  SHADOW_PREFIX,
  shadowAgeMinutes,
  shadowSuffix,
  testDatabaseName,
  testDatabaseUrl,
  testPoolerUrl,
  rollbackChecked,
  setLocalSetting,
  type SwitchClient,
  testOwnerLoginUrl,
  testRoleName,
  testSuperuserUrl,
  withSessionOptions,
} from "./connection"
import { PROVIDER_ENV, TEST_STACKS } from "./profile"

describe("shadowAgeMinutes", () => {
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)

  it("reads the age in minutes from the base36 millisecond stamp", () => {
    const created = NOW - 90 * 60_000
    expect(
      shadowAgeMinutes(`${SHADOW_PREFIX}${created.toString(36)}_x`, NOW)
    ).toBeCloseTo(90, 5)
  })

  it("treats a name of another shape as unknown, not as old", () => {
    expect(shadowAgeMinutes("pgdelta_shadow_zz")).toBeUndefined()
    expect(shadowAgeMinutes("other")).toBeUndefined()
  })
})

describe("connection.ts weight", () => {
  // globalSetup і прибиральник вантажать цей модуль у головному процесі та в
  // spawnSync, тож він має лишатися легким
  it("imports nothing from the package sources", () => {
    const source = readFileSync(
      new URL("./connection.ts", import.meta.url),
      "utf8"
    )
    expect(source).not.toMatch(/from\s+"\.\.\/\.\.\/src/)
  })
})

describe("run tag names", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("generates a tag of 6 chars [0-9a-z]", () => {
    expect(newRunTag()).toMatch(/^[0-9a-z]{6}$/)
  })

  it("refuses to work without the tag set by the stack-guard", () => {
    vi.stubEnv(RUN_TAG_ENV, "")
    delete process.env[RUN_TAG_ENV]
    expect(() => runTag()).toThrow(/stack-guard/)
  })

  it("builds role names from the label and the tag", () => {
    vi.stubEnv(RUN_TAG_ENV, "abc123")
    expect(testRoleName("build_plan_owner")).toBe(
      "simetra_build_plan_owner_abc123"
    )
    expect(() => testRoleName("Bad-Label")).toThrow()
  })

  it("matches own names with the run patterns", () => {
    vi.stubEnv(RUN_TAG_ENV, "abc123")
    const { databases, roles } = runObjectPatterns("abc123")
    expect(testDatabaseName("copy")).toMatch(databases)
    expect(SHADOW_PREFIX + shadowSuffix()).toMatch(databases)
    expect(testRoleName("x")).toMatch(roles)
  })

  it("reads the shadow age from the tagged name", () => {
    vi.stubEnv(RUN_TAG_ENV, "abc123")
    expect(shadowAgeMinutes(SHADOW_PREFIX + shadowSuffix())).toBeLessThan(1)
  })

  it("does not match foreign names", () => {
    const { databases, roles } = runObjectPatterns("abc123")
    for (const name of [
      "pgdelta_shadow_mv9rieqo_6uepn5",
      "metahub_copy",
      "metahub_copy_rehearsal",
      "p3_3_spike_a",
      "simetra_build_plan_owner",
      "simetra_copy_zzz999_k3j2h1",
      "postgres",
    ]) {
      expect(name).not.toMatch(databases)
      expect(name).not.toMatch(roles)
    }
  })
})

describe("runObjectStatementPattern", () => {
  const statement = runObjectStatementPattern("abc123")

  it("matches statements that create the run's objects", () => {
    for (const sql of [
      'CREATE DATABASE "simetra_copy_abc123_k3j2h1" TEMPLATE x',
      'create database "pgdelta_shadow_mv9rieqo_abc123_6uepn5" template template0',
      "CREATE ROLE simetra_x_abc123 nologin",
      "CREATE ROLE simetra_x_abc123",
    ])
      expect(sql).toMatch(statement)
  })

  it("does not match another run's or untagged names", () => {
    for (const sql of [
      'CREATE DATABASE "simetra_copy_zzz999_k3j2h1" TEMPLATE x',
      'create database "pgdelta_shadow_mv9rieqo_zzz999_6uepn5" template template0',
      "CREATE ROLE simetra_x_zzz999 nologin",
      'CREATE DATABASE "pgdelta_shadow_mv9rieqo_6uepn5"',
      "CREATE ROLE simetra_build_plan_owner",
      "CREATE ROLE simetra_x_abc1234 nologin",
      'CREATE DATABASE "metahub_copy" TEMPLATE x',
      "DROP DATABASE simetra_copy_abc123_k3j2h1",
    ])
      expect(sql).not.toMatch(statement)
  })
})

describe("runTagOf", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("reads the tag from the run's own databases, shadows and roles", () => {
    vi.stubEnv(RUN_TAG_ENV, "abc123")
    expect(runTagOf("database", testDatabaseName("copy"))).toBe("abc123")
    expect(runTagOf("database", testDatabaseName("build_plan_owner"))).toBe(
      "abc123"
    )
    expect(runTagOf("database", SHADOW_PREFIX + shadowSuffix())).toBe("abc123")
    expect(runTagOf("role", testRoleName("build_plan_owner"))).toBe("abc123")
  })

  it("agrees with the run patterns of the tag it returns", () => {
    vi.stubEnv(RUN_TAG_ENV, "zz9zz9")
    const { databases, roles } = runObjectPatterns("zz9zz9")
    for (const name of [testDatabaseName("x"), SHADOW_PREFIX + shadowSuffix()])
      expect(runTagOf("database", name) !== undefined).toBe(
        databases.test(name)
      )
    expect(runTagOf("role", testRoleName("x"))).toBe("zz9zz9")
    expect(testRoleName("x")).toMatch(roles)
  })

  it("finds no tag in untagged names", () => {
    for (const name of [
      "pgdelta_shadow_mv9rieqo_6uepn5",
      "metahub_copy",
      "metahub_copy_rehearsal",
      "p3_3_spike_a",
      "simetra_build_plan_owner",
      "postgres",
    ]) {
      expect(runTagOf("database", name)).toBeUndefined()
      expect(runTagOf("role", name)).toBeUndefined()
    }
  })

  it("reads a name by the shape of its own catalog", () => {
    // Ім'я ролі — без випадкового хвоста бази, тож як база воно не тегове
    expect(runTagOf("database", "simetra_x_abc123")).toBeUndefined()
    expect(runTagOf("database", "simetra_copy_abc123_k3j2h1")).toBe("abc123")
  })
})

describe("isRunTag", () => {
  it("accepts only 6 characters [0-9a-z]", () => {
    expect(isRunTag(newRunTag())).toBe(true)
    for (const value of ["", "abc12", "abc1234", "ABC123", "abc.12", ".*"])
      expect(isRunTag(value)).toBe(false)
  })
})

describe("stack addresses by profile", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("takes the defaults from the profile", () => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    vi.stubEnv("SIMETRA_TEST_DATABASE_URL", "")
    vi.stubEnv("SIMETRA_TEST_SUPERUSER_URL", "")
    delete process.env.SIMETRA_TEST_DATABASE_URL
    delete process.env.SIMETRA_TEST_SUPERUSER_URL
    expect(testDatabaseUrl()).toBe(TEST_STACKS.postgres.databaseUrl)
    expect(testSuperuserUrl()).toBe(TEST_STACKS.postgres.superuserUrl)
  })

  it("refuses a pooler address on a profile without a pooler", () => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    vi.stubEnv("SIMETRA_TEST_POOLER_URL", "")
    delete process.env.SIMETRA_TEST_POOLER_URL
    expect(() => testPoolerUrl()).toThrow(/no pooler/)
  })

  it("lets SIMETRA_TEST_* variables override the profile", () => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    vi.stubEnv("SIMETRA_TEST_DATABASE_URL", "postgresql://a@h/db")
    vi.stubEnv("SIMETRA_TEST_SUPERUSER_URL", "postgresql://b@h/db")
    vi.stubEnv("SIMETRA_TEST_POOLER_URL", "postgresql://c@h/db")
    expect(testDatabaseUrl()).toBe("postgresql://a@h/db")
    expect(testSuperuserUrl()).toBe("postgresql://b@h/db")
    expect(testPoolerUrl()).toBe("postgresql://c@h/db")
  })
})

/**
 * Підставний клієнт: записує оператори з параметрами й відповідає рядками
 * `answer`; стан транзакції — `tx`.
 */
function fakeClient(
  answer: (sql: string) => Record<string, unknown>[] = () => [],
  tx: () => string | null = () => "T"
): SwitchClient & { sql: string[] } {
  const sql: string[] = []
  return {
    sql,
    getTransactionStatus: tx,
    query: async <R>(text: string, params?: unknown[]) => {
      sql.push(
        params === undefined ? text : `${text} ${JSON.stringify(params)}`
      )
      return { rows: answer(text) as R[] }
    },
  }
}

describe("login and session options of a URL", () => {
  const tests = TEST_STACKS.postgres.databaseUrl

  it("loginUrl drops the options parameter and sets the login", () => {
    const url = new URL(loginUrl(tests, "simetra_auth", "p@ss"))
    expect(url.searchParams.has("options")).toBe(false)
    expect(url.username).toBe("simetra_auth")
    expect(decodeURIComponent(url.password)).toBe("p@ss")
    expect(url.pathname).toBe("/simetra")
  })

  it("withSessionOptions keeps -c role= and appends the extra settings", () => {
    const url = new URL(withSessionOptions(tests, "-c bytea_output=escape"))
    expect(url.searchParams.getAll("options")).toEqual([
      `-c role=${PROVIDER_OWNER_ROLES.postgres} -c bytea_output=escape`,
    ])
    const plain = new URL(
      withSessionOptions("postgresql://u@h/db", "-c jit=off")
    )
    expect(plain.searchParams.getAll("options")).toEqual(["-c jit=off"])
  })

  // У pg-connection-string перемагає останній параметр, і роль губиться
  it("withSessionOptions refuses a URL with two options parameters", () => {
    expect(() =>
      withSessionOptions(`${tests}&options=-c%20jit%3Doff`, "-c x=y")
    ).toThrow(/several options/)
  })
})

describe("testOwnerLoginUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("postgres: a direct login of the owner, without options", () => {
    vi.stubEnv(PROVIDER_ENV, "postgres")
    vi.stubEnv("SIMETRA_TEST_DATABASE_URL", "")
    delete process.env.SIMETRA_TEST_DATABASE_URL
    const url = new URL(testOwnerLoginUrl())
    expect(url.username).toBe(PROVIDER_OWNER_ROLES.postgres)
    expect(url.password).not.toBe("")
    expect(url.searchParams.has("options")).toBe(false)
    expect(url.pathname).toBe("/simetra")
  })

  it("supabase: the owner is the login, so it is the test URL itself", () => {
    vi.stubEnv(PROVIDER_ENV, "supabase")
    expect(testOwnerLoginUrl()).toBe(testDatabaseUrl())
  })
})

describe("role switch helpers", () => {
  const roles = (sql: string): Record<string, unknown>[] =>
    sql.startsWith("SELECT session_user")
      ? [{ session: "postgres", role: "simetra_command", path: "public" }]
      : sql.startsWith("SELECT current_user")
        ? [{ role: "simetra_command", path: '"$user", public' }]
        : []

  it("asStackSuperuser restores the previous role and search_path before RELEASE", async () => {
    const client = fakeClient(roles)
    expect(await asStackSuperuser(client, async () => 7)).toBe(7)
    expect(client.sql).toEqual([
      "SAVEPOINT stack_superuser",
      "SELECT current_user AS role, current_setting('search_path') AS path",
      "SET LOCAL ROLE NONE",
      "SET LOCAL search_path = pg_catalog, pg_temp",
      `SELECT set_config('role', $1, true), set_config('search_path', $2, true) ["simetra_command","\\"$user\\", public"]`,
      "RELEASE SAVEPOINT stack_superuser",
    ])
  })

  it("asStackSuperuser rolls the savepoint back and rethrows on failure", async () => {
    const client = fakeClient(roles)
    await expect(
      asStackSuperuser(client, () => Promise.reject(new Error("boom")))
    ).rejects.toThrow("boom")
    expect(client.sql.slice(-1)).toEqual([
      "ROLLBACK TO SAVEPOINT stack_superuser",
    ])
  })

  it("the helpers refuse to run outside a transaction", async () => {
    const client = fakeClient(roles, () => "I")
    await expect(asStackSuperuser(client, async () => 1)).rejects.toThrow(
      /only inside a transaction/
    )
    await expect(
      asSessionLogin(client, "simetra_owner", async () => 1)
    ).rejects.toThrow(/only inside a transaction/)
    expect(client.sql).toEqual([])
  })

  // Відновлюється попередня роль (тут — команд), а не роль власника: інакше
  // решта транзакції йшла б від власника з BYPASSRLS
  it.each<[string, () => Promise<number>]>([
    ["success", async (): Promise<number> => 1],
    ["failure", (): Promise<number> => Promise.reject(new Error("boom"))],
  ])(
    "asSessionLogin restores the previous session_user, current_user and search_path on %s",
    async (_path, fn) => {
      const client = fakeClient(roles)
      await asSessionLogin(client, "simetra_owner", fn).catch(() => undefined)
      const restore = [
        "SET LOCAL SESSION AUTHORIZATION postgres",
        "SET LOCAL ROLE simetra_command",
        `SELECT set_config('search_path', $1, true) ["public"]`,
      ]
      expect(client.sql).toEqual([
        "SAVEPOINT session_login",
        "SELECT session_user AS session, current_user AS role, current_setting('search_path') AS path",
        "SET LOCAL SESSION AUTHORIZATION simetra_owner",
        ...(_path === "success"
          ? [...restore, "RELEASE SAVEPOINT session_login"]
          : ["ROLLBACK TO SAVEPOINT session_login", ...restore]),
      ])
    }
  )

  it("setLocalSetting sets a named platform setting for the transaction", async () => {
    const client = fakeClient()
    await setLocalSetting(client, SESSION_CLAIMS_SETTING, "{}")
    await setLocalSetting(client, RIGHTS_MAINTENANCE_SETTING, "on")
    expect(client.sql).toEqual([
      `SELECT set_config($1, $2, true) ["${SESSION_CLAIMS_SETTING}","{}"]`,
      `SELECT set_config($1, $2, true) ["${RIGHTS_MAINTENANCE_SETTING}","on"]`,
    ])
  })
})

describe("role drift checks", () => {
  const owner = { role: "simetra_owner", superuser: false }

  // Підставний клієнт перевірок `withRollback`: `superuser` — чи поточна роль
  // до відкату суперкористувач, `after` — роль після відкату
  const rollbackClient = (o: {
    superuser?: boolean | "aborted"
    after?: string
  }) =>
    fakeClient((sql) => {
      if (sql.startsWith("SELECT NOT rolsuper")) {
        if (o.superuser === "aborted")
          throw new Error("current transaction is aborted")
        return [{ ok: o.superuser !== true }]
      }
      if (sql.startsWith("SELECT current_user"))
        return [{ role: o.after ?? "simetra_owner" }]
      return []
    })

  it("a legal request or command role until the end of the transaction passes", async () => {
    const client = rollbackClient({ superuser: false })
    expect(await rollbackChecked(client, owner)).toBeNull()
    expect(client.sql).toContain("ROLLBACK")
  })

  it("a superuser before ROLLBACK is a drift", async () => {
    expect(
      await rollbackChecked(rollbackClient({ superuser: true }), owner)
    ).toMatch(/ends as a superuser/)
  })

  it("a role other than the start one after ROLLBACK is a drift", async () => {
    expect(
      await rollbackChecked(rollbackClient({ after: "postgres" }), owner)
    ).toMatch(/after ROLLBACK the client runs as postgres/)
  })

  // Помилка перевірки в перерваній транзакції не підміняє першопричину
  it("swallows the check error of an aborted transaction", async () => {
    expect(
      await rollbackChecked(rollbackClient({ superuser: "aborted" }), owner)
    ).toBeNull()
  })

  it("a client started as a superuser is not checked before ROLLBACK", async () => {
    const client = rollbackClient({ superuser: true, after: "postgres" })
    expect(
      await rollbackChecked(client, { role: "postgres", superuser: true })
    ).toBeNull()
    expect(client.sql.some((sql) => sql.startsWith("SELECT NOT"))).toBe(false)
  })

  it("a helper client left as another role outside a transaction fails the check", async () => {
    const left = fakeClient(
      () => [{ role: "postgres" }],
      () => "I"
    )
    await expect(expectClientRole(left, "simetra_owner")).rejects.toThrow(
      /left as postgres outside a transaction/
    )
  })

  it("a helper client inside a transaction is skipped", async () => {
    const busy = fakeClient(
      () => [{ role: "simetra_command" }],
      () => "T"
    )
    await expect(expectClientRole(busy, "simetra_owner")).resolves.toBe(
      undefined
    )
    expect(busy.sql).toEqual([])
  })
})
