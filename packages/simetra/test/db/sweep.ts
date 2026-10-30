// Прибиральник одного DB-прогону: завершує бекенди цього прогону й видаляє
// зі спільного стеку лише об'єкти з його тегом. Кличе його обробник сигналу (`interrupt.ts`) окремим
// процесом через `spawnSync`, а людина — тим самим CLI:
// `node --import tsx sweep.ts <тег>`.
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import pg from "pg"
import {
  GUARD_APPLICATION_NAME,
  isRunTag,
  runApplicationName,
  runObjectPatterns,
  runObjectStatementPattern,
  testSuperuserUrl,
} from "./connection"

const DEFAULT_DEADLINE_MS = 30_000
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
  o: { graceMs?: number } = {}
): Promise<{ stopped: number; left: number[] }> {
  checkTag(tag)
  const client = new pg.Client({
    connectionString: testSuperuserUrl(),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    // Явне ім'я важить більше за `PGAPPNAME` прогону, успадкований
    // прибиральником, — і `pid <> pg_backend_pid()` нижче лише страховка
    application_name: GUARD_APPLICATION_NAME,
  })
  await client.connect()
  try {
    // Точний збіг імені: шаблон міг би зачепити бекенди іншого прогону
    const running = async (): Promise<number[]> =>
      (
        await client.query<{ pid: number }>(
          "select pid from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()",
          [runApplicationName(tag)]
        )
      ).rows.map((row) => row.pid)
    const signal = (fn: string, pids: number[]): Promise<unknown> =>
      client.query(`select ${fn}(pid) from unnest($1::int[]) as pid`, [pids])
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
 * creating one, repeating the pass until one finds nothing or
 * `deadlineMs` runs out. A failed DROP does not stop the pass; whatever is
 * still found at the end is returned in `left`.
 */
export async function sweepRun(
  tag: string,
  o: { deadlineMs?: number } = {}
): Promise<{ dropped: string[]; left: string[] }> {
  checkTag(tag)
  const deadline = Date.now() + (o.deadlineMs ?? DEFAULT_DEADLINE_MS)
  // Воркери вже вбиті, але сервер доводить їхні запити до кінця й без
  // клієнта: важкий запит вантажив би стек наступному прогону після
  // звільнення замка
  const stuck = (await stopRunBackends(tag)).left.map(
    (pid) => `backend ${pid} (did not stop)`
  )
  const { databases, roles } = runObjectPatterns(tag)
  const creating = runObjectStatementPattern(tag)
  // Ролі видаляє лише supabase_admin; `DROP OWNED BY` діє в поточній базі,
  // а тести працюють у `postgres`
  const url = new URL(testSuperuserUrl())
  url.pathname = "/postgres"
  const client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    application_name: GUARD_APPLICATION_NAME,
  })
  await client.connect()
  try {
    const dropped: string[] = []
    for (;;) {
      // `CREATE DATABASE` убитого воркера сервер доводить до кінця й після
      // смерті клієнта, а до фіксації рядка в каталозі немає: прохід без
      // таких запитів у pg_stat_activity ще не означає «чисто». Лише запити,
      // що створюють тегове ім'я цього прогону, — чужий бекенд не чіпаємо.
      // Запити читаються до каталогу: `CREATE`, зафіксований між двома
      // читаннями, видно хоча б в одному з них
      const inFlight = (
        await client.query<{ pid: number; query: string }>(
          "select pid, query from pg_stat_activity where pid <> pg_backend_pid() and state = 'active' and query ~* $1",
          [creating.source]
        )
      ).rows
      const found = {
        databases: await names(
          client,
          "select datname as name from pg_database where datname ~ $1 order by 1",
          databases.source
        ),
        roles: await names(
          client,
          "select rolname as name from pg_roles where rolname ~ $1 order by 1",
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
        await tryQuery(client, "SELECT pg_terminate_backend($1)", [pid])
      const id = (name: string): string => client.escapeIdentifier(name)
      // Бази спершу: роль, що володіє базою, не видалиться
      for (const name of found.databases)
        if (await tryQuery(client, `DROP DATABASE ${id(name)} WITH (FORCE)`))
          dropped.push(name)
      for (const name of found.roles)
        if (
          await tryQuery(
            client,
            `DROP OWNED BY ${id(name)}; DROP ROLE ${id(name)}`
          )
        )
          dropped.push(name)
      // Повторний прохід ловить те, що встигло з'явитися між запитами
      await new Promise((resolve) => setTimeout(resolve, PASS_PAUSE_MS))
    }
  } finally {
    await client.end()
  }
}

// SQL ручного прибирання за тегом — на випадок, коли стек недосяжний
function manualSweepSql(tag: string): string {
  checkTag(tag)
  const { databases, roles } = runObjectPatterns(tag)
  return [
    "-- as supabase_admin, connected to database postgres; run the generated statements",
    `SELECT format('DROP DATABASE %I WITH (FORCE);', datname) FROM pg_database WHERE datname ~ '${databases.source}';`,
    `SELECT format('DROP OWNED BY %I; DROP ROLE %I;', rolname, rolname) FROM pg_roles WHERE rolname ~ '${roles.source}';`,
  ].join("\n")
}

function checkTag(tag: string): void {
  if (!isRunTag(tag))
    throw new Error(`Invalid run tag "${tag}": expected 6 characters [0-9a-z]`)
}

async function names(
  client: pg.Client,
  sql: string,
  pattern: string
): Promise<string[]> {
  return (await client.query<{ name: string }>(sql, [pattern])).rows.map(
    (row) => row.name
  )
}

async function tryQuery(
  client: pg.Client,
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

async function cli(tag: string | undefined): Promise<number> {
  if (tag === undefined || !isRunTag(tag)) {
    process.stderr.write(
      `Usage: node --import tsx sweep.ts <run tag> (6 characters [0-9a-z]); got "${tag ?? ""}"\n`
    )
    return 1
  }
  try {
    const { dropped, left } = await sweepRun(tag)
    process.stderr.write(
      `DB run ${tag} sweep: dropped ${dropped.length > 0 ? dropped.join(", ") : "nothing"}; left ${left.length > 0 ? left.join(", ") : "nothing"}\n`
    )
    return left.length === 0 ? 0 : 1
  } catch (error) {
    process.stderr.write(
      `DB run ${tag} sweep failed: ${(error as Error).message}\nClean up by hand:\n${manualSweepSql(tag)}\n`
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
