import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CommandFailure } from "simetra/model"
import { SignalTokenError } from "simetra/server/signals"

const verifySession = vi.hoisted(() => vi.fn())
const authorizeChannels = vi.hoisted(() => vi.fn())
const getRuntime = vi.hoisted(() => vi.fn())
const getSignalTokens = vi.hoisted(() => vi.fn())
vi.mock("../src/server/auth", () => ({ verifySession }))
vi.mock("../src/server/runtime", () => ({ getRuntime }))
vi.mock("../src/server/signal-tokens", () => ({ getSignalTokens }))

import {
  handleChannelTokens,
  handleConnectionToken,
  handleJwks,
} from "../src/server/signal-routes"

const APP = "https://app.test"
const USER = { sub: "raw-sub", is_anonymous: false }
const GRANT = { subject: "db-user", channels: ["a", "b"] }
const EXPIRES = new Date("2030-01-01T00:00:00.000Z")

const tokens = {
  connectionToken: vi.fn(),
  channelTokens: vi.fn(),
  jwks: vi.fn(),
}

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return new Request(`${APP}/simetra/signals/${path}`, {
    method: "POST",
    headers: { origin: APP, "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}
const connection = (body: unknown = { subject: "raw-sub" }) =>
  post("connection-token", body)
const channels = (body: unknown = { subject: "raw-sub", channels: ["a"] }) =>
  post("channel-tokens", body)

beforeEach(() => {
  vi.stubEnv("SIMETRA_APP_ORIGIN", APP)
  verifySession.mockReset().mockResolvedValue(USER)
  authorizeChannels.mockReset().mockResolvedValue(GRANT)
  getRuntime.mockReset().mockResolvedValue({ authorizeChannels })
  getSignalTokens.mockReset().mockResolvedValue(tokens)
  tokens.connectionToken
    .mockReset()
    .mockResolvedValue({ token: "ct", expiresAt: EXPIRES })
  tokens.channelTokens
    .mockReset()
    .mockResolvedValue([{ channel: "a", token: "t", expiresAt: EXPIRES }])
  tokens.jwks.mockReset().mockReturnValue({ keys: [{ kid: "k" }] })
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const ROUTES = [
  ["connection token", handleConnectionToken, connection],
  ["channel tokens", handleChannelTokens, channels],
] as const

describe.each(ROUTES)("%s route", (_name, handle, make) => {
  it("answers 404 when signals are off, before the guard", async () => {
    getSignalTokens.mockResolvedValue(undefined)
    expect((await handle(make())).status).toBe(404)
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("answers 403 for a foreign origin before any session read", async () => {
    const request = post(
      "x",
      { subject: "raw-sub", channels: [] },
      { origin: "https://evil.test" }
    )
    const response = await handle(request)
    expect(response.status).toBe(403)
    expect(verifySession).not.toHaveBeenCalled()
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  it("answers 401 without a session, without calling the runtime", async () => {
    verifySession.mockResolvedValue(null)
    expect((await handle(make())).status).toBe(401)
    expect(getRuntime).not.toHaveBeenCalled()
  })

  it("answers 401 for an anonymous session, without calling the runtime", async () => {
    verifySession.mockResolvedValue({ sub: "a", is_anonymous: true })
    expect((await handle(make())).status).toBe(401)
    expect(getRuntime).not.toHaveBeenCalled()
  })

  it("answers 401 session-changed for another subject, before the runtime", async () => {
    const response = await handle(
      make({ subject: "someone-else", channels: [] })
    )
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ reason: "session-changed" })
    expect(getRuntime).not.toHaveBeenCalled()
    expect(authorizeChannels).not.toHaveBeenCalled()
  })

  it.each([
    ["not JSON", "{"],
    ["not an object", "[]"],
    ["no subject", { channels: [] }],
    ["subject not a string", { subject: 1, channels: [] }],
  ])("answers 400 for a body that is %s", async (_case, body) => {
    expect((await handle(make(body))).status).toBe(400)
    expect(authorizeChannels).not.toHaveBeenCalled()
  })

  it.each([
    ["signals.no-user", 401],
    ["signals.no-signing-key", 503],
    ["signals.no-mature-key", 503],
    ["signals.forged-grant", 500],
  ] as const)(
    "maps %s to %i without the exception text",
    async (code, status) => {
      const secret = "secret-detail-text"
      tokens.connectionToken.mockRejectedValue(
        new SignalTokenError(code, secret)
      )
      tokens.channelTokens.mockRejectedValue(new SignalTokenError(code, secret))
      const response = await handle(make())
      expect(response.status).toBe(status)
      expect(await response.text()).not.toContain(secret)
    }
  )

  it.each([
    ["command.invalid", 400],
    ["command.unauthenticated", 401],
    ["command.internal", 500],
    ["command.unavailable", 500],
  ] as const)("maps %s to %i", async (code, status) => {
    authorizeChannels.mockRejectedValue(new CommandFailure({ code }))
    expect((await handle(make())).status).toBe(status)
  })

  it("answers 500 without the text of an unknown exception", async () => {
    authorizeChannels.mockRejectedValue(new Error("pg password=hunter2"))
    const response = await handle(make())
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain("hunter2")
  })

  it("asks the runtime afresh on every request (І6)", async () => {
    await handle(make())
    await handle(make())
    expect(authorizeChannels).toHaveBeenCalledTimes(2)
    expect(
      tokens.connectionToken.mock.calls.length +
        tokens.channelTokens.mock.calls.length
    ).toBe(2)
  })
})

describe("connection token route", () => {
  it("signs the grant of an empty channel list, not the raw sub (І4)", async () => {
    const response = await handleConnection()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      token: "ct",
      expiresAt: EXPIRES.toISOString(),
    })
    expect(authorizeChannels).toHaveBeenCalledWith(USER, [])
    // Грант того самого рантайму, не зібраний маршрутом з `claims.sub`
    expect(tokens.connectionToken.mock.calls[0]?.[0]).toBe(GRANT)
  })

  it("ignores channels sent by the client", async () => {
    await handleConnectionToken(
      connection({ subject: "raw-sub", channels: ["x"] })
    )
    expect(authorizeChannels).toHaveBeenCalledWith(USER, [])
  })
})

function handleConnection() {
  return handleConnectionToken(connection())
}

describe("channel tokens route", () => {
  it("returns the tokens of the grant for the requested channels", async () => {
    const response = await handleChannelTokens(
      channels({ subject: "raw-sub", channels: ["a", "b"] })
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      tokens: [{ channel: "a", token: "t", expiresAt: EXPIRES.toISOString() }],
    })
    expect(authorizeChannels).toHaveBeenCalledWith(USER, ["a", "b"])
    expect(tokens.channelTokens.mock.calls[0]?.[0]).toBe(GRANT)
  })

  it.each([
    ["channels missing", { subject: "raw-sub" }],
    ["channels not an array", { subject: "raw-sub", channels: "a" }],
    ["a channel not a string", { subject: "raw-sub", channels: ["a", 1] }],
  ])("answers 400 when %s", async (_case, body) => {
    expect((await handleChannelTokens(channels(body))).status).toBe(400)
    expect(authorizeChannels).not.toHaveBeenCalled()
  })
})

describe("jwks route", () => {
  it("serves the public keys without origin or session", async () => {
    const response = await handleJwks()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ keys: [{ kid: "k" }] })
    expect(verifySession).not.toHaveBeenCalled()
  })

  it("answers 404 when signals are off", async () => {
    getSignalTokens.mockResolvedValue(undefined)
    expect((await handleJwks()).status).toBe(404)
  })
})
