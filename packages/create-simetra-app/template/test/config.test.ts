import { afterEach, describe, expect, it, vi } from "vitest"
import { appOrigin, authSecret, signalsConfig } from "../src/server/config"
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
