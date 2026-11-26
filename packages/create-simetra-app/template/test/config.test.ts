import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appOrigin,
  authSecret,
  authSettings,
  signalsConfig,
} from "../src/server/config"
import { generateKey, mismatchedKey } from "./signal-keys"

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

describe("signalsConfig", () => {
  const url = "wss://signals.test/connection/websocket"

  it("is undefined when neither variable is set", () => {
    vi.stubEnv("SIMETRA_SIGNALS_URL", undefined)
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", undefined)
    expect(signalsConfig()).toBeUndefined()
  })

  it("parses the url and the keys with dates", async () => {
    const key = await generateKey("k1")
    vi.stubEnv("SIMETRA_SIGNALS_URL", url)
    vi.stubEnv(
      "SIMETRA_SIGNALS_KEYS",
      JSON.stringify([{ ...key, retiredAt: "2021-01-01T00:00:00.000Z" }])
    )
    const config = signalsConfig()
    expect(config?.url).toBe(url)
    expect(config?.keys[0]?.kid).toBe("k1")
    expect(config?.keys[0]?.addedAt).toEqual(new Date("2020-01-01T00:00:00Z"))
    expect(config?.keys[0]?.retiredAt).toEqual(new Date("2021-01-01T00:00:00Z"))
  })

  it("refuses the url without the keys and the keys without the url", async () => {
    const key = await generateKey("k1")
    vi.stubEnv("SIMETRA_SIGNALS_URL", url)
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", undefined)
    expect(() => signalsConfig()).toThrow(/together/)
    vi.stubEnv("SIMETRA_SIGNALS_URL", undefined)
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", JSON.stringify([key]))
    expect(() => signalsConfig()).toThrow(/together/)
  })

  it.each(["http://signals.test", "signals.test", "https://a.test"])(
    "refuses a non-websocket url %j",
    async (value) => {
      vi.stubEnv("SIMETRA_SIGNALS_URL", value)
      vi.stubEnv(
        "SIMETRA_SIGNALS_KEYS",
        JSON.stringify([await generateKey("k")])
      )
      expect(() => signalsConfig()).toThrow(/SIMETRA_SIGNALS_URL/)
    }
  )

  it("refuses invalid JSON without echoing the value", () => {
    vi.stubEnv("SIMETRA_SIGNALS_URL", url)
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", '[{"d":"secret-material"')
    expect(() => signalsConfig()).toThrow(/not valid JSON/)
    expect(() => signalsConfig()).not.toThrow(/secret-material/)
  })

  it("refuses malformed keys arrays and key members", async () => {
    const key = await generateKey("k1")
    vi.stubEnv("SIMETRA_SIGNALS_URL", url)
    const cases = [
      "{}",
      "[]",
      JSON.stringify([{ ...key, kid: "" }]),
      JSON.stringify([
        { ...key, privateJwk: { ...key.privateJwk, kty: "RSA" } },
      ]),
      JSON.stringify([
        { ...key, privateJwk: { ...key.privateJwk, crv: "P-256" } },
      ]),
      JSON.stringify([{ ...key, privateJwk: { kty: "OKP", crv: "Ed25519" } }]),
      JSON.stringify([{ ...key, addedAt: "not a date" }]),
      JSON.stringify([{ ...key, retiredAt: 5 }]),
      JSON.stringify([5]),
    ]
    for (const value of cases) {
      vi.stubEnv("SIMETRA_SIGNALS_KEYS", value)
      expect(() => signalsConfig(), value.slice(0, 40)).toThrow(
        /SIMETRA_SIGNALS_KEYS/
      )
    }
  })

  it("refuses x that does not match d without echoing key material", async () => {
    const key = await mismatchedKey("k1")
    vi.stubEnv("SIMETRA_SIGNALS_URL", url)
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", JSON.stringify([key]))
    expect(() => signalsConfig()).toThrow(/"k1".*x must match d/)
    expect(() => signalsConfig()).not.toThrow(key.privateJwk.d)
  })

  it.each(["5", "2020", "Jan 1 2020", "2020-01-01", "2020-01-01T00:00:00"])(
    "refuses a non-ISO date %j",
    async (value) => {
      const key = await generateKey("k1")
      vi.stubEnv("SIMETRA_SIGNALS_URL", url)
      vi.stubEnv(
        "SIMETRA_SIGNALS_KEYS",
        JSON.stringify([{ ...key, addedAt: value }])
      )
      expect(() => signalsConfig()).toThrow(/ISO date/)
    }
  )

  it("refuses a repeated kid", async () => {
    const key = await generateKey("same")
    vi.stubEnv("SIMETRA_SIGNALS_URL", url)
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", JSON.stringify([key, key]))
    expect(() => signalsConfig()).toThrow(/repeated/)
  })
})

