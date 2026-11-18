import { beforeEach, describe, expect, it, vi } from "vitest"

const SECRET = 'connection to "db.internal.example" role simetra_runtime failed'

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

import { createMemoryHistory } from "@tanstack/react-router"
import { getRouter } from "../src/router"

/** Як Start: історія запиту задається після створення роутера. */
function withHistory(router: ReturnType<typeof getRouter>) {
  router.update({
    history: createMemoryHistory({ initialEntries: ["/"] }),
  } as never)
  return router
}

/** Роутер запиту: `serverSsr` ставить обробник Start, тут — його заміна. */
function serverRouter() {
  const router = withHistory(getRouter())
  const cleanups: Array<() => void> = []
  router.serverSsr = {
    onCleanup: (action: () => void) => void cleanups.push(action),
  } as never
  return { router, cleanups }
}

beforeEach(() => {
  vi.restoreAllMocks()
  claims.mockResolvedValue(null)
})

describe("the server router", () => {
  it("a loader error reaches the dehydrated state as a code, the original goes to the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    loader.mockRejectedValue(new Error(SECRET))
    const { router } = serverRouter()
    await router.load()
    const errors = router.state.matches.map((match) => match.error)
    const failed = errors.find((error) => error !== undefined) as Error
    expect(failed.message).toBe("command.internal")
    // ShallowErrorPlugin серіалізує лише `message`
    expect(JSON.stringify({ message: failed.message })).not.toContain(
      "db.internal"
    )
    expect(log).toHaveBeenCalledWith(
      "[simetra] route error",
      expect.objectContaining({ message: SECRET })
    )
  })

  it("a beforeLoad error of the root (session or runtime) is replaced the same way", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
    loader.mockResolvedValue(undefined)
    claims.mockRejectedValue(new Error(SECRET))
    const { router } = serverRouter()
    await router.load()
    const errors = router.state.matches.map((match) => match.error)
    const failed = errors.find((error) => error !== undefined) as Error
    expect(failed.message).toBe("command.internal")
    // ShallowErrorPlugin серіалізує лише `message`
    expect(JSON.stringify({ message: failed.message })).not.toContain(
      "db.internal"
    )
    expect(log).toHaveBeenCalled()
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

  it("the client router does not rewrite errors (no server SSR state)", async () => {
    loader.mockRejectedValue(new Error(SECRET))
    vi.spyOn(console, "error").mockImplementation(() => undefined)
    const router = withHistory(getRouter())
    await router.load()
    const failed = router.state.matches.find((m) => m.error !== undefined)
    expect((failed?.error as Error).message).toBe(SECRET)
  })
})
