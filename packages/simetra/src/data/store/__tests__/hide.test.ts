import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { keyId } from "../epoch"
import { coreInternals, type CoreSession } from "../core"
import { visibleRow } from "../object-store"
import type { ViewSpec, Writer } from "../types"
import {
  harness,
  K1,
  K2,
  K3,
  OBJECT,
  row,
  S,
  type Harness,
} from "./store-support"
import {
  ORG,
  TASK,
  isPage,
  readsOf,
  key,
  seed,
  settle,
  setup,
  taskValues,
  watch,
} from "./core-support"

/*
 * `hide` (план П4-B3-3, задача 0, Р11; спека П4-B §6.2 правило 4): позначка
 * `stale.hidden` ставиться з `hideKeys` і знімається лише читанням, яке
 * почалось після неї. Перший блок — сховище, другий — ядро з `Writer.hide`.
 */

const put = (h: Harness, r: ReturnType<typeof row>, readEpoch = h.now()) =>
  h.write((s) => h.store.put(s, r, readEpoch, false))
const own = (h: Harness, k: string) => h.write((s) => h.store.own(s, k))
const disown = (h: Harness, k: string) => h.write((s) => h.store.disown(s, k))
const hide = (h: Harness, keys: string[]) =>
  h.write((s) => h.store.hideKeys(s, keys))
const putLines = (h: Harness, owner: string, readEpoch: number) =>
  h.write((s) =>
    h.sections.put(
      s,
      owner,
      "lines",
      [{ key: "00000000-0000-4000-8000-0000000000c1", values: { qty: 1 } }],
      1,
      null,
      readEpoch,
      S,
      "owner-section"
    )
  )

describe("ObjectStore.hideKeys", () => {
  it("hides the values of the keys with an entry, queues them for a re-read and logs no horizon-hidden", () => {
    const h = harness()
    put(h, row(K1, 1))
    own(h, K1)
    h.store.drainTail()
    expect(hide(h, [K1, K2])).toEqual([K1])
    const e = h.store.get(K1)!
    expect(visibleRow(e)).toBeUndefined()
    expect(e.row).toBeDefined()
    expect(h.store.drainTail()).toEqual([K1])
    expect(h.log.filter((x) => x.kind === "horizon-hidden")).toEqual([])
  })

  it("is lifted by a read that started after it, not by one that started before", () => {
    const h = harness()
    put(h, row(K1, 1))
    own(h, K1)
    const early = h.now()
    hide(h, [K1])
    // Той самий рядок з читання, що почалось до `hide`, значень не відкриває.
    put(h, row(K1, 1), early)
    expect(visibleRow(h.store.get(K1)!)).toBeUndefined()
    expect(put(h, row(K1, 1))).toBe("written")
    expect(visibleRow(h.store.get(K1)!)).toBeDefined()
  })

  it("takes a fresh epoch over an existing mark: a read started between the two does not lift the newer", () => {
    const h = harness()
    put(h, row(K1, 1))
    own(h, K1)
    hide(h, [K1])
    const between = h.now()
    hide(h, [K1])
    put(h, row(K1, 1), between)
    expect(visibleRow(h.store.get(K1)!)).toBeUndefined()
  })

  it("takes a fresh epoch over a horizon mark", () => {
    const h = harness({ limits: { seenMax: 1 } })
    const early = h.now()
    put(h, row(K1, 1))
    own(h, K1)
    disown(h, K1)
    put(h, row(K2, 1))
    own(h, K2)
    disown(h, K2)
    // K1 витіснено з пам'яті версій: читання з `early` ховається горизонтом.
    expect(put(h, row(K1, 1), early)).toBe("stale-inserted")
    own(h, K1)
    const horizonEpoch = h.store.get(K1)!.stale.hidden!.epoch
    const between = h.now()
    hide(h, [K1])
    expect(h.store.get(K1)!.stale.hidden!.epoch).toBeGreaterThan(between)
    expect(between).toBeGreaterThanOrEqual(horizonEpoch)
    put(h, row(K1, 1), between)
    expect(visibleRow(h.store.get(K1)!)).toBeUndefined()
  })

  it("writes no horizon-hidden metric even for a key that is already hidden by the horizon", () => {
    const h = harness()
    put(h, row(K1, 1))
    own(h, K1)
    hide(h, [K1])
    hide(h, [K1])
    expect(h.log.filter((x) => x.kind === "horizon-hidden")).toEqual([])
  })

  it("a key whose entry went away after the hide is not shown by a read older than the hide", () => {
    const h = harness()
    put(h, row(K1, 1))
    own(h, K1)
    const early = h.now()
    hide(h, [K1])
    disown(h, K1)
    expect(h.store.get(K1)).toBeUndefined()
    expect(put(h, row(K1, 1), early)).toBe("stale-inserted")
    expect(visibleRow(h.store.get(K1)!)).toBeUndefined()
    expect(h.store.drainTail()).toContain(K1)
    // Читання після `hide` пише рядок як завжди.
    disown(h, K1)
    expect(put(h, row(K1, 1))).toBe("written")
  })

  it("a key that never had an entry gets the mark too", () => {
    const h = harness()
    const early = h.now()
    expect(hide(h, [K3])).toEqual([])
    expect(put(h, row(K3, 1), early)).toBe("stale-inserted")
    expect(visibleRow(h.store.get(K3)!)).toBeUndefined()
  })

  it("keeps its marks within tombstonesMax; an evicted mark raises the horizon", () => {
    const h = harness({ limits: { tombstonesMax: 2 } })
    const early = h.now()
    hide(h, [K1])
    hide(h, [K2])
    hide(h, [K3])
    expect(h.session.epochs.sizes().hidden).toBe(2)
    expect(h.session.epochs.hiddenSince(keyId(OBJECT, K1), early)).toBe(false)
    // Позначку K1 витіснено, але горизонт її кошика не пускає читання `early`.
    expect(put(h, row(K1, 1), early)).toBe("stale-inserted")
    expect(visibleRow(h.store.get(K1)!)).toBeUndefined()
  })
})

