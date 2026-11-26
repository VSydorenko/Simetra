import { readFileSync } from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  vi.stubEnv("SIMETRA_APP_ORIGIN", "https://app.test")
})
vi.mock("@tanstack/react-start/server", () => ({
  createServerEntry: (entry: unknown) => entry,
  createStartHandler: () => () => new Response("unused"),
  defaultStreamHandler: () => undefined,
}))
vi.mock("../src/server/runtime", () => ({ serverHash: "hash" }))

import { PAYLOAD_MAX_BYTES } from "simetra/model"
import { toFetchHandler } from "srvx/node"
import { createEntryFetch } from "../src/server"
import { withAgentOauth } from "../src/server/agent-oauth/mount"
import { isAgentOauthPath } from "../src/server/agent-oauth/paths"
import { createAgentOauthProvider } from "../src/server/agent-oauth/provider"
import { agentOauthKeyEnv } from "./agent-oauth-keys"

const ORIGIN = "https://app.test"
const RESOURCE = `${ORIGIN}/mcp`

beforeEach(() => vi.stubEnv("SIMETRA_APP_ORIGIN", ORIGIN))
afterEach(() => vi.unstubAllEnvs())

describe("agent authorization server paths", () => {
  it.each([
    "/.well-known/oauth-authorization-server",
    "/authorize",
    "/authorize/abc-_1",
    "/token",
    "/revoke",
    "/jwks",
  ])("%s goes to the library", (path) => {
    expect(isAgentOauthPath(path)).toBe(true)
  })

  it.each(["/", "/tokens", "/authorize/a/b", "/api/auth/token", "/mcp"])(
    "%s stays with Start",
    (path) => {
      expect(isAgentOauthPath(path)).toBe(false)
    }
  )
})

/** Монтування з підставним обробником: рахує завантаження й бачені запити. */
function stub() {
  const seen: Request[] = []
  let loads = 0
  const inner = vi.fn(async (_r: Request, tag: string) => new Response(tag))
  const fetch = withAgentOauth(inner, async () => {
    loads++
    return async (request) => {
      seen.push(request)
      return new Response("library")
    }
  })
  return { fetch, inner, seen, loads: () => loads }
}

const tokenRequest = (form: string, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: form,
  })

describe("withAgentOauth", () => {
  it("passes other paths to Start with their extra arguments, without loading the library", async () => {
    const s = stub()
    const response = await s.fetch(new Request(`${ORIGIN}/x`), "ctx")
    expect(await response.text()).toBe("ctx")
    expect(s.inner).toHaveBeenCalledOnce()
    expect(s.loads()).toBe(0)
  })

  describe.each(["authorization_code", "refresh_token"])(
    "/token resource pre-check for %s (Р-F4-7)",
    (grantType) => {
      const base = `grant_type=${grantType}&client_id=c&code=x&refresh_token=y`

      it.each([
        [
          "a foreign resource",
          `&resource=${encodeURIComponent("https://evil.test/mcp")}`,
        ],
        [
          "a resource of another path",
          `&resource=${encodeURIComponent(`${ORIGIN}/other`)}`,
        ],
        [
          "a repeated resource",
          `&resource=${encodeURIComponent(RESOURCE)}&resource=${encodeURIComponent(RESOURCE)}`,
        ],
      ])("refuses %s without calling the library", async (_n, extra) => {
        const s = stub()
        const response = await s.fetch(tokenRequest(base + extra), "")
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ error: "invalid_target" })
        expect(s.loads()).toBe(0)
        expect(s.seen).toHaveLength(0)
      })

      it.each([
        ["the canonical resource", `&resource=${encodeURIComponent(RESOURCE)}`],
        ["no resource", ""],
      ])("passes %s to the library with the body intact", async (_n, extra) => {
        const s = stub()
        const response = await s.fetch(tokenRequest(base + extra), "")
        expect(await response.text()).toBe("library")
        expect(await s.seen[0]!.text()).toBe(base + extra)
      })
    }
  )

  it("leaves other grant types to the library", async () => {
    const s = stub()
    await s.fetch(
      tokenRequest(
        `grant_type=client_credentials&resource=${encodeURIComponent("https://evil.test/")}`
      ),
      ""
    )
    expect(s.seen).toHaveLength(1)
  })

  it("an over-limit /token body is the entry's 413, not an OAuth error", async () => {
    const s = stub()
    const fetch = createEntryFetch(s.fetch)
    const big = `grant_type=refresh_token&refresh_token=${"x".repeat(PAYLOAD_MAX_BYTES)}`
    const chunked = new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big))
          c.close()
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" })
    const response = await fetch(chunked, "")
    expect(response.status).toBe(413)
    expect(s.loads()).toBe(0)
  })

  it("pins the request to the app origin: host and forwarded headers are its own", async () => {
    const s = stub()
    await s.fetch(
      new Request(`http://evil.test/authorize?x=1`, {
        headers: {
          host: "evil.test",
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "http",
          "x-forwarded-for": "6.6.6.6",
          forwarded: "host=evil.test",
          "x-simetra-client-ip": "10.0.0.7",
        },
      }),
      ""
    )
    const seen = s.seen[0]!
    expect(seen.url).toBe(`${ORIGIN}/authorize?x=1`)
    expect(seen.headers.get("host")).toBe("app.test")
    expect(seen.headers.get("x-forwarded-proto")).toBe("https")
    expect(seen.headers.get("x-forwarded-for")).toBe("10.0.0.7")
    expect(seen.headers.get("x-forwarded-host")).toBeNull()
    expect(seen.headers.get("forwarded")).toBeNull()
  })
})

