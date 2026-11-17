// Dev-користувач (спека П4-D §4.3, Дх4): скрипт розробника, поза `src/` і
// поза збіркою. Окремий екземпляр Better Auth з дозволеною реєстрацією
// (`disableSignUp: false`) — у застосунку реєстрація вимкнена, тож цей скрипт
// єдиний шлях створити користувача, і він відмовляє поза базою розробника.
import { randomBytes } from "node:crypto"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { betterAuth } from "better-auth"
import pg from "pg"
import { authSchemaOptions, withAuthOptions } from "./auth-options.mjs"

/**
 * Маркер для тесту складу: рядкова стала, яку скрипт використовує (типове
 * ім'я створеного користувача, за ним видно, що рядок із скрипта), а не
 * коментар — мініфікація її не прибере, і тест знайде її в зібраному
 * результаті, де скрипта бути не може.
 */
export const DEV_USER_MARKER = "simetra-dev-user-script"

/** Ознака бази розробника: та сама, що в guard даних designer. */
const ENVIRONMENT_FLAG = "simetra.environment=development"

// Налаштування рівня бази (`ALTER DATABASE … SET` від суперкористувача), а не
// `current_setting`: сесійне `options=-c simetra.environment=development` у DSN
// підробило б другу. Запит іде на тому самому пулі, що й екземпляр Better Auth.
const DEVELOPMENT_FLAG_SQL = `SELECT EXISTS (
  SELECT FROM pg_catalog.pg_db_role_setting d
  JOIN pg_catalog.pg_database b ON b.oid = d.setdatabase
  WHERE b.datname = pg_catalog.current_database() AND d.setrole = 0
    AND $1 = ANY (d.setconfig)) AS development`

const IPV4_LOOPBACK = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Хост, який візьме `pg`: `localhost`, петля IPv4, `::1` чи шлях unix-сокета. */
export function isLocalHost(host) {
  if (host === undefined || host === "") return false
  if (host.startsWith("/")) return true
  const h = host.replace(/^\[|\]$/g, "").toLowerCase()
  if (h === "localhost" || h === "::1") return true
  const m = IPV4_LOOPBACK.exec(h)
  return m !== null && m.slice(1).every((octet) => Number(octet) <= 255)
}

/** Хост DSN так, як його візьме `pg`: параметр `host` перекриває хост адреси. */
function dsnHost(dsn) {
  const url = new URL(dsn)
  return url.searchParams.get("host") ?? url.hostname
}

/** Відмова запобіжника; нічого не записано. */
export class DevUserRefusal extends Error {}

/** Запобіжник: loopback-хост і ознака рівня бази; інакше — відмова. */
export async function assertDevelopmentDatabase(pool, dsn) {
  if (!isLocalHost(dsnHost(dsn)))
    throw new DevUserRefusal(
      "dev-user refused: the database host is not loopback"
    )
  const { rows } = await pool.query(DEVELOPMENT_FLAG_SQL, [ENVIRONMENT_FLAG])
  if (rows[0]?.development !== true)
    throw new DevUserRefusal(
      "dev-user refused: the database does not carry the database-level flag simetra.environment = 'development' (ALTER DATABASE … SET)"
    )
}

/**
 * Створює користувача або міняє пароль наявному; повертає пароль.
 * `dsn` — роль `simetra_auth`; пул один і для запобіжника, і для Better Auth.
 */
export async function createDevUser(o) {
  const pool = new pg.Pool({
    connectionString: withAuthOptions(o.dsn),
    max: 2,
  })
  // Обрив з'єднання між запитами не має валити процес
  pool.on("error", () => {})
  try {
    await assertDevelopmentDatabase(pool, o.dsn)
    const auth = betterAuth(
      authSchemaOptions(pool, {
        origin: o.origin,
        secret: o.secret,
        signUp: true,
      })
    )
    const password = o.password ?? randomBytes(18).toString("base64url")
    const context = await auth.$context
    const existing = await context.internalAdapter.findUserByEmail(o.email)
    if (existing === null) {
      await auth.api.signUpEmail({
        body: { email: o.email, password, name: o.name },
      })
      return { email: o.email, password, created: true }
    }
    // Внутрішній адаптер, а не `auth.api.setPassword` чи скидання листом:
    // пароль міняє той, хто має доступ до бази, без сесії й пошти
    const hash = await context.password.hash(password)
    if (await context.internalAdapter.findCredentialAccount(existing.user.id))
      await context.internalAdapter.updatePassword(existing.user.id, hash)
    else
      await context.internalAdapter.createAccount({
        userId: existing.user.id,
        providerId: "credential",
        accountId: existing.user.id,
        password: hash,
      })
    return { email: o.email, password, created: false }
  } finally {
    await pool.end()
  }
}

function invokedAsCommand() {
  const invoked = process.argv[1]
  if (invoked === undefined) return false
  try {
    return (
      realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url))
    )
  } catch {
    return false
  }
}

if (invokedAsCommand()) {
  const email = process.argv[2] ?? "dev@example.test"
  const dsn = process.env.SIMETRA_AUTH_DATABASE_URL
  if (dsn === undefined || dsn === "") {
    console.error("dev-user: SIMETRA_AUTH_DATABASE_URL is not set")
    process.exit(1)
  }
  createDevUser({
    dsn,
    email,
    name: process.argv[3] ?? DEV_USER_MARKER,
    origin: process.env.SIMETRA_APP_ORIGIN ?? "http://localhost:3000",
    secret: process.env.BETTER_AUTH_SECRET,
  })
    .then((result) => {
      // Пароль друкується один раз: ні файлу, ні репозиторію
      console.log(
        `${result.created ? "created" : "password changed"}: ${result.email}\npassword: ${result.password}`
      )
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exit(1)
    })
}
