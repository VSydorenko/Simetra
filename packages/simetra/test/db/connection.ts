import pg from "pg"
import {
  COMMAND_SETTING,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  PROVIDER_OWNER_ROLES,
  quoteIdent,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
  type ApiRolePurpose,
  type CommandContext,
} from "simetra/model"
import type { ApplyDatabase, ApplyTransaction } from "simetra/schema"

import {
  devSecret,
  LOGIN_SECRETS_FILE,
  SUPERUSER_PRELUDE,
  testProvider,
  testStack,
} from "./profile"

/** Адреса бази стеку для тестів, яким потрібне власне з'єднання (порт `SchemaEngine`). */
export function testDatabaseUrl(): string {
  return process.env.SIMETRA_TEST_DATABASE_URL ?? testStack().databaseUrl
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
  const url = process.env.SIMETRA_TEST_POOLER_URL ?? testStack().poolerUrl
  // Профіль без пулера: мовчки взяти адресу Supabase означало б бити в чужий стек
  if (url === null) throw new Error(`Profile "${testProvider()}" has no pooler`)
  return url
}

/**
 * Суперкористувач стеку — лише для об'єктів, яких роль застосунку не створить
 * (shell-тип). Локальний стек Supabase має його як `supabase_admin`.
 */
export function testSuperuserUrl(): string {
  return process.env.SIMETRA_TEST_SUPERUSER_URL ?? testStack().superuserUrl
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
 * `application_name` з'єднань DB-прогону з тегом `tag`: за ним сторож
 * знаходить бекенди свого прогону в `pg_stat_activity`, не чіпаючи чужих.
 */
export function runApplicationName(tag: string): string {
  return `simetra_db_${tag}`
}

/**
 * `application_name` адмінських з'єднань сторожа й прибиральника — не таке,
 * як у з'єднань прогону: завершення бекендів прогону не зачепить з'єднання,
 * яке їх завершує.
 */
export const GUARD_APPLICATION_NAME = "simetra_db_guard"

/**
 * Робить процес головним процесом DB-прогону з тегом `tag`: тег — в env для
 * імен об'єктів, а `PGAPPNAME` — для `application_name`. node-postgres читає
 * `PGAPPNAME`, коли з'єднання не задає імені саме; з'єднання прогону
 * відкривають і тести, і продуктовий код designer, тож помічник у кожному
 * тег не донесе, а env, успадковане воркерами й дочірніми процесами, —
 * доносить. Ставити до старту воркерів.
 */
export function enterRun(tag: string): void {
  process.env[RUN_TAG_ENV] = tag
  process.env.PGAPPNAME = runApplicationName(tag)
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
 *
 * Дрейф ролі ловиться тут же, у тесті, що його спричинив: перед `ROLLBACK`
 * клієнт, що стартував не суперкористувачем, не може ним бути (законна роль
 * запиту чи команд до кінця транзакції — не дрейф), а після `ROLLBACK` роль —
 * знову стартова. Збій `fn` важить більше за збій перевірки: перервана
 * транзакція інакше підмінила б першопричину.
 */
export async function withRollback<T>(
  fn: (client: pg.Client) => Promise<T>,
  url: string = testDatabaseUrl()
): Promise<T> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const start = await roleOf(client)
    await client.query("BEGIN")
    let result: T
    try {
      result = await fn(client)
    } catch (error) {
      // Збій `fn` (чи обрив з'єднання) важить більше за перевірку
      await rollbackChecked(client, start).catch(() => null)
      throw error
    }
    const drift = await rollbackChecked(client, start)
    if (drift !== null) throw new Error(drift)
    return result
  } finally {
    await client.end()
  }
}

/** Клієнт, якого досить перевіркам дрейфу ролі: тест дає підставний. */
export interface RoleClient {
  query<R extends pg.QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: R[] }>
}

async function roleOf(
  client: RoleClient
): Promise<{ role: string; superuser: boolean }> {
  const { rows } = await client.query<{ role: string; superuser: boolean }>(
    "SELECT current_user AS role, rolsuper AS superuser FROM pg_catalog.pg_roles WHERE rolname = current_user"
  )
  const row = rows[0]
  if (row === undefined) throw new Error("current_user is not in pg_roles")
  return row
}

