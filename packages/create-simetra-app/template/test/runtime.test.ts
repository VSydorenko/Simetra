import { beforeEach, describe, expect, it, vi } from "vitest"

const current = vi.hoisted(() => ({ request: {} as { waitUntil?: unknown } }))
const created = vi.hoisted(() => ({
  options: [] as {
    defer: (work: Promise<unknown>) => void
    database: unknown
  }[],
}))

vi.mock("nitro/context", () => ({ useRequest: () => current.request }))
vi.mock("pg", () => ({ Pool: class {} }))
vi.mock("#instrument", () => ({
  wrapDatabase: (database: unknown) => ({ wrapped: database }),
}))
vi.mock("simetra/server", () => ({
  fromPgPool: (pool: unknown) => ({ port: pool }),
  createCommandRuntime: async (options: never) => {
    created.options.push(options)
    return {}
  },
  createDataHandler: () => () => undefined,
}))

beforeEach(() => {
  created.options.length = 0
  vi.resetModules()
  vi.stubEnv("SIMETRA_RUNTIME_DATABASE_URL", "postgres://r@h/db")
  vi.spyOn(console, "error").mockImplementation(() => undefined)
})

async function load() {
  return await import("../src/server/runtime")
}

describe("runtime binding", () => {
  it("creates the runtime lazily, once", async () => {
    const { getDataHandler } = await load()
    expect(created.options).toHaveLength(0)
    const first = getDataHandler()
    const second = getDataHandler()
    await Promise.all([first, second])
    expect(second).toBe(first)
    expect(created.options).toHaveLength(1)
  })

  it("routes the database port through wrapDatabase", async () => {
    const { getDataHandler } = await load()
    await getDataHandler()
    expect(created.options[0]?.database).toEqual({ wrapped: { port: {} } })
  })

  it("defer takes waitUntil of the current request, not of the first one", async () => {
    const { getDataHandler } = await load()
    await getDataHandler()
    const { defer } = created.options[0]!
    const first = vi.fn()
    const second = vi.fn()
    const work1 = Promise.resolve(1)
    const work2 = Promise.resolve(2)

    current.request = { waitUntil: first }
    defer(work1)
    current.request = { waitUntil: second }
    defer(work2)

    expect(first.mock.calls).toEqual([[work1]])
    expect(second.mock.calls).toEqual([[work2]])
  })

  it("logs a failure of deferred work when the platform has no waitUntil", async () => {
    const { getDataHandler } = await load()
    await getDataHandler()
    current.request = {}
    created.options[0]!.defer(Promise.reject(new Error("late")))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(console.error).toHaveBeenCalled()
  })
})
