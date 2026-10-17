import pg from "pg"
import { describe, expect, it } from "vitest"
import { PROVIDER_EVENT_SOURCES } from "simetra/model"
import { testDatabaseUrl } from "./connection"

/**
 * Пресет фіксований, а образ провайдера оновлюється: розходження колонок
 * пресету з образом локального стеку — червоний тест тут, а не `whenChanged`,
 * що мовчки називає колонку, якої немає.
 */
describe("provider event sources match the stack image", () => {
  it("preset columns equal the stack columns in ordinal order", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() })
    await client.connect()
    try {
      for (const source of PROVIDER_EVENT_SOURCES.supabase) {
        const { rows } = await client.query<{ column_name: string }>(
          `select column_name from information_schema.columns
            where table_schema = $1 and table_name = $2
            order by ordinal_position`,
          [source.schema, source.table]
        )
        expect(
          rows.map((r) => r.column_name),
          `${source.schema}.${source.table}`
        ).toEqual(source.columns)
      }
    } finally {
      await client.end()
    }
  })
})
