// Перерваний DB-прогін прибирає свої об'єкти стеку. Головний процес прогону
// грає фікстура з власним тегом (вкладений vitest узяв би замок, який тримає
// цей прогін); звірка стеку `stack-guard` після прогону — додатковий доказ.
import { spawn, type ChildProcess } from "node:child_process"
import { once } from "node:events"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { constants, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import pg from "pg"
import { describe, expect, it } from "vitest"
import {
  newRunTag,
  RUN_TAG_ENV,
  runApplicationName,
  runObjectPatterns,
  runTag,
  SHADOW_PREFIX,
  shadowSuffix,
  testDatabaseUrl,
  testSuperuserUrl,
} from "./connection"
import { stopRunBackends, sweepRun } from "./sweep"

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

  // Тег у `application_name` ставить сторож через `PGAPPNAME`; що його
  // успадкували воркери vitest і що node-postgres його читає, видно лише з
  // боку сервера
  it("tags every connection of the run with the run's application name", async () => {
    const client = new pg.Client({ connectionString: testDatabaseUrl() })
    await client.connect()
    try {
      const { rows } = await client.query<{ name: string }>(
        "select current_setting('application_name') as name"
      )
      expect(rows).toEqual([{ name: runApplicationName(runTag()) }])
    } finally {
      await client.end()
    }
  })

  // Сервер виконує запит і після смерті клієнта — це видно лише на стеку:
  // замок не звільняється, поки бекенди прогону працюють
  it(
    "stops its own backends before releasing the lock on SIGINT",
    async () => {
      const tag = newRunTag()
      const lockDir = mkdtempSync(join(tmpdir(), "simetra-interrupt-"))
      const lock = join(lockDir, "lock")
      // Бекенд іншого прогону посеред такого самого запиту: сторож фікстури
      // не сміє його торкнутися
      const foreignName = runApplicationName(newRunTag())
      const foreign = new pg.Client({
        connectionString: testDatabaseUrl(),
        application_name: foreignName,
      })
      // Уборка завершує цей бекенд — обрив з'єднання тут очікуваний, а без
      // слухача `error` він став би неперехопленим винятком
      foreign.on("error", () => {})
      await foreign.connect()
      const [{ pid: foreignPid }] = (
        await foreign.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows as [{ pid: number }]
      const foreignSleep = foreign
        .query("SELECT pg_sleep(60)")
        .catch(() => undefined)
      let child: ChildProcess | undefined
      try {
        child = spawn(
          process.execPath,
          ["--import", TSX, FIXTURE, tag, "--sleep", lock],
          { stdio: ["ignore", "pipe", "inherit"] }
        )
        const exited = once(child, "exit") as Promise<[number | null, string]>
        await readyLine(child)
        const sleeping = [expect.stringContaining("pg_sleep")]
        await expect
          .poll(() => backendQueries(runApplicationName(tag)), {
            timeout: 5_000,
          })
          .toEqual(sleeping)
        await expect
          .poll(() => backendQueries(foreignName), { timeout: 5_000 })
          .toEqual(sleeping)
        expect(existsSync(lock)).toBe(true)

        child.kill("SIGINT")
        const [code] = await withDeadline(exited, 45_000)

        expect(code).toBe(128 + constants.signals.SIGINT)
        // Без опитування: обробник звільняє замок лише після того, як бекенди
        // справді вийшли
        expect(await backendQueries(runApplicationName(tag))).toEqual([])
        expect(existsSync(lock)).toBe(false)
        expect(await backendQueries(foreignName)).toEqual(sleeping)
      } finally {
        if (
          child !== undefined &&
          child.exitCode === null &&
          child.signalCode === null
        )
          child.kill("SIGKILL")
        // Обидва бекенди — цього тесту; збій не має лишати їх на стеку
        await cleanup(() => stopRunBackends(tag, { graceMs: 1_000 }))
        await cleanup(() => terminateBackend(foreignPid))
        await foreignSleep
        await cleanup(() => foreign.end())
        rmSync(lockDir, { recursive: true, force: true })
      }
    },
    INTERRUPT_TIMEOUT_MS
  )

  // Шлях `teardown` без вкладеного vitest: та сама функція, що й у сторожа.
  // Бекенд «idle in transaction» глухий до `pg_cancel_backend` — його
  // закінчує лише `pg_terminate_backend`, і це видно тільки на стеку
  it("terminates its idle backends that a cancel does not stop", async () => {
    const tag = newRunTag()
    const connect = async (
      applicationName: string
    ): Promise<{
      client: pg.Client
      pid: number
      closed: Promise<unknown>
    }> => {
      const client = new pg.Client({
        connectionString: testDatabaseUrl(),
        application_name: applicationName,
      })
      // Обрив з'єднання від сервера — очікуваний результат, а не збій тесту;
      // `events.once` відхилився б на `error`, що передує `end`
      const closed = new Promise((resolve) => client.once("end", resolve))
      client.on("error", () => {})
      await client.connect()
      await client.query("BEGIN")
      const [{ pid }] = (
        await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows as [{ pid: number }]
      return { client, pid, closed }
    }
    const own = await connect(runApplicationName(tag))
    const foreignName = runApplicationName(newRunTag())
    const foreign = await connect(foreignName)
    try {
      const result = await stopRunBackends(tag, { graceMs: 500 })

      expect(result).toEqual({ stopped: 1, left: [] })
      expect(await backendQueries(runApplicationName(tag))).toEqual([])
      await withDeadline(own.closed, 5_000)
      expect(await backendQueries(foreignName)).toHaveLength(1)
      await expect(foreign.client.query("SELECT 1")).resolves.toBeDefined()
    } finally {
      await cleanup(() => terminateBackend(own.pid))
      await cleanup(() => terminateBackend(foreign.pid))
      await cleanup(() => own.client.end())
      await cleanup(() => foreign.client.end())
    }
  })

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

// Запити бекендів з цим `application_name` у будь-якому стані; суперкористувач
// бачить запити всіх ролей
async function backendQueries(applicationName: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: testSuperuserUrl() })
  await client.connect()
  try {
    const { rows } = await client.query<{ query: string }>(
      "select query from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()",
      [applicationName]
    )
    return rows.map((row) => row.query)
  } finally {
    await client.end()
  }
}

async function terminateBackend(pid: number): Promise<void> {
  await asSuperuser((client) =>
    client.query("SELECT pg_terminate_backend($1)", [pid])
  )
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
