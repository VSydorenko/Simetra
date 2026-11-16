import {
  BATCH_MAX,
  PROVIDER_API_ROLES,
  PROVIDER_IDENTITY_SOURCES,
  TABULAR_LINES_MAX,
  runtimeCatalogSchema,
  type RuntimeObject,
} from "simetra/model"
import { describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"
import { createCommandRuntime, readRoleOf, sessionKind } from "../runtime"
import { fakeDatabase, failureOf, type Answer } from "./fake-database"
import { catalog, commandObject } from "./fixtures"

const BEGIN = {
  text: "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
  params: [],
}
// Факти ролі входу — перший оператор кожної транзакції створення; параметри
// профілю supabase: схема платформи, власник профілю, сервісна роль і ролі
// входу провайдера літералом масиву (порт передає лише текст).
const FACTS = {
  text: `SELECT
  COALESCE((SELECT pg_catalog.pg_has_role(session_user, n.nspowner, 'MEMBER')
            FROM pg_catalog.pg_namespace n WHERE n.nspname = $1), false)
    OR COALESCE((SELECT pg_catalog.pg_has_role(session_user, o.oid, 'MEMBER')
                 FROM pg_catalog.pg_roles o WHERE o.rolname = $2), false) AS owner,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolsuper
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS superuser,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolbypassrls
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS bypassrls,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolcreaterole
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS createrole,
  EXISTS (SELECT FROM pg_catalog.pg_roles x
          WHERE x.rolname IN ('pg_execute_server_program', 'pg_read_server_files', 'pg_write_server_files')
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS server_files,
  EXISTS (SELECT FROM pg_catalog.pg_roles x WHERE x.rolname = ANY ($4::text[])
          AND pg_catalog.pg_has_role(session_user, x.oid, 'MEMBER')) AS provider_login,
  COALESCE((SELECT pg_catalog.pg_has_role(session_user, s.oid, 'MEMBER')
            FROM pg_catalog.pg_roles s WHERE s.rolname = $3), false) AS service`,
  params: [
    "simetra",
    "postgres",
    "service_role",
    '{"authenticator","supabase_auth_admin","supabase_storage_admin","supabase_realtime_admin","supabase_admin"}',
  ],
}
const FACT_COLUMNS = [
  "owner",
  "superuser",
  "bypassrls",
  "createrole",
  "server_files",
  "provider_login",
  "service",
] as const
/** Рядок фактів: істинні лише `held`. */
const facts = (
  ...held: (typeof FACT_COLUMNS)[number][]
): { rows: Record<string, unknown>[] } => ({
  rows: [
    Object.fromEntries(
      FACT_COLUMNS.map((c) => [c, held.includes(c) ? "t" : "f"])
    ),
  ],
})
const member = (role: string) => ({
  text: "SELECT pg_has_role(session_user, $1, 'SET') AS member",
  params: [role],
})
// Ролі запиту профілю supabase за призначенням: `user`, далі `anonymous`.
const MEMBER = member("authenticated")
const MEMBER_ANON = member("anon")
const ROLE = { text: 'SET LOCAL ROLE "simetra_command"', params: [] }
const HASH = {
  text: 'SELECT "simetra"."applied_snapshot_hash"() AS hash',
  params: [],
}
const COMMIT = { text: "COMMIT", params: [] }
const ROLLBACK = { text: "ROLLBACK", params: [] }

/** Порт відповідає як база з моделлю каталогу; `override` — про що кейс. */
function create(
  override: (
    text: string,
    params: readonly (string | null)[]
  ) => Answer | undefined = () => undefined,
  options: { readFallback?: boolean; objectModules?: never } = {}
) {
  const db = fakeDatabase({
    query: (text, params) =>
      override(text, params) ??
      (text === FACTS.text
        ? facts()
        : text === HASH.text
          ? { rows: [{ hash: "hash-1" }] }
          : text === MEMBER.text
            ? { rows: [{ member: "t" }] }
            : {}),
  })
  const log = vi.fn()
  const runtime = createCommandRuntime({
    database: db.database,
    catalog,
    log,
    ...options,
  })
  return { db, runtime, log }
}

describe("createCommandRuntime", () => {
  it("checks login facts, membership, role and hash in one read-only transaction", async () => {
    const { db, runtime } = create()
    await runtime
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      FACTS,
      MEMBER,
      MEMBER_ANON,
      ROLE,
      HASH,
      COMMIT,
      { release: false },
    ])
  })

  it.each([
    ["owner", "owner"],
    ["superuser", "superuser"],
    ["bypassrls", "bypassrls"],
    ["createrole", "createrole"],
    ["server_files", "server-files"],
    ["provider_login", "provider-login"],
    ["service", "service"],
  ] as const)(
    "refuses a login role holding %s as privileged-login %s, before anything else",
    async (column, reason) => {
      const { db, runtime } = create((text) =>
        text === FACTS.text ? facts(column) : undefined
      )
      expect(await failureOf(runtime)).toEqual({
        code: "command.privileged-login",
        reason,
      })
      expect(db.calls).toEqual([
        { connect: true },
        BEGIN,
        FACTS,
        ROLLBACK,
        { release: false },
      ])
    }
  )

  it("names the first held fact in the order of the reasons", async () => {
    const { runtime } = create((text) =>
      text === FACTS.text
        ? facts("service", "createrole", "bypassrls")
        : undefined
    )
    expect(await failureOf(runtime)).toEqual({
      code: "command.privileged-login",
      reason: "bypassrls",
    })
  })

  it("refuses a privileged login before comparing the applied hash", async () => {
    const { runtime } = create((text) =>
      text === FACTS.text
        ? facts("owner")
        : text === HASH.text
          ? { rows: [{ hash: "hash-0" }] }
          : undefined
    )
    expect(await failureOf(runtime)).toEqual({
      code: "command.privileged-login",
      reason: "owner",
    })
  })

  it("judges the login facts again in the transaction after 42704 on the anonymous role", async () => {
    let judged = 0
    const { db, runtime } = create((text, params) =>
      text === FACTS.text
        ? judged++ === 0
          ? facts()
          : facts("bypassrls")
        : text === MEMBER.text && params[0] === "anon"
          ? { error: { code: "42704", message: "x" } }
          : undefined
    )
    expect(await failureOf(runtime)).toEqual({
      code: "command.privileged-login",
      reason: "bypassrls",
    })
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      FACTS,
      MEMBER,
      MEMBER_ANON,
      ROLLBACK,
      { release: false },
      { connect: true },
      BEGIN,
      FACTS,
      ROLLBACK,
      { release: false },
    ])
  })

  it.each<[string, Answer]>([
    ["no row", { rows: [] }],
    ["a null fact", { rows: [{ ...facts().rows[0], service: null }] }],
  ])(
    "refuses facts with %s as command.internal and logs it",
    async (_, answer) => {
      const { db, runtime, log } = create((text) =>
        text === FACTS.text ? answer : undefined
      )
      expect(await failureOf(runtime)).toEqual({ code: "command.internal" })
      expect(log).toHaveBeenCalledTimes(1)
      expect(db.calls).toEqual([
        { connect: true },
        BEGIN,
        FACTS,
        ROLLBACK,
        { release: false },
      ])
    }
  )

  it("rejects another applied hash with both hashes", async () => {
    const { runtime } = create((text) =>
      text === HASH.text ? { rows: [{ hash: "hash-0" }] } : undefined
    )
    expect(await failureOf(runtime)).toEqual({
      code: "command.model-mismatch",
      hashes: { catalog: "hash-1", applied: "hash-0" },
    })
  })

  it.each([
    ["no marker", { rows: [{ hash: null }] }],
    ["no hash function (42883)", { error: { code: "42883", message: "x" } }],
    ["no platform schema (3F000)", { error: { code: "3F000", message: "x" } }],
  ])("rejects %s as a mismatch with applied null", async (_, answer) => {
    const { db, runtime } = create((text) =>
      text === HASH.text ? (answer as Answer) : undefined
    )
    expect(await failureOf(runtime)).toEqual({
      code: "command.model-mismatch",
      hashes: { catalog: "hash-1", applied: null },
    })
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      FACTS,
      MEMBER,
      MEMBER_ANON,
      ROLE,
      HASH,
      "error" in answer ? ROLLBACK : COMMIT,
      { release: false },
    ])
  })

  // Відповідь бази на перевірку членства лише ролі `role`.
  const onMember =
    (role: string, answer: Answer) =>
    (text: string, params: readonly (string | null)[]) =>
      text === MEMBER.text && params[0] === role ? answer : undefined
  const NOT_MEMBER: Answer = { rows: [{ member: "f" }] }
  const ABSENT: Answer = { error: { code: "42704", message: "x" } }

  it.each(["authenticated", "anon"])(
    "rejects a missing membership in %s with the role",
    async (role) => {
      const { runtime } = create(onMember(role, NOT_MEMBER))
      expect(await failureOf(runtime)).toEqual({
        code: "command.read-role-missing",
        role,
      })
    }
  )

  it("treats a request role absent from the database (42704) as missing", async () => {
    const absent = onMember("authenticated", ABSENT)
    const { db, runtime } = create(absent)
    expect(await failureOf(runtime)).toEqual({
      code: "command.read-role-missing",
      role: "authenticated",
    })
    // Перервана транзакція — решту ролей і хеш звіряє друга, без ролі, якої
    // немає.
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      FACTS,
      MEMBER,
      ROLLBACK,
      { release: false },
      { connect: true },
      BEGIN,
      FACTS,
      MEMBER_ANON,
      ROLE,
      HASH,
      COMMIT,
      { release: false },
    ])
    await expect(
      create(absent, { readFallback: true }).runtime
    ).resolves.toHaveProperty("run")
  })

  it("rejects the anonymous role absent from the database (42704) after checking the user role", async () => {
    const { db, runtime } = create(onMember("anon", ABSENT), {
      readFallback: true,
    })
    expect(await failureOf(runtime)).toEqual({
      code: "command.read-role-missing",
      role: "anon",
    })
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      FACTS,
      MEMBER,
      MEMBER_ANON,
      ROLLBACK,
      { release: false },
      { connect: true },
      BEGIN,
      FACTS,
      MEMBER,
      ROLE,
      HASH,
      COMMIT,
      { release: false },
    ])
  })

  it("lets readFallback replace the missing user membership", async () => {
    const { runtime } = create(onMember("authenticated", NOT_MEMBER), {
      readFallback: true,
    })
    await expect(runtime).resolves.toHaveProperty("run")
  })

  it("keeps readFallback from replacing the missing anonymous membership", async () => {
    const { runtime } = create(onMember("anon", NOT_MEMBER), {
      readFallback: true,
    })
    expect(await failureOf(runtime)).toEqual({
      code: "command.read-role-missing",
      role: "anon",
    })
  })

  it("maps a failed connect to command.unavailable and logs the original error", async () => {
    const raw = new Error("refused")
    const db = fakeDatabase({
      query: () => ({}),
      connect: () => ({ error: raw }),
    })
    const log = vi.fn()
    const runtime = createCommandRuntime({
      database: db.database,
      catalog,
      log,
    })
    expect(await failureOf(runtime)).toEqual({ code: "command.unavailable" })
    expect(db.calls).toEqual([{ connect: true }])
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it("destroys the connection on an error without SQLSTATE and logs it", async () => {
    const raw = new TypeError("driver bug")
    const { db, runtime, log } = create((text) =>
      text === HASH.text ? { error: raw } : undefined
    )
    expect(await failureOf(runtime)).toEqual({ code: "command.unavailable" })
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      FACTS,
      MEMBER,
      MEMBER_ANON,
      ROLE,
      HASH,
      { release: true },
    ])
    expect(log.mock.calls).toEqual([[{ kind: "database", error: raw }]])
  })

  it("maps a refused SET LOCAL ROLE to command.internal and logs it", async () => {
    const raw = { code: "42501", message: "permission denied to set role" }
    const { db, runtime, log } = create((text) =>
      text === ROLE.text ? { error: raw } : undefined
    )
    expect(await failureOf(runtime)).toEqual({ code: "command.internal" })
    expect(log).toHaveBeenCalledWith({ kind: "database", error: raw })
    expect(db.calls).toEqual([
      { connect: true },
      BEGIN,
      FACTS,
      MEMBER,
      MEMBER_ANON,
      ROLE,
      ROLLBACK,
      { release: false },
    ])
  })

  it.each([
    ["an unknown object", { "Catalog.Nope": {} }],
    [
      "a key outside OBJECT_MODULE_KEYS",
      { "Catalog.Client": { beforeDelete: () => {} } },
    ],
  ])("rejects %s before the database", async (_, objectModules) => {
    const db = fakeDatabase({ query: () => ({}) })
    await expect(
      createCommandRuntime({
        database: db.database,
        catalog,
        objectModules: objectModules as never,
      })
    ).rejects.toThrow(/objectModules/)
    expect(db.calls).toEqual([])
  })

  it("rejects an invalid catalog before the database", async () => {
    const db = fakeDatabase({ query: () => ({}) })
    await expect(
      createCommandRuntime({
        database: db.database,
        catalog: { ...catalog, format: 2 },
      })
    ).rejects.toBeInstanceOf(ZodError)
    expect(db.calls).toEqual([])
  })

  it.each([
    ["maxAttempts", 0],
    ["maxAttempts", 1.5],
    ["maxDepth", 0],
    ["readStatementTimeoutMs", 0],
    ["readStatementTimeoutMs", 1.5],
    ["commandBudgetMs", 500],
    ["commandBudgetMs", 1000.5],
    ["lockTimeoutMs", 0],
    ["maxBatch", 0],
    ["maxBatch", BATCH_MAX + 1],
    ["maxTabularLines", 0],
    ["maxTabularLines", TABULAR_LINES_MAX + 1],
  ])("rejects %s = %s before the database", async (option, value) => {
    const db = fakeDatabase({ query: () => ({}) })
    await expect(
      createCommandRuntime({ database: db.database, catalog, [option]: value })
    ).rejects.toBeInstanceOf(ZodError)
    expect(db.calls).toEqual([])
  })
})

