import { READ_BATCH_MAX } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { coreInternals, createCore, inspectCore } from "../core"
import { keyId } from "../epoch"
import {
  createCoreSource,
  createReadLimiter,
  tracked,
  type CoreSource,
} from "../source"
import { DISCARD_PAUSE_MS, DISCARDS_MAX } from "../session"
import { computeRowView } from "../snapshot"
import type { ServerRow, ViewSpec } from "../types"
import {
  ORG,
  TASK,
  isKeys,
  isSection,
  key,
  seed,
  settle,
  setup,
  watch,
  type CoreHarness,
} from "./core-support"
import { collectCore } from "./oracles"
import { TEST_ORIGIN, withSleep } from "../testing/fake-source"
import { harness, K1, row, S, type Harness } from "./store-support"

/*
 * Перемикання епохи версій бази (спека П4-B §6.2): версії
 * порівнюються лише в межах однієї епохи; надгробки, горизонт і поховання пар
 * від епохи не залежать.
 */

const EA = "a".repeat(64)
const EB = "b".repeat(64)
const EC = "c".repeat(64)
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

describe("acceptEpoch", () => {
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

  it("a null answer breaks the series of discards", () => {
    const h = harness()
    accept(h, EA)
    accept(h, EB)
    for (let i = 1; i < DISCARDS_MAX; i++) accept(h, EA)
    expect(accept(h, null)).toBe("apply")
    for (let i = 1; i < DISCARDS_MAX; i++) accept(h, EA)
    expect(h.session.versions.unavailable()).toBe(false)
    expect(h.session.versions.discards()).toBe(DISCARDS_MAX - 1)
  })

  it(`one pass with ${DISCARDS_MAX} discarded answers counts once`, () => {
    const h = harness()
    accept(h, EA)
    accept(h, EB)
    const start = h.now()
    h.write(() => {
      for (let i = 0; i < DISCARDS_MAX; i++)
        expect(h.session.acceptEpoch(EA, start)).toBe("discard")
    })
    expect(h.session.versions.discards()).toBe(1)
    expect(h.session.versions.unavailable()).toBe(false)
  })

  it("a pass with one applied answer of the current epoch resets the counter", () => {
    const h = harness()
    accept(h, EA)
    accept(h, EB)
    for (let i = 1; i < DISCARDS_MAX; i++) accept(h, EA)
    expect(h.session.versions.discards()).toBe(DISCARDS_MAX - 1)
    const start = h.now()
    h.write(() => {
      expect(h.session.acceptEpoch(EA, start)).toBe("discard")
      expect(h.session.acceptEpoch(EB, start)).toBe("apply")
      expect(h.session.acceptEpoch(EA, start)).toBe("discard")
    })
    expect(h.session.versions.discards()).toBe(0)
    for (let i = 1; i < DISCARDS_MAX; i++) accept(h, EA)
    expect(h.session.versions.unavailable()).toBe(false)
  })

  it("a pass whose reads started before the last counted pass does not count again", () => {
    const h = harness()
    accept(h, EA)
    accept(h, EB)
    const start = h.now()
    for (let i = 0; i < DISCARDS_MAX; i++)
      expect(accept(h, EA, start)).toBe("discard")
    expect(h.session.versions.discards()).toBe(1)
    // Читання, що почалось після врахованого проходу, — наступний прохід.
    accept(h, EA)
    expect(h.session.versions.discards()).toBe(2)
    expect(h.session.versions.unavailable()).toBe(false)
  })

  it("throws outside commit", () => {
    const h = harness()
    expect(() => h.session.acceptEpoch(EA, 0)).toThrow(
      "acceptEpoch outside commit"
    )
  })
})

