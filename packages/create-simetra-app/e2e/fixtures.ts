// Фікстура e2e: тегована база прогону з ознакою `simetra.environment =
// 'development'` рівня бази, `db-setup`, `seed`, двоє користувачів Better Auth
// з різними власними рядками `Client`, production-збірка шаблону й сервер
// `node-server` на 127.0.0.1. Усе піднімає один воркерний `app`; збірку він бере
// з метаданих проєкту Playwright (шов #210: нові ноги — рядки матриці).
import { test as base } from "@playwright/test"
import { execFile, type ExecFileException } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import net from "node:net"
import { dirname, join } from "node:path"
import { promisify } from "node:util"
import pg from "pg"
import { betterAuth } from "better-auth"
import type { SessionClaims } from "simetra/model"
import {
  createCommandRuntime,
  fromPgPool,
  type CommandRuntime,
} from "simetra/server"
import { authOptions } from "../template/src/server/auth"
import runtimeCatalog from "../template/generated/runtime-catalog.json" with { type: "json" }
import {
  TEMPLATE,
  appDsns,
  appServerEnv,
  assignClientOwner,
  buildTemplate,
  insertOwnClients,
  prepareDatabase,
  startServer,
  stopServer,
  waitReady,
  withClient,
  withDatabase,
  type ServerRun,
} from "../scripts/lib/app-database.mts"
import {
  generateSigningKeys,
  signalsDsn,
  startSignals,
} from "../scripts/lib/signals-stand.mts"
import { runContainerLabels } from "../../simetra/test/db/external"
import {
  runObjectPatterns,
  runTag,
  testDatabaseName,
  testSuperuserUrl,
} from "../../simetra/test/db/connection"
import {
  LOGIN_SECRETS_FILE,
  devSecret,
  testProvider,
} from "../../simetra/test/db/profile"
import { cookieHeader, send } from "./http"

const exec = promisify(execFile)

export { TEMPLATE }

/** Кількість `Client` засіву: дві повні сторінки по 100 і неповна. */
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

export type { ServerRun }

export interface App {
  origin: string
  port: number
  secret: string
  /** Id Server Function за ім'ям експорту з маніфесту збірки. */
  functionId: (name: "dataFn") => string
  /** Усі Server Function маніфесту збірки: ім'я експорту → id. */
  serverFunctions: Record<string, string>
  /** Centrifugo прогону: WebSocket-адреса й `kid` ключа підпису цього прогону. */
  signals: { url: string; kid: string }
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
  await buildTemplate()
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

async function bringUp(
  buildKind: string,
  cleanups: Array<() => Promise<void>>
): Promise<App> {
  const database = testDatabaseName("e2e")
  // Роль cluster-wide, але пароль і ім'я — стека: `roles` лише знаходить їх
  cleanups.push(() => dropDatabase(database))
  const dsns = appDsns(testSuperuserUrl(), database, {
    SIMETRA_OWNER_DEV_PASSWORD: devSecret(
      "SIMETRA_OWNER_DEV_PASSWORD",
      LOGIN_SECRETS_FILE
    ),
    SIMETRA_AUTH_DEV_PASSWORD: devSecret(
      "SIMETRA_AUTH_DEV_PASSWORD",
      LOGIN_SECRETS_FILE
    ),
    SIMETRA_RUNTIME_DEV_PASSWORD: devSecret(
      "SIMETRA_RUNTIME_DEV_PASSWORD",
      LOGIN_SECRETS_FILE
    ),
  })
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  // Випадковий на прогін, без секретів репозиторію
  const secret = randomBytes(32).toString("base64url")
  const scriptEnv = {
    ...dsns,
    SIMETRA_APP_ORIGIN: origin,
    BETTER_AUTH_SECRET: secret,
  }

  await prepareDatabase({
    database,
    maintenanceUrl: withDatabase(testSuperuserUrl(), "postgres"),
    dsns,
    origin,
    secret,
  })
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
  await assignClientOwner(dsns.SIMETRA_OWNER_DATABASE_URL, [
    users.a.id,
    users.b.id,
  ])
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
  await insertOwnClients(dsns.SIMETRA_OWNER_DATABASE_URL, {
    owner: users.b.id,
    count: B_ROWS,
    prefix: "B",
    description: "placeholder",
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

  // Власний Centrifugo прогону (Р1): мітки прогону дають сторожу стека зняти
  // контейнер, що пережив SIGKILL; на збої й у teardown його знімає фікстура
  const signals = await startSignals({
    name: `simetra-e2e-signals-${runTag()}`,
    labels: runContainerLabels(runTag(), testProvider()),
    origin,
    hostPort: port,
    databaseUrl: signalsDsn(testSuperuserUrl(), database, {
      SIMETRA_SIGNALS_DEV_PASSWORD: devSecret(
        "SIMETRA_SIGNALS_DEV_PASSWORD",
        LOGIN_SECRETS_FILE
      ),
    }),
  })
  cleanups.push(() => signals.down())
  // Новий ключ і `kid` на прогін (Р3): жодного ключа в git
  const keys = await generateSigningKeys()

  await build(buildKind)
  const ids = functionIds()
  const serverEnv = appServerEnv({
    dsns,
    origin,
    port,
    host: "127.0.0.1",
    secret,
    signals: { url: signals.wsUrl, keys: keys.json },
  })
  const server = startServer(serverEnv)
  cleanups.push(() => stopServer(server))
  await waitReady(`${origin}/`, server)

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
    signals: { url: signals.wsUrl, kid: keys.kid },
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

/**
 * Заголовок `Cookie` анонімної сесії Better Auth: серверним API, бо HTTP-шлях
 * анонімного входу вимкнено.
 */
export async function anonymousCookie(app: App): Promise<string> {
  const pool = new pg.Pool({
    connectionString: app.adminUrl,
    options: "-c search_path=better_auth",
  })
  try {
    const auth = betterAuth(authOptions(pool, app.origin, app.secret))
    const result = await auth.api.signInAnonymous({ returnHeaders: true })
    return result.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ")
  } finally {
    await pool.end()
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
