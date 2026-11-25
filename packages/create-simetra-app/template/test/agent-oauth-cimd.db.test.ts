import net from "node:net"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { safeFetch } from "../src/server/agent-oauth/safe-fetch"
import {
  authorize,
  authorizeUrl,
  connect,
  fixture,
  pkce,
  RESOURCE,
  startStand,
  type Stand,
} from "./agent-oauth-helpers"

/**
 * CIMD і `/authorize` сервера авторизації агентів (спека П4-F §5.4, Р-F4-6)
 * через справжнє монтування (`withAgentOauth` → srvx → `oidc-provider`) над
 * сховищем Postgres у `agent_oauth`.
 */
let stand: Stand
beforeAll(async () => {
  stand = await startStand("aocimd")
}, 180_000)
afterAll(() => stand?.close(), 60_000)

const LOOPBACK = "http://localhost:53123/callback"
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata"

function serve(id: string, doc: Record<string, unknown>): string {
  const u = new URL(id)
  const path = `/${u.host}${u.pathname}`
  stand.docs.set(path, JSON.stringify(doc))
  return path
}

describe("CIMD clients", () => {
  const cases = [
    {
      name: "Claude Code (loopback port differs from the document)",
      file: "claude-code",
      id: CLAUDE_CODE,
      redirect: LOOPBACK,
    },
    {
      name: "claude.ai",
      file: "claude-ai",
      id: "https://claude.ai/oauth/mcp-oauth-client-metadata",
      redirect: "https://claude.ai/api/mcp/auth_callback",
    },
    {
      name: "ChatGPT (private_key_jwt document, jwks_uri not fetched)",
      file: "chatgpt",
      id: "https://chatgpt.com/oauth/client.json",
      redirect: "https://chatgpt.com/connector_platform_oauth_redirect",
    },
  ]
  for (const c of cases) {
    it(`${c.name}: a public client, code + PKCE S256 → opaque token for the MCP resource`, async () => {
      const path = serve(c.id, fixture(c.file))
      stand.docs.set("/chatgpt.com/oauth/jwks.json", '{"keys":[]}')
      stand.hits.clear()
      // Свіжий провайдер: бібліотека кешує клієнта CIMD у процесі (знахідка 3 F0)
      const provider = stand.provider()
      const app = stand.app(provider)
      const login = await connect(app, {
        clientId: c.id,
        redirectUri: c.redirect,
        userId: await stand.user(),
      })
      // Обмін коду без автентифікації клієнта пройшов: клієнт публічний
      const token = login.tokens.access_token as string
      expect(token.split(".")).toHaveLength(1)
      const at = await provider.AccessToken.find(token)
      expect(at?.clientId).toBe(c.id)
      expect([at?.aud].flat()).toEqual([RESOURCE])
      expect(stand.hits.get(path)).toBeGreaterThan(0)
      expect(stand.hits.get("/chatgpt.com/oauth/jwks.json") ?? 0).toBe(0)
    }, 60_000)
  }

  it("refuses a document that neither declares nor supports auth method none", async () => {
    const id = "https://keyed.test/client.json"
    serve(id, {
      ...fixture("chatgpt"),
      client_id: id,
      token_endpoint_auth_methods_supported: ["private_key_jwt"],
    })
    const { res, flow } = await authorize(stand.app(stand.provider()), {
      clientId: id,
      redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect",
    })
    expect(flow).toBeUndefined()
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("invalid_client")
  }, 60_000)

  it("the real transport refuses a client_id resolving to a private address, on a port that listens", async () => {
    // Слухач на справжньому порту: без відмови адреси з'єднання дійшло б сюди
    let accepted = 0
    const listener = net.createServer((socket) => {
      accepted++
      socket.destroy()
    })
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r))
    const port = (listener.address() as AddressInfo).port
    const transportErrors: Error[] = []
    const app = stand.app(
      stand.provider({
        fetch: async (url, init) => {
          try {
            return await safeFetch(url as string, init)
          } catch (e) {
            transportErrors.push(e as Error)
            throw e
          }
        },
      })
    )
    try {
      for (const id of [
        `https://127.0.0.1:${port}/cimd.json`,
        `https://localhost:${port}/cimd.json`,
      ]) {
        transportErrors.length = 0
        const { res, flow } = await authorize(app, {
          clientId: id,
          redirectUri: LOOPBACK,
        })
        expect(flow, `${id}: ${res.status}`).toBeUndefined()
        expect(res.status).toBe(400)
        expect(transportErrors.length).toBeGreaterThan(0)
        expect(new Set(transportErrors.map((e) => e.name))).toEqual(
          new Set(["ForbiddenAddressError"])
        )
        expect(accepted, `${id}: connection reached the listener`).toBe(0)
      }
    } finally {
      listener.close()
    }
  }, 60_000)
})

describe("/authorize", () => {
  const client = { clientId: CLAUDE_CODE, redirectUri: LOOPBACK }

  async function noInteraction(url: string): Promise<Response> {
    const res = await stand.app(stand.provider())(
      new Request(url, { redirect: "manual" })
    )
    expect(res.headers.get("location") ?? "").not.toMatch(/\/agent\/connect\//)
    return res
  }

  it("refuses a request without PKCE or with the plain method", async () => {
    serve(CLAUDE_CODE, fixture("claude-code"))
    const { challenge, verifier } = pkce()
    const without = new URL(authorizeUrl(client, challenge))
    without.searchParams.delete("code_challenge")
    without.searchParams.delete("code_challenge_method")
    for (const url of [
      without.href,
      authorizeUrl(client, verifier, { code_challenge_method: "plain" }),
    ]) {
      const res = await noInteraction(url)
      // Помилка йде в callback клієнта, коду немає
      expect(res.status).toBe(303)
      const callback = new URL(res.headers.get("location")!)
      expect(`${callback.origin}${callback.pathname}`).toBe(LOOPBACK)
      expect(callback.searchParams.get("error")).toBe("invalid_request")
      expect(callback.searchParams.get("code")).toBeNull()
    }
  }, 60_000)

  it("refuses a redirect_uri outside the document with the template's own error page", async () => {
    serve(CLAUDE_CODE, fixture("claude-code"))
    for (const redirectUri of [
      "https://evil.test/callback",
      "http://localhost:53123/other",
    ]) {
      const res = await noInteraction(
        authorizeUrl({ ...client, redirectUri }, pkce().challenge)
      )
      expect(res.status).toBe(400)
      expect(res.headers.get("content-security-policy")).toBe(
        "default-src 'none'"
      )
      const html = await res.text()
      expect(html).toContain("The connection could not be started")
      expect(html).toContain("invalid_redirect_uri")
    }
  }, 60_000)
})