/**
 * `ROLLBACK` транзакції `withRollback` з перевірками дрейфу ролі довкола
 * нього; повертає опис дрейфу або `null`. Помилка перевірки до відкату
 * (перервана транзакція) і самого `ROLLBACK` ковтається: першопричину дає
 * `fn`, а роль після відкату перевіряється однаково.
 */
export async function rollbackChecked(
  client: RoleClient,
  start: { role: string; superuser: boolean }
): Promise<string | null> {
  let drift: string | null = null
  if (!start.superuser) {
    const { rows } = await client
      .query<{ ok: boolean }>(
        "SELECT NOT rolsuper AS ok FROM pg_catalog.pg_roles WHERE rolname = current_user"
      )
      .catch(() => ({ rows: [] as { ok: boolean }[] }))
    if (rows[0]?.ok === false)
      drift = `withRollback: the transaction ends as a superuser, though the client started as ${start.role}; leave the superuser through asStackSuperuser, not a bare role switch`
  }
  // Відкат після збою `fn` може сам впасти (перервана транзакція) — це не
  // має затирати першопричину
  await client.query("ROLLBACK").catch(() => undefined)
  const after = await currentRole(client)
  if (after !== start.role)
    drift ??= `withRollback: after ROLLBACK the client runs as ${after}, not its start role ${start.role}: a role set outside the transaction leaks to the next use of the connection`
  return drift
}

async function currentRole(client: RoleClient): Promise<string> {
  const { rows } = await client.query<{ role: string }>(
    "SELECT current_user AS role"
  )
  return rows[0]!.role
}

/**
 * Повертає стартову роль з'єднання, з якою його відкрито: на адресі тестів —
 * власника, на `testSuperuserUrl()` — суперкористувача. Одне місце форми
 * скидання ролі для статичного тесту `role-switch.test.ts`: явне
 * `SET ROLE <власник>` змінило б кейси, що йдуть від суперкористувача.
 */
export async function restoreOwnerRole(client: pg.Client): Promise<void> {
  await client.query("RESET ROLE")
}

/** Налаштування сесії платформи, які тести ставлять до кінця транзакції. */
export type SimetraSetting =
  | typeof SESSION_CLAIMS_SETTING
  | typeof COMMAND_SETTING
  | typeof RIGHTS_MAINTENANCE_SETTING

/**
 * `set_config(name, value, true)`: перший аргумент — лише названа стала
 * платформи, тож статичний тест тримає `set_config($1` в одному місці.
 */
export async function setLocalSetting(
  client: RoleClient,
  name: SimetraSetting,
  value: string
): Promise<void> {
  await client.query("SELECT set_config($1, $2, true)", [name, value])
}

/** Клієнт, якого досить хелперам перемикання ролі: тест дає підставний. */
export interface SwitchClient extends RoleClient {
  getTransactionStatus(): string | null
}

function requireTransaction(client: SwitchClient, helper: string): void {
  // Поза транзакцією `SET LOCAL` діяв би до кінця оператора, а точки
  // збереження немає: відновлювати не було б чого
  if (client.getTransactionStatus() !== "T")
    throw new Error(`${helper} runs only inside a transaction`)
}

/**
 * Виконує `fn` від суперкористувача стека в точці збереження поточної
 * транзакції — для об'єктів, яких власник не створить (`CREATE ROLE`,
 * `CREATE EXTENSION`). `SET LOCAL`, зроблений у точці збереження, переживає
 * `RELEASE SAVEPOINT`, тож попередні роль і `search_path` повертаються явно
 * на успіху, а на збої — відкатом точки збереження.
 *
 * У `fn` кожне ім'я кваліфіковане (`search_path` — лише `pg_catalog,
 * pg_temp`), `CREATE EXTENSION` — завжди з `SCHEMA`.
 */
