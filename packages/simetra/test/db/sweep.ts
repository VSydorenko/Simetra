// Прибиральник одного DB-прогону: завершує бекенди цього прогону й видаляє
// зі спільного стеку лише об'єкти з його тегом. Кличе його обробник сигналу (`interrupt.ts`) окремим
// процесом через `spawnSync`, а людина — тим самим CLI:
// `SIMETRA_TEST_PROVIDER=<профіль> node --import tsx sweep.ts <тег>`. Профіль
// обробник передає через успадковане env прогону.
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import pg from "pg"
import {
  GUARD_APPLICATION_NAME,
  isRunTag,
  runApplicationName,
  runObjectPatterns,
  runObjectStatementPattern,
  testDatabaseUrl,
  testSuperuserUrl,
} from "./connection"
import { type Exec, type Fetch, nodeExec, removeRunResources } from "./external"
import {
  PROVIDER_ENV,
  SUPERUSER_PRELUDE,
  TEST_STACKS,
  testProvider,
  type TestProvider,
} from "./profile"

const DEFAULT_DEADLINE_MS = 30_000
// Гарантована частка дедлайну на контейнери й бакети: DB-фаза, що впирається
// в свій дедлайн чи висить на з'єднанні, не з'їдає часу зовнішніх ресурсів
const EXTERNAL_BUDGET_MS = 5_000
const PASS_PAUSE_MS = 1_000
// Закритий фаєрволом порт інакше тримав би обробник сигналу до його межі
const CONNECT_TIMEOUT_MS = 5_000
// Скасований запит бекенд зазвичай кидає за мілісекунди; хто за цей час не
// вийшов (живий клієнт у простої, глухий до скасування виклик), — завершується
const CANCEL_GRACE_MS = 3_000
const TERMINATE_WAIT_MS = 5_000
const BACKEND_POLL_MS = 100

/**
 * Stops every backend whose `application_name` is the run name of `tag`:
 * cancels their queries, waits up to `graceMs` for them to go, terminates the
 * rest and waits until they are gone. Returns how many stopped and the pids
 * still there after the termination wait. Backends of other runs and untagged ones are
 * never touched.
 */
export async function stopRunBackends(
  tag: string,
  o: { graceMs?: number; signal?: AbortSignal; client?: ClientFactory } = {}
): Promise<{ stopped: number; left: number[] }> {
  checkTag(tag)
  const client = await openAdmin(testSuperuserUrl(), "postgres", o)
  try {
    // Точний збіг імені: шаблон міг би зачепити бекенди іншого прогону
    const running = async (): Promise<number[]> =>
      (
        await client.query<{ pid: number }>(
          "select pid from pg_catalog.pg_stat_activity where application_name = $1 and pid <> pg_catalog.pg_backend_pid()",
          [runApplicationName(tag)]
        )
      ).rows.map((row) => row.pid)
    const signal = (fn: string, pids: number[]): Promise<unknown> =>
      client.query(
        `select pg_catalog.${fn}(pid) from pg_catalog.unnest($1::int[]) as pid`,
        [pids]
      )
    const waitGone = async (ms: number): Promise<number[]> => {
      const deadline = Date.now() + ms
      for (;;) {
        const pids = await running()
        if (pids.length === 0 || Date.now() > deadline) return pids
        await new Promise((resolve) => setTimeout(resolve, BACKEND_POLL_MS))
      }
    }
    const found = await running()
    if (found.length === 0) return { stopped: 0, left: [] }
    // Спершу скасування: запит відкочується штатно, а бекенд, чий клієнт
    // уже мертвий, на відповіді помічає обрив і виходить сам
    await signal("pg_cancel_backend", found)
    const stubborn = await waitGone(o.graceMs ?? CANCEL_GRACE_MS)
    if (stubborn.length === 0) return { stopped: found.length, left: [] }
    await signal("pg_terminate_backend", stubborn)
    // `pg_terminate_backend` лише надсилає сигнал: замок звільняється, коли
    // бекенди справді вийшли, інакше наступний прогін отримав би їх навантаження
    const left = await waitGone(TERMINATE_WAIT_MS)
    return { stopped: found.length - left.length, left }
  } finally {
    await client.end()
  }
}

