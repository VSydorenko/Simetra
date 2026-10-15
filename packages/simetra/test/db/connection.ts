import pg from "pg"

const DEFAULT_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres"

/** Адреса бази стеку для тестів, яким потрібне власне з'єднання (порт `SchemaEngine`). */
export function testDatabaseUrl(): string {
  return process.env.SIMETRA_TEST_DATABASE_URL ?? DEFAULT_URL
}

/**
 * Пулер стеку в режимі транзакцій (Supavisor): порт — `[db.pooler] port` у
 * `supabase/config.toml`, користувач — у форматі тенанта, який створює
 * Supabase CLI (`<роль>.pooler-dev`). `supabase status` рядка пулера не
 * друкує, тож значення звірене підключенням до локального стеку. Типове
 * значення, а не пропуск тесту: CI піднімає стек із того самого конфігу, і
 * недоступний пулер має валити перевірку.
 */
export function testPoolerUrl(): string {
  return (
    process.env.SIMETRA_TEST_POOLER_URL ??
    "postgresql://postgres.pooler-dev:postgres@127.0.0.1:54329/postgres"
  )
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
 * Префікс імені scratch-бази двигуна: pg-delta називає її
 * `pgdelta_shadow_<мс у base36>_…`. Єдине місце, де тести знають цю форму, —
 * сторож стеку, сторож тіней `round-trip.db.test.ts` і лічильники нижче.
 */
export const SHADOW_PREFIX = "pgdelta_shadow_"

/**
 * Вік тіні в хвилинах з її імені. Ім'я іншої форми — `undefined` («вік
 * невідомий»): невпізнане ім'я не можна видавати ні за свіже, ні за старе.
 */
export function shadowAgeMinutes(
  name: string,
  now: number = Date.now()
): number | undefined {
  if (!name.startsWith(SHADOW_PREFIX)) return undefined
  const stamp = /^([0-9a-z]+)_/.exec(name.slice(SHADOW_PREFIX.length))?.[1]
  if (stamp === undefined) return undefined
  const ms = parseInt(stamp, 36)
  return Number.isNaN(ms) ? undefined : (now - ms) / 60_000
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
      "select count(*)::int as n from pg_database where starts_with(datname, $1)",
      [SHADOW_PREFIX]
    )
    return result.rows[0]?.n ?? -1
  } finally {
    await client.end()
  }
}

/**
 * Імена scratch-баз двигуна на стеку, відсортовані. Набір, а не лічильник:
 * сирота, що вже була чи зникла, нову тінь не маскує. Але нове ім'я в наборі
 * ще не «наша» тінь: паралельна сесія створює такі самі імена на тому самому
 * стеку. Чия тінь, вирішує тест за власним записом провізії
 * (`round-trip.db.test.ts`), а не за різницею наборів.
 */
export async function shadowDatabaseNames(): Promise<string[]> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    const result = await client.query<{ name: string }>(
      "select datname as name from pg_database where starts_with(datname, $1) order by 1",
      [SHADOW_PREFIX]
    )
    return result.rows.map((r) => r.name)
  } finally {
    await client.end()
  }
}

/**
 * Виконує `fn` у транзакції, яку завжди відкочує: DDL тесту не лишає слідів у
 * базі стеку. Відсутня база — виняток із `connect` (тест червоний, не пропуск).
 * `url` — інша роль стеку (`testSuperuserUrl()` для того, чого роль
 * застосунку не виконає, як `CREATE EXTENSION`).
 */
export async function withRollback<T>(
  fn: (client: pg.Client) => Promise<T>,
  url: string = testDatabaseUrl()
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
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
