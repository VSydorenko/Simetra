import pg from "pg"
import { PROVIDER_EVENT_SOURCES } from "simetra/model"
import { describe, expect, it } from "vitest"
import { migrateBetterAuth } from "./better-auth"
import {
  testDatabaseName,
  testRoleName,
  testSuperuserUrl,
  loginUrl,
} from "./connection"

const PASSWORD = "better-auth-test"

type Column = { name: string; type: string }

// Знімок усього, що міграція лишає в базі: таблиці, колонки, індекси
async function catalog(client: pg.Client): Promise<unknown> {
  return {
    columns: (
      await client.query(
        `select table_schema, table_name, column_name, data_type, ordinal_position
           from information_schema.columns
          where table_schema not in ('pg_catalog', 'information_schema')
          order by 1, 2, 5`
      )
    ).rows,
    indexes: (
      await client.query(
        "select schemaname, tablename, indexname from pg_indexes where schemaname = 'better_auth' order by 1, 2, 3"
      )
    ).rows,
  }
}

describe("Better Auth migration on the postgres stack", () => {
  // DB-тест, бо перевіряє, що саме Postgres і Better Auth створюють під роллю
  // без CREATE на базу — юніт-рівень цього не доведе
  it("creates better_auth.user in the column order of the event source, touching nothing else", async () => {
    const database = testDatabaseName("ba")
    const role = testRoleName("auth")
    const admin = new pg.Client({ connectionString: testSuperuserUrl() })
    await admin.connect()
    const id = (name: string): string => admin.escapeIdentifier(name)
    const failures: unknown[] = []
    try {
      await admin.query(`CREATE ROLE ${id(role)} LOGIN PASSWORD '${PASSWORD}'`)
      await admin.query(`CREATE DATABASE ${id(database)}`)
      await admin.query(`ALTER ROLE ${id(role)} SET search_path = better_auth`)

      const superUrl = new URL(testSuperuserUrl())
      superUrl.pathname = `/${database}`
      const inDatabase = new pg.Client({ connectionString: superUrl.href })
      await inDatabase.connect()
      let authUrl: string
      try {
        await inDatabase.query(
          `CREATE SCHEMA better_auth AUTHORIZATION ${id(role)}`
        )
        authUrl = loginUrl(superUrl.href, role, PASSWORD)

        await migrateBetterAuth(authUrl)

        const columns = (
          await inDatabase.query<{ name: string; type: string }>(
            `select column_name as name, data_type as type
               from information_schema.columns
              where table_schema = 'better_auth' and table_name = 'user'
              order by ordinal_position`
          )
        ).rows satisfies Column[]
        const source = PROVIDER_EVENT_SOURCES.postgres.find(
          (s) => s.schema === "better_auth" && s.table === "user"
        )
        expect(columns.map((c) => c.name)).toEqual(source?.columns)
        expect(columns.find((c) => c.name === "id")?.type).toBe("uuid")
        expect(columns.find((c) => c.name === "isAnonymous")?.type).toBe(
          "boolean"
        )
        expect(
          (
            await inDatabase.query(
              "select 1 from pg_tables where schemaname = 'public'"
            )
          ).rows
        ).toEqual([])

        const before = await catalog(inDatabase)
        await migrateBetterAuth(authUrl)
        expect(await catalog(inDatabase)).toEqual(before)
      } finally {
        await inDatabase.end()
      }
    } catch (error) {
      failures.push(error)
    } finally {
      // Своє ім'я прогону: база спершу, бо роль, що володіє схемою в ній,
      // не видалиться разом із базою. Кожен крок іде незалежно від збою
      // попереднього: тест нічого не лишає навіть на шляху помилки
      for (const step of [
        () =>
          admin.query(`DROP DATABASE IF EXISTS ${id(database)} WITH (FORCE)`),
        () => admin.query(`DROP ROLE IF EXISTS ${id(role)}`),
        () => admin.end(),
      ])
        await step().catch((e: unknown) => failures.push(e))
    }
    // Перша помилка — причина збою; решта лише не завадила прибиранню
    if (failures.length > 0) throw failures[0]
  }, 60_000)
})
