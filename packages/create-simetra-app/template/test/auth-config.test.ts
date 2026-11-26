import { createHash } from "node:crypto"
import { betterAuth } from "better-auth"
import type { Pool } from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { authPoolConfig } from "../src/server/auth-db"
import {
  authOptions,
  createVerifySession,
  OPEN_AUTH_PATHS,
  PARAM_AUTH_PATHS,
} from "../src/server/auth"
import { OAUTH_PROVIDERS, type AuthSettings } from "../src/server/config"
import { defer } from "../src/server/defer"
import type { MailMessage, MailTransport } from "../src/server/mail"

afterEach(() => vi.unstubAllEnvs())

const pool = {} as Pool
const ORIGIN = "https://app.test"
const PASSWORD_ONLY: AuthSettings = {
  signUp: "closed",
  password: true,
  emailCode: false,
  providers: [],
}
const sent: MailMessage[] = []
const mail: MailTransport = {
  send: (message) => {
    sent.push(message)
    return Promise.resolve()
  },
}
/** Усі способи шаблону: пароль, код і кожен провайдер сталої. */
const everyMethod = (signUp: AuthSettings["signUp"]): AuthSettings => ({
  signUp,
  password: true,
  emailCode: true,
  providers: OAUTH_PROVIDERS.map((id) => ({
    id,
    clientId: `${id}-client-id`,
    clientSecret: `${id}-client-secret`,
  })),
})
const options = authOptions(pool, ORIGIN, "secret", PASSWORD_ONLY, mail)

function emailCodeOptions(
  signUp: AuthSettings["signUp"],
  secret: string | undefined
) {
  const plugin = authOptions(
    pool,
    ORIGIN,
    secret,
    everyMethod(signUp),
    mail
  ).plugins.find((item) => item.id === "email-otp")
  if (plugin === undefined || !("options" in plugin)) {
    throw new Error("no email-otp plugin")
  }
  return plugin.options as {
    disableSignUp?: boolean
    allowedAttempts?: number
    expiresIn?: number
    rateLimit?: unknown
    storeOTP?: unknown
    sendVerificationOTP: (data: {
      email: string
      otp: string
      type: "sign-in"
    }) => Promise<void>
  }
}

function storedHash(secret: string | undefined) {
  const store = emailCodeOptions("open", secret).storeOTP
  if (typeof store !== "object" || store === null || !("hash" in store)) {
    throw new Error("storeOTP has no hash")
  }
  return store.hash as (otp: string) => Promise<string>
}

