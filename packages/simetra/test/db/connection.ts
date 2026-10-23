import pg from "pg"
import type { ApplyDatabase, ApplyTransaction } from "simetra/schema"

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
 * `pgdelta_shadow_<мс у base36>_…`. Префікс каже лише, що база — тінь; чия
 * вона, вирішує облік провізій
 * `packages/designer/src/__tests__/support/shadows.ts`.
 */
export const SHADOW_PREFIX = "pgdelta_shadow_"

/** Змінна середовища з тегом прогону; її ставить globalSetup `stack-guard`. */
export const RUN_TAG_ENV = "SIMETRA_DB_RUN_TAG"

// Форма тегу прогону — одне джерело для перевірки тегу й шаблону «будь-який
// тег»; синтаксис — спільна підмножина JS і POSIX ARE
const RUN_TAG_SHAPE = "[0-9a-z]{6}"

function rand6(): string {
  return Math.random().toString(36).slice(2).padEnd(6, "0").slice(0, 6)
}

/** Новий тег прогону: 6 символів `[0-9a-z]`. */
export function newRunTag(): string {
  return rand6()
}

/**
 * Чи має рядок форму тегу прогону. Тег вставляється в шаблони без
 * екранування: рядок іншої форми (аргумент CLI) розширив би шаблон на чужі
 * об'єкти.
 */
export function isRunTag(value: string): boolean {
  return new RegExp(`^${RUN_TAG_SHAPE}$`).test(value)
}

/**
 * Тег поточного DB-прогону. Без нього кидає: ім'я без тегу прибиральник не
 * впізнає як своє.
 */
export function runTag(): string {
  const tag = process.env[RUN_TAG_ENV]
  if (tag === undefined || tag === "")
    throw new Error(
      `${RUN_TAG_ENV} is not set: DB tests run only under the stack-guard globalSetup (vitest project db)`
    )
  return tag
}

/** Ім'я ролі тесту з тегом прогону; `label` — лише `[a-z0-9_]`. */
export function testRoleName(label: string): string {
  return `simetra_${checkedLabel(label)}_${runTag()}`
}

/** Ім'я тестової бази з тегом прогону й випадковим хвостом. */
export function testDatabaseName(label: string): string {
  return `simetra_${checkedLabel(label)}_${runTag()}_${rand6()}`
}

/**
 * Суфікс імені тіні (`uniqueSuffix` pg-delta): мітка часу лишається першою,
 * щоб `shadowAgeMinutes` читав вік, а тег дає прибиральнику впізнати тінь.
 */
export function shadowSuffix(): string {
  return `${Date.now().toString(36)}_${runTag()}_${rand6()}`
}

/**
 * Шаблони імен об'єктів одного прогону. Прибиральник передає `.source` в
 * оператор Postgres `~`, тож синтаксис — спільна підмножина JS і POSIX ARE.
 */
export function runObjectPatterns(tag: string): {
  databases: RegExp
  roles: RegExp
} {
  const { database, role } = runNameShapes(tag)
  return {
    databases: new RegExp(`^(${database})$`),
    roles: new RegExp(`^(${role})$`),
  }
}

/**
 * Шаблон оператора, що створює об'єкт прогону: `CREATE DATABASE|ROLE` з
 * тегованим ім'ям (лапки необов'язкові), без якорів — шукається в тексті
 * запиту `pg_stat_activity`. Прибиральник передає `.source` в `~*`: поки
 * `CREATE` убитого воркера не зафіксовано, рядка в каталозі ще немає, і
 * видно лише сам запит. Нечутливий до регістру, як і SQL.
 */
export function runObjectStatementPattern(tag: string): RegExp {
  const { database, role } = runNameShapes(tag)
  // Після імені — межа, інакше тег-префікс довшого імені теж збігся б
  return new RegExp(
    `create\\s+(database\\s+"?(${database})|role\\s+"?(${role}))("|;|\\s|$)`,
    "i"
  )
}

/**
 * Тег прогону з імені тегованої бази чи ролі; `undefined` — ім'я не тегове.
 * Форми ті самі, що в шаблонах прибиральника, з будь-яким тегом на місці
 * конкретного: так стек можна розкласти за прогонами, лишки яких на ньому є.
 */
export function runTagOf(
  kind: "database" | "role",
  name: string
): string | undefined {
  // Форма бази має дві альтернативи, кожна зі своєю групою тегу
  const match = new RegExp(
    `^(${runNameShapes(`(${RUN_TAG_SHAPE})`)[kind]})$`
  ).exec(name)
  return match?.slice(2).find((group) => group !== undefined)
}

// Форми імен прогону — одне джерело для каталожних шаблонів, шаблону
// оператора й розбору тегу; `tag` — фрагмент шаблону (конкретний тег чи
// форма будь-якого), синтаксис — спільна підмножина JS і POSIX ARE
function runNameShapes(tag: string): { database: string; role: string } {
  return {
    database: `pgdelta_shadow_[0-9a-z]+_${tag}_[0-9a-z]+|simetra_[a-z0-9_]+_${tag}_[0-9a-z]+`,
    role: `simetra_[a-z0-9_]+_${tag}`,
  }
}

function checkedLabel(label: string): string {
  if (!/^[a-z0-9_]+$/.test(label))
    throw new Error(`Invalid test object label "${label}": use [a-z0-9_]`)
  return label
}

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
 * Імена scratch-баз двигуна на стеку, відсортовані: сирота, що вже була чи
 * зникла, нову тінь не маскує. Але нове ім'я в наборі
 * ще не «наша» тінь: паралельна сесія створює такі самі імена на тому самому
 * стеку. Чия тінь, вирішує облік провізій тестового файлу
 * (`packages/designer/src/__tests__/support/shadows.ts`), а не різниця
 * наборів.
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
 * Порт застосування поверх транзакції тесту: кожен виклик `transaction`
 * працює в ній же, тож усе, що код пише, відкочує `withRollback`.
 */
export function rollbackDatabase(client: pg.Client): ApplyDatabase {
  const tx: ApplyTransaction = {
    query: async <R extends Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[]
    ) => (await client.query(sql, params as unknown[])).rows as R[],
    extract: () =>
      Promise.reject(new Error("no extract in a test transaction")),
  }
  return { transaction: (_db, _end, fn) => fn(tx) }
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
