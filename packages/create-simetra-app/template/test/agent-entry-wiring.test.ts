import { runtimeCatalogSchema } from "simetra/model"
import { beforeEach, describe, expect, it, vi } from "vitest"
import generatedCatalog from "../generated/runtime-catalog.json"
import { stubAgentOauthKeys } from "./agent-oauth-keys"

vi.mock("@tanstack/react-start/server", () => ({
  createServerEntry: (entry: unknown) => entry,
  createStartHandler: () => () => new Response("start"),
  defaultStreamHandler: () => undefined,
}))
// Рантайм без бази: PRM і відмова без токена до порту й рантайму не доходять,
// але `loadEntry` будує вхід над ним так, як у робочому процесі
vi.mock("../src/server/runtime", () => ({
  serverHash: "hash",
  getRuntime: async () => ({
    catalog: runtimeCatalogSchema.parse(generatedCatalog),
    read: async () => ({ rows: [] }),
    run: async () => ({ rows: [], changes: [], epoch: "e" }),
  }),
}))

const ORIGIN = "https://app.test"

beforeEach(async () => {
  vi.resetModules()
  await stubAgentOauthKeys()
  vi.stubEnv("SIMETRA_APP_ORIGIN", ORIGIN)
  // Пул створюється, але з'єднання не відкривається: до порту запит не доходить
  vi.stubEnv("SIMETRA_AUTH_DATABASE_URL", "postgres://auth@127.0.0.1:1/none")
})

async function entry() {
  return (await import("../src/server")).default as unknown as {
    fetch: (request: Request) => Promise<Response>
  }
}

// Шлях, що йде в робочий процес: справжній `loadEntry` за `src/server.ts`
describe("the MCP entry of the server entry", () => {
  it("serves the PRM from appOrigin()", async () => {
    const response = await (
      await entry()
    ).fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      resource: "https://app.test/mcp",
      authorization_servers: ["https://app.test"],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    })
  })

  it("refuses /mcp without a token with 401 pointing to the PRM", async () => {
    const response = await (
      await entry()
    ).fetch(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      })
    )
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://app.test/.well-known/oauth-protected-resource/mcp", scope="mcp"'
    )
  })
})