describe("Better Auth config (spec P4-D 4.3)", () => {
  it.each(["closed", "open"] as const)(
    "password never signs up and needs a verified email at signUp %s",
    (signUp) => {
      expect(
        authOptions(pool, ORIGIN, "secret", everyMethod(signUp), mail)
          .emailAndPassword
      ).toEqual({
        enabled: true,
        disableSignUp: true,
        requireEmailVerification: true,
      })
    }
  )

  it("turns password sign-in off when the method is not listed", () => {
    const settings = { ...PASSWORD_ONLY, password: false, emailCode: true }
    expect(
      authOptions(pool, ORIGIN, "secret", settings, mail).emailAndPassword
        .enabled
    ).toBe(false)
  })

  it("sets no verification email, so an unverified record cannot sign in", () => {
    expect(
      authOptions(pool, ORIGIN, "secret", everyMethod("open"), mail)
    ).not.toHaveProperty("emailVerification")
  })

  it("adds the email-otp plugin only with email-code", () => {
    expect(options.plugins.map((plugin) => plugin.id)).not.toContain(
      "email-otp"
    )
    expect(emailCodeOptions("closed", "secret")).toBeDefined()
  })

  it.each([
    ["closed", true],
    ["open", false],
  ] as const)(
    "email-otp at signUp %s: disableSignUp %s, 5 attempts, 600 s, 3 a minute",
    (signUp, disableSignUp) => {
      expect(emailCodeOptions(signUp, "secret")).toMatchObject({
        disableSignUp,
        allowedAttempts: 5,
        expiresIn: 600,
        rateLimit: { window: 60, max: 3 },
        storeOTP: { hash: expect.any(Function) },
      })
    }
  )

  it("stores a code as a keyed hash, not the code or its plain SHA-256", async () => {
    const hash = storedHash("secret")
    const value = await hash("123456")
    expect(value).toBe(await storedHash("secret")("123456"))
    expect(value).not.toBe("123456")
    expect(value).not.toContain("123456")
    for (const encoding of ["hex", "base64", "base64url"] as const) {
      expect(value).not.toBe(
        createHash("sha256").update("123456").digest(encoding)
      )
    }
    expect(value).not.toBe(await hash("123457"))
    expect(value).not.toBe(await storedHash("another secret")("123456"))
  })

  it("keys the hash with a fixed dev constant when there is no secret", async () => {
    const dev = await storedHash(undefined)("123456")
    expect(dev).toBe(await storedHash(undefined)("123456"))
    expect(dev).not.toBe(await storedHash("secret")("123456"))
  })

  it("sends the code through the mail transport", async () => {
    sent.length = 0
    await emailCodeOptions("closed", "secret").sendVerificationOTP({
      email: "a@b.test",
      otp: "123456",
      type: "sign-in",
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.to).toBe("a@b.test")
    expect(sent[0]?.text).toContain("123456")
  })

  it("refuses email-code without a mail transport", () => {
    expect(() =>
      authOptions(pool, ORIGIN, "secret", everyMethod("open"), undefined)
    ).toThrow(/mail transport/)
  })

  it.each(
    OAUTH_PROVIDERS.flatMap((id) => [
      [id, "closed", true] as const,
      [id, "open", false] as const,
    ])
  )(
    "provider %s at signUp %s: disableSignUp %s in the provider options",
    (id, signUp, disableSignUp) => {
      expect(
        authOptions(pool, ORIGIN, "secret", everyMethod(signUp), mail)
          .socialProviders[id]
      ).toEqual({
        clientId: `${id}-client-id`,
        clientSecret: `${id}-client-secret`,
        disableSignUp,
      })
    }
  )

  it("configures only the listed providers", () => {
    expect(options.socialProviders).toEqual({})
  })

  it("has no trusted providers and no account linking settings", () => {
    const all = authOptions(pool, ORIGIN, "secret", everyMethod("open"), mail)
    expect(all).not.toHaveProperty("account")
    expect(JSON.stringify(all)).not.toContain("trustedProviders")
  })

  it.each([
    [true, undefined],
    [false, { error: "email_not_verified" }],
    [undefined, { error: "email_not_verified" }],
  ])(
    "validateUserInfo on create with emailVerified %s gives %j",
    async (emailVerified, expected) => {
      for (const method of ["oauth", "email-otp", "anonymous"]) {
        expect(
          await options.user.validateUserInfo({
            user: { emailVerified },
            source: {
              action: "create-user",
              method,
              oauth: { providerId: "google" },
            },
          })
        ).toEqual(expected)
      }
    }
  )

  it("validateUserInfo leaves sign-in and account linking to the library", async () => {
    for (const action of ["sign-in", "link-account"] as const) {
      expect(
        await options.user.validateUserInfo({
          user: { emailVerified: false },
          source: {
            action,
            method: "oauth",
            oauth: { providerId: "google" },
          },
        })
      ).toBeUndefined()
    }
  })

  it("runs background tasks through the template defer", () => {
    expect(options.advanced.backgroundTasks.handler).toBe(defer)
  })

  it("enables the anonymous plugin and closes anonymous sign-in", () => {
    expect(options.plugins.map((plugin) => plugin.id)).toContain("anonymous")
    expect(options.disabledPaths).toContain("/sign-in/anonymous")
  })

  it("has no cookie cache", () => {
    expect(options).not.toHaveProperty("session.cookieCache")
    expect(JSON.stringify(options)).not.toContain("cookieCache")
  })

  it("takes baseURL, trustedOrigins and secret from the arguments", () => {
    expect(options.baseURL).toBe(ORIGIN)
    expect(options.trustedOrigins).toEqual([ORIGIN])
    expect(options.secret).toBe("secret")
  })

  it("rate-limits in the database with a rule for /sign-in/email", () => {
    expect(options.rateLimit.enabled).toBe(true)
    expect(options.rateLimit.storage).toBe("database")
    expect(options.rateLimit.customRules).toHaveProperty("/sign-in/email")
  })

  it("uses the pool as is, with no schemaName, and uuid ids", () => {
    expect(options.database).toBe(pool)
    expect(options.database).not.toHaveProperty("schemaName")
    expect(options.advanced.database).toEqual({ generateId: "uuid" })
  })

  it("reads the client address from the header the entry sets", () => {
    expect(options.advanced.ipAddress.ipAddressHeaders).toEqual([
      "x-simetra-client-ip",
    ])
  })

  it("sets HttpOnly, SameSite=Lax and Secure for https only", () => {
    expect(options.advanced.defaultCookieAttributes).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
    })
    const http = authOptions(
      pool,
      "http://127.0.0.1:3000",
      undefined,
      PASSWORD_ONLY,
      mail
    )
    expect(http.advanced.defaultCookieAttributes.secure).toBe(false)
    expect(http.advanced.defaultCookieAttributes.sameSite).toBe("lax")
    expect(http.advanced.defaultCookieAttributes.httpOnly).toBe(true)
  })
})

// Закріплені літерали (спека §5.5): новий відкритий шлях — лише разом зі
// зміною цього тесту
const OPEN = [
  "/sign-in/email",
  "/sign-out",
  "/get-session",
  "/email-otp/send-verification-otp",
  "/sign-in/email-otp",
  "/sign-in/social",
  "/ok",
  "/error",
]
const PARAM = ["/callback/:id", "/reset-password/:token"]

