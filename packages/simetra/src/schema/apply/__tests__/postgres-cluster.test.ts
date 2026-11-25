import { describe, expect, it } from "vitest"
import {
  PLATFORM_LOGIN_ROLES,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  PROVIDER_SCHEMAS,
  quoteIdent,
} from "simetra/model"
import {
  ensurePostgresCluster,
  platformRoleSet,
  postgresClusterSet,
  type ApplyDatabase,
  type PlatformRoleRow,
  type PostgresClusterSet,
} from "simetra/schema"
import {
  authSchemaViolation,
  clusterRoleViolation,
  databaseLocaleViolation,
  explicitConnectDatabases,
  extensionsSchemaViolation,
  templateState,
  type AuthSchemaFacts,
  type ExtensionsSchemaFacts,
  type TemplateRow,
} from "../postgres-cluster"
import {
  PROVIDER_DATABASE_LOCALES,
  PROVIDER_SHADOW_TEMPLATES,
} from "../../engine/provider/presets"
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
  roleSetting: null,
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
      identity: PROVIDER_IDENTITY_SOURCES.postgres.table,
    })
  })

  it("keeps the schema names that the decisions rely on inside the provider boundary", () => {
    expect(PROVIDER_SCHEMAS.postgres).toEqual(
      expect.arrayContaining(["agent_oauth", "better_auth", "extensions"])
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
    schemaOwners: [
      { schema: "agent_oauth", owner: "auth" },
      { schema: "better_auth", owner: "auth" },
    ],
    createDatabase: false,
    createPublic: false,
    strayRelations: [],
    searchPath: null,
  }
  const atAuth = (reason: string) => ({ schema: "better_auth", reason })
  it.each([
    ["no schema yet", { ...safe, schemaOwners: [] }, undefined],
    [
      "only better_auth, before agent_oauth is created",
      { ...safe, schemaOwners: [{ schema: "better_auth", owner: "auth" }] },
      undefined,
    ],
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
      {
        ...safe,
        schemaOwners: [
          { schema: "agent_oauth", owner: "auth" },
          { schema: "better_auth", owner: "owner" },
        ],
      },
      atAuth("owner:owner"),
    ],
    [
      "agent_oauth owned by another role",
      {
        ...safe,
        schemaOwners: [
          { schema: "agent_oauth", owner: "owner" },
          { schema: "better_auth", owner: "auth" },
        ],
      },
      { schema: "agent_oauth", reason: "owner:owner" },
    ],
    [
      "CREATE on the database",
      { ...safe, createDatabase: true },
      atAuth("create-database"),
    ],
    [
      "CREATE on public",
      { ...safe, createPublic: true },
      atAuth("create-public"),
    ],
    [
      "a relation of the auth role outside its schemas",
      { ...safe, strayRelations: [{ schema: "public", name: "t" }] },
      atAuth("relation:public.t"),
    ],
    [
      "another search_path of the role in this database",
      { ...safe, searchPath: ["search_path=public, better_auth"] },
      atAuth("search-path:public, better_auth"),
    ],
  ] as const)("%s", (_title, facts, violation) => {
    expect(authSchemaViolation(facts, "auth")).toEqual(violation)
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
function trapPort(
  answers: (sql: string) => Record<string, unknown>[],
  version = { num: 170000, version: "17.0" }
) {
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
          return sql.includes("server_version_num") ? [version] : answers(sql)
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

const icu = { localeProvider: "icu", locale: "en-US", icuRules: null }

describe("databaseLocaleViolation", () => {
  it.each([
    ["ICU en-US", { ...icu }, undefined],
    [
      "libc of the same language",
      { ...icu, localeProvider: "libc", locale: "en_US.utf8" },
      "libc en_US.utf8",
    ],
    ["ICU of another locale", { ...icu, locale: "uk-UA" }, "icu uk-UA"],
    [
      "the builtin provider",
      { ...icu, localeProvider: "builtin", locale: "C.UTF-8" },
      "builtin C.UTF-8",
    ],
    [
      "ICU en-US with custom rules",
      { ...icu, icuRules: "&a < b" },
      "icu en-US with ICU rules",
    ],
  ] as const)("%s", (_title, found, expected) => {
    expect(databaseLocaleViolation(found)).toBe(expected)
  })
})

/** Рядок `pg_database`, на який відповідає порт-пастка. */
const databaseRow = (
  name: string,
  over: Record<string, unknown> = {}
): Record<string, unknown> => ({
  name,
  owner: "postgres",
  ownerSuper: true,
  isTemplate: false,
  allowConnections: true,
  ...icu,
  ...over,
})

describe("ensurePostgresCluster", () => {
  it("creates the target database and the template from template0 with the ICU locale of the profile", async () => {
    const { dbs, calls } = trapPort((sql) =>
      sql.includes("session_user") ? [{ ok: true, database: "x" }] : []
    )
    const result = await ensurePostgresCluster(dbs, conns, set)
    expect(result).toMatchObject({ ok: true })
    const { provider, locale } = PROVIDER_DATABASE_LOCALES.postgres
    const q = quoteIdent
    const options = `TEMPLATE ${q("template0")} LOCALE_PROVIDER ${provider} ICU_LOCALE '${locale}'`
    expect(
      calls
        .filter((c) => c.kind === "statement")
        .flatMap((c) => c.sql)
        .filter((s) => s.startsWith("CREATE DATABASE"))
    ).toEqual([
      `CREATE DATABASE ${q(set.database)} OWNER ${q(set.owner)} ${options}`,
      `CREATE DATABASE ${q(set.template)} ${options}`,
    ])
  })

  it.each([
    ["the target database", "database"],
    ["the template", "template"],
  ] as const)(
    "refuses %s with another collation before it writes anything",
    async (_title, kind) => {
      const name = kind === "database" ? set.database : set.template
      const { dbs, calls } = trapPort((sql) => {
        if (sql.includes("session_user")) return [{ ok: true, database: "x" }]
        if (sql.includes("FROM pg_catalog.pg_database d JOIN"))
          return [
            databaseRow(name, {
              localeProvider: "libc",
              locale: "en_US.utf8",
              ...(kind === "database"
                ? { owner: set.owner, ownerSuper: false }
                : { isTemplate: true, allowConnections: false }),
            }),
          ]
        return []
      })
      const result = await ensurePostgresCluster(dbs, conns, set)
      expect(result).toMatchObject({
        ok: false,
        error: [
          {
            code: "roles.database-locale",
            params: { database: name, kind, actual: "libc en_US.utf8" },
          },
        ],
      })
      // Жодного запису: лише транзакції з відкатом, жодного оператора
      expect(calls.filter((c) => c.kind === "statement")).toEqual([])
      expect(calls.filter((c) => c.end === "commit")).toEqual([])
    }
  )

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

  it("refuses a server older than the platform minimum before it reads the databases", async () => {
    const { dbs, calls } = trapPort(
      (sql) =>
        sql.includes("session_user") ? [{ ok: true, database: "x" }] : [],
      { num: 160004, version: "16.4" }
    )
    const result = await ensurePostgresCluster(dbs, conns, set)
    expect(result).toMatchObject({
      ok: false,
      error: [{ code: "apply.server-unsupported" }],
    })
    expect(calls.filter((c) => c.kind === "statement")).toEqual([])
    expect(calls.filter((c) => c.end === "commit")).toEqual([])
    expect(calls.flatMap((c) => c.sql).join("\n")).not.toContain("datlocale")
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
    const { dbs, calls } = trapPort(presentCluster())
    const result = await ensurePostgresCluster(dbs, conns, set)
    expect(result).toEqual({
      ok: true,
      value: {
        created: [],
        present: expect.arrayContaining([
          set.database,
          "better_auth:USAGE",
          "better_auth.user:TRIGGER",
        ]),
        skipped: [],
      },
    })
    expect(calls.filter((c) => c.kind === "statement")).toEqual([])
    // Шаблон запечатано: до нього не підключаються
    expect(calls.map((c) => c.db)).not.toContain("template")
    expect(
      calls
        .flatMap((c) => c.sql)
        .filter((s) =>
          /^\s*(CREATE|DROP|ALTER DATABASE|GRANT (USAGE ON SCHEMA better_auth|TRIGGER))/.test(
            s
          )
        )
    ).toEqual([])
  })

  // Схема агентів — окремий факт: база, підготована раніше, має лише
  // `better_auth`, і повторний `roles` додає `agent_oauth` від ролі `auth`
  it.each([
    ["a new target", undefined, ["better_auth", "agent_oauth"]],
    ["a target that has only better_auth", ["better_auth"], ["agent_oauth"]],
  ] as const)(
    "creates the missing schemas of the auth role in %s",
    async (_title, present, expected) => {
      const { dbs, calls } = trapPort(
        present === undefined
          ? (sql) =>
              sql.includes("session_user") ? [{ ok: true, database: "x" }] : []
          : presentCluster(undefined, [...present])
      )
      expect(await ensurePostgresCluster(dbs, conns, set)).toMatchObject({
        ok: true,
      })
      expect(
        calls
          .flatMap((c) => c.sql)
          .filter(
            (s) =>
              s.startsWith("CREATE SCHEMA") &&
              !s.startsWith("CREATE SCHEMA extensions")
          )
      ).toEqual(
        expected.map(
          (schema) =>
            `CREATE SCHEMA ${schema} AUTHORIZATION ${quoteIdent(set.auth)}`
        )
      )
    }
  )

  // Споживач сигналів (спека профілю §3.1): група до ролі входу, а ролі входу —
  // пара й налаштування `role` у тій самій транзакції створення
  it("creates the signals consumer and its login role with the pair and the role setting", async () => {
    const { dbs, calls } = trapPort((sql) =>
      sql.includes("session_user") ? [{ ok: true, database: "x" }] : []
    )
    expect(await ensurePostgresCluster(dbs, conns, set)).toMatchObject({
      ok: true,
    })
    const consumer = PLATFORM_ROLES.signalConsumer
    const signals = PLATFORM_LOGIN_ROLES.signals
    const roleSql = calls
      .filter((c) => c.end === "commit" && c.db === "maintenance")
      .flatMap((c) => c.sql)
      .filter((s) => s.includes(consumer) || s.includes(signals))
    expect(roleSql).toEqual([
      `CREATE ROLE ${consumer} NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
      `CREATE ROLE ${signals} LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
      `GRANT ${consumer} TO ${signals} WITH INHERIT FALSE, SET TRUE`,
      `ALTER ROLE ${signals} SET role = '${consumer}'`,
    ])
  })

  it("refuses a present signals login role without its role setting before it writes", async () => {
    const present = presentCluster()
    const { dbs, calls } = trapPort((sql) =>
      sql.includes("WITH RECURSIVE reach")
        ? present(sql).map((r) =>
            r.name === PLATFORM_LOGIN_ROLES.signals
              ? { ...r, roleSetting: null }
              : r
          )
        : present(sql)
    )
    expect(await ensurePostgresCluster(dbs, conns, set)).toMatchObject({
      ok: false,
      error: [
        {
          code: "plan.platform-role-shape",
          params: {
            role: PLATFORM_LOGIN_ROLES.signals,
            violation: "setting:role",
          },
        },
      ],
    })
    expect(calls.filter((c) => c.end === "commit")).toEqual([])
  })

  // Наявна роль входу без нового батька профілю: `roles` доповнює пару §6.2;
  // зайвий батько й інша форма членства — відмова, не «виправлення».
  describe("a present login role and its parents", () => {
    const login = set.roles.login.find((l) =>
      l.memberOf.includes(PLATFORM_ROLES.files)
    )!
    const changed = (
      change: (row: Record<string, unknown>) => Record<string, unknown>
    ) => {
      const present = presentCluster()
      return trapPort((sql) =>
        sql.includes("WITH RECURSIVE reach")
          ? present(sql).map((r) => (r.name === login.name ? change(r) : r))
          : present(sql)
      )
    }
    type Membership = { role: string; inherit: boolean }
    const withParents = (edit: (parents: Membership[]) => Membership[]) =>
      changed((r) => ({
        ...r,
        memberOf: edit(r.memberOf as Membership[]),
      }))

    it("adds the missing parent in the pair form and nothing else", async () => {
      const { dbs, calls } = withParents((parents) =>
        parents.filter((m) => m.role !== PLATFORM_ROLES.files)
      )
      const result = await ensurePostgresCluster(dbs, conns, set)
      expect(result).toMatchObject({
        ok: true,
        value: {
          created: [],
          added: [{ role: login.name, parents: [PLATFORM_ROLES.files] }],
        },
      })
      expect(
        calls
          .filter((c) => c.end === "commit")
          .flatMap((c) => c.sql)
          .filter((q) => /^GRANT \S+ TO /.test(q) && q.includes("INHERIT"))
      ).toEqual([
        `GRANT ${PLATFORM_ROLES.files} TO ${login.name} WITH INHERIT FALSE, SET TRUE`,
      ])
    })

    // Між фазою читання й записом інший адміністратор додав небезпечне
    // членство: фаза запису звіряє форму знову в тій самій транзакції
    it("refuses and grants nothing when the role turns unsafe between the phases", async () => {
      const present = presentCluster()
      let reads = 0
      const { dbs, calls } = trapPort((sql) => {
        if (!sql.includes("WITH RECURSIVE reach")) return present(sql)
        reads += 1
        return present(sql)
          .map((r) =>
            r.name === login.name
              ? {
                  ...r,
                  memberOf: (r.memberOf as Membership[]).filter(
                    (m) => m.role !== PLATFORM_ROLES.files
                  ),
                }
              : r
          )
          .map((r) =>
            // Перше читання — чисте; наступні (фаза запису) — з зайвим батьком
            reads > 1 && r.name === login.name
              ? {
                  ...r,
                  memberOf: [
                    ...(r.memberOf as Membership[]),
                    {
                      ...(r.memberOf as Membership[])[0]!,
                      role: "pg_read_all_data",
                    },
                  ],
                }
              : r
          )
      })
      expect(await ensurePostgresCluster(dbs, conns, set)).toMatchObject({
        ok: false,
        error: [
          {
            code: "plan.platform-role-shape",
            params: {
              role: login.name,
              violation: "member-of:pg_read_all_data",
            },
          },
        ],
      })
      expect(
        calls.flatMap((c) => c.sql).filter((q) => q.startsWith("GRANT"))
      ).toEqual([])
    })

    it("refuses an extra parent before it writes", async () => {
      const { dbs, calls } = withParents((parents) => [
        ...parents,
        { ...parents[0]!, role: "pg_read_all_data" },
      ])
      expect(await ensurePostgresCluster(dbs, conns, set)).toMatchObject({
        ok: false,
        error: [
          {
            code: "plan.platform-role-shape",
            params: {
              role: login.name,
              violation: "member-of:pg_read_all_data",
            },
          },
        ],
      })
      expect(calls.filter((c) => c.end === "commit")).toEqual([])
    })

    it("refuses a parent with INHERIT TRUE instead of repairing it", async () => {
      const { dbs, calls } = withParents((parents) =>
        parents.map((m) =>
          m.role === PLATFORM_ROLES.files ? { ...m, inherit: true } : m
        )
      )
      expect(await ensurePostgresCluster(dbs, conns, set)).toMatchObject({
        ok: false,
        error: [
          {
            code: "plan.platform-role-shape",
            params: {
              role: login.name,
              violation: `membership-option:${PLATFORM_ROLES.files}`,
            },
          },
        ],
      })
      expect(calls.filter((c) => c.end === "commit")).toEqual([])
    })
  })

  describe("the grants of the identity table", () => {
    const grantSql = (calls: { sql: string[] }[]) =>
      calls
        .flatMap((c) => c.sql)
        .filter(
          (s) => /better_auth/.test(s) && /^(GRANT|ALTER DEFAULT)/.test(s)
        )

    it("grants USAGE after it creates the schema and skips TRIGGER while there is no table", async () => {
      const { dbs, calls } = trapPort((sql) =>
        sql.includes("session_user") ? [{ ok: true, database: "x" }] : []
      )
      const result = await ensurePostgresCluster(dbs, conns, set)
      expect(result).toMatchObject({
        ok: true,
        value: {
          created: expect.arrayContaining(["better_auth:USAGE"]),
          skipped: ["better_auth.user:TRIGGER"],
        },
      })
      const sql = calls.flatMap((c) => c.sql)
      const schema = sql.findIndex((s) =>
        s.startsWith("CREATE SCHEMA better_auth ")
      )
      const usage = sql.indexOf(
        `GRANT USAGE ON SCHEMA better_auth TO ${quoteIdent(set.owner)}`
      )
      expect(schema).toBeGreaterThan(-1)
      expect(usage).toBeGreaterThan(schema)
      expect(grantSql(calls)).toEqual([sql[usage]])
    })

    it("counts only an ordinary or partitioned table as the identity table", async () => {
      const { dbs, calls } = trapPort(presentCluster())
      await ensurePostgresCluster(dbs, conns, set)
      // Вид, послідовність чи індекс з тим самим іменем — таблиці немає
      const lookup = calls
        .flatMap((c) => c.sql)
        .find((s) => s.includes("AS exists"))
      expect(lookup).toMatch(/c\.relkind IN \('r', 'p'\)/)
    })

    it.each([
      ["neither", { trigger: false, references: false }],
      ["only TRIGGER", { trigger: true, references: false }],
      ["only REFERENCES", { trigger: false, references: true }],
    ])(
      "grants TRIGGER and REFERENCES on the table alone when the owner has %s",
      async (_title, grants) => {
        const { dbs, calls } = trapPort(
          presentCluster({ usage: false, ...grants })
        )
        const result = await ensurePostgresCluster(dbs, conns, set)
        expect(result).toMatchObject({
          ok: true,
          value: {
            created: ["better_auth:USAGE", "better_auth.user:TRIGGER"],
            skipped: [],
          },
        })
        expect(grantSql(calls)).toEqual([
          `GRANT USAGE ON SCHEMA better_auth TO ${quoteIdent(set.owner)}`,
          `GRANT TRIGGER, REFERENCES ON better_auth."user" TO ${quoteIdent(set.owner)}`,
        ])
      }
    )
  })
})

/**
 * Відповіді порту-пастки для кластера, де все є й безпечне; `identity` —
 * гранти власника на схему й таблицю ідентичності, `authSchemas` — наявні
 * схеми ролі `auth` у цілі.
 */
function presentCluster(
  identity = { usage: true, trigger: true, references: true },
  authSchemas = ["agent_oauth", "better_auth"]
): (sql: string) => Record<string, unknown>[] {
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
    roleSetting:
      set.roles.login.find((l) => l.name === name)?.settings?.role ?? null,
  }))
  return (sql) => {
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
          ...icu,
        },
        {
          name: set.template,
          owner: "postgres",
          ownerSuper: true,
          isTemplate: true,
          allowConnections: false,
          ...icu,
        },
      ]
    if (sql.includes("aclexplode(d.datacl)")) return []
    if (sql.includes('AS "createGrantees"'))
      return [{ ownerSuper: true, createGrantees: [] }]
    if (sql.includes("'plpgsql_check'")) return [{ schema: "extensions" }]
    if (sql.includes("AS owner\nFROM pg_catalog.pg_namespace"))
      return authSchemas.map((schema) => ({ schema, owner: set.auth }))
    if (sql.includes('AS "createDatabase"'))
      return [{ createDatabase: false, createPublic: false }]
    if (sql.includes("AS exists"))
      return [{ usage: identity.usage, exists: true }]
    if (sql.includes("AS references"))
      return [{ trigger: identity.trigger, references: identity.references }]
    return []
  }
}
