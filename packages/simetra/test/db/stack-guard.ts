// globalSetup DB-проєкту vitest обох пакетів. Локальний стек один на машину, а
// DB-тести ганяють кілька сесій і агентів: правила «один прогін за раз» і «стек
// після прогону такий самий, як до нього» тримає цей механізм, а не дисципліна
// в промптах.
import { execFileSync } from "node:child_process"
import {
  openSync,
  readFileSync,
  statfsSync,
  unlinkSync,
  writeSync,
  closeSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import {
  newRunTag,
  RUN_TAG_ENV,
  runTagOf,
  SHADOW_PREFIX,
  shadowAgeMinutes,
  testDatabaseUrl,
} from "./connection"
import { installInterruptCleanup } from "./interrupt"

// Замок у тимчасовій теці машини, а не в checkout: стек спільний і для інших
// checkout чи worktree того самого репо
const LOCK_PATH = join(tmpdir(), "simetra-db-stack.lock")
// Межа — з запасом над найдовшим повним прогоном (designer); чекати довше
// означає завислий прогін, і про нього краще дізнатися, ніж чекати безкінечно
const LOCK_WAIT_MS = 45 * 60_000
const LOCK_POLL_MS = 5_000
// Тіні двигуна — повні бази; прогін, що впирається в заповнений диск, падає
// вже наприкінці й лишає сиріт, тож краще не стартувати зовсім. Docker на
// Linux тримає дані стеку на кореневому розділі
const MIN_FREE_BYTES = 3 * 1024 ** 3

type Snapshot = Record<
  "databases" | "roles" | "schemas" | "extensions",
  string[]
>

export default async function setup(): Promise<() => Promise<void>> {
  checkFreeSpace()
  await acquireLock()
  let removeInterruptCleanup = (): void => {}
  try {
    // Форки воркерів, які vitest стартує після globalSetup, успадковують env
    const runTag = newRunTag()
    process.env[RUN_TAG_ENV] = runTag
    removeInterruptCleanup = installInterruptCleanup({
      tag: runTag,
      release: releaseLock,
    })
    const tree = treeState()
    process.stderr.write(
      `DB run tag ${runTag}${tree !== undefined ? ` at ${tree.summary}` : ""}\n`
    )
    // Тег уже є, але воркерів ще нема: об'єктів цього прогону в знімку бути
    // не може, тож звіт називає лише чужі лишки
    const before = await snapshot()
    const leftovers = leftoverReport(before)
    if (leftovers.length > 0) process.stderr.write(`${leftovers.join("\n")}\n`)
    return async () => {
      // Нормальне завершення не прибирає: що лишилось, показує звірка стеку
      removeInterruptCleanup()
      try {
        const after = await snapshot()
        const changed = treeState()
        if (tree !== undefined && changed?.summary !== tree.summary)
          process.stderr.write(
            `The working tree changed during the DB run (${tree.summary} → ${changed?.summary ?? "unknown"}): the results are not tied to one commit\n`
          )
        const leaks = diff(before, after)
        if (leaks.length > 0) throw new Error(leakMessage(leaks))
      } finally {
        releaseLock()
      }
    }
  } catch (error) {
    removeInterruptCleanup()
    releaseLock()
    throw error
  }
}

function checkFreeSpace(): void {
  const stats = statfsSync("/")
  const free = stats.bavail * stats.bsize
  if (free < MIN_FREE_BYTES)
    throw new Error(
      `Only ${(free / 1024 ** 3).toFixed(1)} GB free on /: a DB run needs at least ${MIN_FREE_BYTES / 1024 ** 3} GB (shadow databases are full databases). Free disk space first.`
    )
}

async function acquireLock(): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS
  let announced = false
  for (;;) {
    try {
      const fd = openSync(LOCK_PATH, "wx")
      writeSync(
        fd,
        `${process.pid}\n${process.cwd()}\n${new Date().toISOString()}\n`
      )
      closeSync(fd)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    const holder = readHolder()
    // Убитий прогін лишає файл замка без живого процесу — замок не тримає
    // ніхто, і його можна забрати
    if (holder === undefined || !isAlive(holder.pid)) {
      removeLockFile()
      continue
    }
    if (Date.now() > deadline)
      throw new Error(
        `The local stack is still busy after ${LOCK_WAIT_MS / 60_000} min: DB run PID ${holder.pid} (${holder.cwd}, since ${holder.since}). Lock file: ${LOCK_PATH}`
      )
    if (!announced) {
      process.stderr.write(
        `The local stack is busy: DB run PID ${holder.pid} (${holder.cwd}, since ${holder.since}); waiting…\n`
      )
      announced = true
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS))
  }
}

function releaseLock(): void {
  // Лише свій замок: чужий, перехоплений після нашого падіння, не чіпаємо
  if (readHolder()?.pid === process.pid) removeLockFile()
}

