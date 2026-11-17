import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const verifySession = vi.hoisted(() => vi.fn())

const captured = vi.hoisted(() => ({
  handler: undefined as undefined | (() => unknown),
  server: undefined as undefined | (() => unknown),
  client: undefined as undefined | (() => unknown),
  request: undefined as undefined | Request,
}))

vi.mock("@tanstack/react-start", () => {
  const isomorphic = {
    server: (fn: () => unknown) => {
      captured.server = fn
      return isomorphic
    },
    client: (fn: () => unknown) => {
      captured.client = fn
      return isomorphic
    },
  }
  return {
    createServerFn: () => ({
      handler: (fn: () => unknown) => {
        captured.handler = fn
        return () => "rpc"
      },
    }),
    createIsomorphicFn: () => isomorphic,
  }
})
vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => captured.request,
}))
vi.mock("../src/server/auth", () => ({ verifySession }))

import {
  readSessionClaims,
  readSessionClaimsInProcess,
} from "../src/server/session-fn"

const APP = "https://app.test"
const USER = { sub: "u1", is_anonymous: false }

const rpc = (headers: Record<string, string> = {}) =>
  new Request(`${APP}/_serverFn/abc`, { headers })

beforeEach(() => {
  vi.stubEnv("SIMETRA_APP_ORIGIN", APP)
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

  it.each([
    "/_serverFn/abc",
    "/%5FserverFn/abc",
    "/%5fserverfn/abc",
    "/anything",
  ])("refuses a cross-site request whatever the path (%s)", async (path) => {
    const request = new Request(`${APP}${path}`, {
      headers: { "sec-fetch-site": "cross-site" },
    })
    expect(await readSessionClaims(request)).toBeNull()
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("the Server Function handler applies the origin rule to a percent-encoded base path", async () => {
    captured.request = new Request(`${APP}/%5FserverFn/x`, {
      headers: { origin: "https://evil.test" },
    })
    expect(await captured.handler!()).toBeNull()
    expect(verifySession).not.toHaveBeenCalled()
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

describe("session function in process (SSR branch)", () => {
  it("reads the session without the origin rule", async () => {
    const page = new Request(`${APP}/clients`, {
      headers: { "sec-fetch-site": "cross-site", origin: "https://evil.test" },
    })
    expect(await readSessionClaimsInProcess(page)).toEqual(USER)
    expect(verifySession).toHaveBeenCalledTimes(1)
  })

  it("keeps the anonymous and error rules", async () => {
    const page = new Request(`${APP}/`)
    verifySession.mockResolvedValue({ sub: "u1", is_anonymous: true })
    expect(await readSessionClaimsInProcess(page)).toBeNull()
    verifySession.mockRejectedValue(new Error("db.internal"))
    expect(await readSessionClaimsInProcess(page)).toBeNull()
  })

  it("the isomorphic function reads in process on the server and calls the Server Function on the client", async () => {
    captured.request = new Request(`${APP}/`, {
      headers: { "sec-fetch-site": "cross-site" },
    })
    expect(await captured.server!()).toEqual(USER)
    expect(captured.client!()).toBe("rpc")
  })
})