export async function asStackSuperuser<T>(
  client: SwitchClient,
  fn: () => Promise<T>
): Promise<T> {
  requireTransaction(client, "asStackSuperuser")
  await client.query("SAVEPOINT stack_superuser")
  const { rows } = await client.query<{ role: string; path: string }>(
    "SELECT current_user AS role, current_setting('search_path') AS path"
  )
  const before = rows[0]!
  let result: T
  try {
    await client.query("SET LOCAL ROLE NONE")
    await client.query("SET LOCAL search_path = pg_catalog, pg_temp")
    result = await fn()
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT stack_superuser")
    throw error
  }
  await client.query(
    "SELECT set_config('role', $1, true), set_config('search_path', $2, true)",
    [before.role, before.path]
  )
  await client.query("RELEASE SAVEPOINT stack_superuser")
  return result
}

/**
 * Виконує `fn` від ролі входу `login` (`SET LOCAL SESSION AUTHORIZATION`) у
 * точці збереження поточної транзакції: для коду, що вимагає
 * `session_user = current_user` (гард режиму обслуговування прав), на тому
 * самому з'єднанні. На обох шляхах явно повертає попередні `session_user`,
 * `current_user` і `search_path`: не лише вхід (`RESET SESSION AUTHORIZATION`
 * повернув би автентифікований вхід, а не попередній локальний стан), а й
 * роль — виклик із ролі команд чи запиту інакше лишив би решту транзакції
 * власнику з `BYPASSRLS`.
 */
export async function asSessionLogin<T>(
  client: SwitchClient,
  login: string,
  fn: () => Promise<T>
): Promise<T> {
  requireTransaction(client, "asSessionLogin")
  await client.query("SAVEPOINT session_login")
  const { rows } = await client.query<{
    session: string
    role: string
    path: string
  }>(
    "SELECT session_user AS session, current_user AS role, current_setting('search_path') AS path"
  )
  const before = rows[0]!
  const restore = async (): Promise<void> => {
    await client.query(
      `SET LOCAL SESSION AUTHORIZATION ${quoteIdent(before.session)}`
    )
    await client.query(`SET LOCAL ROLE ${quoteIdent(before.role)}`)
    await client.query("SELECT set_config('search_path', $1, true)", [
      before.path,
    ])
  }
  let result: T
  try {
    await client.query(`SET LOCAL SESSION AUTHORIZATION ${quoteIdent(login)}`)
    result = await fn()
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT session_login")
    await restore()
    throw error
  }
  await restore()
  await client.query("RELEASE SAVEPOINT session_login")
  return result
}

/**
 * Клієнт суперкористувача стека (`testSuperuserUrl()`, база `database`,
 * якщо задана) з прелюдією `SUPERUSER_PRELUDE`. Клієнт пов'язується з
 * тестом, що його відкрив: роль, лишена ним поза транзакцією, валить тест.
 */
export async function superuserClient(database?: string): Promise<pg.Client> {
  const url = new URL(testSuperuserUrl())
  if (database !== undefined) url.pathname = `/${encodeURIComponent(database)}`
  const client = new pg.Client({ connectionString: url.toString() })
  await client.connect()
  try {
    for (const statement of SUPERUSER_PRELUDE) await client.query(statement)
  } catch (error) {
    await client.end()
    throw error
  }
  await trackClient(client)
  return client
}

/**
 * DSN ролі входу `user` з паролем `password` до сервера й бази адреси `base`
 * — без параметра `options`: стартова роль `-c role=` адреси тестів підмінила
 * б саму роль входу.
 */
export function loginUrl(base: string, user: string, password: string): string {
  const url = new URL(base)
  url.username = encodeURIComponent(user)
  url.password = encodeURIComponent(password)
  url.searchParams.delete("options")
  return url.toString()
}

/**
 * Дописує сесійні налаштування `extra` (`-c name=value`) до параметра
 * `options` адреси: стартова роль `-c role=` лишається. Адреса з двома
 * параметрами `options` — помилка: у `pg-connection-string` перемагає
 * останній, і роль губиться.
 */
export function withSessionOptions(url: string, extra: string): string {
  const parsed = new URL(url)
  const options = parsed.searchParams.getAll("options")
  if (options.length > 1)
    throw new Error(
      "the URL has several options parameters: the last one wins, and the start role of the others is lost"
    )
  const current = options[0]
  parsed.searchParams.set(
    "options",
    current === undefined || current === "" ? extra : `${current} ${extra}`
  )
  return parsed.toString()
}

