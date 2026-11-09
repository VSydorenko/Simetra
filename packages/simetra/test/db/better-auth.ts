import { getMigrations } from "better-auth/db/migration"
import { anonymous } from "better-auth/plugins"
import { PostgresDialect } from "kysely"
import pg from "pg"

/**
 * Creates the Better Auth tables in schema `better_auth` of the database at
 * `url` (a DSN of role `auth` that owns the schema) and closes its pool.
 *
 * `schemaName` is left out on purpose: with it Better Auth sends
 * `CREATE SCHEMA IF NOT EXISTS`, and Postgres checks `CREATE` on the database
 * before `IF NOT EXISTS`, which the role does not have. The schema is found
 * through `search_path`, set on the pool connection.
 */
export async function migrateBetterAuth(url: string): Promise<void> {
  // Опція з'єднання, а не лише налаштування ролі: вона працює й тоді, коли
  // роль входу не та, що налаштована (друга лінія захисту — `ALTER ROLE … SET`)
  const pool = new pg.Pool({
    connectionString: url,
    options: "-c search_path=better_auth",
    max: 1,
  })
  try {
    const { runMigrations } = await getMigrations({
      database: { type: "postgres", dialect: new PostgresDialect({ pool }) },
      // UUID-ідентифікатори: колонка `id` — `uuid`, як у контракті джерел подій
      advanced: { database: { generateId: "uuid" } },
      plugins: [anonymous()],
    })
    await runMigrations()
  } finally {
    await pool.end()
  }
}