/**
 * Stops the backends of run `tag` ({@link stopRunBackends}), then drops every
 * stack database and role tagged with `tag` and terminates the backends still
 * creating one, repeating the pass until one finds nothing or the database
 * deadline (`deadlineMs` minus the external budget) runs out. A failed DROP
 * does not stop the pass. Then, even when the database is unreachable or
 * hangs, removes the run's containers and empty buckets
 * ({@link removeRunResources}). Whatever is still found at the end, and why a
 * phase failed, is returned in `left`; `cleanup` holds the commands to finish
 * by hand.
 */
export async function sweepRun(
  tag: string,
  o: {
    deadlineMs?: number
    exec?: Exec
    fetch?: Fetch
    client?: ClientFactory
  } = {}
): Promise<{ dropped: string[]; left: string[]; cleanup: string[] }> {
  checkTag(tag)
  const p = testProvider()
  const deadline = Date.now() + (o.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const dbDeadline = deadline - EXTERNAL_BUDGET_MS
  // Тайм-аути з'єднань не обмежують запиту, що не повертається: межу DB-фази
  // тримає таймер, а не сервер. На ньому клієнти фази рвуть з'єднання, тож
  // і на своїй межі фаза не лишає відкритих сокетів
  const phase = new AbortController()
  const timer = setTimeout(
    () =>
      phase.abort(
        new Error(
          `the database phase did not finish within ${o.deadlineMs ?? DEFAULT_DEADLINE_MS} ms minus ${EXTERNAL_BUDGET_MS} ms for containers and buckets`
        )
      ),
    Math.max(0, dbDeadline - Date.now())
  )
  timer.unref()
  const timedOut = new Promise<never>((_, reject) =>
    phase.signal.addEventListener("abort", () => reject(phase.signal.reason))
  )
  let db: { dropped: string[]; left: string[] } = { dropped: [], left: [] }
  let external: Awaited<ReturnType<typeof removeRunResources>>
  try {
    db = await Promise.race([
      sweepDatabase(tag, p, dbDeadline, phase.signal, o.client),
      timedOut,
    ])
  } catch (error) {
    // Недосяжна чи зависла база не скасовує прибирання контейнерів і
    // бакетів: вони від неї не залежать
    db.left.push(
      `stack objects of run ${tag} (sweep failed: ${(error as Error).message})`
    )
  } finally {
    clearTimeout(timer)
    external = await removeRunResources(tag, p, {
      exec: o.exec ?? nodeExec,
      fetch: o.fetch ?? fetch,
      deadlineMs: Math.max(EXTERNAL_BUDGET_MS, deadline - Date.now()),
    })
  }
  return {
    dropped: [...db.dropped, ...external.removed],
    left: [...db.left, ...external.left],
    // SQL — лише коли лишилось щось у базі: для контейнерів і бакетів він не
    // допоможе
    cleanup: [
      ...(db.left.length > 0 ? [manualSweepSql(tag, p)] : []),
      ...external.cleanup,
    ],
  }
}

async function sweepDatabase(
  tag: string,
  p: TestProvider,
  deadline: number,
  signal: AbortSignal,
  make?: ClientFactory
): Promise<{ dropped: string[]; left: string[] }> {
  const o = { signal, client: make }
  // Адреса, перевизначена на чужий стек, дала б прибиральнику видаляти там
  // об'єкти, поки прогін того стека тримає свій замок
  await assertStack(p, o)
  // Воркери вже вбиті, але сервер доводить їхні запити до кінця й без
  // клієнта: важкий запит вантажив би стек наступному прогону після
  // звільнення замка
  const stuck = (await stopRunBackends(tag, o)).left.map(
    (pid) => `backend ${pid} (did not stop)`
  )
  const { databases, roles } = runObjectPatterns(tag)
  const creating = runObjectStatementPattern(tag)
  // Ролі видаляє лише суперкористувач стека, а `DROP OWNED BY` діє лише в
  // поточній базі: об'єкти й гранти ролі прогону лишаються і в `postgres`, і
  // в базі тестів (на `postgres` — `simetra`)
  const [main, ...rest] = stackDatabases(p)
  const client = await openAdmin(testSuperuserUrl(), main!, o)
  const others: GuardClient[] = []
  try {
    for (const database of rest)
      others.push(await openAdmin(testSuperuserUrl(), database, o))
    const dropped: string[] = []
    for (;;) {
      signal.throwIfAborted()
      // `CREATE DATABASE` убитого воркера сервер доводить до кінця й після
      // смерті клієнта, а до фіксації рядка в каталозі немає: прохід без
      // таких запитів у pg_stat_activity ще не означає «чисто». Лише запити,
      // що створюють тегове ім'я цього прогону, — чужий бекенд не чіпаємо.
      // Запити читаються до каталогу: `CREATE`, зафіксований між двома
      // читаннями, видно хоча б в одному з них
      const inFlight = (
        await client.query<{ pid: number; query: string }>(
          "select pid, query from pg_catalog.pg_stat_activity where pid <> pg_catalog.pg_backend_pid() and state = 'active' and query ~* $1",
          [creating.source]
        )
      ).rows
      // `datistemplate`: тегову базу-шаблон Postgres не дає видалити, доки
      // ознаку не знято
      const foundDatabases = (
        await client.query<{ name: string; template: boolean }>(
          "select datname as name, datistemplate as template from pg_catalog.pg_database where datname ~ $1 order by 1",
          [databases.source]
        )
      ).rows
      const found = {
        databases: foundDatabases.map((row) => row.name),
        roles: await names(
          client,
          "select rolname as name from pg_catalog.pg_roles where rolname ~ $1 order by 1",
          roles.source
        ),
      }
      const all = [
        ...found.databases,
        ...found.roles,
        ...inFlight.map(
          ({ pid, query }) => `backend ${pid} (${query.slice(0, 120)})`
        ),
      ]
      if (all.length === 0) return { dropped, left: stuck }
      if (Date.now() > deadline) return { dropped, left: [...stuck, ...all] }
      for (const { pid } of inFlight)
        await tryQuery(client, "SELECT pg_catalog.pg_terminate_backend($1)", [
          pid,
        ])
      const id = (name: string): string => client.escapeIdentifier(name)
      // Бази спершу: роль, що володіє базою, не видалиться
      for (const { name, template } of foundDatabases)
        if (await tryDrop(client, name, template)) dropped.push(name)
      for (const name of found.roles) {
        for (const other of others)
          await tryQuery(other, `DROP OWNED BY ${id(name)}`)
        if (
          await tryQuery(
            client,
            `DROP OWNED BY ${id(name)}; DROP ROLE ${id(name)}`
          )
        )
          dropped.push(name)
      }
      // Повторний прохід ловить те, що встигло з'явитися між запитами
      await new Promise((resolve) => setTimeout(resolve, PASS_PAUSE_MS))
    }
  } finally {
    for (const other of others) await other.end()
    await client.end()
  }
}

/**
 * Бази стека, де можуть лишитися об'єкти чи гранти ролі прогону: `postgres`
 * (кластерні факти, набір базового стану) і база тестів, коли вона інша.
 * Перша — та, з якої видаляються бази й ролі.
 */
export function stackDatabases(p: TestProvider): string[] {
  // Перевизначена адреса стосується лише профілю прогону
  const url =
    p === testProvider() ? testDatabaseUrl() : TEST_STACKS[p].databaseUrl
  const tests = decodeURIComponent(new URL(url).pathname.slice(1))
  return tests === "postgres" || tests === ""
    ? ["postgres"]
    : ["postgres", tests]
}

/**
 * Drops the tagged database `name`; a template database first loses its
 * `datistemplate` flag, because Postgres refuses to drop a template. Takes the
 * client by the two members it uses so a test can pass a stand-in.
 */
export async function dropRunDatabase(
  client: {
    query(text: string): Promise<unknown>
    escapeIdentifier(name: string): string
  },
  name: string,
  isTemplate: boolean
): Promise<void> {
  const id = client.escapeIdentifier(name)
  if (isTemplate)
    await client.query(`ALTER DATABASE ${id} WITH IS_TEMPLATE false`)
  await client.query(`DROP DATABASE ${id} WITH (FORCE)`)
}

/**
 * Why the stack of profile `p` cannot be the stack reached at an address with
 * these facts, or `null` when it can. Only Supabase has `supabase_admin`.
 */
export function stackMismatch(
  p: TestProvider,
  facts: { supabaseAdmin: boolean }
): string | null {
  if (facts.supabaseAdmin === (p === "supabase")) return null
  return `this is not the ${p} stack: role supabase_admin is ${facts.supabaseAdmin ? "present" : "missing"}. A SIMETRA_TEST_* variable likely points at another stack; a run there would not hold that stack's lock. Unset it or run against the matching stack.`
}

/**
 * Throws unless every effective address of the run (`testDatabaseUrl()` and
 * `testSuperuserUrl()`) reaches the stack of profile `p`.
 */
export async function assertStack(
  p: TestProvider,
  o: { signal?: AbortSignal; client?: ClientFactory } = {}
): Promise<void> {
  for (const url of [testDatabaseUrl(), testSuperuserUrl()]) {
    // База `postgres` є на кожному стеку; база тестів — ні, поки стек не
    // піднято командою свого профілю
    const client = await openAdmin(url, "postgres", o)
    let supabaseAdmin: boolean
    try {
      supabaseAdmin =
        (
          await client.query<{ present: boolean }>(
            "select exists (select from pg_catalog.pg_roles where rolname = 'supabase_admin') as present"
          )
        ).rows[0]?.present === true
    } finally {
      await client.end()
    }
    const mismatch = stackMismatch(p, { supabaseAdmin })
    if (mismatch !== null) {
      // Без пароля: повідомлення йде в лог прогону
      const { username, host, pathname } = new URL(url)
      throw new Error(`${username}@${host}${pathname}: ${mismatch}`)
    }
  }
}

// SQL ручного прибирання за тегом — на випадок, коли стек недосяжний.
// `DROP OWNED BY` діє лише в поточній базі, тож блок на кожну базу стека
export function manualSweepSql(tag: string, p: TestProvider): string {
  checkTag(tag)
  const { databases, roles } = runObjectPatterns(tag)
  const [main, ...rest] = stackDatabases(p)
  return [
    `-- as ${TEST_STACKS[p].superuserName}; run the generated statements of each block connected to the database it names (DROP OWNED BY acts in the current database only)`,
    ...rest.flatMap((database) => [
      `-- in database ${database}:`,
      `SELECT format('DROP OWNED BY %I;', rolname) FROM pg_roles WHERE rolname ~ '${roles.source}';`,
    ]),
    `-- in database ${main!}:`,
    // `IS_TEMPLATE false` безпечний і для звичайної бази, а шаблон без нього не видалиться
    `SELECT format('ALTER DATABASE %I WITH IS_TEMPLATE false; DROP DATABASE %I WITH (FORCE);', datname, datname) FROM pg_database WHERE datname ~ '${databases.source}';`,
    `SELECT format('DROP OWNED BY %I; DROP ROLE %I;', rolname, rolname) FROM pg_roles WHERE rolname ~ '${roles.source}';`,
  ].join("\n")
}

/** Мінімальний клієнт адмінських з'єднань сторожа: тест дає підставний. */
export interface GuardClient {
  connect(): Promise<unknown>
  query<R extends pg.QueryResultRow>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: R[] }>
  end(): Promise<unknown>
  escapeIdentifier(name: string): string
}

