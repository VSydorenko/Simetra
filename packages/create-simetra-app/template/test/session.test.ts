import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const verifySession = vi.hoisted(() => vi.fn())
const request = vi.hoisted(() => ({
  current: undefined as undefined | Request,
}))

// Список, а не `vi.fn`: `restoreAllMocks` стирає лічильник викликів, а обгортка
// створюється один раз при імпорті
const wrap = vi.hoisted(() => {
  const wrapped: unknown[] = []
  const serverOnly = <F extends (...args: never[]) => unknown>(fn: F): F => {
    wrapped.push(fn)
    return fn
  }
  return { wrapped, serverOnly }
})

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: wrap.serverOnly,
}))
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => request.current,
}))
vi.mock("../src/server/auth", () => ({ verifySession }))

import { sessionClaims } from "../src/server/session"

const APP = "https://app.test"
const USER = { sub: "u1", is_anonymous: false }

const page = (headers: Record<string, string> = {}) => {
  request.current = new Request(`${APP}/clients`, { headers })
}

beforeEach(() => {
  verifySession.mockReset().mockResolvedValue(USER)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("session claims (SSR)", () => {
  it("reads the session of the current request without the origin rule", async () => {
    page({ "sec-fetch-site": "cross-site", origin: "https://evil.test" })
    expect(await sessionClaims()).toEqual(USER)
    expect(verifySession).toHaveBeenCalledTimes(1)
  })

  it("is wrapped by createServerOnlyFn", () => {
    expect(wrap.wrapped).toContain(sessionClaims)
  })

  it("keeps the anonymous and error rules", async () => {
    page()
    verifySession.mockResolvedValue({ sub: "u1", is_anonymous: true })
    expect(await sessionClaims()).toBeNull()
    verifySession.mockRejectedValue(new Error("db.internal"))
    expect(await sessionClaims()).toBeNull()
    expect(console.error).toHaveBeenCalled()
  })
})
