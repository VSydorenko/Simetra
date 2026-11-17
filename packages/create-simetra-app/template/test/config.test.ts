import { afterEach, describe, expect, it, vi } from "vitest"
import { appOrigin, authSecret } from "../src/server/config"

afterEach(() => vi.unstubAllEnvs())

describe("appOrigin", () => {
  it("returns a canonical origin as is", () => {
    vi.stubEnv("SIMETRA_APP_ORIGIN", "https://a.test")
    expect(appOrigin()).toBe("https://a.test")
    vi.stubEnv("SIMETRA_APP_ORIGIN", "http://127.0.0.1:3000")
    expect(appOrigin()).toBe("http://127.0.0.1:3000")
  })

  it.each(["https://a.test/", "https://a.test/x", "null", "a.test", ""])(
    "refuses to start on %j",
    (value) => {
      vi.stubEnv("SIMETRA_APP_ORIGIN", value)
      expect(() => appOrigin()).toThrow(/SIMETRA_APP_ORIGIN/)
    }
  )

  it("refuses to start without the variable", () => {
    vi.stubEnv("SIMETRA_APP_ORIGIN", undefined)
    expect(() => appOrigin()).toThrow(/SIMETRA_APP_ORIGIN/)
  })
})

describe("authSecret", () => {
  it("throws in production without a secret", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("BETTER_AUTH_SECRET", undefined)
    expect(() => authSecret()).toThrow(/BETTER_AUTH_SECRET/)
    vi.stubEnv("BETTER_AUTH_SECRET", "")
    expect(() => authSecret()).toThrow(/BETTER_AUTH_SECRET/)
  })

  it("returns the secret in production", () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("BETTER_AUTH_SECRET", "s3cret")
    expect(authSecret()).toBe("s3cret")
  })

  it("allows no secret outside production", () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("BETTER_AUTH_SECRET", undefined)
    expect(authSecret()).toBeUndefined()
  })
})
