// Прибиральник одного DB-прогону: видаляє зі спільного стеку лише об'єкти з
// тегом цього прогону. Кличе його обробник сигналу (`interrupt.ts`) окремим
// процесом через `spawnSync`, а людина — тим самим CLI:
// `node --import tsx sweep.ts <тег>`.
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import pg from "pg"
import {
  runObjectPatterns,
  runObjectStatementPattern,
  testSuperuserUrl,
} from "./connection"

// Тег вставляється в шаблон без екранування: інша форма тегу (з аргументу CLI)
// розширила б шаблон на чужі об'єкти
const TAG_FORMAT = /^[0-9a-z]{6}$/
const DEFAULT_DEADLINE_MS = 30_000
const PASS_PAUSE_MS = 1_000
// Закритий фаєрволом порт інакше тримав би обробник сигналу до його межі
const CONNECT_TIMEOUT_MS = 5_000

/**
 * Drops every stack database and role tagged with `tag` and terminates the
 * backends still creating one, repeating the pass until one finds nothing or
 * `deadlineMs` runs out. A failed DROP does not stop the pass; whatever is
 * still found at the end is returned in `left`.
 */
export async function sweepRun(
  tag: string,
  o: { deadlineMs?: number } = {}
): Promise<{ dropped: string[]; left: string[] }> {
  checkTag(tag)
  const deadline = Date.now() + (o.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const { databases, roles } = runObjectPatterns(tag)
  const creating = runObjectStatementPattern(tag)
  // Ролі видаляє лише supabase_admin; `DROP OWNED BY` діє в поточній базі,
  // а тести працюють у `postgres`
  const url = new URL(testSuperuserUrl())
  url.pathname = "/postgres"
  const client = new pg.Client({
    connectionString: url.href,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
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
      if (all.length === 0) return { dropped, left: [] }
      if (Date.now() > deadline) return { dropped, left: all }
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
  if (!TAG_FORMAT.test(tag))
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
  if (tag === undefined || !TAG_FORMAT.test(tag)) {
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
