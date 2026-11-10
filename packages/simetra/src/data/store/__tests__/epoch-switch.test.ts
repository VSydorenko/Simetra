import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCore, inspectCore } from "../core"
import { keyId } from "../epoch"
import { createCoreSource, createReadLimiter } from "../source"
import { DISCARDS_MAX } from "../session"
import { computeRowView } from "../snapshot"
import type { ServerRow, ViewSpec } from "../types"
import {
  TASK,
  isKeys,
  key,
  seed,
  settle,
  setup,
  watch,
  type CoreHarness,
} from "./core-support"
import { harness, K1, row, S, type Harness } from "./store-support"

/*
 * Перемикання епохи версій бази (P4-B план B1c, Р5–Р8, Р12, Р13): версії
 * порівнюються лише в межах однієї епохи; надгробки, горизонт і поховання пар
 * від епохи не залежать.
 */

const EA = "a".repeat(64)
const EB = "b".repeat(64)
const epoch = (n: number) => n.toString(16).padStart(64, "0")

const inEpoch = (r: ServerRow, versionEpoch: string | null): ServerRow => ({
  ...r,
  versionEpoch,
})

const accept = (h: Harness, e: string | null, start = h.now()) =>
  h.write(() => h.session.acceptEpoch(e, start))

const put = (h: Harness, r: ServerRow, readEpoch = h.now()) =>
  h.write((s) => h.store.put(s, r, readEpoch, false))

const stateOf = (h: Harness) =>
  computeRowView(K1, h.store.get(K1)!, [], undefined)

/** Пам'ять версій ключа: запис у сховищі й звільнення. */
const remember = (h: Harness, r: ServerRow) => {
  put(h, r)
  h.write((s) => h.store.own(s, K1))
  h.write((s) => h.store.disown(s, K1))
}

describe("acceptEpoch (Р6, Р7, Р12)", () => {
  it("A, null, A: no switch", () => {
    const h = harness()
    expect(accept(h, EA)).toBe("apply")
    expect(accept(h, null)).toBe("apply")
    expect(accept(h, EA)).toBe("apply")
    expect(h.session.versions.current()).toBe(EA)
    expect(h.session.versions.previous()).toBeNull()
    expect(h.session.versions.switchedAt()).toBe(0)
  })

  it("A, B, A: the second A is discarded and does not switch, also after ten other switches", () => {
    const h = harness()
    accept(h, EA)
    expect(accept(h, EB)).toBe("apply")
    expect(h.session.versions.current()).toBe(EB)
    expect(accept(h, EA)).toBe("discard")
    expect(h.session.versions.current()).toBe(EB)
    for (let n = 1; n <= 10; n++) expect(accept(h, epoch(n))).toBe("apply")
    expect(accept(h, EA)).toBe("discard")
    expect(accept(h, EB)).toBe("discard")
    expect(h.session.versions.current()).toBe(epoch(10))
  })

  it("a read started before the switch: another epoch is discarded, the current one applies", () => {
    const h = harness()
    accept(h, EA)
    const start = h.now()
    accept(h, EB)
    expect(accept(h, epoch(7), start)).toBe("discard")
    expect(accept(h, EB, start)).toBe("apply")
    expect(h.session.versions.current()).toBe(EB)
  })

  it(`${DISCARDS_MAX} discarded in a row: unavailable, even for null`, () => {
    const h = harness()
    accept(h, EA)
    accept(h, EB)
    for (let i = 1; i < DISCARDS_MAX; i++) accept(h, EA)
    expect(h.session.versions.unavailable()).toBe(false)
    // Застосована відповідь обриває серію.
    accept(h, EB)
    for (let i = 1; i < DISCARDS_MAX; i++) accept(h, EA)
    expect(h.session.versions.unavailable()).toBe(false)
    accept(h, EA)
    expect(h.session.versions.unavailable()).toBe(true)
    expect(accept(h, null)).toBe("discard")
    expect(accept(h, EB)).toBe("discard")
  })

  it("throws outside commit", () => {
    const h = harness()
    expect(() => h.session.acceptEpoch(EA, 0)).toThrow(
      "acceptEpoch outside commit"
    )
  })
})

