import { beforeEach, describe, expect, it, vi } from "vitest"

// Унікальний маркер у тексті помилки: його нема в жодній іншій частині відповіді,
// тож знайдений у серіалізованому рядку він міг прийти лише з помилки
const MARKER = `leak-probe-${crypto.randomUUID()}`
const SECRET = `connection to "db.internal.example" role simetra_runtime failed ${MARKER}`

const loader = vi.hoisted(() => vi.fn())
const claims = vi.hoisted(() => vi.fn())
const ssrTransport = vi.hoisted(() => vi.fn())

vi.mock("../src/server/data-fn", () => ({ dataFn: vi.fn() }))
vi.mock("../src/server/session-fn", () => ({ sessionClaims: claims }))
vi.mock("../src/server/ssr-transport", () => ({ ssrTransport }))
vi.mock("../src/server/auth", () => ({ auth: {}, verifySession: vi.fn() }))
vi.mock("../src/routes/api/auth/$", async () => {
  const { createFileRoute } = await import("@tanstack/react-router")
  return { Route: createFileRoute("/api/auth/$")({}) }
})
vi.mock("../src/routes/index", async () => {
  const { createFileRoute } = await import("@tanstack/react-router")
  return { Route: createFileRoute("/")({ loader }) }
})

import {
  createMemoryHistory,
  isNotFound,
  notFound,
} from "@tanstack/react-router"
import { attachRouterServerSsrUtils } from "@tanstack/react-start/server"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RootError } from "../src/root-view"
import { getRouter } from "../src/router"

/** Як Start: історія запиту задається після створення роутера. */
function withHistory(router: ReturnType<typeof getRouter>) {
  router.update({
    history: createMemoryHistory({ initialEntries: ["/"] }),
  } as never)
  return router
}

/**
 * Роутер запиту з справжнім `router.serverSsr` із router-core: рівно те, що
 * прикріплює обробник Start до `load()`, зі стандартними адаптерами
 * серіалізації (зокрема `ShallowErrorPlugin`).
 */
function serverRouter() {
  const router = withHistory(getRouter())
  attachRouterServerSsrUtils({ router, manifest: undefined })
  return { router, serverSsr: router.serverSsr! }
}

/**
 * Рядок, який Start вставляє в HTML як `$_TSR.router=…`: початкові теги
 * гідратації після `dehydrate()` (серіалізатор seroval з адаптерами).
 */
async function serializedState(
  serverSsr: NonNullable<ReturnType<typeof getRouter>["serverSsr"]>
) {
  await serverSsr.dehydrate()
  const tags = serverSsr.takeInitialHydrationScriptTags()
  const text = JSON.stringify(tags)
  // Дивимось у справжній стан роутера, а не в порожній рядок
  expect(text).toContain("$_TSR.router=")
  return text
}

beforeEach(() => {
  vi.restoreAllMocks()
  claims.mockResolvedValue(null)
})

describe("the server router", () => {
  it("a loader error: the serialized state has the code, not the text; the original is in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    loader.mockRejectedValue(new Error(SECRET))
    const { router, serverSsr } = serverRouter()
    await router.load()
    const serialized = await serializedState(serverSsr)
    expect(serialized).toContain("command.internal")
    expect(serialized).not.toContain(MARKER)
    expect(serialized).not.toContain("db.internal")
    // Позитивний контроль: помилку справді кинуто й її текст є в журналі host-а
    expect(log).toHaveBeenCalledWith(
      "[simetra] route error",
      expect.objectContaining({ message: expect.stringContaining(MARKER) })
    )
    serverSsr.cleanup()
  })

  it("a beforeLoad error of the root (session or runtime): the same in the serialized state", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    loader.mockResolvedValue(undefined)
    claims.mockRejectedValue(new Error(SECRET))
    const { router, serverSsr } = serverRouter()
    await router.load()
    const serialized = await serializedState(serverSsr)
    expect(serialized).toContain("command.internal")
    expect(serialized).not.toContain(MARKER)
    expect(serialized).not.toContain("db.internal")
    expect(log).toHaveBeenCalledWith(
      "[simetra] route error",
      expect.objectContaining({ message: expect.stringContaining(MARKER) })
    )
    serverSsr.cleanup()
  })

  it("errorComponent of the root shows the code, never the message", () => {
    const html = renderToStaticMarkup(
      createElement(RootError, {
        error: new Error(SECRET),
        reset: () => undefined,
      })
    )
    expect(html).toContain("command.internal")
    expect(html).not.toContain(MARKER)
    expect(html).not.toContain("db.internal")
  })

  it("an anonymous request has no data in the context and no runtime", async () => {
    loader.mockResolvedValue(undefined)
    const { router } = serverRouter()
    await router.load()
    expect(router.state.matches[0]?.context.data).toBeNull()
    expect(router.options.context.host.holder.current()).toBeUndefined()
  })

  it("a session gives the request its runtime; nothing of it goes into the transported beforeLoad state", async () => {
    loader.mockResolvedValue(undefined)
    claims.mockResolvedValue({ sub: "user-a" })
    ssrTransport.mockReturnValue(() => Promise.reject(new Error("no network")))
    const { router } = serverRouter()
    await router.load()
    const [root] = router.state.matches
    const { host } = router.options.context
    expect(host.holder.current()?.subject).toBe("user-a")
    expect(root?.context.data).toBe(host.holder)
    // `__beforeLoadContext` роутер дегідрує: тримача (і sub) там бути не може
    expect(
      (root as { __beforeLoadContext?: unknown }).__beforeLoadContext
    ).toBeUndefined()
    host.holder.current()?.dispose()
  })

  it("the request runtime is closed by the real serverSsr cleanup, on success and when a loader fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    claims.mockResolvedValue({ sub: "user-a" })
    ssrTransport.mockReturnValue(() => Promise.reject(new Error("no network")))
    for (const outcome of [
      () => loader.mockResolvedValue(undefined),
      () => loader.mockRejectedValue(new Error(SECRET)),
    ]) {
      outcome()
      const { router, serverSsr } = serverRouter()
      await router.load()
      const { holder } = router.options.context.host
      const runtime = holder.current()
      expect(runtime?.disposed).toBe(false)
      serverSsr.cleanup()
      expect(runtime?.disposed).toBe(true)
      expect(holder.current()).toBeUndefined()
    }
  })

  it("without serverSsr the request runtime cannot be closed, which is a failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    loader.mockResolvedValue(undefined)
    claims.mockResolvedValue({ sub: "user-a" })
    ssrTransport.mockReturnValue(() => Promise.reject(new Error("no network")))
    const router = withHistory(getRouter())
    await router.load()
    const failed = router.state.matches.find((m) => m.error !== undefined)
    expect((failed?.error as Error).message).toContain("serverSsr")
    router.options.context.host.holder.current()?.dispose()
  })

  it("a notFound thrown by a loader is left as it is", async () => {
    loader.mockRejectedValue(notFound())
    const { router } = serverRouter()
    await router.load()
    const original = router.state.matches.find((m) => m.status === "notFound")
    expect(original).toBeDefined()
    expect(isNotFound(original?.error)).toBe(true)
  })

  it("the client router does not rewrite errors (no server SSR state)", async () => {
    loader.mockRejectedValue(new Error(SECRET))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const router = withHistory(getRouter())
    await router.load()
    const failed = router.state.matches.find((m) => m.error !== undefined)
    expect((failed?.error as Error).message).toBe(SECRET)
  })
})
