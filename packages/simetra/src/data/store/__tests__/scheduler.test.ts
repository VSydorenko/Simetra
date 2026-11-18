import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { catalogEntry } from "../../../model/runtime/__tests__/entries"
import type { CommandErrorCode } from "simetra/model"
import { createScheduler } from "../scheduler"
import { DISCARDS_MAX } from "../session"
import type { CoreLimits, ViewSpec } from "../types"
import {
  ORG,
  OBJECTS,
  TASK,
  key,
  org,
  seed,
  settle,
  setup,
  watch,
  type CoreHarness,
} from "./core-support"

/*
 * Планувальник свіжості (спека П4-B §6.7, §8.4): один таймер на ядро, такт
 * із вікном 0,1 × I, пауза після збою, видимість у момент спрацювання.
 * Часом керують фейкові таймери Vitest, годинник ядра — `Date.now()`;
 * запити рахує фейковий сервер, а не виклики внутрішніх функцій.
 */

const I = 60_000
const EA = "a".repeat(64)
const EB = "b".repeat(64)

const THIRD = catalogEntry({
  ...org,
  id: "00000000-0000-4000-8000-000000000199",
  name: "Third",
  kindLabel: "third",
  table: { schema: "public", name: "third" },
})
const THIRD_OBJ = "Catalog.Third"
const THREE = [...OBJECTS, THIRD]

const taskKeys = (...ns: number[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys: ns.map(key),
})
const orgKeys = (n: number): ViewSpec => ({
  kind: "keys",
  object: ORG,
  keys: [key(10_000 + n)],
})
const thirdKeys = (n: number): ViewSpec => ({
  kind: "keys",
  object: THIRD_OBJ,
  keys: [key(20_000 + n)],
})

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function build(
  options: {
    limits?: Partial<CoreLimits>
    objects?: typeof OBJECTS
    visible?: boolean
    mode?: "auto" | "manual"
  } = {}
) {
  const h = setup({
    mode: options.mode ?? "auto",
    now: () => Date.now(),
    limits: { revalidateIntervalMs: I, ...options.limits },
    ...(options.objects === undefined ? {} : { objects: options.objects }),
    ...(options.visible === undefined ? {} : { visible: options.visible }),
  })
  seed(h.fake, 1, 6)
  for (let n = 1; n <= 3; n++) {
    h.fake.insert(ORG, { ref: key(10_000 + n) })
    if (options.objects === THREE)
      h.fake.insert(THIRD_OBJ, { ref: key(20_000 + n) })
  }
  return h
}

/** Ядро, що тримає видимий вигляд задач 1..2, завантажений у момент 0. */
async function loadedTask(h: CoreHarness, spec: ViewSpec = taskKeys(1, 2)) {
  const view = h.core.view(spec)
  const sub = watch(view)
  await settle()
  expect(view.getSnapshot().status).toBe("ready")
  return { view, sub }
}

const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

/** Сервер недоступний для читань `down()` — відмова приходить мікрозадачею. */
function breakServer(
  h: CoreHarness,
  down: (object: string | undefined) => boolean,
  moments: { at: number; object: string | undefined }[] = []
) {
  h.fake.hold = (read) => {
    if (!down(read.object)) return false
    moments.push({ at: Date.now(), object: read.object })
    queueMicrotask(() => read.fail("command.internal" as CommandErrorCode))
    return true
  }
  return moments
}

const readsAt = (h: CoreHarness) => h.fake.log.length

