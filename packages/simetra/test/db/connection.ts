import pg from "pg"

const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

/** Адреса бази стеку для тестів, яким потрібне власне з'єднання (порт `SchemaEngine`). */
export function testDatabaseUrl(): string {
  return process.env.SIMETRA_TEST_DATABASE_URL ?? DEFAULT_URL
}

/**
 * Суперкористувач стеку — лише для об'єктів, яких роль застосунку не створить
 * (shell-тип). Локальний стек Supabase має його як `supabase_admin`.
 */
export function testSuperuserUrl(): string {
  return (
    process.env.SIMETRA_TEST_SUPERUSER_URL ??
    "postgresql://supabase_admin:postgres@127.0.0.1:54322/postgres"
  )
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

/**
 * Роль запиту API: від неї PostgREST виконує запит користувача чи сервісного
 * ключа.
 */
export type ApiRole = "authenticated" | "anon" | "service_role"

/**
 * Перемикає транзакцію на роль API з claims запиту, як це робить PostgREST:
 * `SET LOCAL` і `set_config(…, true)` діють до кінця транзакції чи до відкату
 * точки збереження, тож повернення до власника — справа того, хто кличе.
 * Claims ставляться до ролі: роль API не мала б права їх змінити.
 */
export async function asRole(
  client: pg.Client,
  role: ApiRole,
  claims: Record<string, unknown>
): Promise<void> {
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
    JSON.stringify(claims),
  ])
  await client.query(`SET LOCAL ROLE ${role}`)
}

/**
 * Один запит від ролі API в точці збереження: наступний запит тесту — знову
 * від власника, а помилка доступу повертається кодом, не зриваючи транзакції.
 */
export async function queryAs<T extends pg.QueryResultRow>(
  client: pg.Client,
  role: ApiRole,
  claims: Record<string, unknown>,
  sql: string,
  params: unknown[] = []
): Promise<{ rows: T[] } | { code: string }> {
  await client.query("SAVEPOINT as_role")
  try {
    await asRole(client, role, claims)
    const { rows } = await client.query<T>(sql, params)
    return { rows }
  } catch (error) {
    return { code: (error as { code: string }).code }
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT as_role")
  }
}
