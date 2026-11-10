import { withDatabaseName } from "@supabase/pg-delta"
import pg from "pg"
import { ensurePostgresCluster, type PostgresClusterSet } from "simetra/schema"
import { afterAll, describe, expect, it } from "vitest"
import { prepareStackIdentity } from "../../../simetra/test/db/better-auth-cli"
import { migrateBetterAuth } from "../../../simetra/test/db/better-auth"
import {
  clusterRoleNames,
  dropTaggedCluster,
  roleUrl,
  setTestPasswords,
  taggedClusterSet,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import { createApplyDatabase } from "../schema-engine"

/**
 * `prepareStackIdentity` (Р13) на тегованому кластері. DB-рівень, бо гранти,
 * їх відкликання й власника відношень вирішує Postgres, а міграція Better Auth
 * потребує справжньої схеми під роллю без CREATE на базу. Тест лежить у
 * designer: двигун, що готує кластер, — адаптер цього пакета, а `simetra` його
 * не імпортує.
 */
const created: PostgresClusterSet[] = []

afterAll(async () => {
  const failures: unknown[] = []
  for (const set of created)
    await dropTaggedCluster(set).catch((e: unknown) => failures.push(e))
  if (failures.length > 0) throw failures[0]
})

let scenarios = 0

async function cluster(label: string): Promise<PostgresClusterSet> {
  const set = taggedClusterSet(`${label}${(scenarios += 1)}`)
  created.push(set)
  const url = testSuperuserUrl()
  const result = await ensurePostgresCluster(
    createApplyDatabase({ readOnly: false }),
    {
      maintenance: { url: withDatabaseName(url, "postgres") },
      target: { url: withDatabaseName(url, set.database) },
      template: { url: withDatabaseName(url, set.template) },
    },
    set
  )
  if (!result.ok)
    throw new Error(`roles refused: ${result.error.map((d) => d.code)}`)
  await setTestPasswords(set)
  return set
}

const superuserUrl = (set: PostgresClusterSet): string =>
  withDatabaseName(testSuperuserUrl(), set.database)

const identity = (set: PostgresClusterSet) => ({
  superuserUrl: superuserUrl(set),
  authUrl: roleUrl(set, set.auth),
  owner: set.owner,
})

async function sql<T extends Record<string, unknown>>(
  set: PostgresClusterSet,
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const client = new pg.Client({ connectionString: superuserUrl(set) })
  await client.connect()
  try {
    return (await client.query<T>(text, params)).rows
  } finally {
    await client.end()
  }
}

const grants = async (set: PostgresClusterSet) =>
  (
    await sql<{ usage: boolean; trigger: boolean | null }>(
      set,
      `select has_schema_privilege($1, 'better_auth', 'USAGE') as usage,
              case when to_regclass('better_auth."user"') is null then null
                   else has_table_privilege($1, 'better_auth."user"', 'TRIGGER') end as trigger`,
      [set.owner]
    )
  )[0]

/** Все, що `prepareStackIdentity` могла б змінити, одним знімком. */
async function snapshot(set: PostgresClusterSet): Promise<unknown> {
  const roles = clusterRoleNames(set)
  const of = async (text: string, params: unknown[] = [roles]) =>
    sql(set, text, params)
  return {
    roles: await of(
      `select rolname, rolcanlogin, rolinherit, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolreplication
         from pg_roles where rolname = any($1) order by 1`
    ),
    members: await of(
      `select m.rolname as member, r.rolname as role, a.admin_option, a.inherit_option, a.set_option
         from pg_auth_members a join pg_roles m on m.oid = a.member join pg_roles r on r.oid = a.roleid
        where m.rolname = any($1) or r.rolname = any($1) order by 1, 2`
    ),
    privileges: (
      await sql<{ usage: boolean; sel: boolean; ins: boolean; trg: boolean }>(
        set,
        `select has_schema_privilege($1, 'better_auth', 'USAGE') as usage,
                has_table_privilege($1, 'better_auth."user"', 'SELECT') as sel,
                has_table_privilege($1, 'better_auth."user"', 'INSERT') as ins,
                has_table_privilege($1, 'better_auth."user"', 'TRIGGER') as trg`,
        [set.owner]
      )
    )[0],
    columns: await of(
      `select column_name, data_type, ordinal_position from information_schema.columns
        where table_schema = 'better_auth' and table_name = 'user' order by 3`,
      []
    ),
    settings: await of(
      `select r.rolname, d.datname, s.setconfig from pg_db_role_setting s
         left join pg_roles r on r.oid = s.setrole left join pg_database d on d.oid = s.setdatabase
        where r.rolname = any($1) order by 1, 2`
    ),
    nspacl: await of(
      "select nspacl::text[] as acl from pg_namespace where nspname = 'better_auth'",
      []
    ),
    relations: await of(
      `select c.relname, c.relkind, c.relacl::text[] as acl from pg_class c
         join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'better_auth' order by 1`,
      []
    ),
  }
}

const noop = async (): Promise<void> => {}

describe("prepareStackIdentity", () => {
  it("changes nothing on a repeat call", async () => {
    const set = await cluster("rep")
    await prepareStackIdentity(identity(set))
    expect(await grants(set)).toEqual({ usage: true, trigger: true })
    const first = await snapshot(set)
    await prepareStackIdentity(identity(set))
    expect(await snapshot(set)).toEqual(first)
  }, 120_000)

  it("leaves no grants when the migration fails, cold and warm", async () => {
    const set = await cluster("fail")
    // Справжня міграція виконується, а тоді падає: таблиці вже є, гранту ще нема
    await expect(
      prepareStackIdentity({
        ...identity(set),
        migrate: async (url) => {
          await migrateBetterAuth(url)
          throw new Error("after migration")
        },
      })
    ).rejects.toThrow("after migration")
    expect(await grants(set)).toEqual({ usage: false, trigger: false })
    // Підставна міграція створює частину таблиць і падає
    await expect(
      prepareStackIdentity({
        ...identity(set),
        migrate: async (url) => {
          const client = new pg.Client({ connectionString: url })
          await client.connect()
          try {
            await client.query(
              "create table better_auth.partial_probe (id int)"
            )
          } finally {
            await client.end()
          }
          throw new Error("partial")
        },
      })
    ).rejects.toThrow("partial")
    expect(await grants(set)).toEqual({ usage: false, trigger: false })
    await prepareStackIdentity(identity(set))
    expect(await grants(set)).toEqual({ usage: true, trigger: true })
    // Тепла база: гранти вже видано, збій наступної міграції їх відкликає
    await expect(
      prepareStackIdentity({
        ...identity(set),
        migrate: async () => {
          throw new Error("warm")
        },
      })
    ).rejects.toThrow("warm")
    expect(await grants(set)).toEqual({ usage: false, trigger: false })
  }, 120_000)

  it("leaves no grants on a half-created schema before any table exists", async () => {
    const set = await cluster("cold")
    await expect(
      prepareStackIdentity({
        ...identity(set),
        migrate: async () => {
          throw new Error("cold")
        },
      })
    ).rejects.toThrow("cold")
    expect(await grants(set)).toEqual({ usage: false, trigger: null })
  }, 120_000)

  it.each([
    ["a view", () => `create view better_auth."user" as select 1 as id`],
    [
      "a table of another owner",
      (set: PostgresClusterSet) =>
        `create table better_auth."user" (id int); alter table better_auth."user" owner to "${set.owner}"`,
    ],
  ])(
    "refuses %s as better_auth.user and grants nothing",
    async (_, ddl) => {
      const set = await cluster("bad")
      await sql(set, ddl(set))
      await expect(
        prepareStackIdentity({ ...identity(set), migrate: noop })
      ).rejects.toThrow("must be a table owned by the auth role")
      expect((await grants(set))?.usage).toBe(false)
      expect((await grants(set))?.trigger).toBe(false)
    },
    120_000
  )
})
