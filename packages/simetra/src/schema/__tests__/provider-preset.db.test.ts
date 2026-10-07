import pg from "pg"
import { describe, expect, it } from "vitest"
import {
  SUPABASE_BASE_EXTENSIONS,
  SUPABASE_PUBLIC_SCHEMA_GRANTS,
} from "../engine/provider/supabase"
import { testDatabaseUrl } from "../../../test/db/connection"

/**
 * Контрактна передумова пресету (план «Промоція-1», задача 5): пресет
 * фіксований, а образ провайдера оновлюється. Розходження пресету з образом
 * локального стеку має бути червоним тестом тут, а не тихою різницею в плані
 * кожного застосунку з керованою `public`.
 */

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    return (await client.query<T>(sql)).rows
  } finally {
    await client.end()
  }
}

const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

describe("the provider preset matches the stack image", () => {
  it("the stack's public schema ACL equals the preset", async () => {
    // Власник схеми — з каталогу, а не вшитий `pg_database_owner`: його права
    // дає володіння, а не пресет
    const rows = await query<{ grantee: string; privilege: string }>(
      `SELECT CASE a.grantee WHEN 0 THEN 'PUBLIC'
                ELSE a.grantee::regrole::text END AS grantee,
              a.privilege_type AS privilege
         FROM pg_namespace n, aclexplode(n.nspacl) a
        WHERE n.nspname = 'public' AND a.grantee <> n.nspowner`
    )
    const actual = rows.map((r) => `${r.grantee}=${r.privilege}`)
    const preset = SUPABASE_PUBLIC_SCHEMA_GRANTS.flatMap((g) =>
      g.privileges.map((p) => `${g.grantee}=${p}`)
    )
    expect(actual.sort(byCodePoint)).toEqual(preset.sort(byCodePoint))
  })

  it("the stack has every base extension in its schema", async () => {
    const rows = await query<{ name: string; schema: string }>(
      `SELECT extname AS name, extnamespace::regnamespace::text AS schema
         FROM pg_extension`
    )
    for (const ext of SUPABASE_BASE_EXTENSIONS)
      expect(rows).toContainEqual({ name: ext.name, schema: ext.schema })
  })
})
