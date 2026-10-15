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
  SHADOW_PREFIX,
  shadowSuffix,
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
  it.each([
    ["SIGTERM", undefined],
    ["SIGINT", undefined],
    // Другий Ctrl-C посеред прибирання: обробник мусить його проковтнути
    ["SIGINT", "SIGINT"],
  ] as const)(
    "removes its own stack objects on %s (second signal: %s)",
    async (signal, second) => {
      const tag = newRunTag()
      // Тінь чужого прогону — з тегом зовнішнього (env воркера vitest від
      // stack-guard, не фікстури): прибиральник фікстури не сміє її торкнутися,
      // а перерваний зовнішній прогін, чий воркер гине без `finally`, прибере
      // її своїм тегом. Тінь без тегу на такому перериванні лишилася б на стеку
      const foreign = SHADOW_PREFIX + shadowSuffix()
      await createDatabase(foreign)
      let child: ChildProcess | undefined
      let ready: { workerPid: number } | undefined
      let workerGone = false
      try {
        child = spawn(process.execPath, ["--import", TSX, FIXTURE, tag], {
          env: { ...process.env, [RUN_TAG_ENV]: tag },
          stdio: ["ignore", "pipe", "inherit"],
        })
        const exited = once(child, "exit") as Promise<[number | null, string]>
        ready = await readyLine(child)
        // Воркер тим часом створює нові бази: сигнал застає його посеред роботи
        await new Promise((resolve) => setTimeout(resolve, 500))
        child.kill(signal)
        if (second !== undefined) {
          // Обробник уже в spawnSync прибиральника
          await new Promise((resolve) => setTimeout(resolve, 300))
          child.kill(second)
        }
        const [code] = await withDeadline(exited, 45_000)

        expect(code).toBe(128 + constants.signals[signal])
        expect(await taggedObjects(tag)).toEqual([])
        expect(await databaseExists(foreign)).toBe(true)
        await expect
          .poll(() => isAlive(ready!.workerPid), { timeout: 5_000 })
          .toBe(false)
        workerGone = true
      } finally {
        // Збій тесту не має лишати процесів і об'єктів, які він породив:
        // тінь «чужого» прогону — теж його
        if (
          child !== undefined &&
          child.exitCode === null &&
          child.signalCode === null
        )
          child.kill("SIGKILL")
        // Лише живому воркеру: pid мертвого міг уже дістатися іншому процесу
        if (ready !== undefined && !workerGone) killQuietly(ready.workerPid)
        // Коротка межа: очікування виходу (до 45 с) і прибирання разом мають
        // уміститися в таймаут тесту
        await cleanup(() => sweepRun(tag, { deadlineMs: 10_000 }))
        await cleanup(() => dropDatabase(foreign))
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
      expect(stderr).toContain("DROP DATABASE")
    },
    INTERRUPT_TIMEOUT_MS
  )
})

// Збій прибирання лише повідомляємо: виняток з `finally` затер би первинну
// помилку тесту, а звірка стеку після прогону однаково назве залишки
async function cleanup(step: () => Promise<unknown>): Promise<void> {
  try {
    await step()
  } catch (error) {
    process.stderr.write(`Test cleanup failed: ${(error as Error).message}\n`)
  }
}

async function readyLine(child: ChildProcess): Promise<{ workerPid: number }> {
  let out = ""
  for await (const chunk of child.stdout!) {
    out += String(chunk)
    const match = /^ready (\d+)$/m.exec(out)
    if (match !== null) return { workerPid: Number(match[1]) }
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

// Тінь створює й видаляє суперкористувач, як і об'єкти фікстури
async function createDatabase(name: string): Promise<void> {
  await asSuperuser((client) =>
    client.query(`CREATE DATABASE ${client.escapeIdentifier(name)}`)
  )
}

async function dropDatabase(name: string): Promise<void> {
  await asSuperuser((client) =>
    client.query(
      `DROP DATABASE IF EXISTS ${client.escapeIdentifier(name)} WITH (FORCE)`
    )
  )
}

async function asSuperuser(
  fn: (client: pg.Client) => Promise<unknown>
): Promise<void> {
  const client = new pg.Client({ connectionString: testSuperuserUrl() })
  await client.connect()
  try {
    await fn(client)
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
