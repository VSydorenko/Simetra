// Фікстура e2e (Д2-2): тегована база прогону з ознакою `simetra.environment =
// 'development'` рівня бази, `db-setup`, `seed`, двоє користувачів Better Auth
// з різними власними рядками `Client`, production-збірка шаблону й сервер
// `node-server` на 127.0.0.1. Усе піднімає один воркерний `app`; збірку він бере
// з метаданих проєкту Playwright (шов #210: нові ноги — рядки матриці).
import { test as base } from "@playwright/test"
import {
  execFile,
  spawn,
  type ChildProcess,
  type ExecFileException,
} from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import net from "node:net"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { promisify } from "node:util"
import pg from "pg"
import {
  PLATFORM_LOGIN_ROLES,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_LOGIN_ROLES,
  PROVIDER_OWNER_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  type SessionClaims,
} from "simetra/model"
import { PROVIDER_SHADOW_TEMPLATES } from "simetra/schema"
import {
  createCommandRuntime,
  fromPgPool,
  type CommandRuntime,
} from "simetra/server"
import runtimeCatalog from "../template/generated/runtime-catalog.json" with { type: "json" }
import { identityGrantSql } from "../../simetra/src/schema/apply/postgres-cluster"
import {
  runObjectPatterns,
  runTag,
  testDatabaseName,
  testSuperuserUrl,
} from "../../simetra/test/db/connection"
import { LOGIN_SECRETS_FILE, devSecret } from "../../simetra/test/db/profile"
import { runDbSetup } from "../template/scripts/db-setup-steps.mjs"
import { cookieHeader, send } from "./http"

const exec = promisify(execFile)

export const TEMPLATE = resolve(import.meta.dirname, "../template")

/** Кількість `Client` засіву (Д-9): дві повні сторінки по 100 і неповна. */
export const SEED_COUNT = 250
/** Власні рядки користувача B: їх бачить лише B. */
export const B_ROWS = 3

export interface TestUser {
  id: string
  email: string
  /** Пароль: форма входу в браузері (вхід B поверх живої сесії A). */
  password: string
  /** Заголовок `Cookie` дійсної сесії. */
  cookie: string
  /** Адреса сокета, з якої користувач увійшов (межа частоти рахує її). */
  address: string
}

export interface ServerRun {
  child: ChildProcess
  output: () => string
  exited: Promise<number | null>
}

export interface App {
  origin: string
  port: number
  secret: string
  /** Id Server Function за ім'ям експорту з маніфесту збірки. */
  functionId: (name: "dataFn") => string
  /** Усі Server Function маніфесту збірки: ім'я експорту → id. */
  serverFunctions: Record<string, string>
  /** Оточення основного сервера: запуск ще одного з однією зміненою змінною. */
  serverEnv: Record<string, string>
  users: { a: TestUser; b: TestUser }
  /** `CommandRuntime` користувача B з його claims: зовнішні зміни даних. */
  runtimeB: { runtime: CommandRuntime; claims: SessionClaims }
  /** Адреса тегованої бази від суперкористувача (звірка стану у тестах). */
  adminUrl: string
  /** Запит від суперкористувача до тегованої бази. */
  query: <T extends pg.QueryResultRow>(
    sql: string,
    params?: unknown[]
  ) => Promise<T[]>
  serverOutput: () => string
  /** Окремий запуск збірки з іншим оточенням (відмова старту). */
  start: (env: Record<string, string | undefined>) => ServerRun
  freePort: () => Promise<number>
}

function withDatabase(dsn: string, database: string): string {
  const url = new URL(dsn)
  url.pathname = `/${database}`
  url.search = ""
  return url.toString()
}

function loginUrl(role: string, secret: string, database: string): string {
  const url = new URL(withDatabase(testSuperuserUrl(), database))
  url.username = role
  url.password = devSecret(secret, LOGIN_SECRETS_FILE)
  return url.toString()
}

async function withClient<T>(
  dsn: string,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: dsn })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/** Прибирає лише базу з тегом цього прогону; чужу відмовляється чіпати. */