describe("an object without operations", () => {
  it("refuses any action with invalid(action) before the database", async () => {
    const readOnly: RuntimeObject = {
      ...commandObject({ name: "Report", table: "report" }),
      operations: undefined,
    }
    const db = fakeDatabase({
      query: (text) =>
        text === FACTS.text
          ? facts()
          : text === HASH.text
            ? { rows: [{ hash: "hash-1" }] }
            : text === MEMBER.text
              ? { rows: [{ member: "t" }] }
              : {},
    })
    const runtime = await createCommandRuntime({
      database: db.database,
      catalog: runtimeCatalogSchema.parse({
        ...catalog,
        objects: [readOnly],
      }),
    })
    const created = db.calls.length
    const error = await failureOf(
      runtime.run(
        { sub: "user-1", role: "authenticated", is_anonymous: false },
        {
          action: "update",
          object: { kind: "Catalog", name: "Report" },
          id: "11111111-1111-4111-8111-111111111111",
          expectedVersion: 1,
        }
      )
    )
    expect(error).toEqual({
      code: "command.invalid",
      path: "action",
      object: { kind: "Catalog", name: "Report" },
    })
    expect(db.calls.slice(created)).toEqual([])
  })
})

describe("readRoleOf", () => {
  it.each([
    [["user"] as const, "user", "authenticated"],
    [["user"] as const, "anonymous", undefined],
    [["user", "anonymous"] as const, "anonymous", "anon"],
    [[] as const, "user", undefined],
  ] as const)("reads purposes %j for %s as %s", (purposes, purpose, role) => {
    expect(
      readRoleOf(
        "supabase",
        { supabase: purposes, postgres: [] },
        PROVIDER_API_ROLES,
        purpose
      )
    ).toBe(role)
  })

  it("reads under the user role of the postgres profile", () => {
    expect(readRoleOf("postgres")).toBe("simetra_user")
  })

  it("reads the anonymous role of the supabase profile by default tables", () => {
    expect(readRoleOf("supabase", undefined, undefined, "anonymous")).toBe(
      PROVIDER_API_ROLES.supabase.anonymous
    )
  })
})