export type ClientFactory = (config: pg.ClientConfig) => GuardClient

/**
 * Адмінське з'єднання сторожа й прибиральника з базою `database` сервера
 * адреси `url`, з прелюдією суперкористувача: на адресі тестів стартова роль
 * `-c role=` інакше дала б каталоги очима власника.
 */
export async function openAdmin(
  url: string,
  database: string,
  o: { signal?: AbortSignal; client?: ClientFactory } = {}
): Promise<GuardClient> {
  const target = new URL(url)
  target.pathname = `/${encodeURIComponent(database)}`
  const client = sweepClient(
    {
      connectionString: target.toString(),
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      // Явне ім'я важить більше за `PGAPPNAME` прогону, успадкований
      // прибиральником, — і `pid <> pg_backend_pid()` у запитах лише страховка
      application_name: GUARD_APPLICATION_NAME,
    },
    o.signal,
    o.client
  )
  await client.connect()
  try {
    for (const statement of SUPERUSER_PRELUDE) await client.query(statement)
  } catch (error) {
    await client.end()
    throw error
  }
  return client
}

// На сигнал `end()` рве сокет клієнта з активним запитом (node-postgres 8):
// запит падає, `finally` викликача закриває вже закритого клієнта, і процес
// прибиральника не тримає нічого відкритим
function sweepClient(
  config: pg.ClientConfig,
  signal: AbortSignal | undefined,
  make: ClientFactory = (c) => new pg.Client(c)
): GuardClient {
  signal?.throwIfAborted()
  const client = make(config)
  signal?.addEventListener("abort", () => void client.end().catch(() => {}), {
    once: true,
  })
  return client
}

