import { describe, expect, it, vi } from "vitest"

const dataFn = vi.hoisted(() => vi.fn())
vi.mock("../src/server/data-fn", () => ({ dataFn }))

import { createRuntimeHolder, type DataRuntime } from "simetra/data"
import { clientTransport, withStartRefusal } from "../src/data-transport"

const REQUEST = { subject: "u", request: { type: "read", items: [] } } as never
const OK = { ok: true, value: 1, serverHash: "h" }

describe("withStartRefusal", () => {
  it("passes a response through", async () => {
    const transport = withStartRefusal(async () => OK as never, "h")
    expect(await transport(REQUEST)).toEqual(OK)
  })

  it("maps the bare 403 of Start to a coded origin refusal", async () => {
    const transport = withStartRefusal(async () => {
      throw new Error("Forbidden")
    }, "hash")
    expect(await transport(REQUEST)).toEqual({
      ok: false,
      error: { code: "command.forbidden", reason: "origin" },
      serverHash: "hash",
    })
  })

  it("does not swallow other failures", async () => {
    const transport = withStartRefusal(async () => {
      throw new Error("boom")
    }, "h")
    await expect(transport(REQUEST)).rejects.toThrow("boom")
  })
})

describe("clientTransport", () => {
  const unauthenticated = (reason?: string) => ({
    ok: false,
    error: { code: "command.unauthenticated", ...(reason ? { reason } : {}) },
    serverHash: "h",
  })

  /** Тримач із рантаймом суб'єкта `u` (лише те, що читає обгортка). */
  function holderOf(subject: string) {
    const holder = createRuntimeHolder()
    holder.replace({ subject, dispose: vi.fn() } as unknown as DataRuntime)
    return holder
  }

  it("unauthenticated without a reason replaces the holder and goes to login", async () => {
    dataFn.mockResolvedValueOnce(unauthenticated())
    const holder = holderOf("u")
    const navigate = vi.fn()
    const response = await clientTransport(holder, navigate)(REQUEST)
    expect(holder.current()).toBeUndefined()
    expect(holder.closed()).toBe("signed-out")
    expect(navigate).toHaveBeenCalledOnce()
    // Відповідь іде далі, рантайм розбирає її сам
    expect(response).toEqual(unauthenticated())
  })

  it("session-changed is left to the T4 path: no second replacement", async () => {
    dataFn.mockResolvedValueOnce(unauthenticated("session-changed"))
    const holder = holderOf("u")
    const replace = vi.spyOn(holder, "replace")
    const navigate = vi.fn()
    await clientTransport(holder, navigate)(REQUEST)
    expect(replace).not.toHaveBeenCalled()
    expect(holder.current()).toBeDefined()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("leaves other codes and successes alone", async () => {
    const holder = holderOf("u")
    const navigate = vi.fn()
    const transport = clientTransport(holder, navigate)
    for (const response of [
      OK,
      { ok: false, error: { code: "command.forbidden" }, serverHash: "h" },
      { ok: false, error: { code: "command.internal" }, serverHash: "h" },
    ]) {
      dataFn.mockResolvedValueOnce(response)
      expect(await transport(REQUEST)).toEqual(response)
    }
    expect(holder.current()).toBeDefined()
    expect(navigate).not.toHaveBeenCalled()
  })

  it("a late answer for another subject does not close the live runtime", async () => {
    // Вхід B, поки запит A ще в польоті: тримач уже тримає B
    dataFn.mockResolvedValueOnce(unauthenticated())
    const holder = holderOf("b")
    const navigate = vi.fn()
    await clientTransport(holder, navigate)(REQUEST)
    expect(holder.current()?.subject).toBe("b")
    expect(navigate).not.toHaveBeenCalled()
  })
})
