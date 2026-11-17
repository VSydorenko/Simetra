// База розробника (спека П4-D §4.3, порядок спеки профілю `postgres` §4.2):
// `simetra roles` від суперкористувача → міграція Better Auth від
// `simetra_auth` → повторний `simetra roles` (адресні гранти на
// `better_auth."user"`) → `simetra plan` і `simetra apply` від `simetra_owner`.
// DSN беруться лише зі змінних оточення: argv видно в `ps`.
import { assertLoopback, DevGuardRefusal } from "./dev-guard.mjs"
import { runDbSetup, runSimetra } from "./db-setup-steps.mjs"
import config from "../simetra.config.ts"

function requiredEnv(name) {
  const value = process.env[name]
  if (value === undefined || value === "") {
    console.error(`db-setup: ${name} is not set`)
    process.exit(1)
  }
  return value
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

// Крок 1 створює ролі й схему `better_auth`; без нього міграції немає де йти.
// Після міграції таблиця ідентичності з'явилась: повторний запуск дає
// власнику гранти на неї
const roles = () => runSimetra(["roles", config.metadataDir], superuserUrl)
try {
  const applied = await runDbSetup({
    authUrl,
    ownerUrl,
    beforeMigration: roles,
    afterMigration: roles,
  })
  console.log(
    applied === undefined
      ? "db-setup: the database already matches the metadata"
      : `db-setup: applied ${applied}`
  )
} catch (error) {
  console.error(`db-setup: ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
