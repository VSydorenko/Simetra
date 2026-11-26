import { runtimeCatalogSchema } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import generatedCatalog from "../generated/runtime-catalog.json"
import { stubAgentOauthKeys } from "./agent-oauth-keys"

vi.mock("@tanstack/react-start/server", () => ({
  createServerEntry: (entry: unknown) => entry,
  createStartHandler: () => () => new Response("start"),
  defaultStreamHandler: () => undefined,
}))
// Рантайм без бази: PRM і відмова без токена до порту й рантайму не доходять,
// але `loadEntry` будує вхід над ним так, як у робочому процесі
const state = vi.hoisted(() => ({
  scopeRoot: false,
  requiresTenant: [] as boolean[],
}))
vi.mock("../src/server/runtime", () => ({
  serverHash: "hash",
  getRuntime: async () => {
    const catalog = runtimeCatalogSchema.parse(generatedCatalog)
    if (!state.scopeRoot) return { catalog, ...runtimeStub }
    // Корінь виду скоупу в першому об'єкті: застосунок з видами скоупу
    const [first, ...rest] = catalog.objects
    return {
      catalog: {
        ...catalog,
        objects: [
          { ...first!, rights: { ...first!.rights!, root: {} } },
          ...rest,
        ],
      },
      ...runtimeStub,
    }
  },
}))
const runtimeStub = {
  read: async () => ({ rows: [] }),
  run: async () => ({ rows: [], changes: [], epoch: "e" }),
}
// Порт бачить прапорець, який `loadEntry` вивів із каталогу рантайму
vi.mock("../src/server/agent-oauth/verify-token", async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import("../src/server/agent-oauth/verify-token")
    >()
  return {
    ...real,
    createVerifyAgentToken: (
      o: Parameters<typeof real.createVerifyAgentToken>[0]
    ) => {
      state.requiresTenant.push(o.requiresTenant)
      return real.createVerifyAgentToken(o)
    },
  }
})

const ORIGIN = "https://app.test"

beforeEach(async () => {
  vi.resetModules()
  await stubAgentOauthKeys()
  vi.stubEnv("SIMETRA_APP_ORIGIN", ORIGIN)
  // Пул створюється, але з'єднання не відкривається: до порту запит не доходить
  vi.stubEnv("SIMETRA_AUTH_DATABASE_URL", "postgres://auth@127.0.0.1:1/none")
  // Сервер авторизації процесу стартує таймер прибирання: підроблений, щоб
  // тест його бачив і не лишав після себе
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
  state.scopeRoot = false
  state.requiresTenant.length = 0
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
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
    // Перший запит агента підняв сервер авторизації процесу з таймером прибирання
    expect(vi.getTimerCount()).toBe(1)
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://app.test/.well-known/oauth-protected-resource/mcp", scope="mcp"'
    )
  })

  it.each([
    ["a scope kind root", true],
    ["no scope kinds", false],
  ])(
    "the token port requires a pin by the catalog of the runtime (%s)",
    async (_name, scopeRoot) => {
      state.scopeRoot = scopeRoot
      const response = await (
        await entry()
      ).fetch(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`))
      expect(response.status).toBe(200)
      expect(state.requiresTenant).toEqual([scopeRoot])
    }
  )
})
