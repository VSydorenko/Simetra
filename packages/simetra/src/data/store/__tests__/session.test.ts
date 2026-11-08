import { describe, expect, it, vi } from "vitest"
import { createSession } from "../session"
import { DEFAULT_CORE_LIMITS, type CoreLogEntry } from "../types"

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

  it("a listener that closes the session stops the following ones", () => {
    const { session } = make()
    const next = vi.fn()
    session.onFlush(() => session.close("disposed", () => {}))
    session.onFlush(next)
    session.commit(() => {}, session.token())
    expect(next).not.toHaveBeenCalled()
    expect(session.closed).toBe("disposed")
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
    expect(session.commit(() => {}, old)).toBe(false)
    // повторне закриття — без наслідків
    session.close("disposed", purge)
    expect(purge).toHaveBeenCalledTimes(1)
    expect(session.closed).toBe("session-changed")
  })

  it("clears epochs and runs onClose hooks", () => {
    const { session } = make()
    session.epochs.remember("o\u0000k", 3)
    const hook = vi.fn()
    session.onClose(hook)
    session.close("signed-out", () => {})
    expect(session.epochs.seen("o\u0000k")).toBeUndefined()
    expect(hook).toHaveBeenCalledTimes(1)
  })

  it("aborts only unfinished tracked requests", () => {
    const { session } = make()
    const done = session.track()
    const pending = session.track()
    done.release()
    session.close("disposed", () => {})
    expect(done.signal.aborted).toBe(false)
    expect(pending.signal.aborted).toBe(true)
  })

  it("track after close returns an aborted signal", () => {
    const { session } = make()
    session.close("disposed", () => {})
    expect(session.track().signal.aborted).toBe(true)
  })
})

describe("session.track", () => {
  it("10 000 released requests leave no controllers and no signal listeners", () => {
    const { session } = make()
    // Слухачі: підміна addEventListener на сигналі сесії бачить усі підписки.
    const add = vi.spyOn(session.signal, "addEventListener")
    for (let i = 0; i < 10_000; i++) session.track().release()
    expect(add).not.toHaveBeenCalled()
    // Активні контролери: close обриває кожен, що лишився у множині, тож
    // рахуємо виклики abort() — має бути лише сам сигнал сесії.
    const abort = vi.spyOn(AbortController.prototype, "abort")
    session.close("disposed", () => {})
    expect(abort).toHaveBeenCalledTimes(1)
    abort.mockRestore()
  })
})
