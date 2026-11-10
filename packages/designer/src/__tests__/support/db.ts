import { randomBytes, randomUUID } from "node:crypto"
import pg from "pg"
import {
  CommandFailure,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_OWNER_ROLES,
  quoteIdent,
  RIGHTS_MAINTENANCE_SETTING,
  type CommandError,
} from "simetra/model"
import {
  PROVIDER_SHADOW_TEMPLATES,
  type EngineScope,
  type SchemaEngine,
} from "simetra/schema"
import type { CommandDatabase } from "simetra/server"
import { createPgDeltaEngine } from "../../schema-engine"
import {
  asSessionLogin,
  authLoginRole,
  devSecret,
  GAUGE_WRITER_ID,
  LOGIN_SECRETS_FILE,
  loginUrl,
  prepareStackIdentity,
  signUp,
  superuserClient,
  testDatabaseName,
  testDatabaseUrl,
  testPoolerUrl,
  testProvider,
  testRoleName,
  testSuperuserUrl,
  setLocalSetting,
  trackPool,
} from "../../../../simetra/test/support"

/**
 * Спільні помічники DB-тестів designer. Усе, що вони створюють на спільному стеку, називається через
 * `simetra/test/support` і несе тег прогону: прибиральник знайде це за тегом.
 */

/** Двигун за замовчуванням: адаптер без стану, одного екземпляра досить. */
const defaultEngine: SchemaEngine = createPgDeltaEngine()

/** One query (or several statements) on a connection of its own. */
export async function query<R extends pg.QueryResultRow>(
  url: string,
  sql: string,
  params?: unknown[]
): Promise<R[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<R>(sql, params)).rows
  } finally {
    await client.end()
  }
}

/**
 * One statement as the stack superuser (`superuserClient`: the prelude, and
 * a role left on the client fails the test), in database `database` when
 * given. Every name in `sql` is qualified: the prelude's `search_path` is
 * `pg_catalog, pg_temp`.
 */
async function asStack<R extends pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
  database?: string
): Promise<R[]> {
  const client = await superuserClient(database)
  try {
    return (await client.query<R>(sql, params)).rows
  } finally {
    await client.end()
  }
}

/** The database name of `url`. */
const databaseOf = (url: string): string =>
  decodeURIComponent(new URL(url).pathname.slice(1))

/** The same database as `url`, with the stack superuser's credentials. */
export function asSuperuser(url: string): string {
  const su = new URL(testSuperuserUrl())
  su.pathname = new URL(url).pathname
  return su.toString()
}

/**
 * Runs `fn` against a target loaded with `desiredSql` next to the stack; the
 * engine drops the target afterwards. Throws when the target did not load.
 */
export async function inTarget<T>(
  desiredSql: string,
  scope: EngineScope,
  fn: (url: string) => Promise<T>,
  engine: SchemaEngine = defaultEngine
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: { url: testDatabaseUrl() } },
    desiredSql,
    scope,
    (target) => fn(target.url)
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

/**
 * Runs `fn` on a run-tagged copy database, `CREATE DATABASE … OWNER <owner of
 * the profile> <clause>` (for example `template <name>`), created and dropped
 * by the superuser. `fn` gets the copy's URL for the default test role and its
 * name.
 */
export async function withCopy<T>(
  clause: string,
  fn: (url: string, name: string) => Promise<T>
): Promise<T> {
  const name = testDatabaseName("copy")
  // Створення — до `try`: якщо воно впаде, `finally` не видалятиме бази,
  // якої цей виклик не створив
  await asStack(
    `create database "${name}" owner ${quoteIdent(PROVIDER_OWNER_ROLES[testProvider()])} ${clause}`
  )
  try {
    const url = new URL(testDatabaseUrl())
    url.pathname = `/${name}`
    return await fn(url.toString(), name)
  } finally {
    // Прибирання й на шляху падіння: інакше копію зловить сторож стеку
    await asStack(`drop database if exists "${name}" with (force)`)
  }
}

/**
 * Runs `fn` on a bare target: a run-tagged database from the shadow template
 * of the profile (`withCopy`), the way a real target starts — without the seed
 * of assumed schemas that the engine puts only into its shadows (the stub of
 * `better_auth."user"`). A target that needs the identity (`withTargetIdentity`,
 * `signUp`, `seedRuntimeActor`) starts here, not from `inTarget`. A profile
 * without a shadow template has no such target.
 */
export async function withTemplateTarget<T>(
  fn: (url: string, name: string) => Promise<T>
): Promise<T> {
  const template = PROVIDER_SHADOW_TEMPLATES[testProvider()]
  if (template === null)
    throw new Error(`Profile "${testProvider()}" has no shadow template`)
  return withCopy(`template ${quoteIdent(template)}`, fn)
}

