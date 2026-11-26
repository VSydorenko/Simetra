import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ViewSpec } from "../types"
import { TASK, seed, settle, setup } from "./core-support"
import type { settlePass as SettlePass } from "../sync/settle-pass"

/*
 * Точки завантаження, сторінки й системного перечитування осідають лише через `settlePass` (план SK-2,
 * задачі 3 і 4): запис ефектів проходу доводить порядок кроків, а підміна гачка
 * — що запис стану цілі йде лише через `settleTarget` (крок 7), а запис
 * відповіді — лише через `apply` (крок 5). Очікування `main` — у
 * `settle-sites-main.test.ts`; тут лише шов.
 */

const seen = vi.hoisted(() => ({
  calls: [] as string[],
  skip: new Set<string>(),
}))

vi.mock("../sync/settle-pass", async (importOriginal) => {
  const real = await importOriginal<typeof import("../sync/settle-pass")>()
  const wrapped: typeof SettlePass = (session, entries, hooks) => {
    const kind = entries[0]!.flight.kind
    // Підмінений гачок не кличе справжнього; брама без нього пропускає.
    const wrap = <A extends unknown[], R>(
      name: string,
      fn: ((...a: A) => R) | undefined,
      fallback: R
    ) =>
      fn &&
      ((...a: A): R => {
        seen.calls.push(`${kind} ${name}`)
        return seen.skip.has(`${kind} ${name}`) ? fallback : fn(...a)
      })
    return real.settlePass(session, entries, {
      ...hooks,
      gate: wrap("gate", hooks.gate, "apply"),
      apply: wrap("apply", hooks.apply, undefined),
      settleTarget: wrap("settleTarget", hooks.settleTarget, undefined),
      sweep: wrap("sweep", hooks.sweep, undefined),
    })
  }
  return { ...real, settlePass: wrapped }
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
  seen.calls.length = 0
  seen.skip.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const FULL: ViewSpec = { kind: "full", object: TASK }
const WINDOW: ViewSpec = { kind: "window", object: TASK }

async function loaded(spec: ViewSpec, rows: number) {
  const h = setup({ now: () => Date.now() })
  seed(h.fake, 1, rows)
  const view = h.core.view(spec)
  const unsubscribe = view.subscribe(() => {})
  return { h, view, unsubscribe }
}

describe("the load point settles through the pass", () => {
  it("runs the gate, the write, the target transition and the sweep, in the order of the steps", async () => {
    const { unsubscribe } = await loaded(FULL, 3)
    await settle()
    expect(seen.calls).toEqual([
      "load gate",
      "load apply",
      "load settleTarget",
      "load sweep",
    ])
    unsubscribe()
  })

  it("writes the answer only in the step-5 hook", async () => {
    seen.skip.add("load apply")
    const { view, unsubscribe } = await loaded(FULL, 3)
    await settle()
    expect(view.getSnapshot().rows).toHaveLength(0)
    unsubscribe()
  })

  it("moves the state of the view only in the step-7 seam", async () => {
    seen.skip.add("load settleTarget")
    const { view, unsubscribe } = await loaded(FULL, 3)
    await settle()
    expect(view.getSnapshot().status).not.toBe("ready")
    unsubscribe()
  })
})

describe("the page point settles through the pass", () => {
  it("runs the gate, the write, the target transition and the sweep, in the order of the steps", async () => {
    const { view, unsubscribe } = await loaded(WINDOW, 250)
    await settle()
    seen.calls.length = 0
    view.loadAfter()
    await settle()
    expect(seen.calls.filter((c) => c.startsWith("page "))).toEqual([
      "page gate",
      "page apply",
      "page settleTarget",
      "page sweep",
    ])
    unsubscribe()
  })

  it("writes the page only in the step-5 hook", async () => {
    const { view, unsubscribe } = await loaded(WINDOW, 250)
    await settle()
    const first = view.getSnapshot().rows.length
    seen.skip.add("page apply")
    view.loadAfter()
    await settle()
    expect(view.getSnapshot().rows).toHaveLength(first)
    unsubscribe()
  })
})

describe("the system re-read settles through the pass", () => {
  const reread = (h: Awaited<ReturnType<typeof loaded>>["h"]) =>
    void h.core.revalidate(TASK, { visibleOnly: false })

  it("runs the gate, the write, the target transition and the sweep, in the order of the steps", async () => {
    const { h, unsubscribe } = await loaded(FULL, 3)
    await settle()
    seen.calls.length = 0
    reread(h)
    await settle()
    expect(seen.calls.filter((c) => c.startsWith("reread "))).toEqual([
      "reread gate",
      "reread apply",
      "reread settleTarget",
      "reread sweep",
    ])
    unsubscribe()
  })

  it("settles the views of one object as one pass over several flights", async () => {
    const { h, unsubscribe } = await loaded(FULL, 3)
    const second = h.core.view(WINDOW)
    const unsubscribeSecond = second.subscribe(() => {})
    await settle()
    seen.calls.length = 0
    reread(h)
    await settle()
    // Одна область запису: кроки 4–7 для кожного польоту, один `sweep` на всіх.
    expect(seen.calls.filter((c) => c.startsWith("reread "))).toEqual([
      "reread gate",
      "reread apply",
      "reread settleTarget",
      "reread gate",
      "reread apply",
      "reread settleTarget",
      "reread sweep",
    ])
    unsubscribeSecond()
    unsubscribe()
  })

  it("writes the answer only in the step-5 hook", async () => {
    const { h, view, unsubscribe } = await loaded(FULL, 3)
    await settle()
    // Нові рядки сервера лягли б банером лише записом відповіді (крок 5).
    seed(h.fake, 4, 5)
    seen.skip.add("reread apply")
    reread(h)
    await settle()
    expect(view.getSnapshot().hasNewRows).toBe(false)
    unsubscribe()
  })

  it("moves the state of the view only in the step-7 seam", async () => {
    const { h, view, unsubscribe } = await loaded(FULL, 3)
    await settle()
    seen.skip.add("reread settleTarget")
    h.fake.hold = () => true
    reread(h)
    await settle()
    h.fake.take().fail("command.unavailable")
    await settle()
    expect(view.getSnapshot().status).not.toBe("error")
    unsubscribe()
  })
})