function checkTag(tag: string): void {
  if (!isRunTag(tag))
    throw new Error(`Invalid run tag "${tag}": expected 6 characters [0-9a-z]`)
}

async function names(
  client: GuardClient,
  sql: string,
  pattern: string
): Promise<string[]> {
  return (await client.query<{ name: string }>(sql, [pattern])).rows.map(
    (row) => row.name
  )
}

async function tryQuery(
  client: GuardClient,
  sql: string,
  params: unknown[] = []
): Promise<boolean> {
  try {
    await client.query(sql, params)
    return true
  } catch (error) {
    process.stderr.write(`${sql}: ${(error as Error).message}\n`)
    return false
  }
}

async function tryDrop(
  client: GuardClient,
  name: string,
  template: boolean
): Promise<boolean> {
  try {
    await dropRunDatabase(client, name, template)
    return true
  } catch (error) {
    process.stderr.write(`drop database ${name}: ${(error as Error).message}\n`)
    return false
  }
}

async function cli(tag: string | undefined): Promise<number> {
  if (tag === undefined || !isRunTag(tag)) {
    process.stderr.write(
      `Usage: ${PROVIDER_ENV}=<postgres|supabase> node --import tsx sweep.ts <run tag> (6 characters [0-9a-z]); got "${tag ?? ""}"\n`
    )
    return 1
  }
  let p: TestProvider
  try {
    p = testProvider()
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 1
  }
  try {
    const { dropped, left, cleanup } = await sweepRun(tag)
    process.stderr.write(
      `DB run ${tag} sweep: dropped ${dropped.length > 0 ? dropped.join(", ") : "nothing"}; left ${left.length > 0 ? left.join(", ") : "nothing"}\n`
    )
    if (left.length === 0) return 0
    if (cleanup.length > 0)
      process.stderr.write(`Clean up by hand:\n${cleanup.join("\n")}\n`)
    return 1
  } catch (error) {
    process.stderr.write(
      `DB run ${tag} sweep failed: ${(error as Error).message}\nClean up by hand:\n${manualSweepSql(tag, p)}\n`
    )
    return 1
  }
}

// CLI лише при прямому запуску: обробник сигналу й тести імпортують модуль
function isMain(): boolean {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) ===
        realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    // argv[1] — не файл (`node -e`, REPL): модуль точно імпортовано
    return false
  }
}

if (isMain()) {
  // Другий Ctrl-C чи SIGHUP дістається всій групі процесів, тобто й
  // прибиральнику: обірваний посеред проходу, він лишив би тегові об'єкти.
  // Межа в нього й так є — власний дедлайн і SIGTERM від таймаута spawnSync
  process.on("SIGINT", () => {})
  process.on("SIGHUP", () => {})
  process.exitCode = await cli(process.argv[2])
}
