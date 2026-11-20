import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { generateKey, mismatchedKey } from "./signal-keys"

// Порт токенів кешується на модуль: кожен тест бере свіжий екземпляр
let startupPlugin: typeof import("../src/server/startup-plugin").default

beforeEach(async () => {
  vi.resetModules()
  startupPlugin = (await import("../src/server/startup-plugin")).default
  vi.stubEnv("SIMETRA_APP_ORIGIN", "https://app.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "s3cret")
  vi.stubEnv("NODE_ENV", "production")
})
afterEach(() => vi.unstubAllEnvs())

// Плагін Nitro виконується на старті сервера: виняток зупиняє процес (§4.1)
describe("nitro startup plugin", () => {
  it("passes with a valid environment", () => {
    expect(() => startupPlugin()).not.toThrow()
  })

  it("throws on a non-canonical SIMETRA_APP_ORIGIN", () => {
    vi.stubEnv("SIMETRA_APP_ORIGIN", "https://app.test/x")
    expect(() => startupPlugin()).toThrow(/SIMETRA_APP_ORIGIN/)
  })

  it("throws without SIMETRA_APP_ORIGIN", () => {
    vi.stubEnv("SIMETRA_APP_ORIGIN", undefined)
    expect(() => startupPlugin()).toThrow(/SIMETRA_APP_ORIGIN/)
  })

  it("throws in production without BETTER_AUTH_SECRET", () => {
    vi.stubEnv("BETTER_AUTH_SECRET", undefined)
    expect(() => startupPlugin()).toThrow(/BETTER_AUTH_SECRET/)
  })

  describe("signals", () => {
    const url = "wss://signals.test/connection/websocket"

    it("passes with a valid key pair", async () => {
      vi.stubEnv("SIMETRA_SIGNALS_URL", url)
      vi.stubEnv(
        "SIMETRA_SIGNALS_KEYS",
        JSON.stringify([await generateKey("k1")])
      )
      expect(startupPlugin()).toBeUndefined()
    })

    it("throws on the url without the keys", () => {
      vi.stubEnv("SIMETRA_SIGNALS_URL", url)
      expect(() => startupPlugin()).toThrow(/together/)
    })

    it("throws on invalid JSON", () => {
      vi.stubEnv("SIMETRA_SIGNALS_URL", url)
      vi.stubEnv("SIMETRA_SIGNALS_KEYS", "{")
      expect(() => startupPlugin()).toThrow(/SIMETRA_SIGNALS_KEYS/)
    })

    it("throws synchronously when x does not match d", async () => {
      vi.stubEnv("SIMETRA_SIGNALS_URL", url)
      vi.stubEnv(
        "SIMETRA_SIGNALS_KEYS",
        JSON.stringify([await mismatchedKey("k1")])
      )
      expect(() => startupPlugin()).toThrow(/x must match d/)
    })

    it("warns, but starts, while a retired key has no mature successor", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      const old = {
        ...(await generateKey("old")),
        retiredAt: new Date(Date.now() - 60_000).toISOString(),
      }
      const fresh = await generateKey("new", new Date().toISOString())
      vi.stubEnv("SIMETRA_SIGNALS_URL", url)
      vi.stubEnv("SIMETRA_SIGNALS_KEYS", JSON.stringify([old, fresh]))
      expect(startupPlugin()).toBeUndefined()
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("signals.no-mature-key")
      )
      warn.mockRestore()
    })
  })

  it("is registered in the nitro config", () => {
    const config = readFileSync(
      new URL("../vite.config.ts", import.meta.url),
      "utf8"
    )
    expect(config).toContain('new URL("./src/server/startup-plugin.ts"')
  })
})
