import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { generateKey, mismatchedKey } from "./signal-keys"

vi.mock("@tanstack/react-start/server", () => ({
  createServerEntry: (entry: unknown) => entry,
  createStartHandler: () => () => new Response("unused"),
  defaultStreamHandler: () => undefined,
}))
vi.mock("../src/server/runtime", () => ({ serverHash: "hash" }))

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("SIMETRA_APP_ORIGIN", "https://app.test")
  vi.stubEnv("BETTER_AUTH_SECRET", "s3cret")
  vi.stubEnv("NODE_ENV", "production")
})
afterEach(() => vi.unstubAllEnvs())

describe("server entry startup (spec 4.1)", () => {
  it("imports with a valid environment", async () => {
    await expect(import("../src/server")).resolves.toBeDefined()
  })

  it("refuses to start on a non-canonical SIMETRA_APP_ORIGIN", async () => {
    vi.stubEnv("SIMETRA_APP_ORIGIN", "https://app.test/")
    await expect(import("../src/server")).rejects.toThrow(/SIMETRA_APP_ORIGIN/)
  })

  it("refuses to start without SIMETRA_APP_ORIGIN", async () => {
    vi.stubEnv("SIMETRA_APP_ORIGIN", undefined)
    await expect(import("../src/server")).rejects.toThrow(/SIMETRA_APP_ORIGIN/)
  })

  it("refuses to start in production without BETTER_AUTH_SECRET", async () => {
    vi.stubEnv("BETTER_AUTH_SECRET", undefined)
    await expect(import("../src/server")).rejects.toThrow(/BETTER_AUTH_SECRET/)
  })

  it("refuses to start with the signals url but without the keys", async () => {
    vi.stubEnv("SIMETRA_SIGNALS_URL", "wss://signals.test/connection/websocket")
    await expect(import("../src/server")).rejects.toThrow(/SIMETRA_SIGNALS/)
  })

  it("refuses to start with an invalid signing key", async () => {
    vi.stubEnv("SIMETRA_SIGNALS_URL", "wss://signals.test/connection/websocket")
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", "[{}]")
    await expect(import("../src/server")).rejects.toThrow(
      /SIMETRA_SIGNALS_KEYS/
    )
  })

  it("refuses to start when x does not match d", async () => {
    vi.stubEnv("SIMETRA_SIGNALS_URL", "wss://signals.test/connection/websocket")
    vi.stubEnv(
      "SIMETRA_SIGNALS_KEYS",
      JSON.stringify([await mismatchedKey("k")])
    )
    await expect(import("../src/server")).rejects.toThrow(/x must match d/)
  })

  it("imports with signals fully configured", async () => {
    vi.stubEnv("SIMETRA_SIGNALS_URL", "wss://signals.test/connection/websocket")
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", JSON.stringify([await generateKey("k")]))
    await expect(import("../src/server")).resolves.toBeDefined()
  })
})
