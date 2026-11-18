import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { coreInternals } from "../core"
import { failurePause, viewDueAt } from "../subsets"
import { DEFAULT_CORE_LIMITS, type ViewSpec } from "../types"
import { TASK, isKeys, key, seed, settle, setup, watch } from "./core-support"

/*
 * Стан збоїв вигляду, строк вигляду й хвіст `revalidate` (спека П4-B §6.3,
 * §6.7): відмітки, пауза після збою, single-flight системного перечитування.
 */

const I = DEFAULT_CORE_LIMITS.revalidateIntervalMs
const list: ViewSpec = { kind: "keys", object: TASK, keys: [key(1), key(2)] }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function loaded() {
  const h = setup()
  seed(h.fake, 1, 2)
  const handle = h.core.view(list)
  watch(handle)
  await settle()
  const subset = coreInternals(h.core).registry.find(list)!
  return { ...h, handle, subset }
}

const keyReads = (h: Awaited<ReturnType<typeof loaded>>) =>
  h.fake.log.filter((r) => isKeys(r)).length

describe("failure state of a view", () => {
  it("keeps the marks of a view until its re-read settles", async () => {
    const h = await loaded()
    const { refreshedAt } = h.subset
    vi.advanceTimersByTime(5_000)
    h.fake.hold = (read) => isKeys(read)
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(h.fake.pending).toHaveLength(1)
    expect(h.subset.refreshedAt).toBe(refreshedAt)
    expect(h.subset.failures).toBe(0)
    expect(h.subset.failedAt).toBeUndefined()
  })

  it("marks a failed re-read at its start, counts it and keeps refreshedAt", async () => {
    const h = await loaded()
    const { refreshedAt } = h.subset
    vi.advanceTimersByTime(5_000)
    h.fake.hold = (read) => isKeys(read)
    const done = h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const startedAt = performance.now()
    vi.advanceTimersByTime(3_000)
    h.fake.take().fail("command.internal")
    await done
    expect(h.subset.failures).toBe(1)
    expect(h.subset.failedAt).toBe(startedAt)
    expect(h.subset.refreshedAt).toBe(refreshedAt)
    expect(h.handle.getSnapshot().status).toBe("error")
  })

  it("resets the failures on a success", async () => {
    const h = await loaded()
    h.fake.hold = (read) => isKeys(read)
    const failed = h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    h.fake.take().fail("command.internal")
    await failed
    expect(h.subset.failures).toBe(1)
    h.fake.hold = undefined
    await h.core.revalidate(TASK, { visibleOnly: true })
    expect(h.subset.failures).toBe(0)
    expect(h.subset.failedAt).toBeUndefined()
    expect(h.handle.getSnapshot().status).toBe("ready")
  })

  it("counts a failed refresh() of a loaded view", async () => {
    const h = await loaded()
    h.fake.hold = (read) => isKeys(read)
    h.handle.refresh()
    await settle()
    const startedAt = performance.now()
    vi.advanceTimersByTime(1_000)
    h.fake.take().fail("command.internal")
    await settle()
    expect(h.subset.failures).toBe(1)
    expect(h.subset.failedAt).toBe(startedAt)
  })

  it("grows the pause with the failures up to the interval", () => {
    expect(failurePause(1, I)).toBe(0.1 * I)
    expect(failurePause(2, I)).toBe(0.2 * I)
    expect(failurePause(10, I)).toBe(I)
  })

  it("has one due time: the pause after a failure, else refreshedAt + interval", async () => {
    const h = await loaded()
    expect(viewDueAt(h.subset, I)).toBe(h.subset.refreshedAt! + I)
    h.subset.failures = 2
    h.subset.failedAt = 100
    expect(viewDueAt(h.subset, I)).toBe(100 + failurePause(2, I))
  })
})

describe("reconcile with minAgeMs", () => {
  it("does not take a view in its pause after a failure, takes it after", async () => {
    const h = await loaded()
    vi.advanceTimersByTime(20_000)
    h.fake.hold = (read) => isKeys(read)
    const failed = h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    h.fake.take().fail("command.internal")
    await failed
    h.fake.hold = undefined
    const before = keyReads(h)
    vi.advanceTimersByTime(failurePause(1, I) - 1)
    await h.core.revalidate(TASK, { visibleOnly: true, minAgeMs: 0 })
    expect(keyReads(h)).toBe(before)
    vi.advanceTimersByTime(1)
    await h.core.revalidate(TASK, { visibleOnly: true, minAgeMs: 0 })
    expect(keyReads(h)).toBe(before + 1)
  })

  it("does not take a view with a load in flight", async () => {
    const h = await loaded()
    vi.advanceTimersByTime(I)
    h.fake.hold = (read) => isKeys(read)
    h.handle.refresh()
    await settle()
    const before = keyReads(h)
    await h.core.revalidate(TASK, { visibleOnly: true, minAgeMs: 0 })
    await settle()
    expect(keyReads(h)).toBe(before)
    expect(h.fake.pending).toHaveLength(1)
  })

  it("does not take a view with a system re-read in flight", async () => {
    const h = await loaded()
    vi.advanceTimersByTime(I)
    h.fake.hold = (read) => isKeys(read)
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const before = keyReads(h)
    await h.core.revalidate(TASK, { visibleOnly: true, minAgeMs: 0 })
    await settle()
    expect(keyReads(h)).toBe(before)
  })
})

describe("explicit revalidate of a view in flight", () => {
  it("adds exactly one read after the settling, with a new start epoch", async () => {
    const h = await loaded()
    h.fake.hold = (read) => isKeys(read)
    const first = h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const before = keyReads(h)
    const epochAtFirst = h.core.readEpoch()
    const tail = h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    // Склад і читання ті самі: хвіст чекає осідання, нового читання ще немає.
    expect(keyReads(h)).toBe(before)
    h.core.commit(
      (w) => w.purge("Catalog.Organization", { keys: [key(99_999)] }),
      h.core.token()
    )
    expect(h.core.readEpoch()).toBeGreaterThan(epochAtFirst)
    h.fake.take().answer()
    await first
    await settle()
    expect(keyReads(h)).toBe(before + 1)
    expect(h.fake.pending).toHaveLength(1)
    h.fake.take().answer()
    await tail
    await settle()
    expect(keyReads(h)).toBe(before + 1)
    expect(h.fake.pending).toHaveLength(0)
  })

  it("merges three calls into one tail", async () => {
    const h = await loaded()
    h.fake.hold = (read) => isKeys(read)
    const first = h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const before = keyReads(h)
    const tails = [1, 2, 3].map(() =>
      h.core.revalidate(TASK, { visibleOnly: true })
    )
    await settle()
    h.fake.take().answer()
    await first
    await settle()
    h.fake.take().answer()
    await Promise.all(tails)
    await settle()
    expect(keyReads(h)).toBe(before + 1)
  })

  it("adds one read after a load in flight", async () => {
    const h = await loaded()
    h.fake.hold = (read) => isKeys(read)
    h.handle.refresh()
    await settle()
    const before = keyReads(h)
    const tail = h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(keyReads(h)).toBe(before)
    h.fake.take().answer()
    await settle()
    expect(keyReads(h)).toBe(before + 1)
    h.fake.take().answer()
    await tail
    await settle()
    expect(keyReads(h)).toBe(before + 1)
  })
})