describe("sessionKind", () => {
  it.each<[string, Record<string, unknown>, string]>([
    ["true", { is_anonymous: true }, "anonymous"],
    ['"true"', { is_anonymous: "true" }, "anonymous"],
    ["false", { is_anonymous: false }, "user"],
    ['"false"', { is_anonymous: "false" }, "user"],
    ["1", { is_anonymous: 1 }, "invalid"],
    ["null", { is_anonymous: null }, "invalid"],
    ['"yes"', { is_anonymous: "yes" }, "invalid"],
    ["an absent claim", {}, "invalid"],
  ])("reads the anonymous claim %s (%o) as %s", (_, claims, kind) => {
    for (const provider of ["supabase", "postgres"] as const) {
      expect(sessionKind(provider, { sub: "user-1", ...claims })).toBe(kind)
    }
  })

  it("reads every session of a profile without the anonymous claim as user", () => {
    const sources = {
      ...PROVIDER_IDENTITY_SOURCES,
      supabase: { ...PROVIDER_IDENTITY_SOURCES.supabase, anonymousClaim: null },
    }
    expect(sessionKind("supabase", { sub: "user-1" }, sources)).toBe("user")
    expect(
      sessionKind("supabase", { sub: "user-1", is_anonymous: true }, sources)
    ).toBe("user")
  })
})
