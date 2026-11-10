import { describe, expect, it } from "vitest"
import {
  PROVIDER_API_ROLES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  PROVIDER_SCHEMAS,
} from "simetra/model"
import {
  authSchemaViolation,
  clusterRoleViolation,
  ensurePostgresCluster,
  explicitConnectDatabases,
  extensionsSchemaViolation,
  platformRoleSet,
  postgresClusterSet,
  templateState,
  type ApplyDatabase,
  type AuthSchemaFacts,
  type ExtensionsSchemaFacts,
  type PlatformRoleRow,
  type PostgresClusterSet,
  type TemplateRow,
} from "simetra/schema"
import { PROVIDER_SHADOW_TEMPLATES } from "../../engine/provider/presets"
import { CLUSTER_ADVISORY_LOCK } from "../execute"
import {
  CLUSTER_TRANSACTION_PRELUDE,
  ENGINE_SESSION_TIMEOUTS,
} from "../postgres-cluster"

type Attributes = PlatformRoleRow["attributes"]

const ownerAttributes: Attributes = {
  login: true,
  inherit: false,
  superuser: false,
  bypassRls: true,
  createRole: false,
  createDb: true,
  replication: false,
}
const authAttributes: Attributes = {
  login: true,
  inherit: false,
  superuser: false,
  bypassRls: false,
  createRole: false,
  createDb: false,
  replication: false,
}

const row = (
  name: string,
  attributes: Attributes,
  over: Partial<Pick<PlatformRoleRow, "memberOf" | "members">> = {}
): PlatformRoleRow => ({
  name,
  attributes,
  memberOf: over.memberOf ?? [],
  members: over.members ?? [],
  requestPath: [],
})

const membership = (role: string): PlatformRoleRow["memberOf"][number] => ({
  role,
  grantor: "postgres",
  admin: false,
  inherit: false,
  set: true,
})

const member = (role: string): PlatformRoleRow["members"][number] => ({
  role,
  admin: false,
  inherit: false,
  set: true,
  manager: false,
})

describe("postgresClusterSet", () => {
  it("takes every name from the T0/T2 data of the postgres profile", () => {
    const api = PROVIDER_API_ROLES.postgres
    expect(postgresClusterSet("app")).toEqual({
      owner: PROVIDER_OWNER_ROLES.postgres,
      roles: platformRoleSet("postgres"),
      request: [api.user, api.anonymous],
      auth: PROVIDER_LOGIN_ROLES.postgres[0],
      template: PROVIDER_SHADOW_TEMPLATES.postgres,
      database: "app",
    })
  })

  it("keeps the schema names that the decisions rely on inside the provider boundary", () => {
    expect(PROVIDER_SCHEMAS.postgres).toEqual(
      expect.arrayContaining(["better_auth", "extensions"])
    )
  })
})

describe("clusterRoleViolation", () => {
  it.each([
    ["the exact owner shape", "owner", row("o", ownerAttributes), undefined],
    ["the exact auth shape", "auth", row("a", authAttributes), undefined],
    [
      "an owner without BYPASSRLS",
      "owner",
      row("o", { ...ownerAttributes, bypassRls: false }),
      "bypassRls",
    ],
    [
      "an owner that inherits",
      "owner",
      row("o", { ...ownerAttributes, inherit: true }),
      "inherit",
    ],
    [
      "an owner with CREATEROLE",
      "owner",
      row("o", { ...ownerAttributes, createRole: true }),
      "createRole",
    ],
    [
      "an owner that is a superuser",
      "owner",
      row("o", { ...ownerAttributes, superuser: true }),
      "superuser",
    ],
    [
      "an auth role with BYPASSRLS",
      "auth",
      row("a", { ...authAttributes, bypassRls: true }),
      "bypassRls",
    ],
    [
      "an auth role with CREATEDB",
      "auth",
      row("a", { ...authAttributes, createDb: true }),
      "createDb",
    ],
    [
      "an owner that belongs to a predefined role",
      "owner",
      row("o", ownerAttributes, {
        memberOf: [membership("pg_execute_server_program")],
      }),
      "member-of:pg_execute_server_program",
    ],
    [
      "an owner with a member",
      "owner",
      row("o", ownerAttributes, { members: [member("runtime")] }),
      "member:runtime",
    ],
    [
      "an auth role that belongs to a role",
      "auth",
      row("a", authAttributes, { memberOf: [membership("some")] }),
      "member-of:some",
    ],
  ] as const)("%s", (_title, kind, found, violation) => {
    expect(clusterRoleViolation(found, kind)).toBe(violation)
  })
})

