// Робоча база шаблону на спільному стеку `postgres` і запуск його
// production-збірки: одне джерело для фікстури e2e і `pnpm demo`. Тестового
// коду тут немає — демо його не імпортує; адреси й паролі дає той, хто кличе.
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { readFileSync, rmSync } from "node:fs"
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
} from "simetra/model"
import { PROVIDER_SHADOW_TEMPLATES } from "simetra/schema"
// Той самий SQL грантів, що робить `simetra roles`: друга копія розійшлася б
import { identityGrantSql } from "../../../simetra/src/schema/apply/postgres-cluster"
import { runDbSetup } from "../../template/scripts/db-setup-steps.mjs"

const exec = promisify(execFile)

export const TEMPLATE = resolve(import.meta.dirname, "../../template")

/** Рядки підключення застосунку до однієї бази стека. */
export interface AppDsns {
  SIMETRA_SUPERUSER_DATABASE_URL: string
  SIMETRA_OWNER_DATABASE_URL: string
  SIMETRA_AUTH_DATABASE_URL: string
  SIMETRA_RUNTIME_DATABASE_URL: string
}

export function withDatabase(dsn: string, database: string): string {
  const url = new URL(dsn)
  url.pathname = `/${database}`
  url.search = ""
  return url.toString()
}

/**
 * DSN ролей входу до бази `database`: `superuserUrl` — суперкористувач стека,
 * `secrets` — паролі за іменами `SIMETRA_*_DEV_PASSWORD` (`login-secrets.env`).
 */
export function appDsns(
  superuserUrl: string,
  database: string,
  secrets: Record<string, string>
): AppDsns {
  const login = (role: string, secret: string): string => {
    const password = secrets[secret]
    if (password === undefined || password === "")
      throw new Error(`${secret} is not set`)
    const url = new URL(withDatabase(superuserUrl, database))
    url.username = role
    url.password = password
    return url.toString()
  }
  const [authRole] = PROVIDER_LOGIN_ROLES.postgres
  if (authRole === undefined)
    throw new Error("the postgres profile has no auth role")
  return {
    SIMETRA_SUPERUSER_DATABASE_URL: withDatabase(superuserUrl, database),
    SIMETRA_OWNER_DATABASE_URL: login(
      PROVIDER_OWNER_ROLES.postgres,
      "SIMETRA_OWNER_DEV_PASSWORD"
    ),
    SIMETRA_AUTH_DATABASE_URL: login(authRole, "SIMETRA_AUTH_DEV_PASSWORD"),
    SIMETRA_RUNTIME_DATABASE_URL: login(
      PLATFORM_LOGIN_ROLES.runtime,
      "SIMETRA_RUNTIME_DEV_PASSWORD"
    ),
  }
}

