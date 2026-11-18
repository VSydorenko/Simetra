import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const verifySession = vi.hoisted(() => vi.fn())
const handler = vi.hoisted(() => vi.fn())
const onDataResponse = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/react-start", () => {
  const chain = { validator: () => chain, handler: () => () => undefined }
  return { createServerFn: () => chain }
})
vi.mock("@tanstack/react-start/server", () => ({ getRequest: vi.fn() }))
vi.mock("../src/server/auth", () => ({ verifySession }))
vi.mock("../src/server/runtime", () => ({
  getDataHandler: async () => handler,
  serverHash: "hash",
}))
vi.mock("#instrument", () => ({ onDataResponse }))

import { handleDataRequest } from "../src/server/data-request"

const APP = "https://app.test"
const USER = { sub: "u1", is_anonymous: false }
const OK = { ok: true, value: 1, serverHash: "hash" }

function post(headers: Record<string, string>) {
  return new Request(`${APP}/_serverFn/x`, { method: "POST", headers })
}

beforeEach(() => {
  vi.stubEnv("SIMETRA_APP_ORIGIN", APP)
  verifySession.mockReset().mockResolvedValue(USER)
  handler.mockReset().mockResolvedValue(OK)
  onDataResponse.mockReset()
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const FORBIDDEN = {
  ok: false,
  error: { code: "command.forbidden", reason: "origin" },
  serverHash: "hash",
}

describe("dataFn", () => {
  it("refuses a foreign Origin before any session step", async () => {
    const response = await handleDataRequest(
      post({ origin: "https://evil.test" }),
      {}
    )
    expect(response).toEqual(FORBIDDEN)
    expect(verifySession).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it("refuses Sec-Fetch-Site: cross-site before any session step", async () => {
    const response = await handleDataRequest(
      post({ origin: APP, "sec-fetch-site": "cross-site" }),
      {}
    )
    expect(response).toEqual(FORBIDDEN)
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("refuses a request with no origin facts", async () => {
    expect(await handleDataRequest(post({}), {})).toEqual(FORBIDDEN)
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("answers unauthenticated without a session, without the handler", async () => {
    verifySession.mockResolvedValue(null)
    const response = await handleDataRequest(post({ origin: APP }), {})
    expect(response).toEqual({
      ok: false,
      error: { code: "command.unauthenticated" },
      serverHash: "hash",
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it("answers unauthenticated for an anonymous session", async () => {
    verifySession.mockResolvedValue({ sub: "u1", is_anonymous: true })
    const response = await handleDataRequest(post({ origin: APP }), {})
    expect(response).toMatchObject({
      ok: false,
      error: { code: "command.unauthenticated" },
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it("passes the handler only the HTTP facts of the request", async () => {
    const envelope = { request: { type: "read" } }
    const response = await handleDataRequest(
      post({ origin: APP, "sec-fetch-site": "same-origin" }),
      envelope
    )
    expect(response).toEqual(OK)
    expect(handler).toHaveBeenCalledTimes(1)
    const [claims, passed, origin] = handler.mock.calls[0] as unknown[]
    expect(claims).toEqual(USER)
    expect(passed).toBe(envelope)
    expect(origin).toEqual({
      origin: APP,
      secFetchSite: "same-origin",
      expectedOrigin: APP,
    })
    expect(origin).not.toHaveProperty("inProcess")
  })

  it("takes expectedOrigin from SIMETRA_APP_ORIGIN, not from Host or X-Forwarded-Host", async () => {
    const response = await handleDataRequest(
      post({
        origin: "https://evil.test",
        host: "evil.test",
        "x-forwarded-host": "evil.test",
        "x-forwarded-proto": "https",
      }),
      {}
    )
    expect(response).toEqual(FORBIDDEN)
    expect(handler).not.toHaveBeenCalled()

    handler.mockResolvedValue(OK)
    await handleDataRequest(
      post({ origin: APP, host: "evil.test", "x-forwarded-host": "evil.test" }),
      {}
    )
    expect(handler.mock.calls[0]?.[2]).toMatchObject({ expectedOrigin: APP })
  })

  it("answers command.internal without text when the handler throws", async () => {
    handler.mockRejectedValue(
      new Error("connect ECONNREFUSED db.internal:5432")
    )
    const response = await handleDataRequest(post({ origin: APP }), {})
    expect(response).toEqual({
      ok: false,
      error: { code: "command.internal" },
      serverHash: "hash",
    })
    expect(JSON.stringify(response)).not.toContain("db.internal")
    expect(console.error).toHaveBeenCalled()
  })

  it("answers command.internal without text when the session step throws", async () => {
    verifySession.mockRejectedValue(
      new Error("role simetra_auth at db.internal")
    )
    const response = await handleDataRequest(post({ origin: APP }), {})
    expect(response).toMatchObject({
      ok: false,
      error: { code: "command.internal" },
    })
    expect(JSON.stringify(response)).not.toContain("db.internal")
  })

  it("answers command.internal when the origin is not configured", async () => {
    vi.stubEnv("SIMETRA_APP_ORIGIN", undefined)
    const response = await handleDataRequest(post({ origin: APP }), {})
    expect(response).toMatchObject({ error: { code: "command.internal" } })
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("hands the final response to onDataResponse in every branch", async () => {
    const ok = await handleDataRequest(post({ origin: APP }), {})
    const refused = await handleDataRequest(
      post({ origin: "https://x.test" }),
      {}
    )
    verifySession.mockResolvedValue(null)
    const unauth = await handleDataRequest(post({ origin: APP }), {})
    handler.mockRejectedValue(new Error("x"))
    verifySession.mockResolvedValue(USER)
    const internal = await handleDataRequest(post({ origin: APP }), {})
    expect(onDataResponse.mock.calls.map((call) => call[0])).toEqual([
      ok,
      refused,
      unauth,
      internal,
    ])
  })
})
