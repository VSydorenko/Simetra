import { APIError, createAuthMiddleware } from "better-auth/api"
import type { Pool, PoolClient } from "pg"
import * as z from "zod"

/** Шлях запиту коду входу; слот стоїть лише на ньому (Р-D5-6). */
export const SEND_CODE_PATH = "/email-otp/send-verification-otp"

/** Відмова слота: однакова для будь-якої адреси, тож не каже, чи є запис. */
export const SLOT_REFUSED = {
  code: "SIGN_IN_CODE_SLOT_TAKEN",
  message: "Too many sign-in code requests. Please try again later.",
}

// Межа адреси за RFC 5321: шлях 256 октетів мінус кутові дужки. `z.email()`
// маршруту довжини не обмежує, а ключ слота стоїть у блокуванні й рядках
const MAX_EMAIL_LENGTH = 254
const SLOT_SECONDS = 60
const DAY_SECONDS = 24 * 60 * 60
const DAY_CAP = 20

/**
 * Ключ коду плагіна для входу: форма `toOTPIdentifier("sign-in", email)`
 * (`plugins/email-otp/utils.mjs`). Функцію пакет із публічних входів не
 * експортує, тож форма повторена тут; DB-тест звіряє її з рядком коду, який
 * пише сам плагін.
 */
function codeKey(email: string): string {
  return `sign-in-otp-${email}`
}

const badRequest = (message: string) => new APIError("BAD_REQUEST", { message })

/**
 * Тіло ще не провалідоване (`runBeforeHooks` іде до `endpoint(...)`,
 * `api/dispatch.mjs`), тож хук перевіряє його сам, до транзакції: інакше
 * блокування й рядки маркерів брала б адреса, яку маршрут однаково відкине.
 * Перевірка адреси — та сама, що в маршруті (`sendVerificationOTP`,
 * `plugins/email-otp/routes.mjs`): `z.email()` після `toLowerCase()`.
 */
function sendCodeKey(body: unknown): string {
  const fields: Record<string, unknown> =
    typeof body === "object" && body !== null ? { ...body } : {}
  if (typeof fields.email !== "string") {
    throw badRequest("email must be a string")
  }
  const email = fields.email.toLowerCase()
  if (email.length > MAX_EMAIL_LENGTH || !z.email().safeParse(email).success) {
    throw badRequest("Invalid email")
  }
  // Інші призначення коду відкриті плагіном на тому самому шляху; шаблон дає
  // лише вхід (§9 плану D5)
  if (fields.type !== "sign-in") throw badRequest("Invalid OTP type")
  return codeKey(email)
}

type MarkerRow = { identifier: string; value: string }

const addSeconds = (at: Date, seconds: number) =>
  new Date(at.getTime() + seconds * 1000)

/**
 * Слот на адресу під блокуванням ключа. Маркери — у таблиці `verification`
 * Better Auth через `search_path` пула, тобто там, де лежить і сам код:
 * слот `otp-slot:<ключ>` на 60 с і денний `otp-day:<ключ>` з лічильником у
 * `value` на 24 год від першого коду. Денний маркер окремий, бо прибирання
 * прострочених рядків Better Auth (`findVerificationValue`,
 * `db/internal-adapter.mjs`) стерло б лічильник разом зі слотом. Відмова
 * нічого не пише: ні слота, ні лічильника.
 */
async function claimSlot(
  client: PoolClient,
  key: string,
  at: Date
): Promise<boolean> {
  const slot = `otp-slot:${key}`
  const day = `otp-day:${key}`
  // `hashtext` лише розводить черги блокування; колізія двох адрес означає
  // спільну чергу, а не спільні маркери: ті ключовані самою адресою
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key])
  const { rows } = await client.query<MarkerRow>(
    `SELECT identifier, value FROM verification
      WHERE identifier = ANY($1) AND "expiresAt" > $2`,
    [[slot, day], at]
  )
  const dayRow = rows.find((row) => row.identifier === day)
  const count = dayRow === undefined ? 0 : Number(dayRow.value)
  // `!(count < cap)`: зіпсований лічильник відмовляє, а не знімає стелю
  if (rows.some((row) => row.identifier === slot) || !(count < DAY_CAP)) {
    return false
  }
  // Прострочені маркери лежать, доки їх не прибере Better Auth
  await client.query(
    `DELETE FROM verification
      WHERE identifier = ANY($1) AND "expiresAt" <= $2`,
    [[slot, day], at]
  )
  await client.query(
    `INSERT INTO verification (identifier, value, "expiresAt", "createdAt", "updatedAt")
     VALUES ($1, '1', $2, $3, $3)`,
    [slot, addSeconds(at, SLOT_SECONDS), at]
  )
  if (dayRow === undefined) {
    await client.query(
      `INSERT INTO verification (identifier, value, "expiresAt", "createdAt", "updatedAt")
       VALUES ($1, '1', $2, $3, $3)`,
      [day, addSeconds(at, DAY_SECONDS), at]
    )
  } else {
    await client.query(
      `UPDATE verification SET value = $2, "updatedAt" = $3
        WHERE identifier = $1 AND "expiresAt" > $3`,
      [day, String(count + 1), at]
    )
  }
  return true
}

/**
 * Власна транзакція на тому самому пулі, що й `database` Better Auth: адаптер
 * транзакції бібліотеки сирого SQL не дає (`@better-auth/kysely-adapter`).
 * `COMMIT` — до виходу з хука, тож паралельний запит бачить слот зайнятим ще
 * до того, як маршрут ротує код.
 */
async function takeSlot(database: Pool, key: string, at: Date) {
  const client = await database.connect()
  let broken = false
  try {
    await client.query("BEGIN")
    const taken = await claimSlot(client, key, at)
    await client.query(taken ? "COMMIT" : "ROLLBACK")
    return taken
  } catch (error) {
    broken = true
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    // Зламане з'єднання не вертається в пул: на ньому могла лишитися транзакція
    client.release(broken)
  }
}

/**
 * `hooks.before` слота надсилання коду (спека §5.5, Р-D5-6). Користувача хук
 * не шукає: відмова й успіх однакові для наявної й невідомої адреси. Час — з
 * переданого годинника, бо тест керує ним без реального очікування.
 */
export function sendCodeSlot(database: Pool, now: () => Date) {
  return createAuthMiddleware(async (ctx) => {
    if (ctx.path !== SEND_CODE_PATH) return
    const key = sendCodeKey(ctx.body)
    if (!(await takeSlot(database, key, now()))) {
      throw APIError.from("TOO_MANY_REQUESTS", SLOT_REFUSED)
    }
  })
}
