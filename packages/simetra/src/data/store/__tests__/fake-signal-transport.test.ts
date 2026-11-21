import { describe, expect, it, vi } from "vitest"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"

describe("fake signal transport", () => {
  it("delivers a signal only to subscribers of its channel and counts them", () => {
    const transport = createFakeSignalTransport()
    const onA = vi.fn()
    const onB = vi.fn()
    const offA = transport.subscribe(["a"], onA, vi.fn())
    transport.subscribe(["b"], onB, vi.fn())
    transport.emit("a", { id: "1" })
    expect(onA).toHaveBeenCalledWith("a", { id: "1" })
    expect(onB).not.toHaveBeenCalled()
    expect(transport.subscribed().get("a")).toBe(1)
    offA()
    expect(transport.subscribed().has("a")).toBe(false)
    transport.emit("a", {})
    expect(onA).toHaveBeenCalledTimes(1)
  })

  it("reports join with the recovered flag to onSubscribed handlers", () => {
    const transport = createFakeSignalTransport()
    const handler = vi.fn()
    const off = transport.onSubscribed(handler)
    transport.join("a", false)
    transport.join("a", true)
    expect(handler.mock.calls).toEqual([
      [{ channel: "a", recovered: false }],
      [{ channel: "a", recovered: true }],
    ])
    off()
    transport.join("a", false)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it("fail reaches every subscriber's onError", () => {
    const transport = createFakeSignalTransport()
    const onError = vi.fn()
    transport.subscribe(["a"], vi.fn(), onError)
    transport.fail({ kind: "transport" })
    expect(onError).toHaveBeenCalledWith({ kind: "transport" })
  })

  it("refreshTokens closes refused channels and reports auth for each", async () => {
    const transport = createFakeSignalTransport()
    const onError = vi.fn()
    const onSignal = vi.fn()
    transport.subscribe(["a", "b"], onSignal, onError)
    transport.refused.add("a")
    await transport.refreshTokens(["b"])
    expect(onError).not.toHaveBeenCalled()
    await transport.refreshTokens()
    expect(onError).toHaveBeenCalledExactlyOnceWith({
      kind: "auth",
      channel: "a",
    })
    expect(transport.subscribed().has("a")).toBe(false)
    expect(transport.subscribed().get("b")).toBe(1)
    transport.emit("a", {})
    expect(onSignal).not.toHaveBeenCalled()
  })

  it("close drops every subscription and refuses new ones", () => {
    const transport = createFakeSignalTransport()
    const onSignal = vi.fn()
    transport.subscribe(["a"], onSignal, vi.fn())
    expect(transport.closed()).toBe(false)
    transport.close()
    expect(transport.closed()).toBe(true)
    transport.emit("a", {})
    transport.subscribe(["a"], onSignal, vi.fn())
    transport.emit("a", {})
    expect(onSignal).not.toHaveBeenCalled()
    expect(transport.subscribed().size).toBe(0)
  })

  it("fail with an auth channel tells and closes only the holder", () => {
    const transport = createFakeSignalTransport()
    const holder = vi.fn()
    const other = vi.fn()
    transport.subscribe(["a"], vi.fn(), holder)
    transport.subscribe(["b"], vi.fn(), other)
    transport.fail({ kind: "auth", channel: "a" })
    expect(holder).toHaveBeenCalledExactlyOnceWith({
      kind: "auth",
      channel: "a",
    })
    expect(other).not.toHaveBeenCalled()
    expect(transport.subscribed().has("a")).toBe(false)
    expect(transport.subscribed().get("b")).toBe(1)
  })

  it("refreshTokens re-subscribes allowed channels with recovered false", async () => {
    const transport = createFakeSignalTransport()
    const joined = vi.fn()
    transport.onSubscribed(joined)
    transport.subscribe(["a", "b", "c"], vi.fn(), vi.fn())
    transport.refused.add("c")
    await transport.refreshTokens(["a", "c"])
    expect(joined.mock.calls).toEqual([[{ channel: "a", recovered: false }]])
    joined.mockClear()
    await transport.refreshTokens()
    expect(joined.mock.calls).toEqual([
      [{ channel: "a", recovered: false }],
      [{ channel: "b", recovered: false }],
    ])
  })

  it("subscribe on a refused channel reports auth and does not hold it", () => {
    const transport = createFakeSignalTransport()
    const onSignal = vi.fn()
    const onError = vi.fn()
    transport.refused.add("a")
    transport.subscribe(["a", "b"], onSignal, onError)
    expect(onError).toHaveBeenCalledExactlyOnceWith({
      kind: "auth",
      channel: "a",
    })
    expect(transport.subscribed().has("a")).toBe(false)
    transport.emit("a", {})
    expect(onSignal).not.toHaveBeenCalled()
  })
})