/** Drops the given roles, if they exist, as the stack superuser. */
export async function dropRoles(...names: string[]): Promise<void> {
  for (const name of names)
    await asStack(`drop role if exists "${name.replaceAll('"', '""')}"`)
}

/**
 * Waits until backend `pid` blocks on a heavyweight lock (row, relation or
 * advisory), observed through `pg_stat_activity` from another session.
 */
export async function waitForLock(
  observer: pg.Client,
  pid: number
): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 50) {
    const { rows } = await observer.query<{ wait_event_type: string | null }>(
      "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
      [pid]
    )
    if (rows[0]?.wait_event_type === "Lock") return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`backend ${pid} never waited on a lock`)
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

/**
 * Runs `fn` with a run-tagged login role that has a password and the given
 * memberships `WITH INHERIT FALSE, SET TRUE` — the shape of the runtime login
 * role (`simetra_runtime`): it reaches a role only by `SET LOCAL ROLE`. `fn`
 * gets the URL of the database `url` as that role (`CONNECT` on it is granted:
 * a stack database may not give it to `PUBLIC`). The role and its backends
 * are removed on every path; `label` is the readable part of the name, and a
 * random tail makes every call's role name unique.
 * `attributes` gives the role a fact the runtime login must not have
 * (`BYPASSRLS`), for tests of the data-tool guards.
 */
export async function withRuntimeLogin<T>(
  url: string,
  memberOf: readonly string[],
  fn: (loginUrl: string) => Promise<T>,
  label = "runtime",
  attributes: { bypassRls?: boolean } = {}
): Promise<T> {
  // Supavisor кешує секрет ролі за ім'ям: роль, перестворена з тим самим
  // ім'ям і новим паролем, через пулер не входить (`28P01`), доки кеш не
  // скинеться. Тож ім'я — нове на кожен виклик, а не одне на мітку й прогін
  const name = testRoleName(`${label}_${randomBytes(4).toString("hex")}`)
  const password = randomBytes(12).toString("hex")
  const bypass = attributes.bypassRls === true ? " bypassrls" : ""
  // Створення — до `try`: невдале створення не видаляє чужої ролі з тим ім'ям
  await asStack(
    `create role ${quoted(name)} login noinherit${bypass} password '${password}'`
  )
  const database = quoted(databaseOf(url))
  try {
    await asStack(`grant connect on database ${database} to ${quoted(name)}`)
    for (const role of memberOf)
      await asStack(
        `grant ${quoted(role)} to ${quoted(name)} with inherit false, set true`
      )
    return await fn(loginUrl(url, name, password))
  } finally {
    // Пулер тримає серверні з'єднання ролі й після тесту: без завершення
    // бекендів тінь не видалилася б, а роль лишила б сесії сторожу
    await asStack(
      "select pg_terminate_backend(pid) from pg_stat_activity where usename = $1",
      [name]
    )
    // Грант на базу тримав би роль від `DROP ROLE`; бази вже може не бути —
    // тоді й гранту немає
    await asStack(
      `revoke connect on database ${database} from ${quoted(name)}`
    ).catch(() => undefined)
    await dropRoles(name)
  }
}

/**
 * The pooler URL (transaction mode) of the same login and database as
 * `loginUrl`. Supavisor names the tenant after the first dot of the user
 * (`<role>.<tenant>`); the tenant comes from `testPoolerUrl()` only — on a
 * hosted project it is the project ref.
 */
export function throughPoolerAs(loginUrl: string): string {
  const pooler = new URL(testPoolerUrl())
  const user = decodeURIComponent(pooler.username)
  const dot = user.indexOf(".")
  if (dot < 0) throw new Error(`pooler user ${user} names no tenant`)
  const login = new URL(loginUrl)
  pooler.username = `${login.username}.${user.slice(dot + 1)}`
  pooler.password = login.password
  pooler.pathname = login.pathname
  return pooler.toString()
}

/**
 * A pool of `loginUrl` through the pooler, or `null` when the caller does not
 * ask for it. Only the Supabase-bound halves of a test ask: a stack without a
 * pooler never resolves `testPoolerUrl()` for the other half. The pool is
 * checked for a role left on its clients (`trackPool`).
 */
export function poolerPoolOf(
  loginUrl: string,
  viaPooler: boolean
): pg.Pool | null {
  if (!viaPooler) return null
  const pool = new pg.Pool({ connectionString: throughPoolerAs(loginUrl) })
  trackPool(pool)
  return pool
}

/** The pooler pool of an environment built with it; a test bug otherwise. */
export function pooledOf(pool: pg.Pool | null): pg.Pool {
  if (pool === null)
    throw new Error("the environment was built without the pooler")
  return pool
}