export async function withClient<T>(
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

/**
 * База розробника тим самим `runDbSetup`, що й `scripts/db-setup.mjs`
 * (міграція Better Auth, `plan`, `apply --yes`), і ознака
 * `simetra.environment = 'development'` рівня бази. Крок `simetra roles`
 * замінено власним: на спільному стеку логіни Simetra мають явний `CONNECT` до
 * бази `simetra`, і `roles` відмовляє (`roles.shared-cluster`) для будь-якої
 * іншої бази. Замість нього — база з шаблону тінь-баз власником профілю,
 * `CONNECT` і схема `better_auth` до міграції та гранти власнику на таблицю
 * ідентичності після неї (`identityGrantSql`). `created` — одразу після
 * `CREATE DATABASE`: демо ставить на базу мітку власності до будь-якого
 * іншого кроку.
 */
export async function prepareDatabase(o: {
  database: string
  /** Суперкористувач стека до бази обслуговування `postgres`. */
  maintenanceUrl: string
  dsns: AppDsns
  origin: string
  secret: string
  created?: (client: pg.Client) => Promise<void>
}): Promise<void> {
  const owner = PROVIDER_OWNER_ROLES.postgres
  const [authRole] = PROVIDER_LOGIN_ROLES.postgres
  const template = PROVIDER_SHADOW_TEMPLATES.postgres
  if (template === null || authRole === undefined)
    throw new Error("the postgres profile has no shadow template or auth role")
  const { schema, name } = PROVIDER_IDENTITY_SOURCES.postgres.table
  const superuser = o.dsns.SIMETRA_SUPERUSER_DATABASE_URL
  const applied = await runDbSetup({
    authUrl: o.dsns.SIMETRA_AUTH_DATABASE_URL,
    ownerUrl: o.dsns.SIMETRA_OWNER_DATABASE_URL,
    origin: o.origin,
    secret: o.secret,
    beforeMigration: async () => {
      await withClient(o.maintenanceUrl, async (client) => {
        await client.query(
          `CREATE DATABASE "${o.database}" OWNER "${owner}" TEMPLATE "${template}"`
        )
        await o.created?.(client)
      })
      await withClient(superuser, async (client) => {
        await client.query(
          `GRANT CONNECT ON DATABASE "${o.database}" TO "${authRole}"`
        )
        await client.query(
          `CREATE SCHEMA IF NOT EXISTS "${schema}" AUTHORIZATION "${authRole}"`
        )
      })
    },
    afterMigration: async () => {
      const grants = identityGrantSql(owner, { schema, name })
      await withClient(superuser, async (client) => {
        await client.query(grants.usage)
        await client.query(grants.table)
      })
    },
  })
  // Файл плану лежить у `template/plans` (git-ignored): підготовка його не лишає
  if (applied !== undefined) rmSync(resolve(TEMPLATE, applied), { force: true })
  await withClient(superuser, (client) =>
    client.query(
      `ALTER DATABASE "${o.database}" SET simetra.environment = 'development'`
    )
  )
}

/**
 * Роль `ClientOwner` шаблону кожному з `subjects`: носій `owner` звужує
 * читання `Client` до власних рядків (`own`). Пише власник у режимі
 * обслуговування прав.
 */
export async function assignClientOwner(
  ownerUrl: string,
  subjects: readonly string[]
): Promise<void> {
  const roleId = (
    JSON.parse(
      readFileSync(
        join(TEMPLATE, "metadata/roles/ClientOwner/ClientOwner.meta.json"),
        "utf8"
      )
    ) as { id: string }
  ).id
  await withClient(ownerUrl, async (client) => {
    await client.query("BEGIN")
    try {
      await client.query(
        `SELECT set_config('${RIGHTS_MAINTENANCE_SETTING}', 'on', true)`
      )
      for (const subject of subjects)
        await client.query(
          "INSERT INTO app.global_role_assignments (id, subject, archetype) VALUES ($1, $2, $3)",
          [randomUUID(), subject, roleId]
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
}

/** Власні рядки `Client` користувача `owner`: коди `<prefix>00000000`… */
export async function insertOwnClients(
  ownerUrl: string,
  o: { owner: string; count: number; prefix: string; description: string }
): Promise<void> {
  await withClient(ownerUrl, async (client) => {
    for (let i = 0; i < o.count; i++)
      await client.query(
        "INSERT INTO app.client (id, code, description, owner_id) VALUES ($1, $2, $3, $4)",
        [
          randomUUID(),
          `${o.prefix}${String(i).padStart(8, "0")}`,
          o.description,
          o.owner,
        ]
      )
  })
}

/** Production-збірка шаблону (`vite build`). */
export async function buildTemplate(): Promise<void> {
  const vite = join(
    dirname(
      createRequire(join(TEMPLATE, "package.json")).resolve("vite/package.json")
    ),
    "bin/vite.js"
  )
  try {
    await exec(process.execPath, [vite, "build"], {
      cwd: TEMPLATE,
      env: { ...process.env, NODE_ENV: "production" },
      maxBuffer: 16 * 1024 * 1024,
    })
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }
    throw new Error(`vite build failed:\n${e.stdout ?? ""}${e.stderr ?? ""}`)
  }
}

/**
 * Оточення сервера збірки: лише рантайм і автентифікація; DSN власника й
 * суперкористувача серверу не потрібні.
 */
export function appServerEnv(o: {
  dsns: AppDsns
  origin: string
  port: number
  host: string
  secret: string
  /** Сигнали — опційно, обидві змінні разом (Р4). */
  signals?: { url: string; keys: string }
}): Record<string, string> {
  return {
    NODE_ENV: "production",
    PORT: String(o.port),
    HOST: o.host,
    NITRO_HOST: o.host,
    SIMETRA_APP_ORIGIN: o.origin,
    BETTER_AUTH_SECRET: o.secret,
    SIMETRA_RUNTIME_DATABASE_URL: o.dsns.SIMETRA_RUNTIME_DATABASE_URL,
    SIMETRA_AUTH_DATABASE_URL: o.dsns.SIMETRA_AUTH_DATABASE_URL,
    ...(o.signals === undefined
      ? {}
      : {
          SIMETRA_SIGNALS_URL: o.signals.url,
          SIMETRA_SIGNALS_KEYS: o.signals.keys,
        }),
  }
}

export interface ServerRun {
  child: ChildProcess
  output: () => string
  exited: Promise<number | null>
}

/**
 * Сервер збірки `.output/server/index.mjs` з оточенням лише `env` (+ `PATH`).
 * `echo` — дублювати вивід у власний процес (демо), а не лише збирати.
 */
export function startServer(
  env: Record<string, string | undefined>,
  o: { echo?: boolean } = {}
): ServerRun {
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
  child.stdout!.on("data", (c: Buffer) => {
    log += c.toString()
    if (o.echo === true) process.stdout.write(c)
  })
  child.stderr!.on("data", (c: Buffer) => {
    log += c.toString()
    if (o.echo === true) process.stderr.write(c)
  })
  const exited = new Promise<number | null>((resolveExit) =>
    child.once("exit", (code) => resolveExit(code))
  )
  return { child, output: () => log, exited }
}

/** Чекає першої HTTP-відповіді сервера на `url`; вихід процесу — помилка. */
export async function waitReady(url: string, server: ServerRun): Promise<void> {
  const deadline = Date.now() + 30_000
  let exited = false
  void server.exited.then(() => (exited = true))
  while (Date.now() < deadline) {
    if (exited)
      throw new Error(`the server exited at start:\n${server.output()}`)
    try {
      await fetch(url, { redirect: "manual" })
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error(`the server did not answer in time:\n${server.output()}`)
}

/** Зупиняє сервер: `SIGTERM`, через 5 с — `SIGKILL`. */
export async function stopServer(server: ServerRun): Promise<void> {
  server.child.kill("SIGTERM")
  // Таймер знімається одразу після виходу: інакше він тримав би процес ще 5 с
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    server.exited,
    new Promise((r) => (timer = setTimeout(r, 5_000))),
  ])
  clearTimeout(timer)
  if (server.child.exitCode === null) server.child.kill("SIGKILL")
}
