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
import { assertDevelopmentDatabase, DevGuardRefusal } from "./dev-guard.mjs"

export { DevGuardRefusal }

/**
 * Маркер для тесту складу: рядкова стала, яку скрипт використовує (типове
 * ім'я створеного користувача, за ним видно, що рядок із скрипта), а не
 * коментар — мініфікація її не прибере, і тест знайде її в зібраному
 * результаті, де скрипта бути не може.
 */
export const DEV_USER_MARKER = "simetra-dev-user-script"

/**
 * Створює користувача або міняє пароль наявному; повертає пароль.
 * `dsn` — роль `simetra_auth`; пул один і для запобіжника, і для Better Auth.
 */
export async function createDevUser(o) {
  const connectionString = withAuthOptions(o.dsn)
  const pool = new pg.Pool({
    connectionString,
    max: 2,
  })
  // Обрив з'єднання між запитами не має валити процес
  pool.on("error", () => {})
  try {
    await assertDevelopmentDatabase(pool, connectionString)
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
      // `signUpEmail` завжди пише `emailVerified: false`, а вхід паролем
      // вимагає підтвердженої пошти: запис скрипта підтверджує сам розробник
      const created = await context.internalAdapter.findUserByEmail(o.email)
      await context.internalAdapter.updateUser(created.user.id, {
        emailVerified: true,
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
    await context.internalAdapter.updateUser(existing.user.id, {
      emailVerified: true,
    })
    // Старий пароль міг бути скомпрометованим: його сесії не переживають зміну
    await context.internalAdapter.deleteUserSessions(existing.user.id)
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
