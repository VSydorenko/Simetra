import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RightsSnapshot } from "simetra/model"
import type { ViewSpec } from "../types"
import { TASK, key, seed, settle, setup, watch } from "./core-support"

/*
 * Службова частина `rights` у `reconcile` і строк знімка в ядрі (спека П4-B
 * §8.4 «Склад службових частин»; план B5b-2, Р2, задача 3). Часом керують
 * фейкові таймери, годинник ядра — `Date.now()`.
 */

const I = 60_000
const USER = "00000000-0000-4000-8000-0000000000a1"
const V1 = "1".repeat(64)
const V2 = "2".repeat(64)
const SNAPSHOT: RightsSnapshot = {
  userId: USER,
  scopeSets: [],
  rights: [],
  members: [],
  dimensionValues: [],
}
const list: ViewSpec = { kind: "keys", object: TASK, keys: [key(1), key(2)] }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const build = (options: { visible?: boolean } = {}) => {
  const h = setup({
    mode: "auto",
    now: () => Date.now(),
    limits: { revalidateIntervalMs: I },
    rightsSnapshot: true,
    ...options,
  })
  seed(h.fake, 1, 4)
  h.fake.rightsSnapshot = SNAPSHOT
  h.fake.rightsVersion = V1
  return h
}

const open = async (options: { visible?: boolean } = {}) => {
  const h = build(options)
  const view = h.core.view(list)
  const sub = watch(view)
  await settle()
  expect(view.getSnapshot().status).toBe("ready")
  return { ...h, view, sub }
}

const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

