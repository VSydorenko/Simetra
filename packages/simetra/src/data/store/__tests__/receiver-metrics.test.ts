import { channelTopic, type RightsRow } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import { QUIET_MS, REJOIN_JITTER_MS } from "../receiver"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import type { CoreLogEntry, Key, ViewSpec } from "../types"
import { TASK, key, S, seed, settle, setup, task } from "./core-support"

/*
 * Метрики приймача (план B5b-3, задача 5; спека П4-B §8.4 «Метрики»): записи
 * `stale-age` і `revalidate-burst` у журналі ядра — лише вид об'єкта,
 * лічильники й час; без ключів і значень, і без запису, коли значення немає.
 */

const USER = "00000000-0000-4000-8000-0000000000a1"

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const read: RightsRow = {
  level: "scope",
  levelId: null,
  scope: S,
  container: null,
  object: "task",
  action: "read",
  extent: "any",
  dimensionId: null,
}
const channel = channelTopic({
  kind: "changes",
  scopeKindId: SCOPE_KIND_ID,
  scope: S,
  object: task.id,
})
const keysView = (...keys: Key[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys,
})

async function open() {
  const transport = createFakeSignalTransport()
  const h = setup({ rightsSnapshot: true, signals: transport })
  h.fake.rightsSnapshot = {
    userId: USER,
    scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
    rights: [read],
    members: [],
    dimensionValues: [],
  }
  h.fake.rightsVersion = "1".repeat(64)
  seed(h.fake, 1, 3)
  const handle = h.core.view(keysView(key(1)))
  handle.subscribe(() => {})
  await settle()
  expect(transport.subscribed().has(channel)).toBe(true)
  h.log.length = 0
  return { ...h, transport, handle }
}

let seq = 0
const change = (k: Key, rowVer: number) => ({
  id: String(++seq),
  object: task.id,
  op: "update",
  keys: { id: k },
  row_ver: rowVer,
})
const metrics = (log: readonly CoreLogEntry[]) =>
  log.filter((e) => e.kind === "stale-age" || e.kind === "revalidate-burst")
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

