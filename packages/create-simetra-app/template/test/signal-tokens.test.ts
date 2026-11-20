import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { generateKey, mismatchedKey } from "./signal-keys"

const created = vi.hoisted(() => ({ calls: 0 }))

beforeEach(() => {
  created.calls = 0
  vi.resetModules()
  vi.stubEnv("SIMETRA_APP_ORIGIN", "https://app.test")
})
afterEach(() => vi.unstubAllEnvs())

const url = "wss://signals.test/connection/websocket"

describe("getSignalTokens", () => {
  it("is undefined without signals configured", async () => {
    const { getSignalTokens } = await import("../src/server/signal-tokens")
    await expect(getSignalTokens()).resolves.toBeUndefined()
  })

  it("is one port per process, signing for the project audience and the app origin", async () => {
    const key = await generateKey("k1")
    vi.stubEnv("SIMETRA_SIGNALS_URL", url)
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", JSON.stringify([key]))
    const { getSignalTokens } = await import("../src/server/signal-tokens")
    const first = await getSignalTokens()
    expect(await getSignalTokens()).toBe(first)
    // JWKS несе лише публічні члени ключа з оточення
    expect(first?.jwks().keys).toEqual([
      {
        kty: "OKP",
        crv: "Ed25519",
        x: key.privateJwk.x,
        kid: "k1",
        alg: "EdDSA",
        use: "sig",
      },
    ])
  })

  it("passes audience and issuer to the port", async () => {
    vi.doMock("simetra/server/signals", () => ({
      createCentrifugoTokens: async (options: unknown) => {
        created.calls += 1
        return { options }
      },
    }))
    vi.stubEnv("SIMETRA_SIGNALS_URL", url)
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", JSON.stringify([await generateKey("k")]))
    const { getSignalTokens } = await import("../src/server/signal-tokens")
    const port = (await getSignalTokens()) as unknown as {
      options: { audience: string; issuer: string }
    }
    expect(port.options.audience).toBe("centrifugo:TemplateApp")
    expect(port.options.issuer).toBe("https://app.test")
    vi.doUnmock("simetra/server/signals")
  })

  it("does not cache a failed start", async () => {
    vi.stubEnv("SIMETRA_SIGNALS_URL", url)
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", JSON.stringify([await generateKey("k")]))
    vi.stubEnv("SIMETRA_APP_ORIGIN", undefined)
    const { getSignalTokens } = await import("../src/server/signal-tokens")
    await expect(getSignalTokens()).rejects.toThrow(/SIMETRA_APP_ORIGIN/)
    vi.stubEnv("SIMETRA_APP_ORIGIN", "https://app.test")
    await expect(getSignalTokens()).resolves.toBeDefined()
  })

  // Друга лінія захисту: вона важить, коли пара ключів відома лише порту
  it("rejects a mismatched pair in the port itself", async () => {
    const { createCentrifugoTokens } = await import("simetra/server/signals")
    await expect(
      createCentrifugoTokens({
        keys: [
          {
            kid: "k",
            privateJwk: (await mismatchedKey("k")).privateJwk,
            addedAt: new Date(0),
          },
        ],
        audience: "centrifugo:x",
        issuer: "https://app.test",
      })
    ).rejects.toMatchObject({ code: "signals.invalid-key" })
  })
})