/**
 * Прямий вхід власника до бази тестів — для коду, що вимагає
 * `session_user = current_user` (`maintenanceSql`, факти гарда даних,
 * членства `session_user` рантайму): на адресі тестів `session_user` —
 * суперкористувач, член усього. На `supabase` власник і є роль входу, тож це
 * сама адреса тестів. Пароль читається лише на виклик.
 */
export function testOwnerLoginUrl(): string {
  const provider = testProvider()
  if (provider === "supabase") return testDatabaseUrl()
  return loginUrl(
    testDatabaseUrl(),
    PROVIDER_OWNER_ROLES[provider],
    devSecret("SIMETRA_OWNER_DEV_PASSWORD", LOGIN_SECRETS_FILE)
  )
}

// Межа перевірки пулу: витеклий (не звільнений) клієнт інакше вішав би
// останній `connect()` перевірки до тайм-ауту тесту
const POOL_CHECK_MS = 2_000

interface TrackedClient {
  client: pg.Client
  start: string
  ended: boolean
}

// Клієнти й пули, відкриті хелперами поза тестом (`beforeAll`): їх
// перевіряє `afterEach` setup-файлу, бо роль на них може лишити будь-який
// тест файлу
const fileClients = new Set<TrackedClient>()
const filePools = new Set<pg.Pool>()
// Пули файлу для останньої перевірки в `afterAll`: нове з'єднання бачить
// лише стартову роль адреси, а не роль, лишену на вживаному клієнті
const allPools = new Set<pg.Pool>()

/** Хуки раннера, через які хелпер пов'язує клієнта з тестом. */
export interface TestHooks {
  /** Поточний тест раннера; `undefined` — поза тестом (`beforeAll`). */
  current(): { concurrent?: boolean } | undefined
  onFinished(check: () => Promise<void>): void
}

// Хуки дає setup-файл DB-проєкту: модуль вантажать і сторож, і прибиральник
// поза раннером, тож vitest він сам не імпортує й лишається легким
let testHooks: TestHooks | undefined

/** Вмикає перевірку клієнтів хелперів у тесті, що їх відкрив. */
export function useTestHooks(hooks: TestHooks): void {
  testHooks = hooks
}

// Як пов'язати клієнта хелпера з тестом: `undefined` — поза тестом (чи без
// хуків), `null` — тест конкурентний. Клієнти конкурентних тестів не
// опитуються: поточний тест раннера там — будь-який з тестів, що йдуть
// одночасно
function testHook(): ((check: () => Promise<void>) => void) | null | undefined {
  const hooks = testHooks
  const test = hooks?.current()
  if (hooks === undefined || test === undefined) return undefined
  return test.concurrent === true ? null : (check) => hooks.onFinished(check)
}

/**
 * Пов'язує клієнта хелпера з тестом, що його відкрив: після тесту
 * `current_user` клієнта поза транзакцією — його стартова роль. Відкритий
 * поза тестом (`beforeAll`) — під перевірку `afterEach` setup-файлу.
 */
export async function trackClient(client: pg.Client): Promise<void> {
  const tracked: TrackedClient = {
    client,
    start: await currentRole(client),
    ended: false,
  }
  client.once("end", () => (tracked.ended = true))
  const hook = testHook()
  if (hook === undefined) fileClients.add(tracked)
  else hook?.(() => checkTracked(tracked))
}

/** Те саме для пулу хелпера; пул ще й під останню перевірку `afterAll`. */
export function trackPool(pool: pg.Pool): void {
  allPools.add(pool)
  const hook = testHook()
  if (hook === undefined) filePools.add(pool)
  else hook?.(() => expectPoolRole(pool))
}

async function checkTracked(tracked: TrackedClient): Promise<void> {
  // Закритий клієнт ролі вже не лишить; клієнт у транзакції — ще працює
  // (його відкотить чи закомітить власник), і роль транзакції — не дрейф
  if (tracked.ended) return
  await expectClientRole(tracked.client, tracked.start)
}

