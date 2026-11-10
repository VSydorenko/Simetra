import pg from "pg"
import { PROVIDER_EVENT_SOURCES, PROVIDER_OWNER_ROLES } from "simetra/model"
import { describe, expect, it } from "vitest"
import { testDatabaseName, testSuperuserUrl } from "./connection"

// DB-тест, бо стан бази `simetra` — результат `db:pg:start` (roles, пароли,
// міграція Better Auth), який видно лише в каталозі живого Postgres
const DATABASE = "simetra"
const owner = PROVIDER_OWNER_ROLES.postgres

function urlOf(database: string): string {
  const url = new URL(testSuperuserUrl())
  url.pathname = `/${database}`
  return url.href
}

async function inDatabase<T>(
  database: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: urlOf(database) })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

describe("database simetra of the postgres stack", () => {
  it("has the schema better_auth owned by the auth role and plpgsql_check in extensions", async () => {
    await inDatabase(DATABASE, async (client) => {
      const { rows } = await client.query<{ owner: string; check: string }>(
        `select (select r.rolname::text from pg_namespace n join pg_roles r on r.oid = n.nspowner
                  where n.nspname = 'better_auth') as owner,
                (select n.nspname::text from pg_extension e join pg_namespace n on n.oid = e.extnamespace
                  where e.extname = 'plpgsql_check') as check`
      )
      expect(rows[0]).toEqual({ owner: "simetra_auth", check: "extensions" })
    })
  })

  it('has better_auth."user" columns of the event source, in order', async () => {
    const source = PROVIDER_EVENT_SOURCES.postgres.find(
      (s) => s.schema === "better_auth" && s.table === "user"
    )
    await inDatabase(DATABASE, async (client) => {
      const { rows } = await client.query<{ name: string }>(
        `select column_name::text as name from information_schema.columns
          where table_schema = 'better_auth' and table_name = 'user'
          order by ordinal_position`
      )
      expect(rows.map((r) => r.name)).toEqual(source?.columns)
    })
  })

  it("gives the owner USAGE on better_auth and TRIGGER, but not INSERT or SELECT, on the user table", async () => {
    await inDatabase(DATABASE, async (client) => {
      const { rows } = await client.query<Record<string, boolean>>(
        `select has_schema_privilege($1, 'better_auth', 'USAGE') as usage,
                has_table_privilege($1, 'better_auth."user"', 'TRIGGER') as trigger,
                has_table_privilege($1, 'better_auth."user"', 'INSERT') as insert,
                has_table_privilege($1, 'better_auth."user"', 'SELECT') as select`,
        [owner]
      )
      expect(rows[0]).toEqual({
        usage: true,
        trigger: true,
        insert: false,
        select: false,
      })
    })
  })

  it("copies from simetra_template with plpgsql_check and without better_auth", async () => {
    const copy = testDatabaseName("stk_copy")
    const admin = new pg.Client({ connectionString: urlOf("postgres") })
    await admin.connect()
    const failures: unknown[] = []
    try {
      await admin.query(
        `create database ${admin.escapeIdentifier(copy)} template simetra_template`
      )
      await inDatabase(copy, async (client) => {
        const { rows } = await client.query<{ check: boolean; auth: boolean }>(
          `select exists (select from pg_extension where extname = 'plpgsql_check') as check,
                  exists (select from pg_namespace where nspname = 'better_auth') as auth`
        )
        expect(rows[0]).toEqual({ check: true, auth: false })
      })
    } catch (error) {
      failures.push(error)
    } finally {
      await admin
        .query(
          `drop database if exists ${admin.escapeIdentifier(copy)} with (force)`
        )
        .catch((e: unknown) => failures.push(e))
      await admin.end().catch((e: unknown) => failures.push(e))
    }
    if (failures.length > 0) throw failures[0]
  }, 60_000)
})
