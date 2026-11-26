import { hkdfSync } from "node:crypto"
import { AsyncLocalStorage } from "node:async_hooks"
import { runtimeCatalogSchema, type AgentTokenInfo } from "simetra/model"
import {
  createAgentToolCatalog,
  type AgentToolCatalog,
  type CommandRuntime,
} from "simetra/server"
import { createMcpEntry } from "simetra/shell/mcp"
import { describe, expect, it, vi } from "vitest"
import generatedCatalog from "../generated/runtime-catalog.json"
import { withAgentEntry } from "../src/server/agent-entry"
import { agentInputHashKey } from "../src/server/agent-oauth/keys"
import {
  AGENT_MCP_PATH,
  AGENT_PRM_PATH,
  isAgentEntryPath,
} from "../src/server/agent-oauth/paths"
import { agentOauthKeyEnv } from "./agent-oauth-keys"

const ORIGIN = "https://app.test"
const RESOURCE = `${ORIGIN}/mcp`
const runtimeCatalog = runtimeCatalogSchema.parse(generatedCatalog)

function entryOver(catalog?: (real: AgentToolCatalog) => AgentToolCatalog) {
  const runtime = {
    catalog: runtimeCatalog,
    read: async () => ({ rows: [] }),
    run: async () => ({ rows: [], changes: [], epoch: "e" }),
  } as unknown as CommandRuntime
  const real = createAgentToolCatalog({ runtime })
  const token: AgentTokenInfo = {
    sub: "00000000-0000-4000-8000-000000000001",
    isAnonymous: false,
    clientId: "https://client.test/cimd.json",
    aud: [RESOURCE],
  }
  return createMcpEntry({
    catalog: catalog === undefined ? real : catalog(real),
    runtimeCatalog,
    resource: RESOURCE,
    authorizationServer: ORIGIN,
    verifyAgentToken: async () => token,
    onAgentCall: () => {},
    appOrigin: ORIGIN,
    inputHashKey: new Uint8Array(32).fill(1),
  })
}

describe("MCP entry paths", () => {
  it("the light path constants are the paths the adapter serves", () => {
    expect(entryOver().paths).toEqual({
      mcp: AGENT_MCP_PATH,
      protectedResourceMetadata: AGENT_PRM_PATH,
    })
    expect(AGENT_PRM_PATH).toBe("/.well-known/oauth-protected-resource/mcp")
  })

  it.each([
    ["/mcp", true],
    ["/.well-known/oauth-protected-resource/mcp", true],
    ["/mcp/", false],
    ["/.well-known/oauth-protected-resource", false],
    ["/token", false],
    ["/", false],
  ])("%s goes to the MCP entry: %s", (path, expected) => {
    expect(isAgentEntryPath(path)).toBe(expected)
  })
})

describe("withAgentEntry", () => {
  function stub(load: () => Promise<(r: Request) => Promise<Response>>) {
    const inner = vi.fn(async (_r: Request, tag: string) => new Response(tag))
    return { fetch: withAgentEntry(inner, load), inner }
  }

  it("loads the entry on the first MCP request only, once", async () => {
    let loads = 0
    const { fetch, inner } = stub(async () => {
      loads++
      return async () => new Response("mcp")
    })
    expect(await (await fetch(new Request(`${ORIGIN}/`), "start")).text()).toBe(
      "start"
    )
    expect(loads).toBe(0)
    for (const path of [AGENT_MCP_PATH, AGENT_PRM_PATH]) {
      const response = await fetch(new Request(`${ORIGIN}${path}`), "start")
      expect(await response.text()).toBe("mcp")
    }
    expect(loads).toBe(1)
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it("does not cache a failed load: the next request tries again", async () => {
    let loads = 0
    const { fetch } = stub(async () => {
      if (++loads === 1) throw new Error("runtime down")
      return async () => new Response("mcp")
    })
    await expect(fetch(new Request(RESOURCE), "x")).rejects.toThrow(
      "runtime down"
    )
    expect(await (await fetch(new Request(RESOURCE), "x")).text()).toBe("mcp")
    expect(loads).toBe(2)
  })
})

// `defer` рантайму бере запит з асинхронного контексту nitro (`useRequest()`,
// `runtime.ts`); nitro відкриває його над усім entry. Тут доводиться, що SDK
// MCP не губить контекст між `entry.fetch` і викликом каталогу — на обох ерах
describe("the async context of the request reaches the catalog call", () => {
  it.each(["legacy", "modern"] as const)("%s era", async (era) => {
    const context = new AsyncLocalStorage<string>()
    const seen: (string | undefined)[] = []
    const entry = entryOver((real) => ({
      ...real,
      call: async (claims, name, input) => {
        seen.push(context.getStore())
        return real.call(claims, name, input)
      },
    }))
    const modern = era === "modern"
    const request = new Request(RESOURCE, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer t",
        ...(modern
          ? {
              "mcp-protocol-version": "2026-07-28",
              "mcp-method": "tools/call",
              "mcp-name": "describe",
            }
          : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "describe",
          arguments: {},
          ...(modern
            ? {
                _meta: {
                  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                  "io.modelcontextprotocol/clientInfo": {
                    name: "test",
                    version: "1",
                  },
                  "io.modelcontextprotocol/clientCapabilities": {},
                },
              }
            : {}),
        },
      }),
    })
    const response = await context.run("request-1", () => entry.fetch(request))
    expect(response.status).toBe(200)
    await response.text()
    expect(seen).toEqual(["request-1"])
  })
})

describe("agentInputHashKey", () => {
  it("is an HKDF subkey of the current cookie key with its own label", async () => {
    const env = await agentOauthKeyEnv()
    const keys = {
      cookieKeys: JSON.parse(env.cookieKeys) as string[],
      signingKey: JSON.parse(env.signingKey),
    }
    const key = agentInputHashKey(keys)
    expect(key.byteLength).toBe(32)
    expect(Buffer.from(key)).toEqual(
      Buffer.from(
        hkdfSync(
          "sha256",
          keys.cookieKeys[0]!,
          new Uint8Array(0),
          "simetra/agent-call/input-hash",
          32
        )
      )
    )
    expect(Buffer.from(key).toString("base64url")).not.toBe(keys.cookieKeys[0])
    expect(Buffer.from(key).includes(Buffer.from(keys.cookieKeys[0]!))).toBe(
      false
    )
  })
})