/**
 * Перевірка клієнта хелпера: поза транзакцією `current_user` — стартова роль
 * `start`. Клієнт у транзакції пропускається (роль до кінця транзакції — не
 * дрейф, а відкат її скине).
 */
export async function expectClientRole(
  client: SwitchClient,
  start: string
): Promise<void> {
  if (client.getTransactionStatus() !== "I") return
  const role = await currentRole(client)
  if (role !== start)
    throw new Error(
      `a helper client is left as ${role} outside a transaction, though it started as ${start}: the next test on it would run as ${role}`
    )
}

/**
 * Перевірка пулу: бере всі `totalCount` клієнтів одночасними `connect()` з
 * дедлайном і звіряє кожного зі стартовою роллю адреси пулу. Публічного
 * переліку вільних клієнтів у `pg.Pool` немає, тож інакше їх не дістати;
 * усі отримані звільняються, і ті, що прийшли вже після дедлайну, — теж.
 */
export async function expectPoolRole(
  pool: pg.Pool,
  deadlineMs: number = POOL_CHECK_MS
): Promise<void> {
  const total = pool.totalCount
  if (total === 0) return
  const url = pool.options.connectionString
  if (url === undefined)
    throw new Error("a tracked pool has no connection string")
  const start = await startRoleOf(url)
  const taken: pg.PoolClient[] = []
  let done = false
  const takes = Array.from({ length: total }, () =>
    pool.connect().then((client) => {
      if (done) client.release()
      else taken.push(client)
    })
  )
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `a helper pool did not give back its ${total} client(s) within ${deadlineMs} ms (totalCount ${pool.totalCount}, idleCount ${pool.idleCount}, waitingCount ${pool.waitingCount}): a test kept a client checked out`
          )
        ),
      deadlineMs
    )
  })
  try {
    await Promise.race([Promise.all(takes), deadline])
    for (const client of taken) {
      const role = await currentRole(client)
      if (role !== start)
        throw new Error(
          `a pooled helper client runs as ${role}, though the pool address starts as ${start}: the next checkout would run as ${role}`
        )
    }
  } finally {
    clearTimeout(timer)
    done = true
    for (const client of taken) client.release()
  }
}

async function startRoleOf(url: string): Promise<string> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return await currentRole(client)
  } finally {
    await client.end()
  }
}

/**
 * `afterEach` setup-файлу: клієнти й пули, відкриті хелперами поза тестом.
 * `test` — завдання контексту хука.
 */
export async function expectFileConnectionRoles(test: {
  concurrent?: boolean
}): Promise<void> {
  // Конкурентний тест не опитує спільних клієнтів: сусідній тест ще на них
  if (test.concurrent === true) return
  for (const tracked of fileClients) {
    if (tracked.ended) fileClients.delete(tracked)
    else await expectClientRole(tracked.client, tracked.start)
  }
  for (const pool of filePools) await expectPoolRole(pool)
}

/**
 * `afterAll` setup-файлу: пули файлу і нове з'єднання з адреси тестів — його
 * роль власник профілю без `rolsuper` (`ALTER ROLE … SET role` чи налаштування
 * бази, лишені тестом, змінили б її кожному наступному з'єднанню).
 */
export async function expectFileEndRoles(): Promise<void> {
  for (const pool of allPools) {
    if (!pool.ended) await expectPoolRole(pool)
  }
  allPools.clear()
  filePools.clear()
  fileClients.clear()
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    const { role, superuser } = await roleOf(client)
    const owner = PROVIDER_OWNER_ROLES[testProvider()]
    if (role !== owner || superuser)
      throw new Error(
        `a new connection to the test database URL runs as ${role}${superuser ? " (superuser)" : ""}, not ${owner}: a test changed a role or database setting`
      )
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
  return {
    transaction: (_db, _end, fn) => fn(tx),
    statement: () => Promise.reject(new Error("no statement expected")),
  }
}

/**
 * Роль API призначення `purpose` у профілі прогону; `null` — профіль такої
 * ролі не має (сервісної на `postgres`).
 */