async function dropDatabase(database: string): Promise<void> {
  if (!runObjectPatterns(runTag()).databases.test(database))
    throw new Error(`Refusing to drop the database "${database}": not tagged`)
  await withClient(withDatabase(testSuperuserUrl(), "postgres"), (client) =>
    client
      .query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`)
      .then(() => undefined)
  )
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolvePort(port))
    })
  })
}

async function run(
  script: string,
  args: string[],
  env: Record<string, string>,
  label: string
): Promise<string> {
  try {
    const { stdout } = await exec(process.execPath, [script, ...args], {
      cwd: TEMPLATE,
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const e = error as ExecFileException & { stdout?: string; stderr?: string }
    throw new Error(`${label} failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`)
  }
}

/** Збірка шаблону: цільова ноги `build` матриці; поки є лише production. */
async function build(kind: string): Promise<void> {
  if (kind !== "production")
    throw new Error(`the e2e build "${kind}" is not supported yet (#210)`)
  const vite = join(
    dirname(
      createRequire(join(TEMPLATE, "package.json")).resolve("vite/package.json")
    ),
    "bin/vite.js"
  )
  await run(vite, ["build"], { NODE_ENV: "production" }, "vite build")
}

/** Id Server Function з маніфесту production-збірки: `<sha256>` за іменем експорту. */
function functionIds(): Record<string, string> {
  const ids: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith(".mjs")) {
        const text = readFileSync(path, "utf8")
        for (const m of text.matchAll(
          /"([0-9a-f]{64})":\s*\{\s*functionName:\s*"(\w+?)_createServerFn_handler"/g
        ))
          ids[m[2]!] = m[1]!
      }
    }
  }
  walk(join(TEMPLATE, ".output/server"))
  return ids
}