describe("explicitConnectDatabases", () => {
  const logins = ["rt", "auth"]
  it.each([
    ["no grants", [], []],
    [
      "the target itself is not another database",
      [{ database: "app", grantee: "rt" }],
      [],
    ],
    [
      "a login role of Simetra with CONNECT elsewhere",
      [{ database: "other", grantee: "rt" }],
      ["other"],
    ],
    [
      "a role that is not a login role of Simetra",
      [{ database: "other", grantee: "stranger" }],
      [],
    ],
    [
      "sorted and unique",
      [
        { database: "zeta", grantee: "rt" },
        { database: "alpha", grantee: "auth" },
        { database: "alpha", grantee: "rt" },
      ],
      ["alpha", "zeta"],
    ],
  ] as const)("%s", (_title, rows, expected) => {
    expect(explicitConnectDatabases(rows, logins, "app")).toEqual(expected)
  })
})

describe("extensionsSchemaViolation", () => {
  const safe: ExtensionsSchemaFacts = {
    exists: true,
    ownerSuper: true,
    createGrantees: [{ grantee: "postgres", super: true }],
    foreign: [],
    checkSchema: undefined,
  }
  it.each([
    ["a safe schema", safe, undefined],
    ["no schema yet", { ...safe, exists: false }, undefined],
    [
      "plpgsql_check in the schema extensions",
      { ...safe, checkSchema: "extensions" },
      undefined,
    ],
    [
      "an owner that is not a superuser",
      { ...safe, ownerSuper: false },
      "owner-not-superuser",
    ],
    [
      "CREATE for a non-superuser",
      {
        ...safe,
        createGrantees: [
          { grantee: "postgres", super: true },
          { grantee: "simetra_owner", super: false },
        ],
      },
      "create:simetra_owner",
    ],
    [
      "CREATE for PUBLIC",
      {
        ...safe,
        createGrantees: [{ grantee: "PUBLIC", super: false }],
      },
      "create:PUBLIC",
    ],
    [
      "an object of a non-superuser",
      { ...safe, foreign: [{ kind: "function", name: "evil" }] },
      "object:function:evil",
    ],
    [
      "plpgsql_check in another schema, even without the schema extensions",
      { ...safe, exists: false, checkSchema: "public" },
      "plpgsql_check-schema:public",
    ],
  ] as const)("%s", (_title, facts, reason) => {
    expect(extensionsSchemaViolation(facts)).toBe(reason)
  })
})

describe("authSchemaViolation", () => {
  const safe: AuthSchemaFacts = {
    schemaOwner: "auth",
    createDatabase: false,
    createPublic: false,
    strayRelations: [],
    searchPath: null,
  }
  it.each([
    ["no schema yet", { ...safe, schemaOwner: undefined }, undefined],
    ["a safe state", safe, undefined],
    [
      "the expected search_path of the role in the database",
      { ...safe, searchPath: ["search_path=better_auth"] },
      undefined,
    ],
    [
      "the same value quoted",
      { ...safe, searchPath: ['search_path="better_auth"'] },
      undefined,
    ],
    [
      "other settings of the role",
      { ...safe, searchPath: ["statement_timeout=5s"] },
      undefined,
    ],
    [
      "better_auth owned by another role",
      { ...safe, schemaOwner: "owner" },
      "owner:owner",
    ],
    [
      "CREATE on the database",
      { ...safe, createDatabase: true },
      "create-database",
    ],
    ["CREATE on public", { ...safe, createPublic: true }, "create-public"],
    [
      "a relation of the auth role outside better_auth",
      { ...safe, strayRelations: [{ schema: "public", name: "t" }] },
      "relation:public.t",
    ],
    [
      "another search_path of the role in this database",
      { ...safe, searchPath: ["search_path=public, better_auth"] },
      "search-path:public, better_auth",
    ],
  ] as const)("%s", (_title, facts, reason) => {
    expect(authSchemaViolation(facts, "auth")).toBe(reason)
  })
})