/**
 * Records `hash` as the applied snapshot in `simetra.marker` (every `NOT NULL`
 * column of `renderApplyState`, placeholders elsewhere): the runtime compares
 * only the hash. Replaces the row, so a test can switch the hash.
 */
export async function seedMarker(
  client: pg.Client,
  hash: string
): Promise<void> {
  await client.query(
    `INSERT INTO simetra.marker (format, snapshot_hash, snapshot, scope, catalog, engine_name, engine_version, fingerprint, fingerprint_version, platform_version, plan_hash)
     VALUES (1, $1, '{}', '{}', '{}', 'engine', '1', '{}', 1, '0', 'plan')
     ON CONFLICT (singleton) DO UPDATE SET snapshot_hash = EXCLUDED.snapshot_hash`,
    [hash]
  )
}

/**
 * Ознака бази розробника (`simetra.environment = development`) на базі `url`
 * — налаштуванням рівня бази від суперкористувача, як його ставить оператор.
 * Окремого прибирання немає: налаштування зникає разом із тінню.
 */
export async function markDevelopmentDatabase(url: string): Promise<void> {
  await asStack(
    `alter database ${quoted(databaseOf(url))} set simetra.environment = 'development'`
  )
}

/**
 * Ідентичність Better Auth тегованої цілі `url` (рішення Р17 плану ПГ-2b):
 * ціль дістає той самий стан, що й база тестів після `db:pg:start`, —
 * `CONNECT` і схему `better_auth` ролі входу сервісу, справжню міграцію від
 * неї та тимчасові гранти власнику (`prepareStackIdentity`). Кличеться до
 * першого плану чи застосування, що посилається на ідентичність: таблиця,
 * яку pg-delta створила б заглушкою від ролі рушія, — помилка налаштування
 * тесту, і хелпер її не перевласнює. На `supabase` ідентичність дає
 * провайдер — нічого не робить.
 */
export async function withTargetIdentity(url: string): Promise<void> {
  if (testProvider() !== "postgres") return
  const auth = authLoginRole()
  const database = databaseOf(url)
  const { schema, name } = PROVIDER_IDENTITY_SOURCES.postgres.table
  const client = await superuserClient(database)
  try {
    const { rows } = await client.query<{
      schema: string | null
      table: string | null
    }>(
      `SELECT (SELECT pg_catalog.pg_get_userbyid(nspowner) FROM pg_catalog.pg_namespace WHERE nspname = $1) AS schema,
              (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c
                 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = $1 AND c.relname = $2) AS table`,
      [schema, name]
    )
    const facts = rows[0]!
    if (facts.table !== null && facts.table !== auth)
      throw new Error(
        `${quoteIdent(schema)}.${quoteIdent(name)} of ${database} is owned by ${facts.table}, not ${auth}`
      )
    if (facts.schema !== null && facts.schema !== auth)
      throw new Error(
        `schema ${schema} of ${database} is owned by ${facts.schema}, not ${auth}`
      )
    await client.query(
      `GRANT CONNECT ON DATABASE ${quoted(database)} TO ${quoteIdent(auth)}`
    )
    await client.query(
      `CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)} AUTHORIZATION ${quoteIdent(auth)}`
    )
  } finally {
    await client.end()
  }
  await prepareStackIdentity({
    superuserUrl: asSuperuser(url),
    authUrl: loginUrl(
      url,
      auth,
      devSecret("SIMETRA_AUTH_DEV_PASSWORD", LOGIN_SECRETS_FILE)
    ),
    auth,
    owner: PROVIDER_OWNER_ROLES.postgres,
  })
}

/** Актор рантайму: організація, користувач, від якого діє сесія, і його учасник. */
export interface RuntimeActor {
  org: string
  user: string
  member: string
}

/**
 * Організація, користувач (реєстрацією: провізія дає ідентичність, з якої
 * `current_user_id()` читає `sub`), учасник і призначення ролей організації
 * (типово `GaugeWriter`). Призначення — довідник прав, тож засів під режимом
 * обслуговування.
 */
export async function seedRuntimeActor(
  owner: pg.Client,
  archetypes: readonly string[] = [GAUGE_WRITER_ID]
): Promise<RuntimeActor> {
  const org = randomUUID()
  const member = randomUUID()
  let user = ""
  await seedUnderMaintenance(owner, async () => {
    user = await signUp(owner)
    await owner.query("INSERT INTO public.organization (id) VALUES ($1)", [org])
    await owner.query(
      "INSERT INTO public.org_member (id, org_id, user_id) VALUES ($1, $2, $3)",
      [member, org, user]
    )
    for (const archetype of archetypes)
      await owner.query(
        "INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)",
        [randomUUID(), org, member, archetype]
      )
  })
  return { org, user, member }
}