describe("SectionStore after hide", () => {
  it("rejects lines of a read older than the hide when the header is gone, and takes a later read", () => {
    const h = harness()
    put(h, row(K1, 1))
    own(h, K1)
    const early = h.now()
    hide(h, [K1])
    disown(h, K1)
    expect(h.store.get(K1)).toBeUndefined()
    expect(putLines(h, K1, early)).toBe("rejected")
    expect(h.sections.get(K1, "lines")).toBeUndefined()
    expect(putLines(h, K1, h.now())).toBe("written")
  })
})

// ---------------------------------------------------------------- ядро

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const write = (core: CoreSession, fn: (w: Writer) => void) =>
  core.commit(fn, core.token())

const keys = (...ns: number[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys: ns.map(key),
})
const section = (n: number): ViewSpec => ({
  kind: "section",
  object: TASK,
  owner: key(n),
  section: "lines",
})
const lines = [{ ref: key(901), qty: 1, lineNumber: 1 }]

const first = (core: CoreSession, spec: ViewSpec) => {
  const row = core.view(spec).getSnapshot().rows[0]
  if (row === undefined || row.state === "removed") throw new Error("no row")
  return row
}

describe("Writer.hide", () => {
  it("hides the values at once and re-reads every holder: the values return with the read", async () => {
    const { core, fake, inspect, log } = setup()
    seed(fake, 1, 1)
    watch(core.view(keys(1)))
    await settle()
    fake.hold = () => true
    write(core, (w) => w.hide(TASK, [key(1)]))
    expect(first(core, keys(1))).toMatchObject({
      hidden: true,
      state: "stale",
      values: {},
    })
    await settle()
    expect(fake.pending.length).toBeGreaterThan(0)
    fake.hold = undefined
    fake.deliverAll()
    await settle()
    expect(first(core, keys(1)).hidden).toBeUndefined()
    expect(first(core, keys(1))).toMatchObject({ state: "synced" })
    expect(log.filter((x) => x.kind === "horizon-hidden")).toEqual([])
    expect(inspect.violations()).toEqual([])
  })

  it("a read in flight when hide happens does not show the values; the re-read after it does", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    const view = core.view(keys(1))
    watch(view)
    await settle()
    fake.hold = () => true
    view.refresh()
    await settle()
    const older = fake.pending.length
    expect(older).toBe(1)
    write(core, (w) => w.hide(TASK, [key(1)]))
    await settle()
    expect(fake.pending.length).toBeGreaterThan(older)
    // Читання, що почалось до `hide`, доходить першим.
    fake.take(0).answer()
    await settle()
    expect(first(core, keys(1)).hidden).toBe(true)
    fake.hold = undefined
    fake.deliverAll()
    await settle()
    expect(first(core, keys(1)).hidden).toBeUndefined()
  })

  it("a failed re-read leaves the values hidden", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    watch(core.view(keys(1)))
    await settle()
    fake.hold = () => true
    write(core, (w) => w.hide(TASK, [key(1)]))
    await settle()
    for (const read of [...fake.pending])
      fake.take((r) => r === read).fail("command.unavailable")
    fake.hold = undefined
    await settle()
    expect(first(core, keys(1))).toMatchObject({ hidden: true, values: {} })
  })

  it("re-reads an invisible view as that view, not only by the tail of the key", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    const spec: ViewSpec = { kind: "full", object: TASK }
    watch(core.view(spec))
    await settle()
    core.setVisible(spec, false)
    const before = fake.log.length
    write(core, (w) => w.hide(TASK, [key(1)]))
    await settle()
    // Хвіст читає за ключем; сторінку читає лише перечитування самого вигляду.
    expect(fake.log.slice(before).some((read) => isPage(read))).toBe(true)
    expect(first(core, spec).hidden).toBeUndefined()
  })

  it("purge after hide drops the key; the re-read in flight does not bring it back", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 2)
    watch(core.view(keys(1, 2)))
    await settle()
    fake.hold = () => true
    write(core, (w) => w.hide(TASK, [key(1)]))
    await settle()
    write(core, (w) => w.purge(TASK, { keys: [key(1)] }))
    fake.hold = undefined
    fake.deliverAll()
    await settle()
    fake.deliverAll()
    await settle()
    expect(
      core
        .view(keys(1, 2))
        .getSnapshot()
        .rows.map((r) => r.key)
    ).toEqual([key(2)])
    expect(inspect.violations()).toEqual([])
  })

  it("a hidden include target: the row shows refs with hidden until the re-read", async () => {
    const { core, fake } = setup()
    const org = (n: number) => key(10_000 + n)
    fake.insert(ORG, { ref: org(1) })
    fake.insert(TASK, taskValues(1, { org: org(1) }))
    const spec: ViewSpec = { kind: "full", object: TASK, include: ["org"] }
    watch(core.view(spec))
    await settle()
    fake.hold = () => true
    const before = fake.log.length
    write(core, (w) => w.hide(ORG, [org(1)]))
    expect(first(core, spec).refs?.org).toMatchObject({
      key: org(1),
      hidden: true,
      state: "stale",
      values: {},
    })
    await settle()
    // Вигляд задач, що тримає ціль, перечитується сам: хвіст читає лише ключ.
    expect(
      readsOf(fake, TASK).some(
        (read) => fake.log.indexOf(read) >= before && isPage(read)
      )
    ).toBe(true)
    fake.hold = undefined
    fake.deliverAll()
    await settle()
    expect(first(core, spec).refs?.org).toMatchObject({ state: "synced" })
    expect(first(core, spec).refs?.org).not.toHaveProperty("hidden")
  })

  it("the tabular section of a hidden header shows no lines and the stored lines are dropped", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    watch(core.view(keys(1)))
    const lineView = core.view(section(1))
    watch(lineView)
    await settle()
    expect(lineView.getSnapshot().section?.lines).toHaveLength(1)
    fake.hold = () => true
    write(core, (w) => w.hide(TASK, [key(1)]))
    expect(lineView.getSnapshot().section?.lines).toEqual([])
    expect(
      coreInternals(core).objects.get(TASK)!.sections.get(key(1), "lines")
    ).toBeUndefined()
    await settle()
    fake.hold = undefined
    fake.deliverAll()
    await settle()
    expect(lineView.getSnapshot().section?.lines).toHaveLength(1)
  })
})
