import pg from "pg"

const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

/** Адреса бази стеку для тестів, яким потрібне власне з'єднання (порт `SchemaEngine`). */
export function testDatabaseUrl(): string {
  return process.env.SIMETRA_TEST_DATABASE_URL ?? DEFAULT_URL
}

/**
 * Кількість scratch-баз двигуна (`pgdelta_shadow_%`) на стеку. Тінь-сирота
 * лишається, якщо процес убито до `finally` (план E2a, рішення за спайком, 1),
 * тож тести порівнюють лічильник до й після, а не покладаються на ім'я.
 */
export async function shadowDatabaseCount(): Promise<number> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    const result = await client.query<{ n: number }>(
      "select count(*)::int as n from pg_database where datname like 'pgdelta_shadow_%'"
    )
    return result.rows[0]?.n ?? -1
  } finally {
    await client.end()
  }
}

/**
 * Виконує `fn` у транзакції, яку завжди відкочує: DDL тесту не лишає слідів у
 * базі стеку. Відсутня база — виняток із `connect` (тест червоний, не пропуск).
 */
export async function withRollback<T>(
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({
    connectionString: testDatabaseUrl(),
  })
  await client.connect()
  try {
    await client.query("BEGIN")
    try {
      return await fn(client)
    } finally {
      // Відкат після збою `fn` може сам впасти (перервана транзакція) — це не
      // має затирати першопричину
      await client.query("ROLLBACK").catch(() => undefined)
    }
  } finally {
    await client.end()
  }
}
