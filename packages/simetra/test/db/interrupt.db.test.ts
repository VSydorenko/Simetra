// Перерваний DB-прогін прибирає свої об'єкти стеку. Головний процес прогону
// грає фікстура з власним тегом (вкладений vitest узяв би замок, який тримає
// цей прогін); звірка стеку `stack-guard` після прогону — додатковий доказ.
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { createRequire } from "node:module"
import { constants } from "node:os"
import { fileURLToPath, pathToFileURL } from "node:url"
import pg from "pg"
import { describe, expect, it } from "vitest"
import {
  newRunTag,
  RUN_TAG_ENV,
  runObjectPatterns,
  testDatabaseUrl,
  testSuperuserUrl,
} from "./connection"
import { sweepRun } from "./sweep"

const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href
const FIXTURE = fileURLToPath(
  new URL("./fixtures/interrupted-run.ts", import.meta.url)
)
const SWEEP = fileURLToPath(new URL("./sweep.ts", import.meta.url))
// Тест чекає старту двох tsx-процесів, створення баз і прибирання з
// повторними проходами (до 30 с) — типові 5 с DB-проєкту цього не вміщують
const INTERRUPT_TIMEOUT_MS = 90_000

describe("an interrupted DB run", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "removes its own stack objects on %s",
    async (signal) => {
      const tag = newRunTag()
      const child = spawn(process.execPath, ["--import", TSX, FIXTURE, tag], {
        env: { ...process.env, [RUN_TAG_ENV]: tag },
        stdio: ["ignore", "pipe", "inherit"],
      })
      const exited = once(child, "exit") as Promise<[number | null, string]>
      let ready: { foreign: string; workerPid: number } | undefined
      let workerGone = false
      try {
        ready = await readyLine(child)
        // Воркер тим часом створює нові бази: сигнал застає його посеред роботи
        await new Promise((resolve) => setTimeout(resolve, 500))
        child.kill(signal)
        const [code] = await withDeadline(exited, 45_000)

        expect(code).toBe(128 + constants.signals[signal])
        expect(await taggedObjects(tag)).toEqual([])
        expect(await databaseExists(ready.foreign)).toBe(true)
        await expect
          .poll(() => isAlive(ready!.workerPid), { timeout: 5_000 })
          .toBe(false)
        workerGone = true
      } finally {
        // Збій тесту не має лишати процесів і об'єктів, які він породив:
        // чужа на вигляд тінь — теж його, її створила фікстура
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL")
        // Лише живому воркеру: pid мертвого міг уже дістатися іншому процесу
        if (ready !== undefined && !workerGone) killQuietly(ready.workerPid)
        await sweepRun(tag)
        if (ready !== undefined) await dropDatabase(ready.foreign)
      }
    },
    INTERRUPT_TIMEOUT_MS
  )

  it(
    "exits non-zero with the cleanup SQL when the stack is unreachable",
    async () => {
      const tag = newRunTag()
      const started = Date.now()
      const child = spawn(process.execPath, ["--import", TSX, SWEEP, tag], {
        env: {
          ...process.env,
          SIMETRA_TEST_SUPERUSER_URL:
            "postgresql://supabase_admin:postgres@127.0.0.1:1/postgres",
        },
        stdio: ["ignore", "ignore", "pipe"],
      })
      let stderr = ""
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
      const [code] = (await once(child, "close")) as [number | null]

      expect(code).toBe(1)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(stderr).toContain(tag)
    },
    INTERRUPT_TIMEOUT_MS
  )
})

async function readyLine(
  child: ChildProcess
): Promise<{ foreign: string; workerPid: number }> {
  let out = ""
  for await (const chunk of child.stdout!) {
    out += String(chunk)
    const match = /^ready (\S+) (\d+)$/m.exec(out)
    if (match !== null)
      return { foreign: match[1]!, workerPid: Number(match[2]) }
  }
  throw new Error(`The fixture exited before "ready"; stdout: ${out}`)
}

async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`No exit within ${ms} ms`)),
          ms
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function taggedObjects(tag: string): Promise<string[]> {
  const { databases, roles } = runObjectPatterns(tag)
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    const { rows } = await client.query<{ name: string }>(
      `select datname as name from pg_database where datname ~ $1
       union all
       select rolname from pg_roles where rolname ~ $2`,
      [databases.source, roles.source]
    )
    return rows.map((row) => row.name)
  } finally {
    await client.end()
  }
}

async function databaseExists(name: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  try {
    const { rowCount } = await client.query(
      "select 1 from pg_database where datname = $1",
      [name]
    )
    return rowCount === 1
  } finally {
    await client.end()
  }
}

async function dropDatabase(name: string): Promise<void> {
  // Тінь створив суперкористувач — лише він її й видалить
  const client = new pg.Client({ connectionString: testSuperuserUrl() })
  await client.connect()
  try {
    await client.query(
      `DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`
    )
  } finally {
    await client.end()
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
    throw error
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, "SIGKILL")
  } catch {
    // Уже мертвий — так і має бути
  }
}
