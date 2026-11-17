import { withDatabaseName } from "@supabase/pg-delta"
import pg from "pg"
import { ensurePostgresCluster, type PostgresClusterSet } from "simetra/schema"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
  clusterRoleNames,
  dropTaggedCluster,
  prepareStackIdentity,
  roleUrl,
  setTestPasswords,
  taggedClusterSet,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import { createApplyDatabase } from "../schema-engine"

/**
 * `prepareStackIdentity` на тегованому кластері. DB-рівень, бо
 * власника відношень вирішує Postgres, а міграція Better Auth
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
  authUrl: roleUrl(set, set.auth),
  auth: set.auth,
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
    // Таблиці може ще не бути: тоді її привілеї — `null`
    privileges: (
      await sql<Record<string, boolean | null>>(
        set,
        `select has_schema_privilege($1, 'better_auth', 'USAGE') as usage,
                ${["SELECT", "INSERT", "TRIGGER", "REFERENCES"]
                  .map(
                    (p) =>
                      `case when to_regclass('better_auth."user"') is null then null
                            else has_table_privilege($1, 'better_auth."user"', '${p}') end as "${p}"`
                  )
                  .join(",\n")}`,
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
  // Гранти таблиці ідентичності — справа `roles`: крок міграції
  // сам не дає власнику нічого, а повторний `roles` дає `TRIGGER`
  it("migrates as the auth role and grants nothing itself", async () => {
    const set = await cluster("mig")
    const before = await grants(set)
    await prepareStackIdentity(identity(set))
    expect(before).toEqual({ usage: true, trigger: null })
    expect(await grants(set)).toEqual({ usage: true, trigger: false })
    const owners = await sql<{ owner: string }>(
      set,
      `select distinct pg_get_userbyid(c.relowner)::text as owner from pg_class c
         join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'better_auth'`
    )
    expect(owners).toEqual([{ owner: set.auth }])
  }, 120_000)

  it("changes nothing on a repeat call", async () => {
    const set = await cluster("rep")
    await prepareStackIdentity(identity(set))
    const first = await snapshot(set)
    await prepareStackIdentity(identity(set))
    expect(await snapshot(set)).toEqual(first)
  }, 120_000)

  it("refuses an auth DSN of another role and changes nothing", async () => {
    const set = await cluster("who")
    const migrate = vi.fn(noop)
    const before = await snapshot(set)
    await expect(
      prepareStackIdentity({
        ...identity(set),
        authUrl: roleUrl(set, set.owner),
        migrate,
      })
    ).rejects.toThrow("does not log in as the auth role")
    expect(migrate).not.toHaveBeenCalled()
    expect(await snapshot(set)).toEqual(before)
  }, 120_000)
})
