import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
})