// Без бази: адаптер нічого не зберігає й нічого не знаходить (сховище
// Postgres — у DB-тестах)
const emptyAdapter = () => ({
  upsert: async () => {},
  find: async () => undefined,
  findByUid: async () => undefined,
  findByUserCode: async () => undefined,
  consume: async () => {},
  destroy: async () => {},
  revokeByGrantId: async () => {},
})

const claudeAi = readFileSync(
  new URL("./fixtures/cimd/claude-ai.json", import.meta.url),
  "utf8"
)

async function realMount(origin: string) {
  vi.stubEnv("SIMETRA_APP_ORIGIN", origin)
  const env = await agentOauthKeyEnv()
  const provider = createAgentOauthProvider({
    origin,
    pool: {} as never,
    keys: {
      cookieKeys: JSON.parse(env.cookieKeys) as string[],
      signingKey: JSON.parse(env.signingKey),
    },
    adapter: emptyAdapter as never,
    fetch: (async () =>
      new Response(claudeAi, {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  })
  return withAgentOauth(
    async () => new Response("start"),
    async () => toFetchHandler(provider.callback())
  )
}

describe("host pinning over the real library (architect ruling)", () => {
  it.each([
    ["no Host", {}],
    ["a foreign Host", { host: "evil.test" }],
    [
      "forged forwarded headers",
      {
        "x-forwarded-host": "evil.test",
        "x-forwarded-proto": "http",
        forwarded: "host=evil.test;proto=http",
      },
    ],
  ])(
    "discovery endpoints stay on the app origin with %s",
    async (_n, headers) => {
      const fetch = await realMount(ORIGIN)
      const response = await fetch(
        new Request(`${ORIGIN}/.well-known/oauth-authorization-server`, {
          headers,
        })
      )
      const body = (await response.json()) as Record<string, string>
      expect(body.issuer).toBe(ORIGIN)
      for (const key of [
        "authorization_endpoint",
        "token_endpoint",
        "revocation_endpoint",
        "jwks_uri",
      ])
        expect(
          body[key]!.startsWith(`${ORIGIN}/`),
          `${key}: ${body[key]}`
        ).toBe(true)
    }
  )

  const authorize = (origin: string) =>
    new Request(
      `${origin}/authorize?${new URLSearchParams({
        response_type: "code",
        client_id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_challenge: "x".repeat(43),
        code_challenge_method: "S256",
        scope: "mcp",
        resource: `${origin}/mcp`,
      })}`,
      { redirect: "manual", headers: { "x-forwarded-proto": "http" } }
    )

  it("interaction cookies carry Secure on an https origin and the interaction page path", async () => {
    const fetch = await realMount(ORIGIN)
    const response = await fetch(authorize(ORIGIN))
    expect(response.status).toBe(303)
    const uid = /^\/agent\/connect\/([\w-]+)$/.exec(
      response.headers.get("location") ?? ""
    )?.[1]
    expect(uid).toBeDefined()
    const cookies = response.headers.getSetCookie()
    expect(cookies.length).toBeGreaterThan(0)
    for (const cookie of cookies) expect(cookie).toMatch(/;\s*secure/i)
    expect(cookies.find((c) => c.startsWith("_interaction="))).toContain(
      `path=/agent/connect/${uid}`
    )
  })

  it("interaction cookies are not Secure on an http origin (local development)", async () => {
    const fetch = await realMount("http://localhost:3000")
    const response = await fetch(authorize("http://localhost:3000"))
    expect(response.status).toBe(303)
    for (const cookie of response.headers.getSetCookie())
      expect(cookie).not.toMatch(/;\s*secure/i)
  })
})