describe("store after a switch (Р5, Р8, Р13)", () => {
  it("a null row of a higher version does not replace a row of the current epoch: the key is stale", () => {
    const h = harness()
    accept(h, EA)
    put(h, inEpoch(row(K1, 5), EA))
    accept(h, EB)
    put(h, inEpoch(row(K1, 2), EB))
    expect(stateOf(h)).toMatchObject({ version: 2, state: "synced" })
    expect(put(h, inEpoch(row(K1, 9), null))).toBe("stale-inserted")
    expect(stateOf(h)).toMatchObject({ version: 2, state: "stale" })
    expect(h.store.drainTail()).toEqual([K1])
    // Повторна `null`-відповідь (хвіст від репліки) перечитування не крутить.
    expect(put(h, inEpoch(row(K1, 9), null))).toBe("rejected")
    expect(h.store.drainTail()).toEqual([])
  })

  it("the switch marks every row stale; an answer of the new epoch read after it clears the mark", () => {
    const h = harness()
    accept(h, EA)
    const start = h.now()
    put(h, inEpoch(row(K1, 5), EA))
    accept(h, EB)
    expect(stateOf(h).state).toBe("stale")
    // Читання до перемикання підтвердити рядка не може (Р13).
    put(h, inEpoch(row(K1, 1), EB), start)
    expect(stateOf(h)).toMatchObject({ version: 1, state: "stale" })
    put(h, inEpoch(row(K1, 1), EB))
    expect(stateOf(h)).toMatchObject({ version: 1, state: "synced" })
  })

  it("a null answer does not clear the epoch mark", () => {
    const h = harness()
    accept(h, EA)
    put(h, inEpoch(row(K1, 5), EA))
    accept(h, EB)
    expect(put(h, inEpoch(row(K1, 6), null))).toBe("written")
    expect(h.store.get(K1)).toMatchObject({ version: 6, versionEpoch: EA })
    expect(stateOf(h).state).toBe("stale")
  })

  it("stale.minVersion of the old epoch does not hold back the first read of the new one", () => {
    const h = harness()
    accept(h, EA)
    put(h, inEpoch(row(K1, 5), EA))
    h.write((s) => h.store.markStale(s, [K1], 7))
    expect(h.store.get(K1)?.stale.minVersion).toMatchObject({
      v: 7,
      versionEpoch: EA,
    })
    accept(h, EB)
    put(h, inEpoch(row(K1, 3), EB))
    expect(stateOf(h)).toMatchObject({ version: 3, state: "synced" })
  })

  it("the memory of epoch A is not taken into account for an answer of B", () => {
    const h = harness()
    accept(h, EA)
    remember(h, inEpoch(row(K1, 5), EA))
    expect(h.session.epochs.seen(keyId("Catalog.Task", K1))).toMatchObject({
      version: 5,
      versionEpoch: EA,
    })
    accept(h, EB)
    put(h, inEpoch(row(K1, 3), EB))
    expect(stateOf(h)).toMatchObject({ version: 3, state: "synced" })
    expect(h.store.get(K1)?.stale.minVersion).toBeUndefined()
  })

  it("a null row below the remembered version is stale, not synced", () => {
    const h = harness()
    accept(h, EA)
    remember(h, inEpoch(row(K1, 5), EA))
    accept(h, EB)
    put(h, inEpoch(row(K1, 3), null))
    expect(h.store.get(K1)?.stale.minVersion).toMatchObject({ v: 5 })
    expect(stateOf(h)).toMatchObject({ version: 3, state: "stale" })
  })

  it("memory of the old epoch is not refreshed; versions of the current one are", () => {
    const h = harness()
    accept(h, EA)
    put(h, inEpoch(row(K1, 5), EA))
    h.write((s) => h.store.own(s, K1))
    accept(h, EB)
    h.write((s) => h.store.disown(s, K1))
    expect(h.session.epochs.seen(keyId("Catalog.Task", K1))).toBeUndefined()
    remember(h, inEpoch(row(K1, 2), EB))
    expect(h.session.epochs.seen(keyId("Catalog.Task", K1))).toMatchObject({
      version: 2,
      versionEpoch: EB,
    })
  })

  it("a read started before buryPair with an answer of epoch B: the row is not written", () => {
    const h = harness()
    accept(h, EA)
    const start = h.now()
    h.write((s) => h.store.purgeScope(s, S))
    expect(accept(h, EB, start)).toBe("apply")
    expect(put(h, inEpoch(row(K1, 1), EB), start)).toBe("rejected")
    expect(h.store.get(K1)).toBeUndefined()
  })

  it("purge after a switch works as before", () => {
    const h = harness()
    accept(h, EA)
    put(h, inEpoch(row(K1, 5), EA))
    accept(h, EB)
    const start = h.now()
    expect(h.write((s) => h.store.purgeKeys(s, [K1]))).toEqual([K1])
    expect(put(h, inEpoch(row(K1, 6), EB), start)).toBe("rejected")
    expect(h.store.get(K1)).toBeUndefined()
    expect(put(h, inEpoch(row(K1, 6), EB))).toBe("written")
  })

  it("lines written without an epoch before a switch do not hold back lines of the new epoch", () => {
    const h = harness()
    accept(h, EA)
    const lines = (ownerVersion: number, versionEpoch: string | null) =>
      h.write((s) =>
        h.sections.put(
          s,
          K1,
          "lines",
          [],
          ownerVersion,
          versionEpoch,
          h.now(),
          S,
          "owner-section"
        )
      )
    expect(lines(5, null)).toBe("written")
    expect(h.sections.get(K1, "lines")?.versionEpoch).toBeNull()
    accept(h, EB)
    expect(h.sections.get(K1, "lines")?.versionEpoch).toBe(EA)
    expect(lines(1, EB)).toBe("written")
    expect(h.sections.get(K1, "lines")).toMatchObject({
      ownerVersion: 1,
      versionEpoch: EB,
    })
    // `null`-рядки після перемикання не заміняють рядків поточної епохи.
    expect(lines(9, null)).toBe("rejected")
  })
})

