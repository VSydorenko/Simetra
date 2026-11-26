import { createHash } from "node:crypto"
import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import pg from "pg"
import { ensurePostgresCluster, type PostgresClusterSet } from "simetra/schema"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createApplyDatabase } from "../../../designer/src/schema-engine"
import {
  dropTaggedCluster,
  prepareStackIdentity,
  roleUrl,
  setTestPasswords,
  taggedClusterSet,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import { authSchemaOptions, withAuthOptions } from "../scripts/auth-options.mjs"
import { authOptions } from "../src/server/auth"
import type { AuthSettings } from "../src/server/config"
import type { MailMessage, MailTransport } from "../src/server/mail"

/**
 * Слот надсилання коду входу (Р-D5-6, І-2…І-6). DB-рівень, бо слот — це
 * `pg_advisory_xact_lock` і власна транзакція над рядками `verification`, а
 * прибирання прострочених рядків робить справжній Better Auth: усе це є лише
 * в Postgres. Запити йдуть через `auth.handler`, як від браузера.
 */
function withDatabaseName(dsn: string, database: string): string {
  const url = new URL(dsn)
  url.pathname = `/${database}`
  return url.toString()
}

const ORIGIN = "http://localhost:3000"
const SECRET = "simetra-sign-in-code-test-secret-0123456789"
const SEND = "/email-otp/send-verification-otp"
const SIGN_IN = "/sign-in/email-otp"
const SLOT_TAKEN = "SIGN_IN_CODE_SLOT_TAKEN"
const DAY_SECONDS = 24 * 60 * 60
const CODE_ONLY: AuthSettings = {
  signUp: "closed",
  password: false,
  emailCode: true,
  providers: [],
}

let set: PostgresClusterSet
let pool: pg.Pool
let auth: ReturnType<typeof createAuth>
const sent: MailMessage[] = []
const mail: MailTransport = {
  send: (message) => {
    sent.push(message)
    return Promise.resolve()
  },
}
// Керований годинник слота: тест рухає його без реального очікування
let clock = new Date()
const advance = (seconds: number) => {
  clock = new Date(clock.getTime() + seconds * 1000)
}

function createAuth() {
  const options = authOptions(
    pool,
    ORIGIN,
    SECRET,
    CODE_ONLY,
    mail,
    () => clock
  )
  // `defer` шаблону бере `waitUntil` запиту Nitro, якого поза Nitro немає;
  // без обробника Better Auth чекає лист до відповіді
  return betterAuth({
    ...options,
    advanced: { ...options.advanced, backgroundTasks: undefined },
  })
}

async function superuser<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString: withDatabaseName(testSuperuserUrl(), set.database),
  })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

// Ліміт плагіна за IP (3 на хвилину, реальний час) спрацьовує раніше слота й
// теж дає `429`; новий IP на кожен запит лишає перевірці лише слот на адресу
let ipCounter = 0
function nextIp(): string {
  ipCounter += 1
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
}

async function post(path: string, body: unknown) {
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        "x-simetra-client-ip": nextIp(),
      },
      body: JSON.stringify(body),
    })
  )
  const text = await response.text()
  return {
    status: response.status,
    body: text === "" ? null : (JSON.parse(text) as Record<string, unknown>),
  }
}

const sendCode = (email: unknown, type: unknown = "sign-in") =>
  post(SEND, { email, type })

const signIn = (email: string, otp: string) => post(SIGN_IN, { email, otp })

/** Коди з листів на адресу, у порядку надсилання. */
const codesTo = (email: string) =>
  sent
    .filter((message) => message.to === email)
    .map((message) => /code is (\d+)/.exec(message.text)?.[1])

/**
 * Наявний запис з перевіреною адресою. Через екземпляр з опціями скрипта:
 * `validateUserInfo` застосунку вимагає контексту маршруту, а запис
 * користувача тут — передумова, не предмет перевірки.
 */
async function createUser(email: string) {
  const context = await betterAuth(
    authSchemaOptions(pool, { origin: ORIGIN, secret: SECRET })
  ).$context
  await context.internalAdapter.createUser(
    { email, name: email, emailVerified: true },
    { method: "email-otp" }
  )
}

const markerCount = () =>
  superuser(async (client) =>
    Number(
      (
        await client.query(
          "SELECT count(*) AS n FROM better_auth.verification WHERE identifier LIKE 'otp-%'"
        )
      ).rows[0].n
    )
  )

const identifiers = (like: string) =>
  superuser(async (client) =>
    (
      await client.query(
        "SELECT identifier FROM better_auth.verification WHERE identifier LIKE $1 ORDER BY identifier",
        [like]
      )
    ).rows.map((row: { identifier: string }) => row.identifier)
  )

