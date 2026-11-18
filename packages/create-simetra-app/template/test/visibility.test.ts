import { describe, expect, it, vi } from "vitest"
import { createRuntimeHolder, type DataRuntime } from "simetra/data"
import { app } from "../src/app"
import { startClient, watchVisibility } from "../src/visibility"

/** Мінімальна ціль подій: те, що кличе `watchVisibility`. */
function target(hidden = false) {
  const listeners = new Map<string, Set<() => void>>()
  return {
    hidden,
    addEventListener: (type: string, listener: () => void) => {
      const set = listeners.get(type) ?? new Set()
      set.add(listener)
      listeners.set(type, set)
    },
    removeEventListener: (type: string, listener: () => void) => {
      listeners.get(type)?.delete(listener)
    },
    fire: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
    count: (type: string) => listeners.get(type)?.size ?? 0,
    documentElement: { setAttribute: vi.fn() },
  }
}

const stubRuntime = () =>
  ({
    suspend: vi.fn(),
    resume: vi.fn(),
    endHydration: vi.fn(),
    subject: "u",
    dispose: vi.fn(),
  }) as unknown as DataRuntime & {
    suspend: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    endHydration: ReturnType<typeof vi.fn>
  }

describe("watchVisibility", () => {
  it("hidden calls suspend; visibility and focus call resume", () => {
    const holder = createRuntimeHolder()
    const runtime = stubRuntime()
    holder.replace(runtime)
    const doc = target(false)
    const win = target()
    watchVisibility(holder, doc, win)
    doc.hidden = true
    doc.fire("visibilitychange")
    expect(runtime.suspend).toHaveBeenCalledOnce()
    expect(runtime.resume).not.toHaveBeenCalled()
    doc.hidden = false
    doc.fire("visibilitychange")
    win.fire("focus")
    // Пар не рахуємо: кожна подія — один виклик, злиття за 1 с — справа T4
    expect(runtime.resume).toHaveBeenCalledTimes(2)
  })

  it("two hidden in a row do not throw on a real runtime", () => {
    const holder = createRuntimeHolder()
    const runtime = app.createRuntime({
      subject: "u",
      transport: () => Promise.reject(new Error("no network in this test")),
      visible: true,
    })
    holder.replace(runtime)
    const doc = target(true)
    watchVisibility(holder, doc, target())
    expect(() => {
      doc.fire("visibilitychange")
      doc.fire("visibilitychange")
    }).not.toThrow()
    expect(runtime.visible).toBe(false)
    runtime.dispose()
  })

  it("events go to the runtime the holder holds now, and nowhere without one", () => {
    const holder = createRuntimeHolder()
    const first = stubRuntime()
    const second = stubRuntime()
    holder.replace(first)
    const doc = target(false)
    watchVisibility(holder, doc, target())
    holder.replace(second)
    doc.fire("visibilitychange")
    expect(first.resume).not.toHaveBeenCalled()
    expect(second.resume).toHaveBeenCalledOnce()
    holder.replace(undefined)
    expect(() => doc.fire("visibilitychange")).not.toThrow()
  })

  it("the returned function unsubscribes", () => {
    const doc = target()
    const win = target()
    const stop = watchVisibility(createRuntimeHolder(), doc, win)
    expect([doc.count("visibilitychange"), win.count("focus")]).toEqual([1, 1])
    stop()
    expect([doc.count("visibilitychange"), win.count("focus")]).toEqual([0, 0])
  })
})

describe("startClient", () => {
  function scopeOf(runtime: DataRuntime | undefined, hydrated: boolean) {
    const holder = createRuntimeHolder(runtime)
    return {
      holder,
      hydrated,
      hydrationEnded: false,
      markHydrated: vi.fn(),
    }
  }

  it("ends the hydration once, marks the page and survives a StrictMode double run", () => {
    const runtime = stubRuntime()
    const scope = scopeOf(runtime, true)
    const doc = target()
    const stop = startClient(scope, doc, target())
    stop()
    startClient(scope, doc, target())
    expect(runtime.endHydration).toHaveBeenCalledOnce()
    expect(scope.markHydrated).toHaveBeenCalledOnce()
    expect(doc.documentElement.setAttribute).toHaveBeenCalledWith(
      "data-hydrated",
      "true"
    )
    expect(doc.documentElement.setAttribute).toHaveBeenCalledOnce()
  })

  it("an anonymous page is marked hydrated without any runtime", () => {
    const scope = scopeOf(undefined, false)
    const doc = target()
    startClient(scope, doc, target())
    expect(scope.markHydrated).toHaveBeenCalledOnce()
    expect(doc.documentElement.setAttribute).toHaveBeenCalledWith(
      "data-hydrated",
      "true"
    )
  })

  it("does not end a hydration that never took a snapshot", () => {
    const runtime = stubRuntime()
    startClient(scopeOf(runtime, false), target(), target())
    expect(runtime.endHydration).not.toHaveBeenCalled()
  })
})
