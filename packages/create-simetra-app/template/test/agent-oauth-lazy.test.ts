import { describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  vi.stubEnv("SIMETRA_APP_ORIGIN", "https://app.test")
})
vi.mock("@tanstack/react-start/server", () => ({
  createServerEntry: (entry: unknown) => entry,
  createStartHandler: () => () => new Response("start"),
  defaultStreamHandler: () => undefined,
}))
vi.mock("../src/server/runtime", () => ({ serverHash: "hash" }))
// Будь-який імпорт бібліотеки в цьому файлі — помилка: статичний імпорт у
// графі entry зламав би вже імпорт `src/server`
vi.mock("oidc-provider", () => {
  throw new Error("oidc-provider was imported")
})
// Адаптер MCP і SDK — так само лише на першому запиті `/mcp` (Р-F4-5)
vi.mock("simetra/shell/mcp", () => {
  throw new Error("simetra/shell/mcp was imported")
})
vi.mock("@modelcontextprotocol/server", () => {
  throw new Error("@modelcontextprotocol/server was imported")
})

// Знахідка 7 F0: бібліотека в графі імпорту entry робила старт повільним
describe("entry import graph", () => {
  it("imports the entry and serves a non-agent path without loading oidc-provider or the MCP adapter", async () => {
    const entry = (await import("../src/server")).default as unknown as {
      fetch: (request: Request) => Promise<Response>
    }
    const response = await entry.fetch(new Request("https://app.test/"))
    expect(await response.text()).toBe("start")
  })
})