describe("receiver metrics", () => {
  it("writes revalidate-burst for a batch that re-reads, with counters only", async () => {
    const h = await open()
    const version = h.fake.edit(TASK, key(1), { title: "SECRET-TITLE" })
    h.transport.emit(channel, change(key(1), version))
    await advance(QUIET_MS)
    expect(metrics(h.log)).toEqual([
      { kind: "revalidate-burst", objects: 1, views: 1 },
    ])
    const text = JSON.stringify(h.log)
    expect(text).not.toContain(key(1))
    expect(text).not.toContain("SECRET-TITLE")
  })

  it("writes no burst for an echo that re-reads nothing", async () => {
    const h = await open()
    h.transport.emit(channel, change(key(1), 1))
    await advance(QUIET_MS)
    expect(h.fake.requests).not.toHaveLength(0)
    expect(metrics(h.log)).toEqual([])
  })

  it("writes revalidate-burst for a rejoin wave that re-reads, and none without a view to read", async () => {
    const h = await open()
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    expect(metrics(h.log)).toEqual([
      { kind: "revalidate-burst", objects: 1, views: 1 },
    ])
    h.log.length = 0
    h.core.setVisible(keysView(key(1)), false)
    h.transport.join(channel, false)
    await advance(2 * REJOIN_JITTER_MS)
    expect(metrics(h.log).filter((e) => e.kind === "revalidate-burst")).toEqual(
      []
    )
  })

  it("writes stale-age on a tick while a disconnect mark exists, and not once it is lifted", async () => {
    const h = await open()
    h.transport.fail({ kind: "transport", channel })
    await advance(1000)
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    const ages = h.log.filter((e) => e.kind === "stale-age")
    expect(ages).toHaveLength(1)
    expect(ages[0]).toMatchObject({ object: TASK })
    expect((ages[0] as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(
      REJOIN_JITTER_MS / 2
    )
    // Позначку знято перечитуванням хвилі: наступні такти мовчать.
    h.log.length = 0
    await advance(130_000)
    expect(h.log.filter((e) => e.kind === "stale-age")).toEqual([])
  })

  it("writes stale-age for a min-version mark, with the age of the mark", async () => {
    const h = await open()
    const served = h.fake.edit(TASK, key(1), { title: "v" })
    h.transport.emit(channel, change(key(1), served + 1))
    await advance(QUIET_MS)
    expect(h.handle.getSnapshot().rows[0]!.state).toBe("stale")
    h.log.length = 0
    await advance(70_000)
    const ages = h.log.filter((e) => e.kind === "stale-age")
    expect(ages.length).toBeGreaterThan(0)
    expect((ages[0] as { ageMs: number }).ageMs).toBeGreaterThanOrEqual(50_000)
    expect(JSON.stringify(ages)).not.toContain(key(1))
  })

  it("writes no burst on a hidden tab: the batch reads nothing", async () => {
    const h = await open()
    h.core.suspend()
    h.log.length = 0
    const version = h.fake.edit(TASK, key(1), { title: "v" })
    h.transport.emit(channel, change(key(1), version))
    await advance(QUIET_MS)
    expect(metrics(h.log)).toEqual([])
  })

  it("counts only the visible views of the object in a batch and in a wave", async () => {
    const h = await open()
    const other = h.core.view(keysView(key(2)))
    other.subscribe(() => {})
    await settle()
    h.core.setVisible(keysView(key(2)), false)
    h.log.length = 0
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    const version = h.fake.edit(TASK, key(1), { title: "v" })
    h.transport.emit(channel, change(key(1), version))
    await advance(QUIET_MS)
    expect(metrics(h.log)).toEqual([
      { kind: "revalidate-burst", objects: 1, views: 1 },
      { kind: "revalidate-burst", objects: 1, views: 1 },
    ])
  })

  it("measures the age of a flapping channel from the second disconnect mark", async () => {
    const h = await open()
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    h.log.length = 0
    await advance(10_000)
    h.transport.fail({ kind: "transport", channel })
    const second = performance.now()
    await advance(1000)
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    const ages = h.log.filter((e) => e.kind === "stale-age")
    expect(ages).toHaveLength(1)
    expect((ages[0] as { ageMs: number }).ageMs).toBeLessThanOrEqual(
      performance.now() - second
    )
  })

  it("measures the age of a min-version mark cleared and set again from the second mark", async () => {
    const h = await open()
    const served = h.fake.edit(TASK, key(1), { title: "v" })
    h.transport.emit(channel, change(key(1), served + 1))
    await advance(QUIET_MS)
    expect(h.handle.getSnapshot().rows[0]!.state).toBe("stale")
    h.fake.edit(TASK, key(1), { title: "v2" })
    await advance(500)
    expect(h.handle.getSnapshot().rows[0]!.state).not.toBe("stale")
    await advance(20_000)
    h.log.length = 0
    const second = performance.now()
    const served2 = h.fake.edit(TASK, key(1), { title: "v3" })
    h.transport.emit(channel, change(key(1), served2 + 1))
    await advance(QUIET_MS)
    expect(h.handle.getSnapshot().rows[0]!.state).toBe("stale")
    // Крок за кроком до першого запису: `now` тоді — мить такту.
    for (let n = 0; n < 90 && !h.log.some((e) => e.kind === "stale-age"); n++)
      await advance(1000)
    const ages = h.log.filter((e) => e.kind === "stale-age")
    expect(ages.length).toBeGreaterThan(0)
    expect((ages[0] as { ageMs: number }).ageMs).toBeLessThanOrEqual(
      performance.now() - second
    )
  })

  it("does not report a gap whose row the server deleted during it", async () => {
    const h = await open()
    h.transport.fail({ kind: "transport", channel })
    h.fake.remove(TASK, key(1))
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    h.log.length = 0
    await advance(130_000)
    expect(h.log.filter((e) => e.kind === "stale-age")).toEqual([])
  })

  it("writes nothing after dispose", async () => {
    const h = await open()
    h.transport.fail({ kind: "transport", channel })
    h.core.close("disposed")
    h.log.length = 0
    h.transport.join(channel, false)
    await advance(130_000)
    expect(metrics(h.log)).toEqual([])
  })
})