function startServer(env: Record<string, string | undefined>): ServerRun {
  const child = spawn(
    process.execPath,
    [join(TEMPLATE, ".output/server/index.mjs")],
    {
      cwd: TEMPLATE,
      env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  let log = ""
  child.stdout!.on("data", (c: Buffer) => (log += c.toString()))
  child.stderr!.on("data", (c: Buffer) => (log += c.toString()))
  const exited = new Promise<number | null>((resolveExit) =>
    child.once("exit", (code) => resolveExit(code))
  )
  return { child, output: () => log, exited }
}

async function waitReady(port: number, server: ServerRun): Promise<void> {
  const deadline = Date.now() + 30_000
  let exited = false
  void server.exited.then(() => (exited = true))
  while (Date.now() < deadline) {
    if (exited)
      throw new Error(`the server exited at start:\n${server.output()}`)
    try {
      const reply = await send({ port }, { path: "/" })
      if (reply.status > 0) return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error(`the server did not answer in time:\n${server.output()}`)
}

/**
 * База розробника тим самим `runDbSetup`, що й `scripts/db-setup.mjs`
 * (міграція Better Auth, `plan`, `apply --yes`). Крок `simetra roles` фікстура
 * замінює власним: на спільному стеку логіни Simetra мають явний `CONNECT` до
 * бази `simetra`, і `roles` відмовляє (`roles.shared-cluster`) для будь-якої
 * іншої бази. Замість нього — база з шаблону тінь-баз власником профілю,
 * `CONNECT` і схема `better_auth` до міграції та гранти власнику на таблицю
 * ідентичності після неї (`identityGrantSql`, той самий SQL, що в `roles`).
 */
async function prepareDatabase(
  database: string,
  dsns: Record<string, string>,
  origin: string,
  secret: string
): Promise<void> {
  const owner = PROVIDER_OWNER_ROLES.postgres
  const [authRole] = PROVIDER_LOGIN_ROLES.postgres
  const template = PROVIDER_SHADOW_TEMPLATES.postgres
  if (template === null || authRole === undefined)
    throw new Error("the postgres profile has no shadow template or auth role")
  const { schema, name } = PROVIDER_IDENTITY_SOURCES.postgres.table
  const applied = await runDbSetup({
    authUrl: dsns.SIMETRA_AUTH_DATABASE_URL!,
    ownerUrl: dsns.SIMETRA_OWNER_DATABASE_URL!,
    origin,
    secret,
    beforeMigration: async () => {
      await withClient(withDatabase(testSuperuserUrl(), "postgres"), (client) =>
        client.query(
          `CREATE DATABASE "${database}" OWNER "${owner}" TEMPLATE "${template}"`
        )
      )
      await withClient(dsns.SIMETRA_SUPERUSER_DATABASE_URL!, async (client) => {
        await client.query(
          `GRANT CONNECT ON DATABASE "${database}" TO "${authRole}"`
        )
        await client.query(
          `CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION "${authRole}"`
        )
      })
    },
    afterMigration: async () => {
      const grants = identityGrantSql(owner, { schema, name })
      await withClient(dsns.SIMETRA_SUPERUSER_DATABASE_URL!, async (client) => {
        await client.query(grants.usage)
        await client.query(grants.table)
      })
    },
  })
  // Файл плану лежить у `template/plans` (git-ignored): прогін його не лишає
  if (applied !== undefined) rmSync(resolve(TEMPLATE, applied), { force: true })
}

async function bringUp(
  buildKind: string,
  cleanups: Array<() => Promise<void>>
): Promise<App> {
  const database = testDatabaseName("e2e")
  // Роль cluster-wide, але пароль і ім'я — стека: `roles` лише знаходить їх
  cleanups.push(() => dropDatabase(database))
  const owner = PROVIDER_OWNER_ROLES.postgres
  const [authRole] = PROVIDER_LOGIN_ROLES.postgres
  const runtimeRole = PLATFORM_LOGIN_ROLES.runtime
  const dsns = {
    SIMETRA_SUPERUSER_DATABASE_URL: withDatabase(testSuperuserUrl(), database),
    SIMETRA_OWNER_DATABASE_URL: loginUrl(
      owner,
      "SIMETRA_OWNER_DEV_PASSWORD",
      database
    ),
    SIMETRA_AUTH_DATABASE_URL: loginUrl(
      authRole!,
      "SIMETRA_AUTH_DEV_PASSWORD",
      database
    ),
    SIMETRA_RUNTIME_DATABASE_URL: loginUrl(
      runtimeRole,
      "SIMETRA_RUNTIME_DEV_PASSWORD",
      database
    ),
  }
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  // Випадковий на прогін, без секретів репозиторію
  const secret = randomBytes(32).toString("base64url")
  const scriptEnv = {
    ...dsns,
    SIMETRA_APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
  }

  await prepareDatabase(database, dsns, origin, secret)
  await withClient(dsns.SIMETRA_SUPERUSER_DATABASE_URL, (client) =>
    client.query(
      `ALTER DATABASE "${database}" SET simetra.environment = 'development'`
    )
  )
  const query = <T extends pg.QueryResultRow>(
    sql: string,
    params?: unknown[]
  ) =>
    withClient(
      dsns.SIMETRA_SUPERUSER_DATABASE_URL,
      async (client) => (await client.query<T>(sql, params)).rows
    )

  const users: Record<"a" | "b", TestUser> = {} as never
  const passwords: Record<string, string> = {}
  for (const [key, address] of [
    ["a", "127.0.0.2"],
    ["b", "127.0.0.3"],
  ] as const) {
    const email = `${key}-${runTag()}@e2e.test`
    const out = await run(
      "scripts/dev-user.mjs",
      [email, `User ${key.toUpperCase()}`],
      scriptEnv,
      `dev-user ${key}`
    )
    passwords[key] = /password: (\S+)/.exec(out)![1]!
    const [row] = await query<{ id: string }>(
      'SELECT id FROM better_auth."user" WHERE email = $1',
      [email]
    )
    users[key] = {
      id: row!.id.toLowerCase(),
      email,
      password: passwords[key]!,
      cookie: "",
      address,
    }
  }

  // Права: роль `ClientOwner` обох (носій `owner` звужує читання до власних рядків)
  const roleId = (
    JSON.parse(
      readFileSync(
        join(TEMPLATE, "metadata/roles/ClientOwner/ClientOwner.meta.json"),
        "utf8"
      )
    ) as { id: string }
  ).id
  await withClient(dsns.SIMETRA_OWNER_DATABASE_URL, async (client) => {
    await client.query("BEGIN")
    try {
      await client.query(
        `SELECT set_config('${RIGHTS_MAINTENANCE_SETTING}', 'on', true)`
      )
      for (const user of [users.a, users.b])
        await client.query(
          "INSERT INTO app.global_role_assignments (id, subject, archetype) VALUES ($1, $2, $3)",
          [randomUUID(), user.id, roleId]
        )
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      await client.query(
        `SELECT set_config('${RIGHTS_MAINTENANCE_SETTING}', 'off', true)`
      )
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined)
      throw error
    }
  })
  // `CommandRuntime` второго користувача: ті самі пул ролі рантайму, каталог і
  // шлях, що в сервері, з справжніми claims B. Через нього B пише власні
  // рядки й міняє дані «ззовні» (D3); прямий SQL власника лишається лише там,
  // де потрібен режим обслуговування прав
  const runtimePool = new pg.Pool({
    connectionString: dsns.SIMETRA_RUNTIME_DATABASE_URL,
  })
  cleanups.push(() => runtimePool.end())
  const runtime = await createCommandRuntime({
    database: fromPgPool(runtimePool),
    catalog: runtimeCatalog,
  })
  const claimsB: SessionClaims = { sub: users.b.id, is_anonymous: false }
  const runtimeB = { runtime, claims: claimsB }
  // Початкові рядки B вставляє прямий SQL власника, значення міняє вже рантайм
  // B своїми claims: це і є «зовнішня зміна» його рядків. Новий рядок під час
  // тесту (сценарій 9) створюється вже через `create` рантайму B
  await withClient(dsns.SIMETRA_OWNER_DATABASE_URL, async (client) => {
    for (let i = 0; i < B_ROWS; i++)
      await client.query(
        "INSERT INTO app.client (id, code, description, owner_id) VALUES ($1, $2, $3, $4)",
        [
          randomUUID(),
          `B${String(i).padStart(8, "0")}`,
          "placeholder",
          users.b.id,
        ]
      )
  })
  const client = { kind: "Catalog", name: "Client" } as const
  const own = await runtime.read(claimsB, { object: client, limit: 50 })
  if (own.rows.length !== B_ROWS)
    throw new Error(`B sees ${own.rows.length} rows, expected ${B_ROWS}`)
  for (const [i, row] of own.rows.entries())
    await runtime.run(claimsB, {
      action: "update",
      object: client,
      id: String(row.ref),
      expectedVersion: Number(row.version),
      values: { description: `B-only ${i}` },
    })
  await run(
    "scripts/seed.mjs",
    [String(SEED_COUNT), users.a.id],
    scriptEnv,
    "seed"
  )

  await build(buildKind)
  const ids = functionIds()
  const serverEnv = {
    NODE_ENV: "production",
    PORT: String(port),
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
    SIMETRA_APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
    SIMETRA_RUNTIME_DATABASE_URL: dsns.SIMETRA_RUNTIME_DATABASE_URL,
    SIMETRA_AUTH_DATABASE_URL: dsns.SIMETRA_AUTH_DATABASE_URL,
  }
  const server = startServer(serverEnv)
  cleanups.push(async () => {
    server.child.kill("SIGTERM")
    await Promise.race([
      server.exited,
      new Promise((r) => setTimeout(r, 5_000)),
    ])
    if (server.child.exitCode === null) server.child.kill("SIGKILL")
  })
  await waitReady(port, server)

  for (const key of ["a", "b"] as const) {
    const user = users[key]
    const reply = await send(
      { port },
      {
        method: "POST",
        path: "/api/auth/sign-in/email",
        localAddress: user.address,
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email: user.email, password: passwords[key] }),
      }
    )
    if (reply.status !== 200)
      throw new Error(
        `sign-in of ${key} answered ${reply.status}: ${reply.text}`
      )
    user.cookie = cookieHeader(reply.setCookie)
  }

  return {
    origin,
    port,
    secret,
    functionId: (name) => {
      const id = ids[name]
      if (id === undefined)
        throw new Error(`no server function "${name}" in the build manifest`)
      return id
    },
    serverFunctions: ids,
    serverEnv,
    users: users as App["users"],
    runtimeB,
    adminUrl: dsns.SIMETRA_SUPERUSER_DATABASE_URL!,
    query,
    serverOutput: server.output,
    start: startServer,
    freePort,
  }
}

// Помилка підйому одна на прогін: без цього кожен із тестів перепідіймав би базу
// й сервер заново й повторював ту саму помилку. Воркер після падіння фікстури
// перезапускається, тож стан тримає ще й файл за тегом прогону.
let setupFailure: string | undefined
const failureFile = () =>
  join(TEMPLATE, "..", "test-results", `setup-failure-${runTag()}.txt`)

function knownFailure(): string | undefined {
  if (setupFailure !== undefined) return setupFailure
  try {
    return readFileSync(failureFile(), "utf8")
  } catch {
    return undefined
  }
}

function recordFailure(error: unknown): void {
  // `CommandFailure` несе лише код у повідомленні: поля помилки — у `error.error`
  const detail = (error as { error?: unknown }).error
  setupFailure =
    (error instanceof Error ? error.message : String(error)) +
    (detail === undefined ? "" : ` ${JSON.stringify(detail)}`)
  mkdirSync(dirname(failureFile()), { recursive: true })
  writeFileSync(failureFile(), setupFailure)
}

export const test = base.extend<object, { app: App }>({
  app: [
    async ({}, use, workerInfo) => {
      const earlier = knownFailure()
      if (earlier !== undefined)
        throw new Error(`the e2e setup failed earlier in this run:\n${earlier}`)
      const cleanups: Array<() => Promise<void>> = []
      const failures: unknown[] = []
      try {
        const kind = String(workerInfo.project.metadata.build)
        let app: App
        try {
          app = await bringUp(kind, cleanups)
        } catch (error) {
          recordFailure(error)
          throw error
        }
        await use(app)
      } finally {
        // Навіть коли підйом упав на півдорозі: тегована база не лишається на стеку
        for (const cleanup of cleanups.reverse())
          await cleanup().catch((error: unknown) => failures.push(error))
      }
      if (failures.length > 0) throw failures[0]
    },
    { scope: "worker", timeout: 300_000 },
  ],
})

export { expect } from "@playwright/test"
