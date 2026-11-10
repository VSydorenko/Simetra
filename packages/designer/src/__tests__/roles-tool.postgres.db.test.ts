import { withDatabaseName } from "@supabase/pg-delta"
import pg from "pg"
import { quoteIdent } from "simetra/model"
import {
  ensurePostgresCluster,
  type ApplyDatabase,
  type PostgresClusterSet,
} from "simetra/schema"
import { afterAll, describe, expect, it } from "vitest"
import {
  clusterRoleNames,
  dropTaggedCluster,
  roleUrl,
  setTestPasswords,
  taggedClusterSet,
  testDatabaseName,
  testRoleName,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import { CLUSTER_TRANSACTION_PRELUDE } from "../../../simetra/src/schema/apply/postgres-cluster"
import { createApplyDatabase } from "../schema-engine"

/**
 * `simetra roles` в профілі `postgres` на стеку `postgres` (спека профілю §3.1,
 * §3.4, §3.5, §4.2). DB-рівень, бо атрибути ролей, власника баз, позначку
 * шаблону й дію `SET role` від власника на сесію суперкористувача вирішує
 * Postgres. Кожен сценарій має свій набір тегованих імен; усе, що він створив,
 * прибирає `dropTaggedCluster`.
 */
const created: { set: PostgresClusterSet; extra: string[] }[] = []

afterAll(async () => {
  const failures: unknown[] = []
  for (const { set, extra } of created)
    await dropTaggedCluster(set, extra).catch((e: unknown) => failures.push(e))
  if (failures.length > 0) throw failures[0]
})

// Роль кластерна, а її ім'я тегове за міткою: однакова мітка двох сценаріїв дала
// б їм одні ролі й явний CONNECT до баз одне одного
let scenarios = 0

function scenario(label: string) {
  const entry = {
    set: taggedClusterSet(`${label}${(scenarios += 1)}`),
    extra: [] as string[],
  }
  created.push(entry)
  return entry
}

const port = createApplyDatabase({ readOnly: false })

/** Підключення суперкористувача (або `url`) до службової бази, цілі й шаблону. */
function connections(
  set: PostgresClusterSet,
  url: string = testSuperuserUrl()
) {
  return {
    maintenance: { url: withDatabaseName(url, "postgres") },
    target: { url: withDatabaseName(url, set.database) },
    template: { url: withDatabaseName(url, set.template) },
  }
}

const ensure = (
  set: PostgresClusterSet,
  dbs: ApplyDatabase = port,
  url?: string
) => ensurePostgresCluster(dbs, connections(set, url), set)

async function mustEnsure(set: PostgresClusterSet) {
  const result = await ensure(set)
  if (!result.ok)
    throw new Error(
      `roles refused: ${JSON.stringify(result.error.map((d) => [d.code, d.params]))}`
    )
  return result.value
}

/** Запит суперкористувача; `database` — база, `undefined` — службова. */
async function sql<T extends Record<string, unknown>>(
  database: string | undefined,
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = new pg.Client({
    connectionString: withDatabaseName(
      testSuperuserUrl(),
      database ?? "postgres"
    ),
  })
  await client.connect()
  try {
    // База може мати `ALTER DATABASE SET role`/`search_path` від власника:
    // перевірка читає як суперкористувач із чистим шляхом
    await client.query("SET ROLE NONE")
    await client.query("SET search_path = pg_catalog")
    return (await client.query(text, params)).rows as T[]
  } finally {
    await client.end()
  }
}

/** Стан кластера, який відмова не може змінити (Review Focus 5). */
async function clusterState(set: PostgresClusterSet, extra: string[] = []) {
  const roles = clusterRoleNames(set)
  return {
    roles: await sql(
      undefined,
      `select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
              rolcanlogin, rolreplication, rolbypassrls, rolconfig
         from pg_roles where rolname = any($1) order by 1`,
      [roles]
    ),
    members: await sql(
      undefined,
      `select r.rolname as role, m.rolname as member, g.rolname as grantor,
              a.admin_option, a.inherit_option, a.set_option
         from pg_auth_members a
         join pg_roles r on r.oid = a.roleid
         join pg_roles m on m.oid = a.member
         join pg_roles g on g.oid = a.grantor
        where r.rolname = any($1) or m.rolname = any($1) order by 1, 2, 3`,
      [roles]
    ),
    databases: await sql(
      undefined,
      `select d.datname, o.rolname as owner, d.datistemplate, d.datallowconn,
              d.datacl::text as datacl
         from pg_database d join pg_roles o on o.oid = d.datdba
        where d.datname = any($1) order by 1`,
      [[set.database, set.template, ...extra]]
    ),
    settings: await sql(
      undefined,
      `select r.rolname, d.datname, s.setconfig
         from pg_db_role_setting s
         left join pg_roles r on r.oid = s.setrole
         left join pg_database d on d.oid = s.setdatabase
        where r.rolname = any($1) order by 1, 2`,
      [roles]
    ),
  }
}

const codes = (result: Awaited<ReturnType<typeof ensure>>): string[] =>
  result.ok ? [] : result.error.map((d) => d.code)

/** Вдруге викликає `roles` після підміни стану й перевіряє відмову без змін. */
async function expectRefusal(
  set: PostgresClusterSet,
  expected: { code: string; params?: Record<string, unknown> }[],
  extra: string[] = [],
  dbs: ApplyDatabase = port
) {
  const before = await clusterState(set, extra)
  const result = await ensure(set, dbs)
  expect(result.ok).toBe(false)
  expect(result.ok ? [] : result.error).toEqual(
    expect.arrayContaining(
      expected.map((e) =>
        expect.objectContaining({
          code: e.code,
          ...(e.params === undefined
            ? {}
            : { params: expect.objectContaining(e.params) }),
        })
      )
    )
  )
  expect(await clusterState(set, extra)).toEqual(before)
}

/** Клієнт ролі входу до цілі набору. */
async function asRole<T>(
  set: PostgresClusterSet,
  role: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: roleUrl(set, role) })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

