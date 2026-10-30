import pg from "pg"
import type { EngineScope, SchemaEngine } from "simetra/schema"
import { createPgDeltaEngine } from "../../schema-engine"
import {
  testDatabaseName,
  testDatabaseUrl,
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
