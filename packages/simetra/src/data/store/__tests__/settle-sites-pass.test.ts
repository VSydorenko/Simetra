import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { channelTopic } from "simetra/model"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import { QUIET_MS } from "../receiver"
import { REREAD_TIMEOUT_MS } from "../writer"
import { coreInternals } from "../core"
import type { ViewSpec } from "../types"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import {
  S,
  TASK,
  key,
  keysOf,
  seed,
  settle,
  setup,
  task,
  type CoreHarness,
} from "./core-support"
import type { settlePass as SettlePass } from "../sync/settle-pass"

/*
 * Точки завантаження, сторінки, системного перечитування, підтвердження
 * запису, хвоста й приймача осідають лише через `settlePass` (план SK-2,
 * задачі 3–5): запис ефектів проходу доводить порядок кроків, а підміна гачка
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
    const { flight } = entries[0]!
    // Ключі трьох точок розрізняє код рядка: K1/K2 приймач, K3 хвіст, K4 запис.
    const kind =
      flight.kind === "keys" ? `keys ${flight.site}` : (flight.kind ?? "")
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
      // Наслідок запитувачу `write-confirm` іде лише з `finish`.
      finish: kind.startsWith("keys")
        ? wrap("finish", hooks.finish, undefined)
        : hooks.finish,
    })
  }
  // Приймач осідає через `settleAfter`, що кличе справжній прохід: підміняємо
  // її так, щоб вона кликала обгорнутий.
  const wrappedAfter: typeof real.settleAfter = (session, entries, hooks) => {
    const waits = entries.flatMap((e) =>
      e.after === undefined ? [] : [e.after]
    )
    return waits.length === 0
      ? wrapped(session, entries, hooks)
      : Promise.all(waits).then(() => wrapped(session, entries, hooks))
  }
  return { ...real, settlePass: wrapped, settleAfter: wrappedAfter }
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

async function loaded(
  spec: ViewSpec,
  rows: number,
  options: Parameters<typeof setup>[0] = {}
) {
  const h = setup({ now: () => Date.now(), ...options })
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

describe("the write-confirm point settles through the pass", () => {
  const rig = async () => {
    // Відповідь запису без рядків (понад бюджет, Рд26): ключ перечитується.
    const { h, view, unsubscribe } = await loaded(FULL, 3, {
      epoch: "e".repeat(64),
      server: (fake) => ({
        ...fake.server,
        run: async (request) => {
          const answer = {
            ...((await fake.server.run(request)) as Record<string, unknown>),
          }
          delete answer.rows
          return answer
        },
      }),
    })
    await settle()
    seen.calls.length = 0
    let resolved = false
    const update = () =>
      void h.core
        .update(TASK, key(1), { title: "x" }, { expectedVersion: 1 })
        .settled.then(() => (resolved = true))
    return { h, view, unsubscribe, update, resolved: () => resolved }
  }

  it("runs the gate, the write and the reply to the requester, in the order of the steps", async () => {
    const { update, resolved, unsubscribe } = await rig()
    update()
    await settle()
    expect(seen.calls.filter((c) => c.startsWith("keys K4 "))).toEqual([
      "keys K4 gate",
      "keys K4 apply",
      "keys K4 finish",
    ])
    expect(resolved()).toBe(true)
    unsubscribe()
  })

  it("tells the requester of a failure only in the settlement of the pass", async () => {
    const settledAfterFailure = async (skipFinish: boolean) => {
      const { h, update, resolved, unsubscribe } = await rig()
      if (skipFinish) seen.skip.add("keys K4 finish")
      // Держимо лише читання за ключем: сам запис проходить.
      h.fake.hold = (read) => keysOf(read.query).length > 0
      update()
      await settle()
      expect(resolved()).toBe(false)
      h.fake.hold = undefined
      h.fake.take().fail("command.unavailable")
      await settle()
      unsubscribe()
      return resolved()
    }
    // Запитувач чекає наслідку: його дає лише осідання проходу (тут — збій).
    expect(await settledAfterFailure(false)).toBe(true)
    expect(await settledAfterFailure(true)).toBe(false)
  })

  it("writes the key only in the step-5 hook", async () => {
    const written = async (skipApply: boolean) => {
      const { view, update, unsubscribe } = await rig()
      if (skipApply) seen.skip.add("keys K4 apply")
      update()
      await settle()
      const title = (
        view.getSnapshot().rows[0] as { values?: { title?: unknown } }
      ).values?.title
      unsubscribe()
      return title
    }
    expect(await written(false)).toBe("x")
    // Без застосування `patchRows` і `removeKeys` не кличуться: рядок старий.
    expect(await written(true)).not.toBe("x")
  })

  it("calls the requester once: a late answer after the deadline passes without it", async () => {
    const { h, update, unsubscribe } = await rig()
    const marks = vi.spyOn(
      coreInternals(h.core).objects.get(TASK)!.rows,
      "markUnconfirmed"
    )
    h.fake.hold = (read) => keysOf(read.query).length > 0
    update()
    await settle()
    await vi.advanceTimersByTimeAsync(REREAD_TIMEOUT_MS)
    await settle()
    expect(marks).toHaveBeenCalledTimes(1)
    // Пізня відповідь — збій: запитувача вдруге не кличуть (`done`).
    h.fake.hold = undefined
    h.fake.take().fail("command.unavailable")
    await settle()
    expect(marks).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("has no step-7 seam: a key read writes no target state", async () => {
    const { update, unsubscribe } = await rig()
    update()
    await settle()
    expect(seen.calls.some((c) => c.includes("keys K4 settleTarget"))).toBe(
      false
    )
    unsubscribe()
  })
})

describe("the tail point settles through the pass", () => {
  const hide = (h: CoreHarness) =>
    void h.core.commit((w) => w.hideByHorizon(TASK, [key(1)]), h.core.token())

  it("runs the epoch gate and the write, in the order of the steps", async () => {
    const { h, unsubscribe } = await loaded(FULL, 3)
    await settle()
    seen.calls.length = 0
    hide(h)
    await settle()
    expect(seen.calls.filter((c) => c.startsWith("keys K3 "))).toEqual([
      "keys K3 gate",
      "keys K3 apply",
    ])
    unsubscribe()
  })

  it("writes the answer only in the step-5 hook", async () => {
    const { h, view, unsubscribe } = await loaded(FULL, 3)
    await settle()
    const before = view.getSnapshot().rows.length
    seen.skip.add("keys K3 apply")
    hide(h)
    await settle()
    expect(view.getSnapshot().rows).toHaveLength(before)
    expect(view.getSnapshot().rows[0]).toMatchObject({ hidden: true })
    unsubscribe()
  })
})

describe("the signal receiver point settles through the pass", () => {
  const USER = "00000000-0000-4000-8000-0000000000a1"
  const CHANNEL = channelTopic({
    kind: "changes",
    scopeKindId: SCOPE_KIND_ID,
    scope: S,
    object: task.id,
  })

  async function signalCore() {
    const transport = createFakeSignalTransport()
    const h = setup({
      now: () => Date.now(),
      limits: { revalidateIntervalMs: 10_000_000 },
      signals: transport,
      rightsSnapshot: true,
    })
    h.fake.rightsSnapshot = {
      userId: USER,
      scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
      rights: [
        {
          level: "scope",
          levelId: null,
          scope: S,
          container: null,
          object: "task",
          action: "read",
          extent: "any",
          dimensionId: null,
        },
      ],
      members: [],
      dimensionValues: [],
    }
    h.fake.rightsVersion = "1".repeat(64)
    seed(h.fake, 1, 3)
    const view = h.core.view({
      kind: "keys",
      object: TASK,
      keys: [key(1), key(2)],
    })
    view.subscribe(() => {})
    await settle()
    seen.calls.length = 0
    const emit = async () => {
      const version = h.fake.edit(TASK, key(1), { title: "from the signal" })
      transport.emit(CHANNEL, {
        id: "1",
        object: task.id,
        op: "update",
        keys: { id: key(1) },
        row_ver: version,
      })
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      await settle()
    }
    return { h, view, emit }
  }

  it("runs the epoch gate, the write and the sweep, in the order of the steps", async () => {
    const { emit } = await signalCore()
    await emit()
    expect(seen.calls.filter((c) => c.startsWith("keys K1 "))).toEqual([
      "keys K1 gate",
      "keys K1 apply",
      "keys K1 sweep",
    ])
  })

  it("writes the answer only in the step-5 hook", async () => {
    const { view, emit } = await signalCore()
    seen.skip.add("keys K1 apply")
    await emit()
    expect(JSON.stringify(view.getSnapshot().rows)).not.toContain(
      "from the signal"
    )
  })

  it("the epoch gate of the pass is a hook; the inner gate of Writer.apply still discards an abandoned epoch", async () => {
    const EA = "a".repeat(64)
    const EB = "b".repeat(64)
    const { h, view, emit } = await signalCore()
    const pass = (epoch: string) =>
      h.core.commit(
        (w) =>
          void w.apply(
            TASK,
            { rows: [], absent: [] },
            h.core.readEpoch(),
            epoch
          ),
        h.core.token()
      )
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    // Епоха EA покинута: відповіді з неї відкидаються.
    pass(EA)
    pass(EB)
    seen.calls.length = 0
    seen.skip.add("keys K1 gate")
    await emit()
    // Брама проходу пропустила (гачок підмінено), але друга брама
    // `Writer.apply` — та, що лишає §3, — відкинула: рядок не записано.
    expect(seen.calls).toContain("keys K1 apply")
    expect(JSON.stringify(view.getSnapshot().rows)).not.toContain(
      "from the signal"
    )
  })
})