describe("templateState", () => {
  const sealed: TemplateRow = {
    ownerSuper: true,
    owner: "postgres",
    isTemplate: true,
    allowConnections: false,
  }
  it.each([
    ["no database", undefined, { state: "absent" }],
    ["a sealed template of a superuser", sealed, { state: "sealed" }],
    [
      "an unfinished database of a superuser",
      { ...sealed, isTemplate: false, allowConnections: true },
      { state: "unsealed" },
    ],
    [
      "a template of a non-superuser",
      { ...sealed, ownerSuper: false, owner: "simetra_owner" },
      { state: "unsafe", reason: "owner-not-superuser:simetra_owner" },
    ],
    [
      "an unfinished database of a non-superuser",
      {
        ...sealed,
        ownerSuper: false,
        owner: "simetra_owner",
        isTemplate: false,
        allowConnections: true,
      },
      { state: "unsafe", reason: "owner-not-superuser:simetra_owner" },
    ],
    [
      "a template that accepts connections",
      { ...sealed, allowConnections: true },
      { state: "unsafe", reason: "allows-connections" },
    ],
    [
      "a closed database that is not a template",
      { ...sealed, isTemplate: false },
      { state: "unsafe", reason: "closed-not-template" },
    ],
  ] as const)("%s", (_title, found, expected) => {
    expect(templateState(found)).toEqual(expected)
  })
})

/**
 * Порт-пастка: відповідає на запити за шматком SQL і записує все, що йшло.
 * Адреса з'єднання тут — його назва.
 */
function trapPort(answers: (sql: string) => Record<string, unknown>[]) {
  const calls: {
    kind: "transaction" | "statement"
    db: string
    end?: string
    sql: string[]
  }[] = []
  const dbs: ApplyDatabase = {
    async transaction(db, end, fn) {
      const call = {
        kind: "transaction" as const,
        db: db.url,
        end,
        sql: [] as string[],
      }
      calls.push(call)
      return fn({
        query: (async (sql: string) => {
          call.sql.push(sql)
          return answers(sql)
        }) as never,
        extract: () => Promise.reject(new Error("no extract")),
      })
    },
    async statement(db, sql) {
      calls.push({ kind: "statement", db: db.url, sql: [sql] })
    },
  }
  return { dbs, calls }
}

const conns = {
  maintenance: { url: "maintenance" },
  target: { url: "target" },
  template: { url: "template" },
}

const set: PostgresClusterSet = postgresClusterSet("app")
const allRoleNames = [
  set.owner,
  set.auth,
  ...set.roles.names,
  ...set.request,
  ...set.roles.login.map((l) => l.name),
]