describe("the rights deadline of the snapshot", () => {
  it("revokes by I: the tick re-reads the view and carries rights with known in one request", async () => {
    const h = await open()
    expect(h.fake.rightsReads).toEqual([undefined])
    h.fake.rightsSnapshot = { ...SNAPSHOT, scopeSets: [] }
    h.fake.rightsVersion = V2
    const from = h.fake.requests.length
    await advance(I)
    // Одне читання виду й одна частина `rights`: 2 частини в 1 запиті.
    expect(h.fake.requests.slice(from)).toEqual([2])
    expect(h.fake.rightsReads).toEqual([undefined, V1])
    expect(h.core.rights()!.rightsVersion).toBe(V2)
  })

  it("views and rights sent 50 ms apart are still one request after I: views with rights", async () => {
    const h = await open()
    await advance(50)
    h.core.requestRights()
    await settle()
    expect(h.fake.rightsReads).toEqual([undefined, V1])
    const from = h.fake.requests.length
    await advance(I - 50)
    // Строк виду настав, строк знімка — через 50 мс, у вікні 0,1 × I.
    expect(h.fake.requests.slice(from)).toEqual([2])
    expect(h.fake.rightsReads).toEqual([undefined, V1, V1])
  })

  it("a tab with no visible views: a rights-only request, lastTickAt does not move", async () => {
    const h = await open()
    h.core.setVisible(list, false)
    const at = h.core.freshness.lastTickAt()
    const from = h.fake.requests.length
    await advance(I)
    expect(h.fake.requests.slice(from)).toEqual([1])
    expect(h.fake.rightsReads).toEqual([undefined, V1])
    expect(h.core.freshness.lastTickAt()).toBe(at)
    // Строк рахується від відправки: наступна частина — ще через I.
    await advance(I - 1)
    expect(h.fake.rightsReads).toHaveLength(2)
    await advance(1)
    expect(h.fake.rightsReads).toEqual([undefined, V1, V1])
    expect(h.fake.requests.slice(from)).toEqual([1, 1])
  })

  it("while the part is in flight there is no deadline: 1 s of ticks is none, 0 timers", async () => {
    const h = await open()
    h.core.setVisible(list, false)
    h.fake.holdRights = true
    await advance(I)
    expect(h.fake.rightsReads).toHaveLength(2)
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    const from = h.fake.requests.length
    await advance(1000)
    expect(h.fake.requests.length).toBe(from)
    expect(h.fake.rightsReads).toHaveLength(2)
    h.fake.releaseRights()
    await settle()
    // Відповідь повертає строк: від відправки, тож `rightsAt + I` ще попереду.
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(1)
  })

  it("counts the deadline from the actual sending, not from the queue of read slots", async () => {
    const h = setup({
      mode: "auto",
      now: () => Date.now(),
      limits: { revalidateIntervalMs: I, readParallel: 1 },
      rightsSnapshot: true,
    })
    seed(h.fake, 1, 4)
    h.fake.rightsSnapshot = SNAPSHOT
    h.fake.rightsVersion = V1
    const view = h.core.view(list)
    watch(view)
    await settle()
    h.core.setVisible(list, false)
    // Єдиний слот читань зайнято довше за I: частина `rights` чекає в черзі.
    h.fake.hold = () => true
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(h.fake.pending).toHaveLength(1)
    h.fake.hold = undefined
    h.core.requestRights()
    await settle()
    expect(h.fake.rightsReads).toEqual([undefined])
    await advance(I + 1000)
    h.fake.take().answer()
    await settle()
    // Частина пішла лише тепер: строк — через I від цієї миті.
    expect(h.fake.rightsReads).toEqual([undefined, V1])
    await advance(1000)
    expect(h.fake.rightsReads).toEqual([undefined, V1])
    await advance(I - 1000)
    expect(h.fake.rightsReads).toEqual([undefined, V1, V1])
  })

  it("an empty store has no deadline: 0 timers, 0 requests over 10 intervals", async () => {
    const h = build()
    h.core.requestRights()
    await settle()
    expect(h.fake.rightsReads).toEqual([undefined])
    expect(h.inspect.serviceSizes().schedulerTimers).toBe(0)
    await advance(10 * I)
    expect(h.fake.rightsReads).toEqual([undefined])
    expect(h.fake.requests).toEqual([1])
  })

  it("a hidden tab: 0 requests over 10 intervals, 0 timers", async () => {
    const h = await open()
    h.core.suspend()
    const from = h.fake.requests.length
    await advance(10 * I)
    expect(h.fake.requests.length).toBe(from)
    expect(h.fake.rightsReads).toEqual([undefined])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("resume() after a hidden stretch sends version and rights with known in one request", async () => {
    const h = await open()
    h.core.suspend()
    await advance(5 * I)
    const from = h.fake.requests.length
    h.core.resume()
    await settle()
    expect(h.fake.rightsReads).toEqual([undefined, V1])
    // `version`, `rights` и перечитування виду — один запит.
    expect(h.fake.requests.slice(from)).toEqual([3])
  })

  it("dispose() leaves 0 timers, nothing is sent after it", async () => {
    const h = await open()
    expect(vi.getTimerCount()).toBe(1)
    h.core.close("disposed")
    expect(vi.getTimerCount()).toBe(0)
    await advance(3 * I)
    expect(h.fake.rightsReads).toEqual([undefined])
  })

  it("sends no rights part, and no deadline, without rightsSnapshot", async () => {
    const h = setup({
      mode: "auto",
      now: () => Date.now(),
      limits: { revalidateIntervalMs: I },
    })
    seed(h.fake, 1, 4)
    watch(h.core.view(list))
    await settle()
    h.core.resume()
    await advance(I)
    expect(h.fake.rightsReads).toEqual([])
  })
})

describe("the service parts of endHydration", () => {
  it("version and rights without known, with the views, in one request", async () => {
    const source = setup()
    seed(source.fake, 1, 4)
    watch(source.core.view(list))
    await settle()
    const snapshot = JSON.parse(JSON.stringify(source.core.dehydrate()))

    const h = build()
    h.core.hydrate(snapshot)
    watch(h.core.view(list))
    h.core.endHydration()
    await settle()
    expect(h.fake.rightsReads).toEqual([undefined])
    // `version`, `rights` і перечитування виду.
    expect(h.fake.requests).toEqual([3])
  })
})
