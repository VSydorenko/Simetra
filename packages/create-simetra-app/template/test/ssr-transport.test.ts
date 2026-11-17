import { beforeEach, describe, expect, it, vi } from "vitest"

const handler = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ client: false }))
const createServerFn = vi.hoisted(() => vi.fn())

// Підміна імітує перетворення Start: на клієнті обгорнута функція кидає
vi.mock("@tanstack/react-start", () => ({
  createServerFn,
  createServerOnlyFn:
    <A extends unknown[], R>(fn: (...args: A) => R) =>
    (...args: A): R => {
      if (state.client)
        throw new Error("server-only function called on the client")
      return fn(...args)
    },
}))
vi.mock("../src/server/runtime", () => ({
  getDataHandler: async () => handler,
}))

import { ssrTransport } from "../src/server/ssr-transport"

const CLAIMS = { sub: "u1", is_anonymous: false }
const REQUEST = { subject: "u1", request: { type: "read" } } as never

beforeEach(() => {
  state.client = false
  handler.mockReset().mockResolvedValue({ ok: true, value: 1, serverHash: "h" })
  createServerFn.mockClear()
})

describe("ssrTransport", () => {
  it("throws in the client environment", () => {
    state.client = true
    expect(() => ssrTransport(CLAIMS)).toThrow(/server-only/)
  })

  it("calls the handler in process with the session claims", async () => {
    const response = await ssrTransport(CLAIMS)(REQUEST)
    expect(response).toMatchObject({ ok: true })
    expect(handler).toHaveBeenCalledWith(CLAIMS, REQUEST, { inProcess: true })
  })

  it("is not a Server Function", () => {
    ssrTransport(CLAIMS)
    expect(createServerFn).not.toHaveBeenCalled()
  })
})