describe("scheduler: one timer", () => {
  it("a visible view and a visible tab — exactly 1 timer; resume() five times — still 1; no targets — 0", async () => {
    const h = build()
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
    const a = await loadedTask(h, taskKeys(1, 2))
    await loadedTask(h, orgKeys(1))
    await loadedTask(h, taskKeys(3))
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    for (let i = 0; i < 5; i++) h.core.resume()
    await settle()
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    a.sub.unsubscribe()
    h.core.setVisible(orgKeys(1), false)
    h.core.setVisible(taskKeys(3), false)
    await settle()
    // Вигляд без підписки не ціль; решта звільняється після `releaseDelayMs`.
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
  })

  it("resume() → suspend() → resume() within 1 s — exactly 1 timer: the coalescing suppresses only the reconciliation", async () => {
    const h = build()
    await loadedTask(h)
    h.core.resume()
    await settle()
    h.core.suspend()
    await settle()
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
    await advance(500)
    const base = readsAt(h)
    h.core.resume()
    await settle()
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    expect(readsAt(h)).toBe(base)
  })

  it("visible: false at creation — 0 timers until resume()", async () => {
    const h = build({ visible: false })
    await loadedTask(h)
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    h.core.resume()
    await settle()
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(1)
  })

  it("setVisible of a hundred views in one microtask — one re-plan", async () => {
    const h = build({ limits: { viewsMax: 200 } })
    for (let n = 0; n < 100; n++) h.fake.insert(TASK, { ref: key(100 + n) })
    const specs = Array.from({ length: 100 }, (_, n) => taskKeys(100 + n))
    for (const spec of specs) watch(h.core.view(spec))
    await settle()
    const before = h.inspect.schedulerPlans()
    for (const spec of specs) h.core.setVisible(spec, false)
    await settle()
    expect(h.inspect.schedulerPlans() - before).toBe(1)
  })

  it("subscribe to a view held by preload (read at r) with no timer — 1 timer, the tick at r + I", async () => {
    const h = build()
    const spec = taskKeys(1, 2)
    void h.core.preload(spec, { ttlMs: 10 * I })
    await settle()
    const r = Date.now()
    expect(readsAt(h)).toBe(1)
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
    await advance(20_000)
    const sub = watch(h.core.view(spec))
    await settle()
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(1)
    expect(readsAt(h)).toBe(1)
    await advance(r + I - 1 - Date.now())
    expect(readsAt(h)).toBe(1)
    await advance(1)
    expect(readsAt(h)).toBe(2)
    sub.unsubscribe()
  })
})

describe("scheduler: views never read", () => {
  it("a card shown from the store has no due time: 0 reads before the tick of the list holding its row", async () => {
    const h = build()
    await loadedTask(h, orgKeys(1))
    await advance(30_000)
    const base = readsAt(h)
    const card = h.core.view({ kind: "card", object: ORG, key: key(10_001) })
    watch(card)
    await settle()
    expect(card.getSnapshot().status).toBe("ready")
    expect(readsAt(h), "after subscribe").toBe(base)
    await advance(I - 30_000 - 1)
    expect(readsAt(h), "before tick").toBe(base)
    await advance(1)
    // Тик списку — його одне читання; картка свого читання не має.
    expect(readsAt(h)).toBe(base + 1)
  })

  it("a view subscribed after hydrate but before endHydration: 0 scheduler reads", async () => {
    const source = build()
    await loadedTask(source, orgKeys(1))
    const snapshot = JSON.parse(JSON.stringify(source.core.dehydrate()))
    const h = build()
    h.core.hydrate(snapshot)
    watch(h.core.view(orgKeys(1)))
    await settle()
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
    await advance(3 * I)
    expect(readsAt(h)).toBe(0)
  })
})

describe("scheduler: the tick", () => {
  it("due times t, t + 0.05·I, t + 0.15·I (three views of two objects): the first two in one request, the third on its own tick", async () => {
    const h = build()
    await loadedTask(h, taskKeys(1))
    await advance(0.05 * I)
    await loadedTask(h, orgKeys(1))
    await advance(0.1 * I)
    await loadedTask(h, taskKeys(2))
    expect(h.fake.requests).toEqual([1, 1, 1])
    await advance(I - 0.15 * I - 1)
    expect(h.fake.requests).toHaveLength(3)
    await advance(1)
    // Строк першого — `t + I`; другий (`+ 0,05·I`) у вікні 10 %, третій — ні.
    expect(h.fake.requests).toEqual([1, 1, 1, 2])
    await advance(0.15 * I)
    expect(h.fake.requests).toEqual([1, 1, 1, 2, 1])
  })

  it("five views of three objects with a shared due time — 1 request", async () => {
    const h = build({ objects: THREE })
    const specs = [
      taskKeys(1),
      taskKeys(2),
      orgKeys(1),
      orgKeys(2),
      thirdKeys(1),
    ]
    for (const spec of specs) watch(h.core.view(spec))
    await settle()
    expect(h.fake.requests).toHaveLength(1)
    await advance(I)
    expect(h.fake.requests).toEqual([5, 5])
  })

  it("the tick sends no version part", async () => {
    const h = build()
    await loadedTask(h)
    await advance(I)
    expect(readsAt(h)).toBe(2)
    // Частина `version` — у пакеті з `type: "version"`, лічильник частин
    // збігається з читаннями: один пакет, одна частина.
    expect(h.fake.requests).toEqual([1, 1])
  })
})

