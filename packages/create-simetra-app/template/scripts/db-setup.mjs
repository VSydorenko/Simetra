// База розробника (спека П4-D §4.3, порядок спеки профілю `postgres` §4.2):
// `simetra roles` від суперкористувача → міграція Better Auth від
// `simetra_auth` → повторний `simetra roles` (адресні гранти на
// `better_auth."user"`) → `simetra plan` і `simetra apply` від `simetra_owner`.
// DSN беруться лише зі змінних оточення: argv видно в `ps`.
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { getMigrations } from "better-auth/db/migration"
import pg from "pg"
import config from "../simetra.config.ts"
import { authSchemaOptions, withAuthOptions } from "./auth-options.mjs"
import { assertLoopback, DevGuardRefusal } from "./dev-guard.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === "") {
    console.error(`db-setup: ${name} is not set`)
    process.exit(1)
  }
  return value
}

/** Запускає `simetra <args>` з DSN у змінній `SIMETRA_DATABASE_URL`. */
function simetra(args, databaseUrl) {
  const designer = dirname(
    createRequire(import.meta.url).resolve("@simetrajs/designer/package.json")
  )
  const result = spawnSync(
    process.execPath,
    [join(designer, "bin/simetra.mjs"), ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, SIMETRA_DATABASE_URL: databaseUrl },
    }
  )
  if (result.status !== 0) {
    console.error(`db-setup: simetra ${args[0]} failed`)
    console.error(result.stdout + result.stderr)
    process.exit(1)
  }
  return result.stdout
}

async function migrateBetterAuth(authUrl) {
  const pool = new pg.Pool({
    connectionString: withAuthOptions(authUrl),
    max: 1,
  })
  try {
    const { runMigrations } = await getMigrations(
      authSchemaOptions(pool, { origin: "http://localhost:3000" })
    )
    await runMigrations()
  } finally {
    await pool.end()
  }
}

const superuserUrl = requiredEnv("SIMETRA_SUPERUSER_DATABASE_URL")
const authUrl = requiredEnv("SIMETRA_AUTH_DATABASE_URL")
const ownerUrl = requiredEnv("SIMETRA_OWNER_DATABASE_URL")

// Ознаки рівня бази ще немає (її ставить оператор після `roles`), тож до
// першого запису перевіряється лише хост: суперкористувач не має бити по
// чужому серверу
try {
  for (const url of [superuserUrl, authUrl, ownerUrl]) assertLoopback(url)
} catch (error) {
  if (!(error instanceof DevGuardRefusal)) throw error
  console.error(`db-setup ${error.message}`)
  process.exit(1)
}

// Крок 1 створює ролі й схему `better_auth`; без нього міграції немає де йти
simetra(["roles", config.metadataDir], superuserUrl)
await migrateBetterAuth(authUrl)
// Таблиця ідентичності з'явилась: повторний запуск дає власнику гранти на неї
simetra(["roles", config.metadataDir], superuserUrl)

const planned = JSON.parse(
  simetra(["plan", config.metadataDir, "--format=json"], ownerUrl)
)
if (planned.planHash === undefined || planned.file === undefined) {
  console.log("db-setup: the database already matches the metadata")
} else {
  simetra(
    [
      "apply",
      planned.file,
      config.metadataDir,
      `--plan-hash=${planned.planHash}`,
      // `apply` — руйнівний інструмент, і без підтвердження CLI відмовляє;
      // рішення — за людиною, що запустила `db-setup`
      "--yes",
    ],
    ownerUrl
  )
  console.log(`db-setup: applied ${planned.file}`)
}