/** Екземпляр застосунку на адаптері в пам'яті: перелік шляхів від бази не залежить. */
function memoryAuth(settings: AuthSettings, withDisabledPaths = true) {
  const appOptions = authOptions(pool, ORIGIN, "secret", settings, mail)
  return betterAuth({
    ...appOptions,
    database: undefined,
    disabledPaths: withDisabledPaths ? appOptions.disabledPaths : undefined,
  })
}

/** Маршрути пробного екземпляра тесту, кожен зі своїм першим методом. */
function probeRoutes(settings: AuthSettings) {
  return Object.values(memoryAuth(settings, false).api).flatMap(
    (endpoint): { path: string; method: string }[] => {
      const method = endpoint.options?.method
      if (typeof endpoint.path !== "string" || method === undefined) return []
      return [
        {
          path: endpoint.path,
          method: Array.isArray(method) ? method[0] : method,
        },
      ]
    }
  )
}

const closedRoutes = (settings: AuthSettings) =>
  probeRoutes(settings).filter(
    ({ path }) => !OPEN.includes(path) && !PARAM.includes(path)
  )

// Метод — свій для кожного шляху: чужий метод теж дає 404 і сховав би
// відкритий шлях
function request(path: string, method: string) {
  return new Request(`${ORIGIN}/api/auth${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "x-simetra-client-ip": "203.0.113.7",
    },
    body: method === "GET" ? undefined : "{}",
  })
}

describe("auth path allowlist (Р-D5-7)", () => {
  it("pins the open and the parameter paths", () => {
    expect([...OPEN_AUTH_PATHS]).toEqual(OPEN)
    expect([...PARAM_AUTH_PATHS]).toEqual(PARAM)
  })

  it("knows every parameter path of the probe instance", () => {
    const withParam = probeRoutes(everyMethod("open"))
      .map(({ path }) => path)
      .filter((path) => path.includes(":"))
    expect(new Set(withParam)).toEqual(new Set(PARAM))
  })

  it.each([
    ["password only", PASSWORD_ONLY],
    ["every method", everyMethod("open")],
  ])("closes every other probe path (%s)", (_, settings) => {
    expect(
      [
        ...authOptions(pool, ORIGIN, "secret", settings, mail).disabledPaths,
      ].sort()
    ).toEqual(
      closedRoutes(settings)
        .map(({ path }) => path)
        .sort()
    )
  })

  it.each(closedRoutes(everyMethod("open")))(
    "$method $path answers 404 through the handler",
    async ({ path, method }) => {
      const response = await memoryAuth(everyMethod("open")).handler(
        request(path, method)
      )
      expect(response.status).toBe(404)
    }
  )

  it.each(
    probeRoutes(everyMethod("open")).filter(({ path }) => OPEN.includes(path))
  )("$method $path stays reachable", async ({ path, method }) => {
    const response = await memoryAuth(everyMethod("open")).handler(
      request(path, method)
    )
    expect(response.status).not.toBe(404)
  })

  it("refuses an anonymous record through the auth API (validateUserInfo)", async () => {
    await expect(
      memoryAuth(PASSWORD_ONLY).api.signInAnonymous()
    ).rejects.toMatchObject({ body: { code: "email_not_verified" } })
  })
})

describe("auth pool", () => {
  it("sets search_path=better_auth through the connection option", () => {
    vi.stubEnv("SIMETRA_AUTH_DATABASE_URL", "postgres://u@h/db")
    expect(authPoolConfig()).toEqual({
      connectionString: "postgres://u@h/db",
      options: "-c search_path=better_auth",
    })
  })

  it("refuses to build without the DSN", () => {
    vi.stubEnv("SIMETRA_AUTH_DATABASE_URL", undefined)
    expect(() => authPoolConfig()).toThrow(/SIMETRA_AUTH_DATABASE_URL/)
  })
})

describe("verifySession", () => {
  const headers = new Headers({ cookie: "a=b" })
  const verify = (session: unknown) => {
    const getSession = vi.fn(async () => session as never)
    return { getSession, result: createVerifySession(getSession)(headers) }
  }

  it("returns null without a session", async () => {
    const { getSession, result } = verify(null)
    expect(await result).toBeNull()
    expect(getSession).toHaveBeenCalledWith({ headers })
  })

  it.each([
    ["false", { isAnonymous: false }, false],
    ["absent", {}, false],
    ["null", { isAnonymous: null }, false],
    ["true", { isAnonymous: true }, true],
  ])(
    "is_anonymous is a boolean when isAnonymous is %s",
    async (_, extra, expected) => {
      const { result } = verify({ user: { id: "x", ...extra } })
      const claims = await result
      expect(claims?.is_anonymous).toBe(expected)
    }
  )

  it("lowercases sub", async () => {
    const { result } = verify({
      user: { id: "0A1B2C3D-0000-4000-8000-ABCDEFABCDEF" },
    })
    expect((await result)?.sub).toBe("0a1b2c3d-0000-4000-8000-abcdefabcdef")
  })
})