describe("authSettings", () => {
  const clear = () => {
    for (const name of [
      "SIMETRA_SIGN_UP",
      "SIMETRA_SIGN_IN_METHODS",
      "SIMETRA_OAUTH_GOOGLE_CLIENT_ID",
      "SIMETRA_OAUTH_GOOGLE_CLIENT_SECRET",
      "SIMETRA_OAUTH_GITHUB_CLIENT_ID",
      "SIMETRA_OAUTH_GITHUB_CLIENT_SECRET",
    ]) {
      vi.stubEnv(name, undefined)
    }
  }

  it("defaults to a closed sign-up and password only", () => {
    clear()
    expect(authSettings()).toEqual({
      signUp: "closed",
      password: true,
      emailCode: false,
      providers: [],
    })
  })

  it("reads an empty SIMETRA_SIGN_UP as closed", () => {
    clear()
    vi.stubEnv("SIMETRA_SIGN_UP", "")
    expect(authSettings().signUp).toBe("closed")
  })

  it("reads sign-up, methods and provider credentials", () => {
    clear()
    vi.stubEnv("SIMETRA_SIGN_UP", "open")
    vi.stubEnv("SIMETRA_SIGN_IN_METHODS", "email-code, github")
    vi.stubEnv("SIMETRA_OAUTH_GITHUB_CLIENT_ID", "gh-id")
    vi.stubEnv("SIMETRA_OAUTH_GITHUB_CLIENT_SECRET", "gh-secret")
    expect(authSettings()).toEqual({
      signUp: "open",
      password: false,
      emailCode: true,
      providers: [
        { id: "github", clientId: "gh-id", clientSecret: "gh-secret" },
      ],
    })
  })

  it.each([
    ["SIMETRA_SIGN_UP", "maybe", /SIMETRA_SIGN_UP/],
    ["SIMETRA_SIGN_IN_METHODS", "password,facebook", /SIMETRA_SIGN_IN_METHODS/],
    ["SIMETRA_SIGN_IN_METHODS", "password,", /SIMETRA_SIGN_IN_METHODS/],
    ["SIMETRA_SIGN_IN_METHODS", ",", /SIMETRA_SIGN_IN_METHODS/],
    // Типовий пароль дає лише відсутня змінна: порожній перелік — відмова
    // старту (П4-D §4.1), а не мовчки ввімкнений пароль
    ["SIMETRA_SIGN_IN_METHODS", "", /SIMETRA_SIGN_IN_METHODS/],
    ["SIMETRA_SIGN_IN_METHODS", "  ", /SIMETRA_SIGN_IN_METHODS/],
    ["SIMETRA_SIGN_IN_METHODS", " , ", /SIMETRA_SIGN_IN_METHODS/],
  ])("refuses %s=%j", (name, value, pattern) => {
    clear()
    vi.stubEnv(name, value)
    expect(() => authSettings()).toThrow(pattern)
  })

  it.each([
    "SIMETRA_OAUTH_GOOGLE_CLIENT_ID",
    "SIMETRA_OAUTH_GOOGLE_CLIENT_SECRET",
  ])(
    "refuses a provider without %s and does not leak the other value",
    (missing) => {
      clear()
      vi.stubEnv("SIMETRA_SIGN_IN_METHODS", "google")
      vi.stubEnv("SIMETRA_OAUTH_GOOGLE_CLIENT_ID", "visible-id")
      vi.stubEnv("SIMETRA_OAUTH_GOOGLE_CLIENT_SECRET", "top-secret")
      vi.stubEnv(missing, undefined)
      let message = ""
      try {
        authSettings()
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toContain(missing)
      expect(message).not.toContain("top-secret")
    }
  )

  it("does not demand credentials of a provider that is not enabled", () => {
    clear()
    vi.stubEnv("SIMETRA_SIGN_IN_METHODS", "password")
    expect(() => authSettings()).not.toThrow()
  })
})
