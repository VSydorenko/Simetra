import { randomBytes } from "node:crypto"
import pg from "pg"
import type { EngineScope, SchemaEngine } from "simetra/schema"
import { createPgDeltaEngine } from "../../schema-engine"
import {
  testDatabaseName,
  testDatabaseUrl,
  testPoolerUrl,
  testRoleName,
  testSuperuserUrl,
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
 * Runs `fn` on a run-tagged copy database, `CREATE DATABASE … OWNER postgres
 * <clause>` (for example `template <name>`), created and dropped by the
 * superuser. `fn` gets the copy's URL for the default test role and its name.
 */
export async function withCopy<T>(
  clause: string,
  fn: (url: string, name: string) => Promise<T>
): Promise<T> {
  const name = testDatabaseName("copy")
  // Створення — до `try`: якщо воно впаде, `finally` не видалятиме бази,
  // якої цей виклик не створив
  await query(
    testSuperuserUrl(),
    `create database "${name}" owner postgres ${clause}`
  )
  try {
    const url = new URL(testDatabaseUrl())
    url.pathname = `/${name}`
    return await fn(url.toString(), name)
  } finally {
    // Прибирання й на шляху падіння: інакше копію зловить сторож стеку
    await query(
      testSuperuserUrl(),
      `drop database if exists "${name}" with (force)`
    )
  }
}

/** Drops the given roles, if they exist, as the stack superuser. */
export async function dropRoles(...names: string[]): Promise<void> {
  for (const name of names)
    await query(
      testSuperuserUrl(),
      `drop role if exists "${name.replaceAll('"', '""')}"`
    )
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
 * gets the URL of the database `url` as that role. The role and its backends
 * are removed on every path; `label` tells apart two such roles in one run.
 */
export async function withRuntimeLogin<T>(
  url: string,
  memberOf: readonly string[],
  fn: (loginUrl: string) => Promise<T>,
  label = "runtime"
): Promise<T> {
  const name = testRoleName(label)
  const password = randomBytes(12).toString("hex")
  // Створення — до `try`: невдале створення не видаляє чужої ролі з тим ім'ям
  await query(
    testSuperuserUrl(),
    `create role ${quoted(name)} login noinherit password '${password}'`
  )
  try {
    for (const role of memberOf)
      await query(
        testSuperuserUrl(),
        `grant ${quoted(role)} to ${quoted(name)} with inherit false, set true`
      )
    const login = new URL(url)
    login.username = name
    login.password = password
    return await fn(login.toString())
  } finally {
    // Пулер тримає серверні з'єднання ролі й після тесту: без завершення
    // бекендів тінь не видалилася б, а роль лишила б сесії сторожу
    await query(
      testSuperuserUrl(),
      "select pg_terminate_backend(pid) from pg_stat_activity where usename = $1",
      [name]
    )
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