/** Транзакція засіву власником: закомічена, бо її читають інші сесії. */
export async function committed(
  owner: pg.Client,
  steps: () => Promise<void>
): Promise<void> {
  await owner.query("BEGIN")
  try {
    await steps()
    await owner.query("COMMIT")
  } catch (error) {
    await owner.query("ROLLBACK").catch(() => undefined)
    throw error
  }
}

/**
 * Закомічений засів власником під режимом обслуговування прав: рядки
 * довідників прав інакше відхилив би запобіжник `rights-context`. Відкладені
 * запобіжники судяться ще в режимі — `SET CONSTRAINTS ALL IMMEDIATE` до
 * вимкнення, а не на `COMMIT` уже без нього. Увесь засів — від входу
 * власника (`asSessionLogin`): гард режиму вимагає `session_user =
 * current_user`, а на адресі тестів `postgres` сесія — суперкористувач.
 */
export function seedUnderMaintenance(
  owner: pg.Client,
  steps: () => Promise<void>
): Promise<void> {
  return committed(owner, () =>
    asSessionLogin(owner, PROVIDER_OWNER_ROLES[testProvider()], async () => {
      await setLocalSetting(owner, RIGHTS_MAINTENANCE_SETTING, "on")
      await steps()
      await owner.query("SET CONSTRAINTS ALL IMMEDIATE")
      await setLocalSetting(owner, RIGHTS_MAINTENANCE_SETTING, "off")
    })
  )
}

/** Оператор, який рантайм надіслав порту; `failed` — відповідь бази помилкою. */
export interface RecordedStatement {
  text: string
  params: readonly (string | null)[]
  failed?: { code?: string; detail?: string }
}

/**
 * Порт команд, що записує кожен оператор і помилку, якою на нього відповіла
 * база: так тест бачить, хто відмовив — T3 до надсилання чи база на
 * конкретному операторі (`COMMIT`).
 */
export function recordingDatabase(inner: CommandDatabase): {
  database: CommandDatabase
  statements: RecordedStatement[]
} {
  const statements: RecordedStatement[] = []
  return {
    statements,
    database: {
      async connect() {
        const client = await inner.connect()
        return {
          async query(text, params) {
            const entry: RecordedStatement = { text, params: params ?? [] }
            statements.push(entry)
            try {
              return await client.query(text, params)
            } catch (error) {
              const { code, detail } = error as {
                code?: string
                detail?: string
              }
              entry.failed = { code, detail }
              throw error
            }
          },
          release: (destroy) => client.release(destroy),
        }
      },
    },
  }
}

/**
 * Порт команд, що кличе `hook` перед кожним оператором клієнта; `index` —
 * номер оператора на цьому з'єднанні від нуля. Так тест вклинює чужий коміт
 * рівно між двома операторами однієї транзакції рантайму.
 */
export function beforeStatement(
  inner: CommandDatabase,
  hook: (index: number, text: string) => Promise<void>
): CommandDatabase {
  return {
    async connect() {
      const client = await inner.connect()
      let index = 0
      return {
        async query(text, params) {
          await hook(index++, text)
          return client.query(text, params)
        },
        release: (destroy) => client.release(destroy),
      }
    },
  }
}

/**
 * Ресурс колбек-помічника (`inTarget`, `withRuntimeLogin`), утриманий між
 * `beforeAll` і `afterAll`: `open` чекає, доки `scope` віддасть значення, а
 * `close` відпускає колбек і чекає його прибирання. Ресурс, що впав до
 * значення, завершує `open` помилкою.
 */
export function heldResource<T>(
  scope: (use: (value: T) => Promise<void>) => Promise<unknown>
): { open: () => Promise<T>; close: () => Promise<void> } {
  let release: (() => void) | undefined
  let held: Promise<unknown> | undefined
  return {
    open: async () => {
      const released = new Promise<void>((resolve) => (release = resolve))
      let loaded: ((value: T) => void) | undefined
      const ready = new Promise<T>((resolve) => (loaded = resolve))
      held = scope(async (value) => {
        loaded?.(value)
        await released
      })
      return Promise.race([
        ready,
        held.then(() => {
          throw new Error("the resource closed before the scenario")
        }),
      ])
    },
    close: async () => {
      release?.()
      await held
    },
  }
}

/** Відмова команди як `CommandError`; успіх — помилка тесту. */
export async function commandRefusal(
  work: Promise<unknown>
): Promise<CommandError> {
  try {
    await work
  } catch (error) {
    if (error instanceof CommandFailure) return error.error
    throw error
  }
  throw new Error("the command succeeded")
}