describe("acceptEpochs: one answer of several epochs", () => {
  /** Джерело, що відповідає на кожне читання наступною епохою з `order`. */
  const answering = (order: readonly (string | null)[]): CoreSource => {
    let at = 0
    return {
      close: () => {},
      run: () => Promise.reject(new Error("unexpected run")),
      read: async (parts) => ({
        items: parts.map(() => ({
          ok: true as const,
          rows: { rows: [] },
          epoch: order[at++] ?? null,
        })),
      }),
    }
  }

  it("tracked A → B → A: the answer is discarded although B switched", async () => {
    const h = harness()
    accept(h, EA)
    const start = h.now()
    const read = tracked(withSleep(answering([EA, EB, EA])), TEST_ORIGIN)
    for (let i = 0; i < 3; i++)
      await read.source.read([
        {
          type: "query",
          query: { object: { kind: "Catalog", name: "Task" }, id: key(1) },
        },
      ])
    expect(h.write(() => h.session.acceptEpochs(read.epochs, start))).toBe(
      "discard"
    )
    expect(h.session.versions.current()).toBe(EB)
    // Покинута епоха лишається відкинутою й окремою відповіддю.
    expect(accept(h, EA)).toBe("discard")
  })

  it("the order of the epochs does not change the outcome", () => {
    for (const order of [
      [EA, EB],
      [EB, EA],
      [EA, EB, EA],
      [null, EA, EB],
    ]) {
      const h = harness()
      accept(h, EA)
      const start = h.now()
      expect(h.write(() => h.session.acceptEpochs(order, start))).toBe(
        "discard"
      )
    }
  })

  it.each([
    ["current, abandoned", [EB, EA]],
    ["abandoned, current", [EA, EB]],
  ])(
    `${DISCARDS_MAX} passes of a discarded answer (%s): unavailable`,
    (_, order) => {
      const h = harness()
      accept(h, EA)
      accept(h, EB)
      for (let i = 0; i < DISCARDS_MAX; i++) {
        expect(h.write(() => h.session.acceptEpochs(order, h.now()))).toBe(
          "discard"
        )
        expect(h.session.versions.discards()).toBe(i + 1)
      }
      expect(h.session.versions.unavailable()).toBe(true)
    }
  )

  it.each([
    ["A, B", [EA, EB]],
    ["A, B, A", [EA, EB, EA]],
  ])(
    "an answer discarded by its own switch (%s) counts as a discarded pass",
    (_, order) => {
      const h = harness()
      accept(h, EA)
      expect(h.write(() => h.session.acceptEpochs(order, h.now()))).toBe(
        "discard"
      )
      expect(h.session.versions.discards()).toBe(1)
    }
  )

  it("epochs of one answer that leave nothing abandoned apply", () => {
    const h = harness()
    accept(h, EA)
    expect(h.write(() => h.session.acceptEpochs([EA, null, EA], h.now()))).toBe(
      "apply"
    )
    // Перша непорожня епоха стає поточною без перемикання.
    const fresh = harness()
    expect(
      fresh.write(() => fresh.session.acceptEpochs([null, EB], fresh.now()))
    ).toBe("apply")
    expect(fresh.session.versions.current()).toBe(EB)
  })
})

