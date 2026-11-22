import { afterEach, describe, expect, it, vi } from "vitest"

// Дерево роутера тягне серверні модулі (пул, Better Auth): тест перевіряє
// фабрику, а не їх
vi.mock("../src/server/data-fn", () => ({ dataFn: vi.fn() }))
vi.mock("../src/server/session", () => ({ sessionClaims: vi.fn() }))
vi.mock("../src/server/ssr-transport", () => ({ ssrTransport: vi.fn() }))
vi.mock("../src/server/auth", () => ({ auth: {}, verifySession: vi.fn() }))
vi.mock("../src/routes/api/auth/$", async () => {
  const { createFileRoute } = await import("@tanstack/react-router")
  return { Route: createFileRoute("/api/auth/$")({}) }
})

import { app } from "../src/app"
import { getRouter } from "../src/router"
import { generateKey } from "./signal-keys"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe("getRouter", () => {
  it("is a new router with its own holder on every call", () => {
    const a = getRouter()
    const b = getRouter()
    expect(a).not.toBe(b)
    expect(a.options.context.host.holder).not.toBe(
      b.options.context.host.holder
    )
  })

  it("starts with no data in the context (an anonymous request stays so)", () => {
    expect(getRouter().options.context.data).toBeNull()
  })

  it("sets the router options of §4.6", () => {
    const { options } = getRouter()
    expect(options.defaultStaleReloadMode).toBe("blocking")
    expect(options.defaultPendingMinMs).toBe(0)
    expect(options.defaultPendingMs).toBeGreaterThanOrEqual(10_000)
  })

  it("dehydrates nothing for a request without a runtime", async () => {
    expect(await getRouter().options.dehydrate?.()).toEqual({ data: null })
  })

  it("dehydrates the signals url when the server has signals, and never the keys", async () => {
    const key = await generateKey("k1")
    vi.stubEnv(
      "SIMETRA_SIGNALS_URL",
      "ws://centrifugo.test/connection/websocket"
    )
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", JSON.stringify([key]))
    const dehydrated = await getRouter().options.dehydrate?.()
    expect(dehydrated).toEqual({
      data: null,
      signalsUrl: "ws://centrifugo.test/connection/websocket",
    })
    expect(JSON.stringify(dehydrated)).not.toContain(key.privateJwk.d)
    // Адреса береться один раз на процес: конфіг вдруге не читається
    vi.stubEnv("SIMETRA_SIGNALS_URL", "")
    vi.stubEnv("SIMETRA_SIGNALS_KEYS", "")
    expect(await getRouter().options.dehydrate?.()).toEqual({
      data: null,
      signalsUrl: "ws://centrifugo.test/connection/websocket",
    })
  })

  it("keeps the signals url from the snapshot on the scope, with or without data", async () => {
    const withData = getRouter()
    await withData.options.hydrate?.({
      data: null,
      signalsUrl: "ws://centrifugo.test/connection/websocket",
    })
    expect(withData.options.context.host.signalsUrl).toBe(
      "ws://centrifugo.test/connection/websocket"
    )
    // Снімок без адреси (сервер без сигналів) лишає клієнта без сигналів
    const without = getRouter()
    await without.options.hydrate?.({ data: null })
    expect(without.options.context.host.signalsUrl).toBeUndefined()
    // Не рядок — не адреса
    const bad = getRouter()
    await bad.options.hydrate?.({ data: null, signalsUrl: 7 } as never)
    expect(bad.options.context.host.signalsUrl).toBeUndefined()
  })

  it("hydrates the snapshot of the server runtime before the first render", async () => {
    const server = getRouter()
    const client = getRouter()
    const runtime = app.createRuntime({
      subject: "user-a",
      transport: () => Promise.reject(new Error("no network in this test")),
      visible: false,
    })
    server.options.context.host.holder.replace(runtime)
    // Знімок проходить ту саму дорогу, що й у відповіді: JSON
    const dehydrated = JSON.parse(
      JSON.stringify(await server.options.dehydrate?.())
    )
    expect(dehydrated.data.meta).toEqual({ subject: "user-a" })

    // `document` — після створення роутерів: з ним роутер вважає себе браузерним
    vi.stubGlobal("document", { hidden: true })
    await client.options.hydrate?.(dehydrated)
    const { host } = client.options.context
    expect(host.holder.current()?.subject).toBe("user-a")
    // Вкладка відкрита прихованою: рантайм без `suspend()` не живе видимим
    expect(host.holder.current()?.visible).toBe(false)
    expect(host.hydrated).toBe(true)
    expect(client.options.context.data).toBe(host.holder)
    runtime.dispose()
    host.holder.current()?.dispose()
  })

  it("an anonymous snapshot leaves the client without a runtime", async () => {
    const client = getRouter()
    await client.options.hydrate?.({ data: null })
    expect(client.options.context.host.holder.current()).toBeUndefined()
    expect(client.options.context.data).toBeNull()
    expect(client.options.context.host.hydrated).toBe(false)
  })

  it("a snapshot of the wrong shape is logged and leaves the client without data", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const client = getRouter()
    vi.stubGlobal("document", { hidden: false })
    await client.options.hydrate?.({ data: { meta: {} } })
    expect(client.options.context.host.holder.current()).toBeUndefined()
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })
})