describe("scheduler: the pause after a failure", () => {
  it("the server is down from 0, the view fresh at 0, I = 60 s: 12 reads in 600 s at the moments of the pause rule", async () => {
    const h = build()
    await loadedTask(h)
    const t0 = Date.now()
    const moments = breakServer(h, () => true)
    await advance(10 * I)
    expect(moments.map((m) => (m.at - t0) / 1000)).toEqual([
      60, 66, 78, 102, 150, 210, 270, 330, 390, 450, 510, 570,
    ])
  })

  it("a success resets the pause to 6 s", async () => {
    const h = build()
    await loadedTask(h)
    const t0 = Date.now()
    let down = true
    const moments = breakServer(h, () => down)
    await advance(100_000)
    down = false
    await advance(2_000) // 102: успіх; наступний строк — 162
    expect(h.fake.log.at(-1)!.response).toBeDefined()
    down = true
    await advance(60_000) // 162: збій; наступна спроба через 6 с
    const at = moments.map((m) => (m.at - t0) / 1000)
    expect(at).toEqual([60, 66, 78, 162])
    await advance(5_999)
    expect(moments).toHaveLength(4)
    await advance(1)
    expect(moments.map((m) => (m.at - t0) / 1000)).toEqual([
      60, 66, 78, 162, 168,
    ])
  })

  it("beside a healthy view of another object, the broken one is read on its own schedule", async () => {
    const h = build()
    await loadedTask(h, taskKeys(1, 2))
    await loadedTask(h, orgKeys(1))
    const t0 = Date.now()
    const moments = breakServer(h, (object) => object === TASK)
    await advance(10 * I)
    const of = (object: string) =>
      moments.filter((m) => m.object === object).map((m) => (m.at - t0) / 1000)
    expect(of(TASK)).toEqual([
      60, 66, 78, 102, 150, 210, 270, 330, 390, 450, 510, 570,
    ])
    // Справний об'єкт читається щоінтервалу, вікно 10 % зламаний вигляд не береться.
    const healthy = h.fake.log.filter(
      (r) => r.query?.object.name === "Organization"
    )
    expect(healthy).toHaveLength(1 + 10)
  })

  it("the window of 10 % does not take a view in its pause: it is read at the end of the pause, not on the tick of another view", async () => {
    const h = build()
    const { view } = await loadedTask(h, taskKeys(1, 2))
    await loadedTask(h, orgKeys(1))
    const t0 = Date.now()
    const moments = breakServer(h, (object) => object === TASK)
    await advance(57_000)
    view.refresh() // збій о 57 с: пауза до 63 с
    await settle()
    await advance(3_000) // 60 с: такт справного вигляду
    expect(moments.map((m) => (m.at - t0) / 1000)).toEqual([57])
    expect(h.fake.requests.at(-1)).toBe(1)
    await advance(3_000)
    expect(moments.map((m) => (m.at - t0) / 1000)).toEqual([57, 63])
  })

  it("refresh() fails at 30 s: 0 reads before 36 s, exactly 1 at 36 s", async () => {
    const h = build()
    const { view } = await loadedTask(h)
    await advance(30_000)
    breakServer(h, () => true)
    view.refresh()
    await settle()
    h.fake.hold = undefined
    const base = readsAt(h)
    await advance(5_999)
    expect(readsAt(h)).toBe(base)
    await advance(1)
    expect(readsAt(h)).toBe(base + 1)
  })
})

