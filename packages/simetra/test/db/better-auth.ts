import { betterAuth, type BetterAuthOptions } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { anonymous } from "better-auth/plugins"
import { PostgresDialect } from "kysely"
import pg from "pg"
import { withSessionOptions } from "./connection"

/**
 * Секрет і адреса тестового екземпляра: без них Better Auth бере типові
 * значення й попереджає в лог. Лише для тестів — жодної сесії поза процесом.
 */
const TEST_SECRET = "simetra-test-better-auth-secret-0123456789"
const TEST_BASE_URL = "http://localhost:3000"

/**
 * Конфіг Better Auth тестів — одне джерело для міграції й для подій
 * (`auth.api`): розбіжність дала б таблиці не тієї форми, у яку пишуть події.
 * `schemaName` немає навмисно: з ним Better Auth шле
 * `CREATE SCHEMA IF NOT EXISTS`, а Postgres перевіряє `CREATE` на базу ще
 * до `IF NOT EXISTS`, і роль `auth` його не має. Схему дає `search_path`
 * з'єднання.
 */
function authOptions(pool: pg.Pool) {
  return {
    database: {
      type: "postgres",
      dialect: new PostgresDialect({ pool }),
    },
    secret: TEST_SECRET,
    baseURL: TEST_BASE_URL,
    // UUID-ідентифікатори: колонка `id` — `uuid`, як у контракті джерел подій
    advanced: { database: { generateId: "uuid" } },
    plugins: [anonymous()],
    emailAndPassword: { enabled: true },
  } satisfies BetterAuthOptions
}

/** Тестовий екземпляр Better Auth: тип з плагінами, щоб `auth.api` мав їхні ендпоінти. */
export type TestAuth = ReturnType<typeof createAuth>

function createAuth(pool: pg.Pool) {
  return betterAuth(authOptions(pool))
}

/** Пул тестового екземпляра до бази `url` зі схемою Better Auth у `search_path`. */
function authPool(url: string): pg.Pool {
  // Опція з'єднання, а не лише налаштування ролі: вона працює й тоді, коли
  // роль входу не та, що налаштована (друга лінія захисту — `ALTER ROLE … SET`)
  return new pg.Pool({
    connectionString: withSessionOptions(url, "-c search_path=better_auth"),
    max: 2,
  })
}

/**
 * A Better Auth instance over the database at `url` (a DSN of role `auth`
 * that owns schema `better_auth`) with the test configuration; `close` ends
 * its pool.
 */
export function testAuth(url: string): {
  auth: TestAuth
  close(): Promise<void>
} {
  const pool = authPool(url)
  return { auth: createAuth(pool), close: () => pool.end() }
}

/**
 * Creates the Better Auth tables in schema `better_auth` of the database at
 * `url` (a DSN of role `auth` that owns the schema) and closes its pool. The
 * configuration is that of `testAuth`.
 */
export async function migrateBetterAuth(url: string): Promise<void> {
  // Конфіг, а не екземпляр: екземпляр на старті звіряє схему й лаяв би в
  // лог відсутніми таблицями, які міграція саме створює
  const pool = authPool(url)
  try {
    const { runMigrations } = await getMigrations(authOptions(pool))
    await runMigrations()
  } finally {
    await pool.end()
  }
}
