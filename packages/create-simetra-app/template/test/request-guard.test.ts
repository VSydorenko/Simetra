import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const verifySession = vi.hoisted(() => vi.fn())
vi.mock("../src/server/auth", () => ({ verifySession }))

import { guardRequest } from "../src/server/request-guard"

const APP = "https://app.test"

function post(headers: Record<string, string>) {
  return new Request(`${APP}/x`, { method: "POST", headers })
}

beforeEach(() => {
  vi.stubEnv("SIMETRA_APP_ORIGIN", APP)
  verifySession
    .mockReset()
    .mockResolvedValue({ sub: "u1", is_anonymous: false })
})
afterEach(() => vi.unstubAllEnvs())

describe("guardRequest", () => {
  it("refuses a foreign origin with 403 before any session read", async () => {
    const result = await guardRequest(post({ origin: "https://evil.test" }))
    expect(result).toMatchObject({ ok: false, reason: "origin" })
    if (result.ok) throw new Error("unreachable")
    expect(result.response.status).toBe(403)
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("refuses without a session with 401", async () => {
    verifySession.mockResolvedValue(null)
    const result = await guardRequest(post({ origin: APP }))
    expect(result).toMatchObject({ ok: false, reason: "unauthenticated" })
    if (result.ok) throw new Error("unreachable")
    expect(result.response.status).toBe(401)
  })

  it("refuses an anonymous session with 401", async () => {
    verifySession.mockResolvedValue({ sub: "a", is_anonymous: true })
    const result = await guardRequest(post({ origin: APP }))
    expect(result).toMatchObject({ ok: false, reason: "unauthenticated" })
  })

  it("returns the verified claims and origin facts", async () => {
    const result = await guardRequest(post({ origin: APP }))
    expect(result).toMatchObject({
      ok: true,
      claims: { sub: "u1" },
      origin: { origin: APP, expectedOrigin: APP },
    })
  })
})