const id = quoteIdent

/** Обгортка порту: `hook` виконується раз, перед першим записом фази запису. */
function beforeFirstWrite(hook: () => Promise<void>): ApplyDatabase {
  let fired = false
  const fire = async () => {
    if (fired) return
    fired = true
    await hook()
  }
  return {
    transaction: async (db, end, fn) => {
      if (end === "commit") await fire()
      return port.transaction(db, end, fn)
    },
    statement: async (db, text) => {
      await fire()
      return port.statement(db, text)
    },
  }
}

describe("roles: the postgres profile cluster", () => {
  it("creates the roles, the database, the sealed template and the extension schemas", async () => {
    const { set, extra } = scenario("full")
    const outcome = await mustEnsure(set)
    expect(outcome.created).toEqual(
      expect.arrayContaining([
        ...clusterRoleNames(set),
        set.database,
        set.template,
      ])
    )
    expect(outcome.present).toEqual([])
    const [runtime] = set.roles.login
    const [command] = set.roles.names
    const [user, anon] = set.request

    const attrs = await sql<{ rolname: string } & Record<string, unknown>>(
      undefined,
      `select rolname, rolcanlogin, rolsuper, rolinherit, rolbypassrls,
              rolcreatedb, rolcreaterole, rolreplication, rolconfig
         from pg_roles where rolname = any($1)`,
      [clusterRoleNames(set)]
    )
    const byRole = (a: { rolname: string }, b: { rolname: string }) =>
      a.rolname < b.rolname ? -1 : 1
    const shape = (
      name: string,
      login: boolean,
      over: Record<string, unknown> = {}
    ) => ({
      rolname: name,
      rolcanlogin: login,
      rolsuper: false,
      rolinherit: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolconfig: null,
      ...over,
    })
    expect([...attrs].sort(byRole)).toEqual(
      [
        shape(set.owner, true, { rolbypassrls: true, rolcreatedb: true }),
        shape(set.auth, true, { rolconfig: ["search_path=better_auth"] }),
        shape(command!, false),
        shape(user!, false),
        shape(anon!, false),
        shape(runtime!.name, true),
      ].sort(byRole)
    )

    // Єдині членства — пари ролі входу рантайму: INHERIT FALSE, SET TRUE
    const members = (await clusterState(set)).members as {
      role: string
    }[]
    expect([...members].sort((a, b) => (a.role < b.role ? -1 : 1))).toEqual(
      [command!, user!, anon!]
        .map((role) => ({
          role,
          member: runtime!.name,
          grantor: expect.any(String),
          admin_option: false,
          inherit_option: false,
          set_option: true,
        }))
        .sort((a, b) => (a.role < b.role ? -1 : 1))
    )

    const databases = await sql<{
      datname: string
      owner: string
      super: boolean
      datistemplate: boolean
      datallowconn: boolean
    }>(
      undefined,
      `select d.datname, o.rolname as owner, o.rolsuper as super,
              d.datistemplate, d.datallowconn
         from pg_database d join pg_roles o on o.oid = d.datdba
        where d.datname = any($1) order by 1`,
      [[set.database, set.template]]
    )
    const byName = Object.fromEntries(databases.map((d) => [d.datname, d]))
    expect(byName[set.database]).toMatchObject({ owner: set.owner })
    expect(byName[set.template]).toMatchObject({
      super: true,
      datistemplate: true,
      datallowconn: false,
    })

    // Ціль: розширення, USAGE власника, better_auth, налаштування auth
    const target = (text: string) =>
      sql<Record<string, unknown>>(set.database, text)
    expect(
      await target(
        `select n.nspname as schema from pg_extension e
           join pg_namespace n on n.oid = e.extnamespace
          where e.extname = 'plpgsql_check'`
      )
    ).toEqual([{ schema: "extensions" }])
    expect(
      await sql(
        set.database,
        `select has_schema_privilege($1, 'extensions', 'USAGE') as usage,
                has_schema_privilege($1, 'extensions', 'CREATE') as create,
                (select r.rolname from pg_namespace n join pg_roles r on r.oid = n.nspowner
                  where n.nspname = 'extensions') as owner`,
        [set.owner]
      )
    ).toEqual([{ usage: true, create: false, owner: "postgres" }])
    expect(
      await target(
        `select r.rolname as owner from pg_namespace n
           join pg_roles r on r.oid = n.nspowner where n.nspname = 'better_auth'`
      )
    ).toEqual([{ owner: set.auth }])
    const settings = (await clusterState(set)).settings
    expect(settings).toHaveLength(2)
    expect(settings).toEqual(
      expect.arrayContaining([
        {
          rolname: set.auth,
          datname: null,
          setconfig: ["search_path=better_auth"],
        },
        {
          rolname: set.auth,
          datname: set.database,
          setconfig: ["search_path=better_auth"],
        },
      ])
    )

    // Копія шаблону: plpgsql_check є, better_auth немає
    const copy = testDatabaseName("full_cp")
    extra.push(copy)
    await sql(
      undefined,
      `create database ${id(copy)} template ${id(set.template)}`
    )
    expect(
      await sql(
        copy,
        `select extname from pg_extension where extname = 'plpgsql_check'`
      )
    ).toHaveLength(1)
    expect(
      await sql(
        copy,
        `select 1 from pg_namespace where nspname = 'better_auth'`
      )
    ).toEqual([])
  })

  it("is idempotent, also after the template is sealed and after auth owns a table with a TOAST relation", async () => {
    const { set } = scenario("idem")
    await mustEnsure(set)
    const state = await clusterState(set)
    expect(await mustEnsure(set)).toEqual({
      created: [],
      present: expect.arrayContaining([set.database, set.template]),
    })
    expect(await clusterState(set)).toEqual(state)
    // TOAST-відношення таблиці `auth` живе в `pg_toast` з її власником: це не
    // об'єкт `auth` поза `better_auth`
    await setTestPasswords(set)
    await asRole(set, set.auth, (c) =>
      c.query("create table better_auth.sample (body text)")
    )
    expect(await mustEnsure(set)).toEqual({
      created: [],
      present: expect.any(Array),
    })
    expect(await clusterState(set)).toEqual(state)
  })

  it("finishes and seals a template that a superuser left unmarked", async () => {
    const { set } = scenario("unfin")
    await mustEnsure(set)
    await sql(undefined, `alter database ${id(set.template)} is_template false`)
    await sql(
      undefined,
      `alter database ${id(set.template)} allow_connections true`
    )
    // Перерваний запуск міг лишити шаблон з типовим CONNECT для PUBLIC
    await sql(
      undefined,
      `grant connect, temporary on database ${id(set.template)} to public`
    )
    const outcome = await mustEnsure(set)
    expect(outcome.created).toEqual([])
    expect(
      await sql(
        undefined,
        `select count(*)::int as n from pg_database d, aclexplode(d.datacl) a
         where d.datname = $1 and a.grantee = 0`,
        [set.template]
      )
    ).toEqual([{ n: 0 }])
    expect(
      await sql(
        undefined,
        `select datistemplate, datallowconn from pg_database where datname = $1`,
        [set.template]
      )
    ).toEqual([{ datistemplate: true, datallowconn: false }])
    expect(
      await sql(
        undefined,
        `select count(*)::int as n from pg_stat_activity where datname = $1`,
        [set.template]
      )
    ).toEqual([{ n: 0 }])
  })

  it("creates the template from nothing when only the roles and the database exist", async () => {
    const { set } = scenario("tplgone")
    await mustEnsure(set)
    await sql(undefined, `alter database ${id(set.template)} is_template false`)
    await sql(undefined, `drop database ${id(set.template)}`)
    const outcome = await mustEnsure(set)
    expect(outcome.created).toEqual([set.template])
  })

  it("refuses a session that is not a superuser, and writes nothing", async () => {
    const { set } = scenario("nosuper")
    await mustEnsure(set)
    await setTestPasswords(set)
    const before = await clusterState(set)
    const result = await ensure(set, port, roleUrl(set, set.owner))
    expect(codes(result)).toEqual(["roles.superuser-required"])
    expect(await clusterState(set)).toEqual(before)
  })

  it("refuses an existing database of another owner before it creates any role", async () => {
    const { set } = scenario("dbowner")
    await sql(undefined, `create database ${id(set.database)}`)
    const before = await clusterState(set)
    const result = await ensure(set)
    expect(result.ok ? [] : result.error).toMatchObject([
      { code: "roles.database-owner" },
    ])
    expect(await clusterState(set)).toEqual(before)
    // Ролей ще немає: відмова фази читання нічого не створила
    expect(before.roles).toEqual([])
  })

  it("refuses an explicit CONNECT of a Simetra login role to another database", async () => {
    const { set, extra } = scenario("shared")
    await mustEnsure(set)
    const other = testDatabaseName("shared_other")
    extra.push(other)
    await sql(undefined, `create database ${id(other)}`)
    await sql(
      undefined,
      `grant connect on database ${id(other)} to ${id(set.roles.login[0]!.name)}`
    )
    await expectRefusal(
      set,
      [{ code: "roles.shared-cluster", params: { databases: other } }],
      [other]
    )
  })

  describe("a schema that the superuser session cannot trust", () => {
    const cases: [string, (set: PostgresClusterSet) => string[]][] = [
      [
        "extensions owned by the owner",
        (set) => [
          `drop extension plpgsql_check`,
          `drop schema extensions cascade`,
          `create schema extensions authorization ${id(set.owner)}`,
        ],
      ],
      [
        "CREATE on extensions for the owner",
        (set) => [`grant create on schema extensions to ${id(set.owner)}`],
      ],
      [
        "CREATE on extensions for PUBLIC",
        () => [`grant create on schema extensions to public`],
      ],
      [
        "an object of the owner in extensions",
        (set) => [
          `create function extensions.planted() returns int language sql as 'select 1'`,
          `alter function extensions.planted() owner to ${id(set.owner)}`,
        ],
      ],
      [
        "plpgsql_check in another schema",
        () => [
          `drop extension plpgsql_check`,
          `create extension plpgsql_check schema public`,
        ],
      ],
      [
        "better_auth owned by another role",
        (set) => [`alter schema better_auth owner to ${id(set.owner)}`],
      ],
      [
        "CREATE on the database for auth",
        (set) => [
          `grant create on database ${id(set.database)} to ${id(set.auth)}`,
        ],
      ],
      [
        "CREATE on public for auth",
        (set) => [`grant create on schema public to ${id(set.auth)}`],
      ],
      [
        "a relation of auth outside better_auth",
        (set) => [
          `create table public.stray (x int)`,
          `alter table public.stray owner to ${id(set.auth)}`,
        ],
      ],
      [
        "another search_path of auth in the database",
        (set) => [
          `alter role ${id(set.auth)} in database ${id(set.database)} set search_path = public`,
        ],
      ],
    ]
    it.each(cases)("%s", async (_title, perturb) => {
      const { set } = scenario("unsafe")
      await mustEnsure(set)
      for (const statement of perturb(set)) await sql(set.database, statement)
      await expectRefusal(set, [{ code: "roles.unsafe-schema" }])
    })
  })

  describe("a template that the superuser session cannot trust", () => {
    it("refuses a template that the owner created", async () => {
      const { set } = scenario("tplown")
      await mustEnsure(set)
      await setTestPasswords(set)
      await sql(
        undefined,
        `alter database ${id(set.template)} is_template false`
      )
      await sql(undefined, `drop database ${id(set.template)}`)
      const client = new pg.Client({
        connectionString: withDatabaseName(roleUrl(set, set.owner), "postgres"),
      })
      await client.connect()
      try {
        await client.query(
          `create database ${id(set.template)} template template0`
        )
      } finally {
        await client.end()
      }
      await expectRefusal(set, [{ code: "roles.unsafe-template" }])
    })

    it("refuses a sealed template that accepts connections again", async () => {
      const { set } = scenario("tplopen")
      await mustEnsure(set)
      await sql(
        undefined,
        `alter database ${id(set.template)} allow_connections true`
      )
      await expectRefusal(set, [{ code: "roles.unsafe-template" }])
    })

    it("refuses an unsealed template that already has better_auth", async () => {
      const { set } = scenario("tplba")
      await mustEnsure(set)
      await sql(
        undefined,
        `alter database ${id(set.template)} is_template false`
      )
      await sql(
        undefined,
        `alter database ${id(set.template)} allow_connections true`
      )
      await sql(set.template, `create schema better_auth`)
      await expectRefusal(set, [{ code: "roles.unsafe-template" }])
    })
  })

  describe("the shape of the existing roles", () => {
    const cases: [
      string,
      (set: PostgresClusterSet) => string[],
      (set: PostgresClusterSet) => { role: string; violation: string },
    ][] = [
      [
        "an owner that belongs to a predefined role",
        (set) => [`grant pg_execute_server_program to ${id(set.owner)}`],
        (set) => ({
          role: set.owner,
          violation: "member-of:pg_execute_server_program",
        }),
      ],
      [
        "the runtime login role that belongs to the owner",
        (set) => [`grant ${id(set.owner)} to ${id(set.roles.login[0]!.name)}`],
        (set) => ({
          role: set.owner,
          violation: `member:${set.roles.login[0]!.name}`,
        }),
      ],
      [
        "an auth role with BYPASSRLS",
        (set) => [`alter role ${id(set.auth)} bypassrls`],
        (set) => ({ role: set.auth, violation: "bypassRls" }),
      ],
    ]
    it.each(cases)("%s", async (_title, perturb, violation) => {
      const { set } = scenario("shape")
      await mustEnsure(set)
      for (const statement of perturb(set)) await sql(undefined, statement)
      await expectRefusal(set, [
        { code: "plan.platform-role-shape", params: violation(set) },
      ])
    })

    it("refuses an intermediary with CREATEROLE that a request role reaches", async () => {
      const { set } = scenario("path")
      await mustEnsure(set)
      const [user, anon] = set.request
      const middle = testRoleName("path_mid")
      await sql(undefined, `create role ${id(middle)} nologin createrole`)
      try {
        await sql(
          undefined,
          `grant ${id(middle)} to ${id(anon!)} with inherit false, set true`
        )
        await sql(
          undefined,
          `grant ${id(user!)} to ${id(middle)} with admin true, inherit false, set false`
        )
        await expectRefusal(set, [
          {
            code: "plan.platform-role-shape",
            params: { role: user, violation: `request-path:${middle}` },
          },
        ])
      } finally {
        await sql(undefined, `drop role ${id(middle)}`)
      }
    })
  })

  describe("a change between the read phase and the write phase", () => {
    it("re-checks extensions right before CREATE EXTENSION", async () => {
      const { set } = scenario("late")
      await mustEnsure(set)
      await sql(set.database, `drop extension plpgsql_check`)
      const racing = beforeFirstWrite(async () => {
        await sql(
          set.database,
          `grant create on schema extensions to ${id(set.owner)}`
        )
      })
      const result = await ensure(set, racing)
      expect(result.ok ? [] : result.error).toMatchObject([
        { code: "roles.unsafe-schema" },
      ])
      expect(
        await sql(
          set.database,
          `select 1 from pg_extension where extname = 'plpgsql_check'`
        )
      ).toEqual([])
    })

    it("fails, and installs nothing, when the owner creates extensions in between", async () => {
      const { set } = scenario("race")
      await mustEnsure(set)
      await setTestPasswords(set)
      await sql(set.database, `drop extension plpgsql_check`)
      await sql(set.database, `drop schema extensions`)
      const racing = beforeFirstWrite(async () => {
        await asRole(set, set.owner, (c) => c.query("create schema extensions"))
      })
      await expect(ensure(set, racing)).rejects.toMatchObject({
        sqlstate: "42P06",
      })
      expect(
        await sql(
          set.database,
          `select 1 from pg_extension where extname = 'plpgsql_check'`
        )
      ).toEqual([])
    })
  })

  // Мутація (Review Focus 4): без прелюдії транзакції `roles` цей тест червоний
  it("is not steered by a role, a search_path and functions that the owner plants", async () => {
    const { set } = scenario("plant")
    await mustEnsure(set)
    await setTestPasswords(set)
    const plant = [
      `create table public.marker (who text)`,
      `create function public.current_database() returns name language plpgsql
         as $$ begin insert into public.marker values (current_user); return null; end $$`,
      `create function public.pg_get_userbyid(oid) returns name language plpgsql
         as $$ begin insert into public.marker values (current_user); return null; end $$`,
      `create function public.has_database_privilege(oid, text, text) returns boolean language plpgsql
         as $$ begin insert into public.marker values (current_user); return true; end $$`,
      `create function public.has_schema_privilege(oid, oid, text) returns boolean language plpgsql
         as $$ begin insert into public.marker values (current_user); return true; end $$`,
      `create function public.aclexplode(aclitem[])
         returns table (grantor oid, grantee oid, privilege_type text, is_grantable boolean)
         language plpgsql
         as $$ begin insert into public.marker values (current_user); return; end $$`,
      `create function public.name_eq_text(name, text) returns boolean language plpgsql
         as $$ begin insert into public.marker values (current_user); return true; end $$`,
      `create operator public.= (leftarg = name, rightarg = text, function = public.name_eq_text)`,
    ]
    await asRole(set, set.owner, async (c) => {
      for (const statement of plant) await c.query(statement)
    })
    await sql(
      undefined,
      `alter database ${id(set.database)} set role = ${id(set.owner)}`
    )
    await sql(
      undefined,
      `alter database ${id(set.database)} set search_path = public, pg_catalog`
    )
    const result = await ensure(set)
    expect(result).toEqual({
      ok: true,
      value: { created: [], present: expect.any(Array) },
    })
    expect(await sql(set.database, `select who from public.marker`)).toEqual([])
  })

  it("keeps a runtime login role without SET ROLE from reading the tables of a request role", async () => {
    const { set } = scenario("runtime")
    await mustEnsure(set)
    await setTestPasswords(set)
    const [user] = set.request
    await sql(set.database, `create table public.readable (x int)`)
    await sql(set.database, `grant select on public.readable to ${id(user!)}`)
    await asRole(set, set.roles.login[0]!.name, async (c) => {
      await expect(
        c.query("select * from public.readable")
      ).rejects.toMatchObject({
        code: "42501",
      })
      await c.query(`set role ${id(user!)}`)
      expect((await c.query("select * from public.readable")).rows).toEqual([])
    })
  })

  it("lifts the session timeouts inside the prelude transaction only", async () => {
    const { set } = scenario("idle")
    await mustEnsure(set)
    // Ліміт простою на рівні бази, як у кластері з налаштованим таймаутом
    await sql(
      undefined,
      `alter database ${id(set.database)} set idle_in_transaction_session_timeout = '5min'`
    )
    await sql(
      undefined,
      `alter database ${id(set.database)} set transaction_timeout = '5min'`
    )
    const client = new pg.Client({
      connectionString: withDatabaseName(testSuperuserUrl(), set.database),
    })
    await client.connect()
    try {
      const read = async (guc: string) =>
        (
          await client.query<{ v: string }>("select current_setting($1) as v", [
            guc,
          ])
        ).rows[0]!.v
      const GUCS = [
        "idle_in_transaction_session_timeout",
        "transaction_timeout",
      ]
      for (const guc of GUCS) expect(await read(guc)).toBe("5min")
      for (const outcome of ["COMMIT", "ROLLBACK"]) {
        await client.query("BEGIN")
        for (const text of CLUSTER_TRANSACTION_PRELUDE) await client.query(text)
        for (const guc of GUCS) expect(await read(guc)).toBe("0")
        await client.query(outcome)
        for (const guc of GUCS) expect(await read(guc)).toBe("5min")
      }
    } finally {
      await client.end()
    }
  })
})