beforeAll(async () => {
  set = taggedClusterSet("sgncod")
  const url = testSuperuserUrl()
  const result = await ensurePostgresCluster(
    createApplyDatabase({ readOnly: false }),
    {
      maintenance: { url: withDatabaseName(url, "postgres") },
      target: { url: withDatabaseName(url, set.database) },
      template: { url: withDatabaseName(url, set.template) },
    },
    set
  )
  if (!result.ok)
    throw new Error(`roles refused: ${result.error.map((d) => d.code)}`)
  await setTestPasswords(set)
  const authUrl = roleUrl(set, set.auth)
  // Міграція за опціями скрипта, як у `db-setup`: та сама форма схеми
  await prepareStackIdentity({
    authUrl,
    auth: set.auth,
    migrate: async (dsn) => {
      const migrationPool = new pg.Pool({
        connectionString: withAuthOptions(dsn),
      })
      try {
        const { runMigrations } = await getMigrations(
          authSchemaOptions(migrationPool, { origin: ORIGIN, secret: SECRET })
        )
        await runMigrations()
      } finally {
        await migrationPool.end()
      }
    },
  })
  pool = new pg.Pool({ connectionString: withAuthOptions(authUrl) })
  auth = createAuth()
}, 120_000)

afterAll(async () => {
  await pool?.end()
  if (set !== undefined) await dropTaggedCluster(set)
}, 60_000)

beforeEach(() => {
  clock = new Date()
})

