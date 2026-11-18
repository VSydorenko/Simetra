import { afterEach, describe, expect, it, vi } from "vitest"
import { createSession } from "../session"
import { DEFAULT_CORE_LIMITS, type CoreLogEntry } from "../types"

afterEach(() => vi.restoreAllMocks())

function make() {
  const log: CoreLogEntry[] = []
  const session = createSession({
    subject: "u1",
    limits: DEFAULT_CORE_LIMITS,
    log: (e) => log.push(e),
  })
  return { session, log }
}

describe("session.commit", () => {
  it("a stale token returns false, skips fn and logs late-response", () => {
    const { session, log } = make()
    let valid = true
    const child = session.childToken(() => valid)
    valid = false
    const fn = vi.fn()
    expect(session.commit(fn, child, "page")).toBe(false)
    expect(fn).not.toHaveBeenCalled()
    expect(log).toEqual([{ kind: "late-response", what: "page" }])
  })

  it("childToken is invalid after close even when isValid() is true", () => {
    const { session } = make()
    const child = session.childToken(() => true)
    expect(child.valid).toBe(true)
    session.close("disposed", () => {})
    expect(child.valid).toBe(false)
    expect(session.token().valid).toBe(false)
  })

  it("scope.assert() throws after fn returns", () => {
    const { session } = make()
    let kept: { assert(): void } | undefined
    session.commit((scope) => {
      scope.assert()
      kept = scope
    }, session.token())
    expect(() => kept?.assert()).toThrow("write scope is closed")
  })

  it("a nested commit throws", () => {
    const { session } = make()
    expect(() =>
      session.commit(() => {
        session.commit(() => {}, session.token())
      }, session.token())
    ).toThrow("nested commit")
    // сесія лишається придатною після кидка
    expect(session.commit(() => {}, session.token())).toBe(true)
  })

  it("two writes in one commit give one notification batch", () => {
    const { session } = make()
    const listener = vi.fn()
    session.onFlush(listener)
    session.commit((scope) => {
      scope.assert()
      scope.assert()
    }, session.token())
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("session.onFlush", () => {
  it("a throwing listener does not stop the next and logs listener-failed", () => {
    const { session, log } = make()
    const boom = new Error("boom")
    const next = vi.fn()
    session.onFlush(() => {
      throw boom
    })
    session.onFlush(next)
    session.commit(() => {}, session.token())
    expect(next).toHaveBeenCalledTimes(1)
    expect(log).toEqual([{ kind: "listener-failed", error: boom }])
  })

  it("a listener that closes the session: purge batch reaches the next listener once, original batch stops", () => {
    const { session } = make()
    let purged = false
    const seen: Array<{ purged: boolean; closed: unknown }> = []
    session.onFlush(() => {
      if (!purged) session.close("disposed", () => (purged = true))
    })
    session.onFlush(() => seen.push({ purged, closed: session.closed }))
    session.commit(() => {}, session.token())
    // closed ще не виставлено й purge уже виконано: виклик у purge-пачці
    expect(seen).toEqual([{ purged: true, closed: undefined }])
    expect(session.closed).toBe("disposed")
  })

  it("a listener commit during the close batch is refused and logged", () => {
    const { session, log } = make()
    const old = session.token()
    const child = session.childToken(() => true)
    const results: boolean[] = []
    const childValid: boolean[] = []
    session.onFlush(() => {
      results.push(session.commit(() => {}, old, "late"))
      childValid.push(child.valid)
    })
    session.close("disposed", () => {})
    expect(results).toEqual([false])
    expect(childValid).toEqual([false])
    expect(child.valid).toBe(false)
    expect(log).toEqual([{ kind: "late-response", what: "late" }])
  })

  it("a listener may commit: the nested batch reaches the next listener first", () => {
    const { session } = make()
    let first = true
    const order: string[] = []
    session.onFlush(() => {
      if (!first) return
      first = false
      order.push("commit")
      session.commit(() => {}, session.token())
    })
    session.onFlush(() => order.push("next"))
    session.commit(() => {}, session.token())
    expect(order).toEqual(["commit", "next", "next"])
  })

  it("unsubscribe stops notifications", () => {
    const { session } = make()
    const listener = vi.fn()
    const off = session.onFlush(listener)
    off()
    session.commit(() => {}, session.token())
    expect(listener).not.toHaveBeenCalled()
  })
})

describe("session.close", () => {
  it("purges once before abort, one notification, then commit is false", () => {
    const { session } = make()
    const order: string[] = []
    const listener = vi.fn(() => order.push("flush"))
    session.onFlush(listener)
    const old = session.token()
    session.signal.addEventListener("abort", () => order.push("abort"))
    const purge = vi.fn(() => order.push("purge"))
    session.close("session-changed", purge)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(order).toEqual(["purge", "flush", "abort"])
    expect(session.closed).toBe("session-changed")
    expect(session.signal.aborted).toBe(true)
    expect(session.signal.reason).toBe("session-changed")
    expect(session.commit(() => {}, old)).toBe(false)
    // повторне закриття — без наслідків
    session.close("disposed", purge)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(session.closed).toBe("session-changed")
  })

  it("clears epochs and runs onClose hooks", () => {
    const { session } = make()
    session.epochs.remember("o\u0000k", 3, null)
    const hook = vi.fn()
    session.onClose(hook)
    session.close("signed-out", () => {})
    expect(session.epochs.seen("o\u0000k")).toBeUndefined()
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it("close inside a commit throws and leaves the session alive", () => {
    const { session } = make()
    const purge = vi.fn()
    expect(() =>
      session.commit(() => session.close("disposed", purge), session.token())
    ).toThrow("close inside commit")
    expect(purge).not.toHaveBeenCalled()
    expect(session.closed).toBeUndefined()
    expect(session.token().valid).toBe(true)
  })

  it("a throwing onClose hook does not skip the rest nor the listener cleanup", () => {
    const { session, log } = make()
    const boom = new Error("hook")
    const second = vi.fn()
    const listener = vi.fn()
    session.onClose(() => {
      throw boom
    })
    session.onClose(second)
    session.close("disposed", () => {})
    session.onFlush(listener)
    expect(second).toHaveBeenCalledTimes(1)
    expect(log).toEqual([{ kind: "listener-failed", error: boom }])
    expect(listener).not.toHaveBeenCalled()
  })

  it("onClose registered after close runs immediately", () => {
    const { session } = make()
    session.close("disposed", () => {})
    const hook = vi.fn()
    session.onClose(hook)
    expect(hook).toHaveBeenCalledTimes(1)
  })
})

describe("session.sleep", () => {
  afterEach(() => vi.useRealTimers())

  it("wakes after the pause and leaves no timer", async () => {
    vi.useFakeTimers()
    const { session } = make()
    let woke = false
    void session.sleep(100).then(() => (woke = true))
    await vi.advanceTimersByTimeAsync(99)
    expect(woke).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(woke).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("close clears the timer and wakes the wait at once", async () => {
    vi.useFakeTimers()
    const { session } = make()
    let woke = false
    const sleeping = session.sleep(60_000).then(() => (woke = true))
    void session.sleep(60_000, new AbortController().signal)
    expect(vi.getTimerCount()).toBe(2)
    session.close("disposed", () => {})
    expect(vi.getTimerCount()).toBe(0)
    // Без продовження годинника: очікування завершує сама мікрозадача.
    await sleeping
    expect(woke).toBe(true)
  })

  it("a sleep after close resolves at once with no timer", async () => {
    vi.useFakeTimers()
    const { session } = make()
    session.close("disposed", () => {})
    await session.sleep(60_000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("an aborted signal wakes only its own sleep and clears its timer", async () => {
    vi.useFakeTimers()
    const { session } = make()
    const stop = new AbortController()
    let first = false
    let second = false
    void session.sleep(1_000, stop.signal).then(() => (first = true))
    void session.sleep(1_000).then(() => (second = true))
    stop.abort()
    await Promise.resolve()
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    await session.sleep(0, stop.signal)
    expect(vi.getTimerCount()).toBe(1)
  })
})