describe("scheduler: visibility", () => {
  it("a tab hidden for 10 min — 0 reads; the same scenario visible — exactly 10", async () => {
    const hidden = build()
    await loadedTask(hidden)
    hidden.core.suspend()
    const base = readsAt(hidden)
    await advance(10 * I)
    expect(readsAt(hidden)).toBe(base)
    expect(hidden.inspect.serviceSizes().schedulerTimers).toBe(0)

    const visible = build()
    await loadedTask(visible)
    const start = readsAt(visible)
    await advance(10 * I)
    expect(readsAt(visible) - start).toBe(10)
  })

  it("the visibility is checked at the moment of firing: a timer that outlived suspend() reads nothing", async () => {
    const h = build()
    h.inspect.defects.add("scheduler-keeps-timer-on-suspend")
    await loadedTask(h)
    h.core.suspend()
    // Прапорець лишає таймер: без перевірки при спрацюванні він би читав.
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(1)
    const base = readsAt(h)
    await advance(3 * I)
    expect(readsAt(h)).toBe(base)
  })

  it("resume() after a hidden stretch plans the timer again", async () => {
    const h = build()
    await loadedTask(h)
    h.core.suspend()
    await advance(5 * I)
    h.core.resume()
    await settle()
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(1)
  })
})

describe("scheduler: the discard limit", () => {
  it("a view in error with the exhausted discard limit: 0 scheduler reads in 10 intervals, 0 timers; refresh() — 1 read", async () => {
    // Строк перемикання епохи — `U[0, I)`: фіксуємо його в кінці інтервалу,
    // щоб він не втручався у дев'ять читань нижче.
    vi.spyOn(Math, "random").mockReturnValue(0.999)
    const big = 10_000_000
    const h = build({ mode: "manual", limits: { revalidateIntervalMs: big } })
    h.fake.epoch = EA
    const view = h.core.view(taskKeys(1, 2))
    watch(view)
    const deliver = async () => {
      await settle()
      h.fake.deliverAll()
      await settle()
    }
    await deliver()
    h.fake.epoch = EB
    view.refresh()
    await deliver()
    h.fake.epoch = EA
    view.refresh()
    for (let i = 0; i < DISCARDS_MAX; i++) {
      await deliver()
      vi.advanceTimersByTime(60_000)
    }
    await settle()
    expect(h.inspect.versionEpochs().unavailable).toBe(true)
    expect(view.getSnapshot()).toMatchObject({
      status: "error",
      error: { code: "command.unavailable" },
    })
    // Строк перемикання епохи (теж планувальника) настає в межах `I`.
    await vi.advanceTimersByTimeAsync(big)
    await deliver()
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
    const base = readsAt(h)
    await vi.advanceTimersByTimeAsync(10 * big)
    await deliver()
    expect(readsAt(h)).toBe(base)
    expect(h.fake.pending).toHaveLength(0)
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
    view.refresh()
    await settle()
    expect(readsAt(h)).toBe(base + 1)
  })
})

describe("scheduler: close", () => {
  it("dispose() leaves 0 timers", async () => {
    const h = build()
    await loadedTask(h)
    expect(vi.getTimerCount()).toBe(1)
    h.core.close("disposed")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a tick in flight during dispose(): after settling, 0 timers and nothing written", async () => {
    const h = build({ mode: "manual" })
    const view = h.core.view(taskKeys(1, 2))
    watch(view)
    await settle()
    h.fake.deliverAll()
    await settle()
    await advance(I)
    expect(h.fake.pending).toHaveLength(1)
    h.core.close("disposed")
    expect(vi.getTimerCount()).toBe(0)
    h.fake.deliverAll()
    await settle()
    expect(vi.getTimerCount()).toBe(0)
    expect(h.inspect.rowCount()).toBe(0)
    expect(view.getSnapshot().status).toBe("purged")
    expect(h.inspect.violations()).toEqual([])
  })
})

/** Запити (не частини), що пішли після `base` частин журналу. */
const requestsSince = (h: CoreHarness, base: number) =>
  new Set(h.fake.log.slice(base).map((l) => l.request)).size