describe("store after a switch", () => {
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
    // Читання до перемикання підтвердити рядка не може.
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
    // Перемикання скидає позначку старої епохи одразу, а не першим записом.
    expect(h.store.get(K1)?.stale.minVersion).toBeUndefined()
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
    // `null`-рядки після перемикання не заміняють рядків поточної епохи:
    // наявні стають `stale` (одне перечитування), повтор — відкинуто.
    expect(lines(9, null)).toBe("stale")
    expect(h.sections.get(K1, "lines")).toMatchObject({
      ownerVersion: 1,
      versionEpoch: EB,
      staleEpoch: true,
    })
    expect(lines(9, null)).toBe("rejected")
    expect(lines(2, EB)).toBe("written")
    expect(h.sections.get(K1, "lines")?.staleEpoch).toBeUndefined()
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
  // Годинник ядра — `Date.now()`: строк перемикання міряється ним, тож `Date`
  // фейкується разом з таймерами.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
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
    now: () => Date.now(),
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
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(1)
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

  it("a stale-client object is not re-read after the switch and keeps isStale", async () => {
    const h = await loaded()
    h.fake.insert(ORG, { ref: S })
    h.core.staleClient(TASK)
    expect(h.handle.getSnapshot().isStale).toBe(true)
    // Перемикання приходить з читання іншого об'єкта.
    h.fake.epoch = EB
    watch(h.core.view({ kind: "keys", object: ORG, keys: [S] }))
    await deliver(h)
    expect(h.inspect.versionEpochs().current).toBe(EB)
    const before = h.fake.log.length
    vi.advanceTimersByTime(INTERVAL)
    await deliver(h)
    // Читання ORG (власне перемикання) лишається; читань TASK немає.
    expect(
      h.fake.log.slice(before).filter((l) => l.query?.object.name === "Task")
    ).toEqual([])
    expect(h.handle.getSnapshot()).toMatchObject({ isStale: true })
    expect(h.handle.getSnapshot().status).not.toBe("error")
  })

  it("a stale mark after the switch cancels the re-read timer: the view stays ready and isStale", async () => {
    const h = await loaded()
    h.fake.edit(TASK, key(1), { title: "b1" })
    h.fake.epoch = EB
    h.handle.refresh()
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    await deliver(h)
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(1)
    h.core.staleClient(TASK)
    const before = h.fake.log.length
    vi.advanceTimersByTime(INTERVAL)
    await deliver(h)
    expect(h.fake.log.length).toBe(before)
    expect(h.handle.getSnapshot()).toMatchObject({ isStale: true })
    expect(h.handle.getSnapshot().status).not.toBe("error")
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(0)
  })

  it("refresh() of a stale-client object sends no read", async () => {
    const h = await loaded()
    h.core.staleClient(TASK)
    const before = h.fake.log.length
    h.handle.refresh()
    await deliver(h)
    expect(h.fake.log.length).toBe(before)
    expect(h.handle.getSnapshot().isStale).toBe(true)
    expect(h.handle.getSnapshot().status).not.toBe("error")
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

  const MANY = 2 * READ_BATCH_MAX + 1

  /** Ядро з видимим списком MANY рядків в епосі A; ключ на частину. */
  async function loadedMany() {
    const h = setup({
      mode: "manual",
      now: () => Date.now(),
      limits: { revalidateIntervalMs: INTERVAL, keysPerRequest: 1 },
    })
    seed(h.fake, 1, MANY)
    h.fake.epoch = EA
    const handle = h.core.view(
      keysView(...Array.from({ length: MANY }, (_, i) => i + 1))
    )
    const sub = watch(handle)
    await deliver(h)
    return { ...h, handle, sub }
  }

  /** Відповідає на запити утриманого читання по черзі, кожен — своєю епохою. */
  async function answerRequests(
    h: CoreHarness,
    order: readonly (string | null)[]
  ) {
    await settle()
    const requests = [...new Set(h.fake.pending.map((r) => r.log.request))]
    expect(requests).toHaveLength(order.length)
    for (const [i, epoch] of order.entries()) {
      h.fake.epoch = epoch
      while (h.fake.pending.some((r) => r.log.request === requests[i]))
        h.fake.take((r) => r.log.request === requests[i]).answer()
      await settle()
    }
  }

  it("one read answered A → B → A: the late A part is not written, not even as stale", async () => {
    const h = await loadedMany()
    // У третьому запиті — ключ, змінений у старій базі.
    h.fake.edit(TASK, key(MANY), { title: "late" })
    h.handle.refresh()
    await answerRequests(h, [EA, EB, EA])
    expect(h.inspect.versionEpochs()).toMatchObject({
      current: EB,
      previous: EA,
    })
    const rows = h.handle.getSnapshot().rows
    expect(rows[MANY - 1]).toMatchObject({
      state: "stale",
      values: { title: `t${MANY}` },
    })
    expect(rows.every((r) => r.state === "stale")).toBe(true)
    h.sub.unsubscribe()
  })

  it("a tail re-read answered B → C → B: the late B part is not written", async () => {
    const h = await loadedMany()
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    h.fake.epoch = EB
    h.handle.refresh()
    await deliver(h)
    vi.advanceTimersByTime(INTERVAL)
    await deliver(h)
    expect(h.handle.getSnapshot().rows.every((r) => r.state === "synced")).toBe(
      true
    )
    // `null`-відповідь над рядками поточної епохи — `stale` і хвіст.
    h.fake.epoch = null
    h.handle.refresh()
    await answerRequests(h, [null, null, null])
    h.fake.edit(TASK, key(MANY), { title: "late" })
    await answerRequests(h, [EB, EC, EB])
    expect(h.inspect.versionEpochs()).toMatchObject({
      current: EC,
      previous: EB,
    })
    expect(h.handle.getSnapshot().rows[MANY - 1]).toMatchObject({
      values: { title: `t${MANY}` },
    })
    h.sub.unsubscribe()
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
        createReadLimiter(4),
        h.fake.server
      ),
      index: h.fake.index,
    })
    collectCore(core, h.fake)
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

  /** Перемикає ядро на B відповіддю на `refresh` списку. */
  async function switched() {
    const h = await loaded()
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    h.fake.epoch = EB
    h.handle.refresh()
    await deliver(h)
    expect(h.inspect.versionEpochs().current).toBe(EB)
    return h
  }

  /** Перемикання на B і перечитування, що підтверджує рядки нової епохи. */
  async function proven() {
    const h = await switched()
    vi.advanceTimersByTime(INTERVAL)
    await deliver(h)
    expect(h.handle.getSnapshot().rows).toMatchObject([
      { state: "synced" },
      { state: "synced" },
    ])
    return h
  }

  const receive = (
    h: CoreHarness,
    answer: { rows: ServerRow[]; absent: string[] },
    versionEpoch: string | null
  ) => {
    let result: "applied" | "discarded" | undefined
    h.core.commit((w) => {
      result = w.apply(TASK, answer, h.core.readEpoch(), versionEpoch)
    }, h.core.token())
    return result
  }

  it("a receiver answer of an abandoned epoch is discarded: no row absent, no patch", async () => {
    const h = await proven()
    const old = {
      key: key(2),
      version: 99,
      values: { ref: key(2), version: 99, org: S, title: "old" },
    }
    expect(receive(h, { rows: [], absent: [key(1)] }, EA)).toBe("discarded")
    expect(receive(h, { rows: [old], absent: [] }, EA)).toBe("discarded")
    expect(h.handle.getSnapshot().rows).toMatchObject([
      { state: "synced", values: { title: "t1" } },
      { state: "synced", values: { title: "t2" } },
    ])
    // Відповідь поточної епохи пишеться.
    expect(receive(h, { rows: [], absent: [key(1)] }, EB)).toBe("applied")
    expect(h.handle.getSnapshot().rows[0]).toEqual({
      key: key(1),
      state: "removed",
    })
  })

  it("a receiver answer with versionEpoch null and a row of an abandoned epoch is discarded", async () => {
    const h = await proven()
    const old: ServerRow = {
      key: key(1),
      version: 99,
      versionEpoch: EA,
      values: { ref: key(1), version: 99, org: S, title: "old" },
    }
    expect(receive(h, { rows: [old], absent: [] }, null)).toBe("discarded")
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({
      state: "synced",
      values: { title: "t1" },
    })
  })

  it("a receiver answer of the current epoch with a row of an abandoned epoch is discarded whole", async () => {
    const h = await proven()
    const old: ServerRow = {
      key: key(1),
      version: 99,
      versionEpoch: EA,
      values: { ref: key(1), version: 99, org: S, title: "old" },
    }
    expect(receive(h, { rows: [old], absent: [key(2)] }, EB)).toBe("discarded")
    expect(h.handle.getSnapshot().rows).toMatchObject([
      { state: "synced", values: { title: "t1" } },
      { state: "synced", values: { title: "t2" } },
    ])
  })

  it("a receiver answer with versionEpoch null and rows of the current epoch applies", async () => {
    const h = await proven()
    const fresh: ServerRow = {
      key: key(1),
      version: 99,
      versionEpoch: EB,
      values: { ref: key(1), version: 99, org: S, title: "new" },
    }
    expect(receive(h, { rows: [fresh], absent: [] }, null)).toBe("applied")
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({
      state: "synced",
      values: { title: "new" },
    })
  })

  it("a receiver answer after the session became unavailable is discarded", async () => {
    const h = await proven()
    for (let i = 0; i < DISCARDS_MAX; i++)
      expect(receive(h, { rows: [], absent: [] }, EA)).toBe("discarded")
    expect(h.inspect.versionEpochs().unavailable).toBe(true)
    expect(receive(h, { rows: [], absent: [key(1)] }, EB)).toBe("discarded")
    expect(receive(h, { rows: [], absent: [key(1)] }, null)).toBe("discarded")
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({ state: "synced" })
  })

  it("a load answer of an abandoned epoch without the held keys removes nothing", async () => {
    const h = await proven()
    h.fake.remove(TASK, key(1))
    h.fake.remove(TASK, key(2))
    h.fake.epoch = EA
    h.handle.refresh()
    await deliver(h)
    expect(h.handle.getSnapshot().rows).toMatchObject([
      { state: "synced" },
      { state: "synced" },
    ])
  })

  it("a revalidate answer of an abandoned epoch without the held keys removes nothing", async () => {
    const h = await proven()
    h.fake.remove(TASK, key(1))
    h.fake.remove(TASK, key(2))
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await deliver(h)
    expect(h.handle.getSnapshot().rows).toMatchObject([
      { state: "synced" },
      { state: "synced" },
    ])
  })

  it("a tail re-read answered from an abandoned epoch writes nothing", async () => {
    const h = await switched()
    // Перечитування після перемикання підтверджує рядки поточної епохи.
    vi.advanceTimersByTime(INTERVAL)
    await deliver(h)
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({ state: "synced" })
    // `null`-відповідь над рядком поточної епохи — `stale` і хвіст.
    h.fake.epoch = null
    h.handle.refresh()
    await settle()
    h.fake.take().answer()
    await settle()
    const tail = h.fake.pending.filter(isKeys)
    expect(tail).toHaveLength(1)
    h.fake.edit(TASK, key(1), { title: "old" })
    h.fake.epoch = EA
    h.fake.take().answer()
    await settle()
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({
      values: { title: "t1" },
    })
  })

  it("a discarded revalidate re-reads after a pause by the same system path", async () => {
    const h = await switched()
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await deliver(h)
    expect(h.fake.pending).toHaveLength(0)
    vi.advanceTimersByTime(DISCARD_PAUSE_MS)
    await settle()
    expect(h.fake.pending.filter(isKeys)).toHaveLength(1)
    h.fake.epoch = EB
    await deliver(h)
    expect(h.handle.getSnapshot()).toMatchObject({ status: "ready" })
  })

  /** Відповідає, доки обмежувач читань не випустить усі. */
  async function drain(h: CoreHarness) {
    await settle()
    for (let i = 0; i < 10 && h.fake.pending.length > 0; i++) await deliver(h)
    await settle()
    expect(h.fake.pending).toHaveLength(0)
  }

  /** Ще `DISCARDS_MAX + 1` карток, завантажених у поточній епосі B. */
  async function manyViews(h: CoreHarness) {
    const many = Array.from({ length: DISCARDS_MAX + 1 }, (_, i) => i + 3)
    seed(h.fake, 3, DISCARDS_MAX + 3)
    const handles = many.map((n) => h.core.view(keysView(n)))
    for (const handle of handles) watch(handle)
    await drain(h)
    for (const handle of handles)
      expect(handle.getSnapshot()).toMatchObject({ status: "ready" })
    return handles
  }

  it(`one revalidate pass over more than ${DISCARDS_MAX} views at a switch counts once`, async () => {
    const h = await proven()
    const handles = await manyViews(h)
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await drain(h)
    expect(h.inspect.versionEpochs()).toMatchObject({
      discards: 1,
      unavailable: false,
    })
    for (const handle of handles)
      expect(handle.getSnapshot().status).not.toBe("error")
  })

  it(`more than ${DISCARDS_MAX} views loading together at a switch count once`, async () => {
    const h = await proven()
    h.fake.epoch = EA
    seed(h.fake, 3, DISCARDS_MAX + 3)
    const handles = Array.from({ length: DISCARDS_MAX + 1 }, (_, i) =>
      h.core.view(keysView(i + 3))
    )
    for (const handle of handles) watch(handle)
    await drain(h)
    expect(h.inspect.versionEpochs()).toMatchObject({
      discards: 1,
      unavailable: false,
    })
    // Повтори після паузи — наступний прохід, теж один.
    vi.advanceTimersByTime(DISCARD_PAUSE_MS)
    await drain(h)
    expect(h.inspect.versionEpochs()).toMatchObject({
      discards: 2,
      unavailable: false,
    })
    h.fake.epoch = EB
    vi.advanceTimersByTime(2 * DISCARD_PAUSE_MS)
    await drain(h)
    expect(h.inspect.versionEpochs().discards).toBe(0)
    for (const handle of handles)
      expect(handle.getSnapshot()).toMatchObject({ status: "ready" })
  })

  it("sync() shows the pause of a discarded load as a deadline, not as a flight", async () => {
    const h = await proven()
    h.fake.epoch = EA
    seed(h.fake, 3, 3)
    watch(h.core.view(keysView(3)))
    await drain(h)
    expect(h.inspect.versionEpochs().discards).toBe(1)
    const states = () =>
      h.inspect
        .sync()
        .filter(
          (x) =>
            x.target.kind === "view" &&
            x.target.spec.kind === "keys" &&
            x.target.spec.keys.includes(key(3))
        )
    // Запиту немає: політ завантаження не показано, пауза — строк повтору.
    expect(states()).toHaveLength(1)
    expect(states()[0]!.flights).toEqual([])
    expect(states()[0]!.due).toBe(Date.now() + DISCARD_PAUSE_MS)
    // Пауза відрізняється від звичайного строку явною причиною.
    expect(states()[0]!.dueCause).toBe("retry")
    // Після паузи повтор іде й політ знову видно.
    vi.advanceTimersByTime(DISCARD_PAUSE_MS)
    await settle()
    expect(states()[0]!.flights).toEqual([
      expect.objectContaining({ kind: "load" }),
    ])
    expect(states()[0]!.due).toBeUndefined()
    expect(states()[0]!.dueCause).toBeUndefined()
  })

  it("a core close in the pause of a discarded load leaves no timer and sends nothing", async () => {
    const h = await proven()
    h.fake.epoch = EA
    seed(h.fake, 3, 3)
    watch(h.core.view(keysView(3)))
    await drain(h)
    expect(h.inspect.versionEpochs().discards).toBe(1)
    // Повтор очікує паузу: це його таймер.
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    h.core.close("disposed")
    expect(vi.getTimerCount()).toBe(0)
    await settle()
    expect(h.fake.pending).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it(`${DISCARDS_MAX} revalidate passes in a row with the pause: command.unavailable; a new session works`, async () => {
    const h = await proven()
    const handles = await manyViews(h)
    // Паузи разом довші за інтервал такту: щоб такт не читав здорові вигляди
    // між проходами, вигляди невидимі (строк повтору відкинутого їх не питає).
    h.core.setVisible(keysView(1, 2), false)
    for (let n = 3; n < DISCARDS_MAX + 4; n++)
      h.core.setVisible(keysView(n), false)
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await drain(h)
    for (let pass = 1; pass < DISCARDS_MAX; pass++) {
      expect(h.inspect.versionEpochs()).toMatchObject({
        discards: pass,
        unavailable: false,
      })
      // Пауза росте: раніше за неї повтору немає.
      const pause = DISCARD_PAUSE_MS * 2 ** (pass - 1)
      vi.advanceTimersByTime(pause - 1)
      await settle()
      expect(h.fake.pending).toHaveLength(0)
      vi.advanceTimersByTime(1)
      await drain(h)
    }
    expect(h.inspect.versionEpochs()).toMatchObject({
      discards: DISCARDS_MAX,
      unavailable: true,
    })
    for (const handle of [h.handle, ...handles])
      expect(handle.getSnapshot()).toMatchObject({
        status: "error",
        error: { code: "command.unavailable" },
      })
    vi.advanceTimersByTime(60_000)
    await settle()
    expect(h.fake.pending).toHaveLength(0)

    const core = createCore({
      subject: "u1",
      source: createCoreSource(
        () => h.fake.adapter,
        h.fake.index,
        createReadLimiter(4),
        h.fake.server
      ),
      index: h.fake.index,
    })
    collectCore(core, h.fake)
    watch(core.view(keysView(1, 2)))
    await drain(h)
    expect(core.view(keysView(1, 2)).getSnapshot()).toMatchObject({
      status: "ready",
    })
  })

  it("a null section answer after a switch marks the lines stale and re-reads them once", async () => {
    const h = await proven()
    h.fake.setLines(TASK, key(1), "lines", [
      { ref: key(901), qty: 1, lineNumber: 1 },
    ])
    h.fake.epoch = EB
    const spec: ViewSpec = {
      kind: "section",
      object: TASK,
      owner: key(1),
      section: "lines",
    }
    const lines = h.core.view(spec)
    watch(lines)
    await deliver(h)
    const sections = () =>
      coreInternals(h.core).objects.get(TASK)!.sections.get(key(1), "lines")
    expect(sections()).toMatchObject({ versionEpoch: EB })
    expect(sections()?.staleEpoch).toBeUndefined()
    h.fake.epoch = null
    lines.refresh()
    await settle()
    h.fake.take(isSection).answer()
    await settle()
    expect(sections()).toMatchObject({ staleEpoch: true })
    // Одне перечитування; його `null`-відповідь нового не ставить.
    expect(h.fake.pending.filter(isSection)).toHaveLength(1)
    h.fake.take(isSection).answer()
    await settle()
    expect(h.fake.pending.filter(isSection)).toHaveLength(0)
    // Відповідь поточної епохи знімає позначку.
    h.fake.epoch = EB
    lines.refresh()
    await deliver(h)
    expect(sections()?.staleEpoch).toBeUndefined()
  })

  it("a switch on a hidden tab, the due time passed: 0 reads; resume() — 1 read taking the object though its freshness mark is younger than resumeMinIntervalMs", async () => {
    const h = await loaded()
    h.core.suspend()
    vi.spyOn(Math, "random").mockReturnValue(0.1)
    h.fake.epoch = EB
    h.handle.refresh()
    await deliver(h)
    expect(h.inspect.versionEpochs().current).toBe(EB)
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(1)
    const before = h.fake.log.length
    // Строк (0,1 × I) минув, а власний строк виглядів (I) — ще ні: читання
    // дає лише строк перемикання.
    vi.advanceTimersByTime(INTERVAL / 2)
    await deliver(h)
    expect(h.fake.log.length).toBe(before)
    expect(h.inspect.serviceSizes()).toMatchObject({
      scheduledObjects: 1,
      schedulerTimers: 0,
    })
    expect(h.handle.getSnapshot().rows).toMatchObject([
      { state: "stale" },
      { state: "stale" },
    ])
    // Відмітка свіжості (рефреш) молодша за 15 с — `resumeMinIntervalMs`.
    const sent = h.fake.log.length
    h.core.resume()
    await settle()
    expect(h.fake.pending.filter(isKeys)).toHaveLength(1)
    // Читання об'єкта перемикання йде тим самим пакетом, що й частина `version`
    // звірки, а не окремим запитом пізніше.
    expect(new Set(h.fake.log.slice(sent).map((l) => l.request)).size).toBe(1)
    await deliver(h)
    expect(h.handle.getSnapshot().rows).toMatchObject([
      { state: "synced" },
      { state: "synced" },
    ])
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(0)
  })

  it("a discarded answer on a hidden tab: the retry waits for resume()", async () => {
    // `proven`: строк самого перемикання вже відпрацював, лишається повтор.
    const h = await proven()
    h.core.suspend()
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await deliver(h)
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(1)
    const before = h.fake.log.length
    vi.advanceTimersByTime(10 * DISCARD_PAUSE_MS)
    await deliver(h)
    expect(h.fake.log.length).toBe(before)
    h.fake.epoch = EB
    h.core.resume()
    await settle()
    expect(h.fake.pending.filter(isKeys)).toHaveLength(1)
    await deliver(h)
    expect(h.handle.getSnapshot()).toMatchObject({ status: "ready" })
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(0)
  })

  it("the switch time and the retry are due together on resume(): the view is read once now and once in the tail, not twice at once", async () => {
    const h = await proven()
    h.core.suspend()
    // Перемикання на прихованій вкладці ставить цілий строк об'єкта.
    h.fake.epoch = EC
    h.handle.refresh()
    await deliver(h)
    // Відкинута відповідь ставить повтор того ж вигляду.
    h.fake.epoch = EA
    void h.core.revalidate(TASK, { visibleOnly: false })
    await deliver(h)
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(1)
    // Обидва строки минули на прихованій вкладці.
    vi.advanceTimersByTime(INTERVAL + DISCARD_PAUSE_MS)
    h.fake.epoch = EC
    h.core.resume()
    await settle()
    // Повтор іде тим самим single-flight шляхом: вигляд у польоті не читається вдруге.
    expect(h.fake.pending.filter(isKeys)).toHaveLength(1)
    h.fake.deliverAll()
    await settle()
    // Один спільний хвіст після осідання.
    expect(h.fake.pending.filter(isKeys)).toHaveLength(1)
    h.fake.deliverAll()
    await settle()
    expect(h.fake.pending.filter(isKeys)).toHaveLength(0)
  })

  it("close clears the timers of a switch", async () => {
    const h = await loaded()
    h.fake.epoch = EB
    h.handle.refresh()
    await deliver(h)
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(1)
    h.core.close("disposed")
    expect(h.inspect.serviceSizes().scheduledObjects).toBe(0)
    vi.advanceTimersByTime(INTERVAL)
    await settle()
    expect(h.fake.pending).toHaveLength(0)
  })
})
