import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const verifySession = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/react-start", () => {
  const chain = { handler: () => () => undefined }
  return { createServerFn: () => chain }
})
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }))
vi.mock("../src/server/auth", () => ({ verifySession }))

import { readSessionClaims } from "../src/server/session-fn"

const APP = "https://app.test"
const USER = { sub: "u1", is_anonymous: false }

const rpc = (headers: Record<string, string> = {}) =>
  new Request(`${APP}/_serverFn/abc`, { headers })

beforeEach(() => {
  vi.stubEnv("SIMETRA_APP_ORIGIN", APP)
  vi.stubEnv("TSS_SERVER_FN_BASE", "/_serverFn/")
  verifySession.mockReset().mockResolvedValue(USER)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("session function", () => {
  it("returns the claims of a signed-in user on the HTTP path", async () => {
    expect(await readSessionClaims(rpc({ origin: APP }))).toEqual(USER)
  })

  it("returns null without calling getSession for a foreign Origin", async () => {
    expect(
      await readSessionClaims(rpc({ origin: "https://evil.test" }))
    ).toBeNull()
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("returns null without calling getSession for Sec-Fetch-Site: cross-site", async () => {
    expect(
      await readSessionClaims(
        rpc({ origin: APP, "sec-fetch-site": "cross-site" })
      )
    ).toBeNull()
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("treats an unknown Server Function base as the HTTP path", async () => {
    vi.stubEnv("TSS_SERVER_FN_BASE", undefined)
    expect(
      await readSessionClaims(rpc({ "sec-fetch-site": "cross-site" }))
    ).toBeNull()
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("does not apply the HTTP origin rule to the SSR navigation", async () => {
    // Перехід за посиланням з іншого сайту — законна навігація, не RPC
    const page = new Request(`${APP}/clients`, {
      headers: { "sec-fetch-site": "cross-site" },
    })
    expect(await readSessionClaims(page)).toEqual(USER)
  })

  it("returns null for no session and for an anonymous one", async () => {
    verifySession.mockResolvedValue(null)
    expect(await readSessionClaims(rpc({ origin: APP }))).toBeNull()
    verifySession.mockResolvedValue({ sub: "u1", is_anonymous: true })
    expect(await readSessionClaims(rpc({ origin: APP }))).toBeNull()
  })

  it("returns null with no error text when the session step fails", async () => {
    verifySession.mockRejectedValue(
      new Error(
        "password authentication failed for role simetra_auth host db.internal"
      )
    )
    const result = await readSessionClaims(rpc({ origin: APP }))
    expect(result).toBeNull()
    expect(JSON.stringify(result)).not.toContain("db.internal")
    expect(console.error).toHaveBeenCalled()
  })

  it("returns null when the origin is not configured", async () => {
    vi.stubEnv("SIMETRA_APP_ORIGIN", undefined)
    expect(await readSessionClaims(rpc({ origin: APP }))).toBeNull()
  })
})