function readHolder(): { pid: number; cwd: string; since: string } | undefined {
  try {
    const [pid, cwd = "?", since = "?"] = readFileSync(LOCK_PATH, "utf8").split(
      "\n"
    )
    const parsed = Number(pid)
    return Number.isInteger(parsed) && parsed > 0
      ? { pid: parsed, cwd, since }
      : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM — процес є, але чужого користувача
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function removeLockFile(): void {
  try {
    unlinkSync(LOCK_PATH)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

function treeState(): { summary: string } | undefined {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim()
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter((line) => line !== "")
    return {
      summary:
        dirty.length === 0
          ? `${head}, clean tree`
          : `${head}, ${dirty.length} uncommitted path(s)`,
    }
  } catch {
    // Без git (архів, контейнер) відбиток просто не друкується
    return undefined
  }
}

async function snapshot(): Promise<Snapshot> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    const names = async (sql: string): Promise<string[]> =>
      (await client.query<{ name: string }>(sql)).rows.map((row) => row.name)
    return {
      databases: await names(
        "select datname as name from pg_database order by 1"
      ),
      roles: await names("select rolname as name from pg_roles order by 1"),
      // Тимчасові схеми сесій Postgres створює сам і не прибирає — це не слід тесту
      schemas: await names(
        "select nspname as name from pg_namespace where nspname !~ '^pg_(toast_)?temp_[0-9]+$' order by 1"
      ),
      extensions: await names(
        "select extname as name from pg_extension order by 1"
      ),
    }
  } finally {
    await client.end()
  }
}

/**
 * Рядки звіту про об'єкти прогонів, що вже є на стеку; порожньо — їх нема.
 * Замок гарантує, що інший DB-прогін зараз не йде, тож тегові об'єкти на
 * старті — лишки вбитого прогону чи збою прибиральника: SIGKILL не ловиться,
 * а звірка наступного прогону їх не побачить, бо вони вже є в знімку «до».
 * Їх лише називаємо, згрупувавши за тегом із командою прибиральника цього
 * тегу: що видаляти на спільному стеку, вирішує людина. Тінь без тегу могла
 * лишити й інша сесія (ручний спайк), тож для неї — окремий `DROP` на ім'я.
 */
export function leftoverReport(
  before: Pick<Snapshot, "databases" | "roles">,
  now: number = Date.now()
): string[] {
  const byTag = new Map<string, string[]>()
  const untaggedShadows: string[] = []
  const objects = [
    ...before.databases.map((name) => ({ kind: "database" as const, name })),
    ...before.roles.map((name) => ({ kind: "role" as const, name })),
  ]
  for (const { kind, name } of objects) {
    const shadow = kind === "database" && name.startsWith(SHADOW_PREFIX)
    const tag = runTagOf(kind, name)
    if (tag !== undefined)
      byTag.set(tag, [
        ...(byTag.get(tag) ?? []),
        `${kind} ${name}${shadow ? ` (${ageNote(name, now)})` : ""}`,
      ])
    else if (shadow) untaggedShadows.push(name)
  }
  const lines: string[] = []
  if (byTag.size > 0)
    lines.push(
      "Objects of earlier DB runs are already on the stack, likely left by a killed run or a failed sweep; they are not removed. A run's sweep drops only the objects of its tag:",
      ...[...byTag].flatMap(([tag, names]) => [
        `  run ${tag}: ${names.join(", ")}`,
        `    cd packages/simetra && node --import tsx test/db/sweep.ts ${tag}`,
      ])
    )
  if (untaggedShadows.length > 0)
    lines.push(
      "Untagged shadow databases are already on the stack, left by a killed run or another session; they are not removed. To clean up, after checking nobody else owns them:",
      ...untaggedShadows.map(
        (name) =>
          `  DROP DATABASE "${name}" WITH (FORCE);  -- ${ageNote(name, now)}`
      )
    )
  return lines
}

function ageNote(name: string, now: number): string {
  const age = shadowAgeMinutes(name, now)
  return age === undefined ? "age unknown" : `${Math.round(age)} min old`
}

type Change = {
  kind: keyof Snapshot
  name: string
  change: "added" | "removed"
}

function diff(before: Snapshot, after: Snapshot): Change[] {
  return (Object.keys(before) as (keyof Snapshot)[]).flatMap((kind) => {
    const was = new Set(before[kind])
    const now = new Set(after[kind])
    return [
      ...after[kind]
        .filter((name) => !was.has(name))
        .map((name) => ({ kind, name, change: "added" as const })),
      ...before[kind]
        .filter((name) => !now.has(name))
        .map((name) => ({ kind, name, change: "removed" as const })),
    ]
  })
}

function leakMessage(changes: readonly Change[]): string {
  const lines = changes.map(
    ({ kind, name, change }) => `  ${change} ${kind}: ${name}`
  )
  const cleanup = changes.flatMap(({ kind, name, change }) => {
    if (change !== "added") return []
    if (kind === "databases") return [`  DROP DATABASE "${name}" WITH (FORCE);`]
    // Роль, яку створив тест, видаляє лише supabase_admin (testSuperuserUrl):
    // у postgres на локальному стеку немає ADMIN на неї
    if (kind === "roles")
      return [`  DROP ROLE "${name}";  -- as supabase_admin`]
    if (kind === "schemas") return [`  DROP SCHEMA "${name}";`]
    return [`  DROP EXTENSION "${name}";`]
  })
  return [
    "The DB run left the local stack different from how it found it (a test that does not clean up, or another client changed the stack during the run):",
    ...lines,
    ...(cleanup.length > 0
      ? ["Cleanup, after checking nobody else owns these objects:", ...cleanup]
      : []),
  ].join("\n")
}