export function testRoleFor(purpose: ApiRolePurpose): string | null {
  return PROVIDER_API_ROLES[testProvider()][purpose]
}

/**
 * Claims запиту призначення `purpose`, як їх дає сесія провайдера: на
 * `supabase` — з claim `role` (за ним PostgREST обирає роль), на `postgres` —
 * без `role`, з `is_anonymous` (спека профілю §4.4: роль ставить сервер, а не
 * claim). `sub` — id облікового запису, коли сесія є (`null` — claim є, але
 * порожній).
 */
export function claimsFor(
  purpose: ApiRolePurpose,
  sub?: string | null
): Record<string, unknown> {
  const provider = testProvider()
  const role = requiredRole(purpose)
  const subject = sub === undefined ? {} : { sub }
  return provider === "supabase"
    ? { ...subject, role }
    : { ...subject, is_anonymous: purpose === "anonymous" }
}

function requiredRole(purpose: ApiRolePurpose): string {
  const role = testRoleFor(purpose)
  if (role === null)
    throw new Error(`no ${purpose} role in ${testProvider()} profile`)
  return role
}

/**
 * Перемикає транзакцію на роль API призначення `purpose` з claims запиту, як
 * це робить сервер запитів: `SET LOCAL` і `set_config(…, true)` діють до кінця
 * транзакції чи до відкату точки збереження, тож повернення до власника —
 * справа того, хто кличе. Claims ставляться до ролі: роль API не мала б
 * права їх змінити. Роль звіряється окремим запитом: поза транзакцією
 * `SET LOCAL` — лише `WARNING`, і запит тихо пішов би від власника з
 * `BYPASSRLS`.
 */
export async function asRole(
  client: RoleClient,
  purpose: ApiRolePurpose,
  claims: Record<string, unknown>
): Promise<void> {
  const role = requiredRole(purpose)
  await setLocalSetting(client, SESSION_CLAIMS_SETTING, JSON.stringify(claims))
  await client.query(`SET LOCAL ROLE ${quoteIdent(role)}`)
  const current = await currentRole(client)
  if (current !== role)
    throw new Error(
      `asRole: the transaction runs as ${current}, not ${role}: SET LOCAL ROLE outside a transaction does not switch the role`
    )
}

/**
 * Один запит від ролі API в точці збереження: наступний запит тесту — знову
 * від власника, а помилка доступу повертається кодом, не зриваючи транзакції.
 */
export async function queryAs<T extends pg.QueryResultRow>(
  client: pg.Client,
  purpose: ApiRolePurpose,
  claims: Record<string, unknown>,
  sql: string,
  params: unknown[] = []
): Promise<{ rows: T[] } | { code: string }> {
  await client.query("SAVEPOINT as_role")
  try {
    await asRole(client, purpose, claims)
    const { rows } = await client.query<T>(sql, params)
    return { rows }
  } catch (error) {
    // Без коду Postgres це не відмова запиту, а збій з'єднання чи помічника:
    // загорнутий у відповідь, він маскувався б під очікувану відмову.
    if (!isDatabaseError(error)) throw error
    return { code: error.code }
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT as_role")
  }
}

/** Помилка, яку повернув Postgres (з кодом SQLSTATE), а не збій клієнта. */
function isDatabaseError(
  error: unknown
): error is pg.DatabaseError & { code: string } {
  return error instanceof pg.DatabaseError && typeof error.code === "string"
}

/**
 * Відмова запиту: код, повідомлення, деталь, колонка й підказка помилки
 * Postgres. Колонка розрізняє відмови з тим самим кодом і текстом: тригер
 * ефектів називає нею колонку, на якій відмовив. Підказкою ядро команд
 * віддає поточну версію при конфлікті (спека П4 §6.10).
 */
export interface Refusal {
  code: string
  message: string
  detail?: string
  column?: string
  hint?: string
}

/**
 * Один запит від ролі команд у точці збереження, як його виконає
 * `runCommand`: claims користувача, контекст команди в `COMMAND_SETTING`
 * (рядок ставиться сирим — для зіпсованого контексту; `undefined` — не
 * ставиться) і `SET LOCAL ROLE` ролі команд. Членство з `SET` у ролі команд
 * дає собі опис. `after` виконує власник (`restoreOwnerRole`) у тій самій
 * точці збереження до відкату: каскад і поширення копій інакше не видно.
 * Відмова повертається кодом, повідомленням, деталлю, колонкою й підказкою — `42501`
 * дають і RLS, і контекст, і тригер ефектів.
 */
