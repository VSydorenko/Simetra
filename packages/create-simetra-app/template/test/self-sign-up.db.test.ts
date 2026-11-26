import { randomUUID } from "node:crypto"
import { betterAuth } from "better-auth"
import pg from "pg"
import type { SessionClaims } from "simetra/model"
import {
  createCommandRuntime,
  fromPgPool,
  type CommandRuntime,
} from "simetra/server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  appDsns,
  prepareDatabase,
  withClient,
  withDatabase,
  type AppDsns,
} from "../../scripts/lib/app-database.mts"
import {
  LOGIN_SECRETS_FILE,
  devSecret,
  runObjectPatterns,
  runTag,
  testDatabaseName,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import runtimeCatalog from "../generated/runtime-catalog.json" with { type: "json" }
import { authSchemaOptions, withAuthOptions } from "../scripts/auth-options.mjs"
import { createDevUser } from "../scripts/dev-user.mjs"
import { authOptions } from "../src/server/auth"
import type { AuthSettings } from "../src/server/config"
import type { MailMessage, MailTransport } from "../src/server/mail"

/**
 * Самореєстрація й права клієнта одним сценарієм (задача 6 D5; І-8, І-11). База
 * застосунку готується тим самим шляхом, що фікстура e2e (`prepareDatabase`):
 * провізія — тригер бази, права — справжні політики метаданих шаблону. Вхід —
 * через `auth.handler`, як від браузера; дані — через `CommandRuntime` під
 * claims нового користувача. OAuth — потік id-token `/sign-in/social` з
 * перевизначеними `verifyIdToken` і `getUserInfo` провайдера, без мережі.
 */

const ORIGIN = "http://localhost:3000"
const SECRET = "simetra-self-sign-up-test-secret-0123456789"
const CLIENT = { kind: "Catalog", name: "Client" } as const
const PROVIDER = {
  id: "google",
  clientId: "self-sign-up-client",
  clientSecret: "self-sign-up-secret",
}

/** Профіль провайдера за рядком id-token: перевірка підпису тут не предмет. */
const profiles = new Map<
  string,
  { sub: string; email: string; emailVerified: boolean }
>()

const sent: MailMessage[] = []
const mail: MailTransport = {
  send: (message) => {
    sent.push(message)
    return Promise.resolve()
  },
}

let database: string
let dsns: AppDsns
let authPool: pg.Pool | undefined
let runtimePool: pg.Pool | undefined
let runtime: CommandRuntime
let openAuth: ReturnType<typeof createAuth>
let closedAuth: ReturnType<typeof createAuth>

function createAuth(signUp: AuthSettings["signUp"]) {
  const options = authOptions(
    authPool!,
    ORIGIN,
    SECRET,
    { signUp, password: true, emailCode: true, providers: [PROVIDER] },
    mail
  )
  const google = options.socialProviders[PROVIDER.id]!
  return betterAuth({
    ...options,
    // `socialProviders` шаблону бере з налаштувань лише ключі й
    // `disableSignUp`; шов перевірки токена й профілю — поверх них, тож
    // `disableSignUp` лишається тим, що дав `authOptions`
    socialProviders: {
      [PROVIDER.id]: {
        ...google,
        verifyIdToken: (token: string) => Promise.resolve(profiles.has(token)),
        getUserInfo: ({ idToken }: { idToken?: string }) => {
          const profile = profiles.get(idToken ?? "")
          return Promise.resolve(
            profile === undefined
              ? null
              : {
                  user: {
                    id: profile.sub,
                    name: profile.email,
                    email: profile.email,
                    emailVerified: profile.emailVerified,
                  },
                  data: { sub: profile.sub, email: profile.email },
                }
          )
        },
      },
    },
    // Відмови сценарію очікувані, а бібліотека пише про них попередження
    logger: { level: "error" },
    // `defer` шаблону бере `waitUntil` запиту Nitro, якого поза Nitro немає;
    // без обробника Better Auth чекає лист до відповіді
    advanced: { ...options.advanced, backgroundTasks: undefined },
  })
}

// Ліміт плагіна за IP спрацював би раніше перевірок сценарію: новий IP на запит
let ipCounter = 0
function nextIp(): string {
  ipCounter += 1
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`
}

async function post(
  auth: ReturnType<typeof createAuth>,
  path: string,
  body: unknown
) {
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

const codesTo = (email: string) =>
  sent
    .filter((message) => message.to === email)
    .map((message) => /code is (\d+)/.exec(message.text)?.[1])

/** Запит коду й вхід кодом з листа; `null` — листа не було. */
async function signInWithCode(
  auth: ReturnType<typeof createAuth>,
  email: string
) {
  const request = await post(auth, "/email-otp/send-verification-otp", {
    email,
    type: "sign-in",
  })
  expect(request).toEqual({ status: 200, body: { success: true } })
  const [otp] = codesTo(email)
  return post(auth, "/sign-in/email-otp", { email, otp: otp ?? "000000" })
}

const signInWithPassword = (email: string, password: string) =>
  post(openAuth, "/sign-in/email", { email, password })

const signInWithProvider = (
  auth: ReturnType<typeof createAuth>,
  profile: { sub: string; email: string; emailVerified: boolean }
) => {
  const token = `id-token-${profile.sub}`
  profiles.set(token, profile)
  return post(auth, "/sign-in/social", {
    provider: PROVIDER.id,
    idToken: { token },
  })
}

const query = <T extends pg.QueryResultRow>(sql: string, params?: unknown[]) =>
  withClient(
    dsns.SIMETRA_SUPERUSER_DATABASE_URL,
    async (client) => (await client.query<T>(sql, params)).rows
  )

const userIds = async (email: string) =>
  (
    await query<{ id: string }>(
      'SELECT id FROM better_auth."user" WHERE email = $1',
      [email]
    )
  ).map((row) => row.id.toLowerCase())

const accountsOf = async (userId: string) =>
  (
    await query<{ providerId: string; password: string | null }>(
      'SELECT "providerId", password FROM better_auth.account WHERE "userId" = $1 ORDER BY "providerId"',
      [userId]
    )
  ).map((row) => ({ providerId: row.providerId, password: row.password }))

const sessionTokens = async (userId: string) =>
  (
    await query<{ token: string }>(
      'SELECT token FROM better_auth.session WHERE "userId" = $1',
      [userId]
    )
  ).map((row) => row.token)

const claimsOf = (id: string): SessionClaims => ({
  sub: id.toLowerCase(),
  is_anonymous: false,
})

let codeCounter = 0
/** Новий рядок `Client` під claims власника через рантайм. */
async function createClient(owner: string): Promise<string> {
  codeCounter += 1
  const id = randomUUID()
  await runtime.run(claimsOf(owner), {
    action: "create",
    object: CLIENT,
    id,
    values: {
      code: `SSU${String(codeCounter).padStart(6, "0")}`,
      description: `row of ${owner}`,
      owner,
    },
  })
  return id
}

const readClients = async (user: string) =>
  (await runtime.read(claimsOf(user), { object: CLIENT, limit: 100 })).rows

/**
 * Запис з неперевіреною адресою, як його лишив би шлях реєстрації паролем
 * (`signUpEmail` завжди пише `emailVerified: false` і сам відкриває сесію), з
 * паролем і сесіями, що виникли до доказу володіння адресою.
 */
async function unverifiedRecord(email: string, password: string) {
  const pool = new pg.Pool({
    connectionString: withAuthOptions(dsns.SIMETRA_AUTH_DATABASE_URL),
  })
  try {
    const auth = betterAuth(
      authSchemaOptions(pool, { origin: ORIGIN, secret: SECRET, signUp: true })
    )
    await auth.api.signUpEmail({ body: { email, password, name: email } })
  } finally {
    await pool.end()
  }
  const [id] = await userIds(email)
  await query(
    `INSERT INTO better_auth.session (id, token, "userId", "expiresAt", "createdAt", "updatedAt")
     VALUES (gen_random_uuid(), $1, $2, now() + interval '1 day', now(), now())`,
    [`ssu-token-${randomUUID()}`, id]
  )
  const tokens = await sessionTokens(id!)
  expect(tokens).toHaveLength(2)
  return { id: id!, tokens }
}

/** Прибирає лише базу з тегом цього прогону; чужу відмовляється чіпати. */
async function dropDatabase(name: string): Promise<void> {
  if (!runObjectPatterns(runTag()).databases.test(name))
    throw new Error(`Refusing to drop the database "${name}": not tagged`)
  await withClient(withDatabase(testSuperuserUrl(), "postgres"), (client) =>
    client
      .query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      .then(() => undefined)
  )
}

beforeAll(async () => {
  // Ім'я — до створення: прибирання в `afterAll` знає базу й тоді, коли
  // підготовка впала на півдорозі
  database = testDatabaseName("ssu")
  dsns = appDsns(testSuperuserUrl(), database, {
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
  await prepareDatabase({
    database,
    maintenanceUrl: withDatabase(testSuperuserUrl(), "postgres"),
    dsns,
    origin: ORIGIN,
    secret: SECRET,
  })
  authPool = new pg.Pool({
    connectionString: withAuthOptions(dsns.SIMETRA_AUTH_DATABASE_URL),
  })
  runtimePool = new pg.Pool({
    connectionString: dsns.SIMETRA_RUNTIME_DATABASE_URL,
  })
  runtime = await createCommandRuntime({
    database: fromPgPool(runtimePool),
    catalog: runtimeCatalog,
  })
  openAuth = createAuth("open")
  closedAuth = createAuth("closed")
}, 240_000)

afterAll(async () => {
  await authPool?.end()
  await runtimePool?.end()
  if (database !== undefined) await dropDatabase(database)
}, 60_000)

describe("self sign-up and client rights (D5 task 6)", () => {
  it("creates the user, its Users row and everyUser rights with the code sign-in response at open", async () => {
    const email = "new-open@example.test"
    const signedIn = await signInWithCode(openAuth, email)
    expect(signedIn.status).toBe(200)
    const id = String((signedIn.body?.user as { id: string }).id).toLowerCase()
    expect(await userIds(email)).toEqual([id])
    // Провізія — тригер на вставці запису: рядок «Users» записала та сама
    // транзакція, що й запис Better Auth (той самий `xmin`)
    expect(
      await query<{ same: boolean }>(
        `SELECT u.xmin::text = a.xmin::text AS same
           FROM app.users u JOIN better_auth."user" a ON a.id = u.id
          WHERE u.id = $1`,
        [id]
      )
    ).toEqual([{ same: true }])
    // Права `everyUser` — без призначення: `create` і `read` під claims нового
    // користувача одразу після відповіді входу
    const row = await createClient(id)
    expect((await readClients(id)).map((r) => r.ref)).toEqual([row])
  }, 60_000)

  it("gives a new address neither a record nor a mail at closed", async () => {
    const email = "new-closed@example.test"
    const signedIn = await signInWithCode(closedAuth, email)
    expect({
      status: signedIn.status,
      mails: codesTo(email).length,
      users: (await userIds(email)).length,
    }).toEqual({ status: 400, mails: 0, users: 0 })
  }, 60_000)

  it("keeps the password of a script record after a code sign-in", async () => {
    const email = "script@example.test"
    const password = "script-record-password-0123456789"
    await createDevUser({
      dsn: dsns.SIMETRA_AUTH_DATABASE_URL,
      email,
      name: email,
      origin: ORIGIN,
      secret: SECRET,
      password,
    })
    const [id] = await userIds(email)
    const before = await accountsOf(id!)
    expect(before.map((a) => a.providerId)).toEqual(["credential"])
    expect((await signInWithCode(openAuth, email)).status).toBe(200)
    expect(await accountsOf(id!)).toEqual(before)
    expect((await signInWithPassword(email, password)).status).toBe(200)
  }, 60_000)

  it("strips earlier accounts and sessions of an unverified record on a code sign-in", async () => {
    const email = "unverified-code@example.test"
    const password = "unverified-record-password-0123456789"
    const record = await unverifiedRecord(email, password)
    expect((await accountsOf(record.id)).map((a) => a.providerId)).toEqual([
      "credential",
    ])
    // Пароль неперевіреного запису не входить і до доказу
    expect((await signInWithPassword(email, password)).status).toBe(403)
    const signedIn = await signInWithCode(openAuth, email)
    expect(signedIn.status).toBe(200)
    expect(
      String((signedIn.body?.user as { id: string }).id).toLowerCase()
    ).toBe(record.id.toLowerCase())
    expect(await accountsOf(record.id)).toEqual([])
    // Лишається рівно сесія цього входу: жодна з ранішніх
    const tokens = await sessionTokens(record.id)
    expect(tokens).toEqual([signedIn.body?.token])
    expect(record.tokens).not.toContain(signedIn.body?.token)
    expect(
      await query<{ emailVerified: boolean }>(
        'SELECT "emailVerified" FROM better_auth."user" WHERE id = $1',
        [record.id]
      )
    ).toEqual([{ emailVerified: true }])
    // Пароль, що був до доказу, не успадковано: облікового запису вже немає
    expect((await signInWithPassword(email, password)).status).toBe(401)
  }, 60_000)

  it("creates and links nothing for a provider with emailVerified false", async () => {
    // Шов провайдера справді створює запис, коли адресу підтверджено: відмова
    // нижче — від перевірки адреси, а не від зламаного шва
    const verified = await signInWithProvider(openAuth, {
      sub: "provider-verified",
      email: "oauth-verified@example.test",
      emailVerified: true,
    })
    expect(verified.status).toBe(200)
    expect(await userIds("oauth-verified@example.test")).toHaveLength(1)

    const fresh = await signInWithProvider(openAuth, {
      sub: "provider-unverified",
      email: "oauth-unverified@example.test",
      emailVerified: false,
    })
    // Відмова — від `validateUserInfo` застосунку (І-8)
    expect({
      status: fresh.status,
      code: fresh.body?.code,
      users: (await userIds("oauth-unverified@example.test")).length,
    }).toEqual({ status: 403, code: "email_not_verified", users: 0 })

    const email = "oauth-unverified-record@example.test"
    const record = await unverifiedRecord(
      email,
      "unverified-oauth-password-0123456789"
    )
    const linked = await signInWithProvider(openAuth, {
      sub: "provider-unverified-record",
      email,
      emailVerified: false,
    })
    // Неявне зв'язування вимагає перевіреної адреси і в провайдера, і в запису
    expect(linked).toMatchObject({
      status: 401,
      body: { code: "OAUTH_LINK_ERROR", message: "account not linked" },
    })
    expect((await accountsOf(record.id)).map((a) => a.providerId)).toEqual([
      "credential",
    ])
    expect((await sessionTokens(record.id)).sort()).toEqual(
      [...record.tokens].sort()
    )
  }, 60_000)

  it("does not link a verified provider to an unverified local record with a password", async () => {
    const email = "oauth-verified-to-unverified@example.test"
    const record = await unverifiedRecord(
      email,
      "verified-provider-password-0123456789"
    )
    const linked = await signInWithProvider(openAuth, {
      sub: "provider-verified-to-unverified",
      email,
      emailVerified: true,
    })
    // Перевірена адреса провайдера не підтверджує запис, який зареєстрував
    // хтось інший: зв'язування вимагає перевіреної адреси й у запису
    // (`requireLocalEmailVerified`, типово `true`)
    expect(linked).toMatchObject({
      status: 401,
      body: { code: "OAUTH_LINK_ERROR", message: "account not linked" },
    })
    expect((await accountsOf(record.id)).map((a) => a.providerId)).toEqual([
      "credential",
    ])
    expect(
      await query<{ emailVerified: boolean }>(
        'SELECT "emailVerified" FROM better_auth."user" WHERE id = $1',
        [record.id]
      )
    ).toEqual([{ emailVerified: false }])
    expect((await sessionTokens(record.id)).sort()).toEqual(
      [...record.tokens].sort()
    )
  }, 60_000)

  it("lets two clients read and change only their own rows (І-11)", async () => {
    const a = String(
      (
        (await signInWithCode(openAuth, "client-a@example.test")).body
          ?.user as { id: string }
      ).id
    ).toLowerCase()
    const b = String(
      (
        (await signInWithCode(openAuth, "client-b@example.test")).body
          ?.user as { id: string }
      ).id
    ).toLowerCase()
    const rowsA = [await createClient(a), await createClient(a)].sort()
    const rowsB = [await createClient(b)].sort()
    expect({
      a: (await readClients(a)).map((r) => String(r.ref)).sort(),
      b: (await readClients(b)).map((r) => String(r.ref)).sort(),
    }).toEqual({ a: rowsA, b: rowsB })

    const [own] = await readClients(a)
    await runtime.run(claimsOf(a), {
      action: "update",
      object: CLIENT,
      id: String(own!.ref),
      expectedVersion: Number(own!.version),
      values: { description: "changed by A" },
    })
    // Чужий рядок: та сама дія з claims A не змінює рядок B
    const [foreign] = await readClients(b)
    const refused = await runtime
      .run(claimsOf(a), {
        action: "update",
        object: CLIENT,
        id: String(foreign!.ref),
        expectedVersion: Number(foreign!.version),
        values: { description: "changed by A" },
      })
      .then(
        () => undefined,
        (error: unknown) => (error as { error?: { code?: string } }).error?.code
      )
    expect(refused).toBe("command.forbidden")
    expect(
      await query<{ id: string; description: string }>(
        "SELECT id, description FROM app.client WHERE id = ANY($1) ORDER BY id",
        [[String(own!.ref), String(foreign!.ref)]]
      )
    ).toEqual(
      [
        { id: String(own!.ref), description: "changed by A" },
        { id: String(foreign!.ref), description: `row of ${b}` },
      ].sort((x, y) => (x.id < y.id ? -1 : 1))
    )
  }, 60_000)
})