describe("sign-in code send slot (Р-D5-6)", () => {
  it("answers the same for an existing and an unknown address, and takes the slot for both", async () => {
    await createUser("present@example.test")
    const known = await sendCode("present@example.test")
    const unknown = await sendCode("absent@example.test")
    expect(known).toEqual({ status: 200, body: { success: true } })
    expect(unknown).toEqual(known)
    // Ключ маркера — рівно ключ коду, який пише сам плагін
    expect(await identifiers("%-present@example.test")).toEqual([
      "otp-day:sign-in-otp-present@example.test",
      "otp-slot:sign-in-otp-present@example.test",
      "sign-in-otp-present@example.test",
    ])
    expect(await identifiers("%-otp-absent@example.test")).toEqual([
      "otp-day:sign-in-otp-absent@example.test",
      "otp-slot:sign-in-otp-absent@example.test",
    ])
    advance(10)
    const repeatKnown = await sendCode("present@example.test")
    const repeatUnknown = await sendCode("absent@example.test")
    expect(repeatKnown).toEqual({
      status: 429,
      body: expect.objectContaining({ code: SLOT_TAKEN }),
    })
    expect(repeatUnknown).toEqual(repeatKnown)
  }, 60_000)

  it("stores the code as neither the code nor its plain SHA-256 (І-6)", async () => {
    await createUser("hash@example.test")
    expect((await sendCode("hash@example.test")).status).toBe(200)
    const [otp] = codesTo("hash@example.test")
    expect(otp).toMatch(/^\d{6}$/)
    const value = await superuser(
      async (client) =>
        (
          await client.query(
            "SELECT value FROM better_auth.verification WHERE identifier = $1",
            ["sign-in-otp-hash@example.test"]
          )
        ).rows[0].value as string
    )
    const stored = value.slice(0, value.lastIndexOf(":"))
    expect(stored).not.toBe(otp)
    expect(stored).not.toBe(
      createHash("sha256").update(String(otp)).digest("base64url")
    )
  }, 60_000)

  it("refuses the sixth attempt even with the right code", async () => {
    await createUser("attempts@example.test")
    expect((await sendCode("attempts@example.test")).status).toBe(200)
    const [otp] = codesTo("attempts@example.test")
    const wrong = otp === "000000" ? "111111" : "000000"
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect((await signIn("attempts@example.test", wrong)).status).toBe(400)
    }
    expect((await signIn("attempts@example.test", String(otp))).status).toBe(
      403
    )
  }, 60_000)

  it("limits one address across IPs and reopens the slot after 60 s", async () => {
    await createUser("ips@example.test")
    expect((await sendCode("ips@example.test")).status).toBe(200)
    advance(59)
    expect(await sendCode("ips@example.test")).toEqual({
      status: 429,
      body: expect.objectContaining({ code: SLOT_TAKEN }),
    })
    advance(2)
    expect((await sendCode("ips@example.test")).status).toBe(200)
    expect(codesTo("ips@example.test")).toHaveLength(2)
  }, 60_000)

  it("sends exactly one code out of parallel requests (І-5)", async () => {
    await createUser("parallel@example.test")
    const results = await Promise.all(
      Array.from({ length: 8 }, () => sendCode("parallel@example.test"))
    )
    expect(
      results.map((result) => result.status).sort((a, b) => a - b)
    ).toEqual([200, 429, 429, 429, 429, 429, 429, 429])
    for (const result of results.filter((r) => r.status === 429)) {
      expect(result.body).toMatchObject({ code: SLOT_TAKEN })
    }
    expect(codesTo("parallel@example.test")).toHaveLength(1)
  }, 60_000)

  it("refuses a repeat before 60 s in another case and keeps the first code valid (І-2)", async () => {
    await createUser("repeat@example.test")
    expect((await sendCode("repeat@example.test")).status).toBe(200)
    advance(30)
    expect(await sendCode("Repeat@Example.TEST")).toEqual({
      status: 429,
      body: expect.objectContaining({ code: SLOT_TAKEN }),
    })
    const codes = codesTo("repeat@example.test")
    expect(codes).toHaveLength(1)
    expect((await signIn("repeat@example.test", String(codes[0]))).status).toBe(
      200
    )
  }, 60_000)

  it.each([
    ["a number", 42],
    ["null", null],
    ["an array", ["array@example.test"]],
    ["missing", undefined],
  ])(
    "refuses an email that is %s with 400 and no markers",
    async (_name, email) => {
      const before = await markerCount()
      expect((await sendCode(email)).status).toBe(400)
      expect(await markerCount()).toBe(before)
    },
    60_000
  )

  it.each([
    ["not an address", "not-an-email"],
    // `z.email()` маршруту таку адресу приймає: відмовляє лише межа 254
    ["longer than 254", `${"a".repeat(200)}@${"b".repeat(60)}.test`],
  ])(
    "refuses an email that is %s with 400 and no markers",
    async (_name, email) => {
      const before = await markerCount()
      expect((await sendCode(email)).status).toBe(400)
      expect(await markerCount()).toBe(before)
    },
    60_000
  )

  it.each(["email-verification", "forget-password", "change-email", "other"])(
    "refuses type %s with 400, no markers and no mail",
    async (type) => {
      const email = `type-${type}@example.test`
      await createUser(email)
      const before = await markerCount()
      expect((await sendCode(email, type)).status).toBe(400)
      expect(await markerCount()).toBe(before)
      expect(codesTo(email)).toHaveLength(0)
    },
    60_000
  )

  it("refuses the 21st code of a day, also after another address signs in with a code (І-3)", async () => {
    // Годинник у минулому реального часу: слот-маркери вже прострочені для
    // прибирання Better Auth (`findVerificationValue` рахує реальний час), тож
    // вхід іншої адреси справді їх стирає; денний маркер живе 24 год
    clock = new Date(Date.now() - 25 * 60 * 1000)
    await createUser("daily@example.test")
    await createUser("other@example.test")
    for (let code = 1; code <= 20; code += 1) {
      expect((await sendCode("daily@example.test")).status).toBe(200)
      advance(61)
    }
    expect((await sendCode("other@example.test")).status).toBe(200)
    const [otherCode] = codesTo("other@example.test")
    expect((await signIn("other@example.test", String(otherCode))).status).toBe(
      200
    )
    expect(await identifiers("otp-slot:sign-in-otp-daily@%")).toEqual([])
    advance(61)
    expect(await sendCode("daily@example.test")).toEqual({
      status: 429,
      body: expect.objectContaining({ code: SLOT_TAKEN }),
    })
    expect(codesTo("daily@example.test")).toHaveLength(20)
  }, 120_000)

  it("counts the day from the first code: refused until first + 24 h, then a fresh day (І-3)", async () => {
    // Годинник — реальний час: прибирання Better Auth рахує реальний час, і
    // денний маркер мусить дожити до межі сам, а не зникнути раніше
    const email = "window@example.test"
    await createUser(email)
    const first = clock.getTime()
    for (let code = 1; code <= 20; code += 1) {
      expect((await sendCode(email)).status).toBe(200)
      advance(61)
    }
    // Стелю досягнуто; вікно не ковзає за останнім кодом і не коротше доби
    clock = new Date(first + (DAY_SECONDS - 1) * 1000)
    expect(await sendCode(email)).toEqual({
      status: 429,
      body: expect.objectContaining({ code: SLOT_TAKEN }),
    })
    clock = new Date(first + DAY_SECONDS * 1000)
    expect((await sendCode(email)).status).toBe(200)
    expect(
      await superuser(
        async (client) =>
          (
            await client.query(
              "SELECT value FROM better_auth.verification WHERE identifier = $1",
              [`otp-day:sign-in-otp-${email}`]
            )
          ).rows
      )
    ).toEqual([{ value: "1" }])
    expect(codesTo(email)).toHaveLength(21)
  }, 120_000)

  it("keeps two addresses apart when hashtext of their keys collides (І-4)", async () => {
    const pair = await superuser(
      async (client) =>
        (
          await client.query(
            `SELECT array_agg(n ORDER BY n) AS pair
               FROM generate_series(1, 300000) AS n
              GROUP BY hashtext('sign-in-otp-c' || n || '@example.test')
             HAVING count(*) > 1
              LIMIT 1`
          )
        ).rows[0]?.pair as number[] | undefined
    )
    expect(pair).toBeDefined()
    const [first, second] = (pair ?? []).map((n) => `c${n}@example.test`)
    const hashes = await superuser(
      async (client) =>
        (
          await client.query("SELECT hashtext($1) AS a, hashtext($2) AS b", [
            `sign-in-otp-${first}`,
            `sign-in-otp-${second}`,
          ])
        ).rows[0] as { a: number; b: number }
    )
    expect(hashes.a).toBe(hashes.b)
    expect((await sendCode(first)).status).toBe(200)
    expect((await sendCode(second)).status).toBe(200)
  }, 60_000)
})
