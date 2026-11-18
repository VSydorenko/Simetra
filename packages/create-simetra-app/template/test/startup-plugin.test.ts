import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import startupPlugin from "../src/server/startup-plugin"

beforeEach(() => {
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

  it("is registered in the nitro config", () => {
    const config = readFileSync(
      new URL("../vite.config.ts", import.meta.url),
      "utf8"
    )
    expect(config).toContain('new URL("./src/server/startup-plugin.ts"')
  })
})