describe("scheduler: the seam of the rights block (B5b)", () => {
  /** Три об'єкти з видимими виглядами, прочитаними в момент 0. */
  async function threeObjects(visible = true) {
    const h = build({ objects: THREE, visible })
    for (const spec of [taskKeys(1, 2), orgKeys(1), thirdKeys(1)])
      watch(h.core.view(spec))
    await settle()
    return h
  }

  it("requestReread with jitterMs 0 for three objects in one turn: 1 request after the microtask, no timer advanced", async () => {
    const h = await threeObjects()
    const base = readsAt(h)
    h.core.freshness.requestReread([TASK, ORG, THIRD_OBJ], { jitterMs: 0 })
    h.core.freshness.requestReread([TASK], { jitterMs: 0 })
    await settle()
    expect(readsAt(h) - base).toBe(3)
    expect(requestsSince(h, base)).toBe(1)
  })

  it("requestReread on a hidden tab: 0 reads, the due time waits for resume()", async () => {
    const h = await threeObjects()
    h.core.suspend()
    const base = readsAt(h)
    h.core.freshness.requestReread([TASK, ORG], { jitterMs: 0 })
    await settle()
    await advance(5_000)
    expect(readsAt(h)).toBe(base)
    h.core.resume()
    await settle()
    expect(readsAt(h) - base).toBeGreaterThanOrEqual(2)
  })

  it("requestReread spreads the due time over [0, jitterMs): nothing before it, 1 read at it", async () => {
    const h = await threeObjects()
    vi.spyOn(Math, "random").mockReturnValue(0.5)
    const base = readsAt(h)
    h.core.freshness.requestReread([TASK], { jitterMs: 10_000 })
    await advance(4_999)
    expect(readsAt(h)).toBe(base)
    await advance(1)
    expect(readsAt(h)).toBe(base + 1)
  })

  it("lastTickAt: the start of the last tick that read; a tick without targets leaves it", async () => {
    const h = await threeObjects()
    expect(h.core.freshness.lastTickAt()).toBeUndefined()
    const startedAt = Date.now()
    await advance(I)
    expect(h.core.freshness.lastTickAt()).toBe(startedAt + I)
    // Об'єкт без видимих виглядів: строк настав, а читати нічого.
    const h2 = build({ objects: THREE })
    watch(h2.core.view(taskKeys(1)))
    await settle()
    await advance(I)
    const at = h2.core.freshness.lastTickAt()
    expect(at).toBeDefined()
    h2.core.freshness.requestReread([ORG], { jitterMs: 0 })
    await settle()
    expect(h2.core.freshness.lastTickAt()).toBe(at)
  })
})

describe("scheduler: a synchronous failure of the tick", () => {
  it("a throwing tick does not kill the timer: the next due time fires", async () => {
    let ticks = 0
    const scheduler = createScheduler({
      now: () => Date.now(),
      visible: () => true,
      closed: () => false,
      dueAt: () => (ticks < 2 ? Date.now() + 10 : undefined),
      tick() {
        ticks++
        if (ticks === 1) throw new Error("tick failed")
      },
      defects: new Set(),
    })
    scheduler.request()
    await settle()
    expect(() => vi.advanceTimersByTime(10)).toThrow("tick failed")
    await settle()
    expect(scheduler.timers()).toBe(1)
    vi.advanceTimersByTime(10)
    expect(ticks).toBe(2)
  })
})

describe("scheduler: the tail of an explicit revalidate", () => {
  it("a later call with visibleOnly: false joins the pending tail and is not lost", async () => {
    const h = build({ mode: "manual" })
    const spec = taskKeys(1, 2)
    const view = h.core.view(spec)
    watch(view)
    const deliver = async () => {
      await settle()
      h.fake.deliverAll()
      await settle()
    }
    await deliver()
    h.core.setVisible(spec, false)
    view.refresh()
    await settle()
    expect(h.fake.pending).toHaveLength(1)
    void h.core.revalidate(TASK, { visibleOnly: true })
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const base = readsAt(h)
    await deliver()
    // Хвіст бере суму викликів: невидимий вигляд перечитано один раз.
    await deliver()
    expect(readsAt(h) - base).toBe(1)
  })
})
