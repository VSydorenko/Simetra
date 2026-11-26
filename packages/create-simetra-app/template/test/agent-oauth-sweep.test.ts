import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startSweepTimer } from "../src/server/agent-oauth/store"

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("the sweep timer", () => {
  it("skips a tick while a sweep runs and stops on demand", async () => {
    let finish!: () => void
    const sweep = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    const stop = startSweepTimer(sweep, 1000)
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(2)
    finish()
    stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(sweep).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("logs a failed sweep and keeps ticking", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const sweep = vi.fn(() => Promise.reject(new Error("db down")))
    const stop = startSweepTimer(sweep, 1000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(sweep).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(
      "[simetra] agent oauth: sweep failed",
      expect.objectContaining({ message: "db down" })
    )
    stop()
  })
})