// ------------------------------------------------------------ ядро

const keysView = (...ns: number[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys: ns.map(key),
})
const INTERVAL = 1_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Відповідає на всі утримані читання й дає дійти мікрозадачам. */
async function deliver(h: CoreHarness) {
  await settle()
  h.fake.deliverAll()
  await settle()
}

/** Ядро з видимим списком рядків 1 і 2, завантаженим в епосі A. */
async function loaded() {
  const h = setup({
    mode: "manual",
    limits: { revalidateIntervalMs: INTERVAL },
  })
  seed(h.fake, 1, 2)
  h.fake.epoch = EA
  const handle = h.core.view(keysView(1, 2))
  const sub = watch(handle)
  await deliver(h)
  expect(handle.getSnapshot().rows).toMatchObject([
    { state: "synced" },
    { state: "synced" },
  ])
  return { ...h, handle, sub }
}

describe("core: the epoch switch", () => {
  it("A → B: the answer that switched applies, rows are stale and re-read within the interval, not at once", async () => {
    const h = await loaded()
    h.fake.edit(TASK, key(1), { title: "b1" })
    h.fake.epoch = EB
    h.handle.refresh()
    // Розкид — у межах інтервалу: випадкове значення під кінець.
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    await deliver(h)
    expect(h.inspect.versionEpochs()).toMatchObject({
      current: EB,
      previous: EA,
    })
    expect(h.handle.getSnapshot().rows).toMatchObject([
      { state: "stale", values: { title: "b1" } },
      { state: "stale" },
    ])
    await settle()
    expect(h.fake.pending).toHaveLength(0)
    expect(h.inspect.serviceSizes().switchTimers).toBe(1)
    vi.advanceTimersByTime(INTERVAL - 11)
    await settle()
    expect(h.fake.pending).toHaveLength(0)
    vi.advanceTimersByTime(10)
    await settle()
    expect(h.fake.pending.filter(isKeys)).toHaveLength(1)
    await deliver(h)
    expect(h.handle.getSnapshot().rows).toMatchObject([
      { state: "synced", values: { title: "b1" } },
      { state: "synced" },
    ])
  })

  it("a late answer of A after the switch is not applied", async () => {
    const h = await loaded()
    const other = watch(h.core.view(keysView(2)))
    await deliver(h)
    h.handle.refresh()
    await settle()
    const late = h.fake.take()
    h.fake.edit(TASK, key(1), { title: "late" })
    h.fake.epoch = EB
    h.core.view(keysView(2)).refresh()
    await deliver(h)
    expect(h.inspect.versionEpochs().current).toBe(EB)
    h.fake.epoch = EA
    late.answer()
    await settle()
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({
      values: { title: "t1" },
    })
    other.unsubscribe()
  })

  it(`${DISCARDS_MAX} discarded answers in a row: command.unavailable; a new session works`, async () => {
    const h = await loaded()
    h.fake.epoch = EB
    h.handle.refresh()
    await deliver(h)
    h.fake.epoch = EA
    h.handle.refresh()
    for (let i = 0; i < DISCARDS_MAX; i++) {
      await deliver(h)
      vi.advanceTimersByTime(60_000)
    }
    await settle()
    expect(h.inspect.versionEpochs().unavailable).toBe(true)
    expect(h.handle.getSnapshot()).toMatchObject({
      status: "error",
      error: { code: "command.unavailable" },
    })
    expect(h.fake.pending).toHaveLength(0)

    // Нова сесія над тією самою базою читає знову.
    const core = createCore({
      subject: "u1",
      source: createCoreSource(
        () => h.fake.adapter,
        h.fake.index,
        createReadLimiter(4)
      ),
      index: h.fake.index,
    })
    const fresh = watch(core.view(keysView(1, 2)))
    void fresh
    await deliver(h)
    expect(core.view(keysView(1, 2)).getSnapshot()).toMatchObject({
      status: "ready",
      rows: [{ state: "synced" }, { state: "synced" }],
    })
    expect(inspectCore(core).versionEpochs()).toMatchObject({
      current: EA,
      unavailable: false,
    })
  })

  it("close clears the timers of a switch", async () => {
    const h = await loaded()
    h.fake.epoch = EB
    h.handle.refresh()
    await deliver(h)
    expect(h.inspect.serviceSizes().switchTimers).toBe(1)
    h.core.close("disposed")
    expect(h.inspect.serviceSizes().switchTimers).toBe(0)
    vi.advanceTimersByTime(INTERVAL)
    await settle()
    expect(h.fake.pending).toHaveLength(0)
  })
})
