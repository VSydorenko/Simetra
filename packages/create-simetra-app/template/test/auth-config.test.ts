import type { Pool } from "pg"
import { afterEach, describe, expect, it, vi } from "vitest"
import { authPoolConfig } from "../src/server/auth-db"
import { authOptions, createVerifySession } from "../src/server/auth"

afterEach(() => vi.unstubAllEnvs())

const pool = {} as Pool
const ORIGIN = "https://app.test"
const options = authOptions(pool, ORIGIN, "secret")

describe("Better Auth config (spec P4-D 4.3)", () => {
  it("keeps sign-up disabled and email sign-in on", () => {
    expect(options.emailAndPassword).toEqual({
      enabled: true,
      disableSignUp: true,
    })
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
    const http = authOptions(pool, "http://127.0.0.1:3000", undefined)
    expect(http.advanced.defaultCookieAttributes.secure).toBe(false)
    expect(http.advanced.defaultCookieAttributes.sameSite).toBe("lax")
    expect(http.advanced.defaultCookieAttributes.httpOnly).toBe(true)
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