describe("ensurePostgresCluster", () => {
  it("refuses a session that is not a superuser before it takes the lock or writes", async () => {
    const { dbs, calls } = trapPort((sql) =>
      sql.includes("session_user") ? [{ ok: false, database: "postgres" }] : []
    )
    const result = await ensurePostgresCluster(dbs, conns, set)
    expect(result).toMatchObject({
      ok: false,
      error: [{ code: "roles.superuser-required" }],
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      kind: "transaction",
      db: "maintenance",
      end: "rollback",
    })
    // Прелюдія — перші оператори транзакції, до будь-якого читання
    expect(calls[0]!.sql.slice(0, CLUSTER_TRANSACTION_PRELUDE.length)).toEqual(
      CLUSTER_TRANSACTION_PRELUDE
    )
    expect(calls[0]!.sql.join("\n")).not.toContain("advisory")
  })

  it("resets every engine session timeout inside the transaction only", () => {
    expect(ENGINE_SESSION_TIMEOUTS).toEqual([
      "statement_timeout",
      "lock_timeout",
      "idle_in_transaction_session_timeout",
      "transaction_timeout",
    ])
    for (const guc of ENGINE_SESSION_TIMEOUTS)
      expect(CLUSTER_TRANSACTION_PRELUDE).toContain(`SET LOCAL ${guc} = 0`)
    for (const sql of CLUSTER_TRANSACTION_PRELUDE)
      expect(sql.startsWith("SET LOCAL ")).toBe(true)
  })

  it("holds the cluster lock in the reading transaction before any read", async () => {
    const { dbs, calls } = trapPort((sql) =>
      sql.includes("session_user") ? [{ ok: true, database: "postgres" }] : []
    )
    await ensurePostgresCluster(dbs, conns, set).catch(() => undefined)
    const sql = calls[0]!.sql
    const lock = sql.findIndex((s) => s.includes("pg_advisory_xact_lock"))
    expect(sql[lock]).toContain(CLUSTER_ADVISORY_LOCK)
    expect(lock).toBeGreaterThan(3)
    expect(lock).toBeLessThan(sql.length - 1)
  })

  // Усе наявне й безпечне: фаза запису не створює нічого, окрім ідемпотентних
  // грантів на цілі — жодного оператора поза транзакцією
  it("creates nothing when every object is present and safe", async () => {
    const roleRows = allRoleNames.map((name) => ({
      name,
      attributes:
        name === set.owner
          ? ownerAttributes
          : name === set.auth
            ? authAttributes
            : {
                ...authAttributes,
                login: set.roles.login.some((l) => l.name === name),
              },
      memberOf: set.roles.login
        .filter((l) => l.name === name)
        .flatMap((l) =>
          l.memberOf.map((role) => ({
            role,
            grantor: "postgres",
            admin: false,
            inherit: false,
            set: true,
          }))
        ),
      members: set.roles.login
        .filter((l) => l.memberOf.includes(name))
        .map((l) => ({
          role: l.name,
          admin: false,
          inherit: false,
          set: true,
          manager: false,
        })),
      requestPath: [],
    }))
    const { dbs, calls } = trapPort((sql) => {
      if (sql.includes("session_user")) return [{ ok: true, database: "x" }]
      if (sql.includes("WITH RECURSIVE reach")) return roleRows
      if (sql.includes("FROM pg_catalog.pg_database d JOIN"))
        return [
          {
            name: set.database,
            owner: set.owner,
            ownerSuper: false,
            isTemplate: false,
            allowConnections: true,
          },
          {
            name: set.template,
            owner: "postgres",
            ownerSuper: true,
            isTemplate: true,
            allowConnections: false,
          },
        ]
      if (sql.includes("aclexplode(d.datacl)")) return []
      if (sql.includes('AS "createGrantees"'))
        return [{ ownerSuper: true, createGrantees: [] }]
      if (sql.includes("'plpgsql_check'")) return [{ schema: "extensions" }]
      if (sql.includes('AS "schemaOwner"')) return [{ schemaOwner: set.auth }]
      if (sql.includes('AS "createDatabase"'))
        return [{ createDatabase: false, createPublic: false }]
      return []
    })
    const result = await ensurePostgresCluster(dbs, conns, set)
    expect(result).toEqual({
      ok: true,
      value: { created: [], present: expect.arrayContaining([set.database]) },
    })
    expect(calls.filter((c) => c.kind === "statement")).toEqual([])
    // Шаблон запечатано: до нього не підключаються
    expect(calls.map((c) => c.db)).not.toContain("template")
    expect(
      calls
        .flatMap((c) => c.sql)
        .filter((s) => /^\s*(CREATE|DROP|ALTER DATABASE)/.test(s))
    ).toEqual([])
  })
})