export async function commandAs<T extends pg.QueryResultRow>(
  client: pg.Client,
  claims: Record<string, unknown>,
  context: CommandContext | string | undefined,
  sql: string,
  options: { params?: unknown[]; after?: string } = {}
): Promise<{ rows: T[]; after?: pg.QueryResultRow[] } | Refusal> {
  await client.query("SAVEPOINT command_as")
  try {
    await setLocalSetting(
      client,
      SESSION_CLAIMS_SETTING,
      JSON.stringify(claims)
    )
    if (context !== undefined)
      await setLocalSetting(
        client,
        COMMAND_SETTING,
        typeof context === "string" ? context : JSON.stringify(context)
      )
    await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
    const { rows } = await client.query<T>(sql, options.params)
    if (options.after === undefined) return { rows }
    await restoreOwnerRole(client)
    return { rows, after: (await client.query(options.after)).rows }
  } catch (error) {
    if (!isDatabaseError(error)) throw error
    return refusalOf(error)
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT command_as")
  }
}

/** Крок сценарію `commandSteps`: оператор SQL або перевірка від власника. */
export type CommandStep =
  | {
      context?: CommandContext
      sql: string
      params?: unknown[]
      asOwner?: boolean
    }
  | { check: (client: pg.Client) => Promise<unknown> }

/**
 * Кілька операторів однієї команди в одній точці збереження, як їх виконає
 * `runCommand`: `commandAs` відкочує свою точку після одного оператора, тож
 * ефект попереднього кроку (запис у джерело прав) наступному кроку не видно.
 * Claims ставляться раз; контекст — перед кроком, що його має, і діє далі до
 * наступного; крок `asOwner` виконує власник із тим самим контекстом команди
 * (зміни, яких політики ролі команд не відкривають), інакше — роль команд.
 * Крок `check` — від власника без зміни контексту, його результат — у
 * `completed`. Між кроками `SET CONSTRAINTS` немає: відкладені перевірки
 * судять кінцевий стан, як на COMMIT; `immediate` форсує їх після останнього
 * кроку. Перша помилка Postgres — `refusal`, `completed` — кроки до неї.
 */
export async function commandSteps(
  client: pg.Client,
  claims: Record<string, unknown>,
  steps: readonly CommandStep[],
  options: { immediate?: boolean } = {}
): Promise<{ completed: unknown[]; refusal?: Refusal }> {
  const completed: unknown[] = []
  await client.query("SAVEPOINT command_steps")
  try {
    await setLocalSetting(
      client,
      SESSION_CLAIMS_SETTING,
      JSON.stringify(claims)
    )
    for (const step of steps) {
      if ("check" in step) {
        await restoreOwnerRole(client)
        completed.push(await step.check(client))
        continue
      }
      if (step.context !== undefined)
        await setLocalSetting(
          client,
          COMMAND_SETTING,
          JSON.stringify(step.context)
        )
      if (step.asOwner === true) await restoreOwnerRole(client)
      else await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      const { rows, rowCount } = await client.query(step.sql, step.params)
      completed.push({ rows, rowCount })
    }
    if (options.immediate === true) {
      await restoreOwnerRole(client)
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    }
    return { completed }
  } catch (error) {
    if (!isDatabaseError(error)) throw error
    return { completed, refusal: refusalOf(error) }
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT command_steps")
  }
}

// Одна форма відмови для `commandAs` і `commandSteps`: кейси порівнюють їх
// однаково, хоч би яким помічником ішов сценарій
function refusalOf(error: pg.DatabaseError & { code: string }): Refusal {
  const { code, message, detail, column, hint } = error
  return {
    code,
    message,
    ...(detail === undefined ? {} : { detail }),
    ...(column === undefined ? {} : { column }),
    ...(hint === undefined ? {} : { hint }),
  }
}
