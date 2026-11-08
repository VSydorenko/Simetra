import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DataError } from "../../errors"
import { coreInternals } from "../core"
import { createRowViews } from "../snapshot"
import { DEFAULT_CORE_LIMITS, type ViewSpec } from "../types"
import {
  ORG,
  TASK,
  S,
  isCard,
  isKeys,
  isSection,
  key,
  keysIn,
  keysOf,
  readsOf,
  seed,
  settle,
  setup,
  taskValues,
  watch,
} from "./core-support"

const RELEASE = DEFAULT_CORE_LIMITS.releaseDelayMs

const keys = (...ns: number[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys: ns.map(key),
})
const card = (n: number): ViewSpec => ({
  kind: "card",
  object: TASK,
  key: key(n),
})
const section = (n: number): ViewSpec => ({
  kind: "section",
  object: TASK,
  owner: key(n),
  section: "lines",
})

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
  } catch (error) {
    return error instanceof DataError ? error.code : String(error)
  }
  return undefined
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("view registry and holds", () => {
  it("returns the same handle for equal forms", () => {
    const { core } = setup()
    const a = core.view(keys(1, 2))
    expect(core.view(keys(1, 2))).toBe(a)
    expect(
      core.view({ kind: "keys", object: TASK, keys: [key(1), key(2)] })
    ).toBe(a)
    expect(core.view(keys(2, 1))).not.toBe(a)
    const where = { attribute: "title", op: "eq", value: "x" } as const
    const full = core.view({ kind: "full", object: TASK, where })
    expect(
      core.view({
        kind: "full",
        object: TASK,
        where: { value: "x", op: "eq", attribute: "title" },
      })
    ).toBe(full)
  })

  it("loads on the first subscription and not on the second", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    const handle = core.view(keys(1, 2))
    expect(fake.log).toHaveLength(0)
    const first = watch(handle)
    await settle()
    expect(fake.log).toHaveLength(1)
    const second = watch(handle)
    await settle()
    expect(fake.log).toHaveLength(1)
    expect(keysIn(handle.getSnapshot())).toEqual([key(1), key(2)])
    first.unsubscribe()
    second.unsubscribe()
  })

  it("keeps the subset without a request when resubscribed within releaseDelayMs", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1)
    const handle = core.view(keys(1))
    watch(handle).unsubscribe()
    await settle()
    vi.advanceTimersByTime(RELEASE - 1)
    const again = watch(handle)
    await settle()
    vi.advanceTimersByTime(RELEASE * 2)
    expect(fake.log).toHaveLength(1)
    expect(inspect.owners(TASK, key(1))).toBe(1)
    again.unsubscribe()
  })

  it("drops every owner after a StrictMode double subscribe-unsubscribe", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1)
    const handle = core.view(keys(1))
    const listener = vi.fn()
    const off1 = handle.subscribe(listener)
    off1()
    const off2 = handle.subscribe(listener)
    await settle()
    expect(inspect.owners(TASK, key(1))).toBe(1)
    off2()
    off2()
    off1()
    vi.advanceTimersByTime(RELEASE)
    expect(inspect.owners(TASK, key(1))).toBe(0)
    expect(inspect.rowCount()).toBe(0)
    expect(inspect.violations()).toEqual([])
  })

  it("holds a preload until the first subscription or ttlMs", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 2)
    await core.preload(keys(1), { ttlMs: 500 })
    expect(inspect.owners(TASK, key(1))).toBe(1)
    vi.advanceTimersByTime(499)
    expect(inspect.owners(TASK, key(1))).toBe(1)
    vi.advanceTimersByTime(1)
    expect(inspect.owners(TASK, key(1))).toBe(0)

    // Перша підписка знімає утримання preload: далі тримає лише вона.
    const preloaded = core.preload(keys(2), { ttlMs: 500 })
    const sub = watch(core.view(keys(2)))
    await preloaded
    vi.advanceTimersByTime(10_000)
    expect(inspect.owners(TASK, key(2))).toBe(1)
    sub.unsubscribe()
    vi.advanceTimersByTime(RELEASE)
    expect(inspect.owners(TASK, key(2))).toBe(0)
    expect(readsOf(fake, TASK)).toHaveLength(2)
  })

  it("merges two refresh() calls during an active load into one trailing request", async () => {
    const { core, fake } = setup({ mode: "manual" })
    seed(fake, 1, 1)
    const handle = core.view(keys(1))
    watch(handle)
    expect(fake.pending).toHaveLength(1)
    handle.refresh()
    handle.refresh()
    expect(fake.pending).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(fake.pending).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(fake.pending).toHaveLength(0)
    expect(fake.log).toHaveLength(2)
  })

  it("does not write a response of an old generation after a new request and after release", async () => {
    const { core, fake, log, inspect } = setup({ mode: "manual" })
    seed(fake, 1, 1)
    const late = () => log.filter((e) => e.kind === "late-response").length
    const handle = core.view(keys(1))
    watch(handle).unsubscribe()
    vi.advanceTimersByTime(RELEASE)
    // Звільнено: відповідь нікуди не пише.
    fake.take().answer()
    await settle()
    expect(inspect.rowCount()).toBe(0)
    expect(late()).toBe(1)

    // Звільнено й підписано знову: відповідь старого покоління після нового
    // запиту не пише, нове покоління — пише.
    watch(handle).unsubscribe()
    vi.advanceTimersByTime(RELEASE)
    const sub = watch(handle)
    expect(fake.pending).toHaveLength(2)
    fake.edit(TASK, key(1), { title: "new" })
    fake.take(0).answer()
    await settle()
    expect(late()).toBe(2)
    expect(handle.getSnapshot().rows).toEqual([])
    fake.take(0).answer()
    await settle()
    expect(handle.getSnapshot().rows).toMatchObject([
      { key: key(1), state: "synced", values: { title: "new" } },
    ])
    expect(inspect.owners(TASK, key(1))).toBe(1)
    sub.unsubscribe()
  })

  it("shows a key read before its bucket horizon as stale with hidden values, re-reads it, composition unchanged", async () => {
    const { core, fake, log } = setup({
      limits: { seenMax: 1, tombstonesMax: 1, horizonBuckets: 1 },
    })
    seed(fake, 1, 3)
    let holding = true
    fake.hold = (read) => holding && keysOf(read.query).includes(key(1))
    const handle = core.view(keys(1))
    watch(handle)
    const first = fake.take()
    // Витіснення пам'яті версій після старту читання піднімає горизонт.
    watch(core.view(keys(2, 3))).unsubscribe()
    await settle()
    vi.advanceTimersByTime(RELEASE)
    first.answer()
    await settle()
    const hidden = handle.getSnapshot()
    expect(keysIn(hidden)).toEqual([key(1)])
    expect(hidden.rows[0]).toMatchObject({ state: "stale", values: {} })
    expect(log).toContainEqual({
      kind: "horizon-hidden",
      object: TASK,
      count: 1,
    })
    expect(fake.pending).toHaveLength(1)
    holding = false
    fake.take().answer()
    await settle()
    const shown = handle.getSnapshot()
    expect(keysIn(shown)).toEqual([key(1)])
    expect(shown.rows[0]).toMatchObject({
      state: "synced",
      values: { title: "t1" },
    })
  })

  it("reports refreshing, not loading, on a repeated read of a view with data", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    const handle = core.view(keys(1))
    const { seen } = watch(handle)
    expect(handle.getSnapshot().status).toBe("loading")
    await settle()
    expect(handle.getSnapshot().status).toBe("ready")
    fake.mode = "manual"
    handle.refresh()
    expect(handle.getSnapshot().status).toBe("refreshing")
    fake.take().answer()
    await settle()
    expect(seen.map((s) => s.status)).toEqual(["ready", "refreshing", "ready"])
  })

  it("keeps the rows on a failed read and reports error", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    const handle = core.view(keys(1))
    watch(handle)
    await settle()
    const rows = handle.getSnapshot().rows
    fake.mode = "manual"
    handle.refresh()
    fake.take().fail("command.unavailable")
    await settle()
    const failed = handle.getSnapshot()
    expect(failed.status).toBe("error")
    expect(failed.error).toEqual({ code: "command.unavailable" })
    expect(failed.rows).toBe(rows)
  })

  it("does not fail on 300 handles without a subscription", () => {
    const { core, fake } = setup()
    for (let n = 1; n <= 300; n++) core.view(keys(n)).getSnapshot()
    expect(fake.log).toHaveLength(0)
  })

  it("releases unsubscribed holds first, then refuses the 201st held form synchronously, preload too", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 2)
    const subs = []
    for (let n = 100; n < 298; n++) subs.push(watch(core.view(keys(n))))
    void core.preload(keys(1), { ttlMs: 60_000 })
    watch(core.view(keys(2))).unsubscribe()
    await settle()
    expect(inspect.owners(TASK, key(1))).toBe(1)
    expect(inspect.owners(TASK, key(2))).toBe(1)

    subs.push(watch(core.view(keys(500))))
    subs.push(watch(core.view(keys(501))))
    await settle()
    expect(inspect.owners(TASK, key(1))).toBe(0)
    expect(inspect.owners(TASK, key(2))).toBe(0)

    const reads = fake.log.length
    expect(codeOf(() => core.view(keys(502)).subscribe(() => {}))).toBe(
      "data.views-limit"
    )
    expect(codeOf(() => core.preload(keys(503)))).toBe("data.views-limit")
    // Уже утримана форма місця не займає: підписка на неї дозволена.
    expect(
      codeOf(() => core.view(keys(100)).subscribe(() => {}))
    ).toBeUndefined()
    await settle()
    expect(fake.log).toHaveLength(reads)
    expect(inspect.violations()).toEqual([])
  })

  it("attaches a new handle after memo eviction to the same subset", async () => {
    const { core, fake } = setup({ limits: { viewsMax: 4 } })
    seed(fake, 1, 1)
    const first = core.view(keys(1))
    watch(first)
    await settle()
    for (let n = 10; n < 20; n++) core.view(keys(n))
    const second = core.view(keys(1))
    expect(second).not.toBe(first)
    expect(second.getSnapshot()).toBe(first.getSnapshot())
    watch(second)
    await settle()
    expect(fake.log).toHaveLength(1)
  })

  it("returns the same snapshot object for an unchanged view", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    const handle = core.view(keys(1))
    watch(handle)
    await settle()
    const before = handle.getSnapshot()
    expect(handle.getSnapshot()).toBe(before)
    watch(core.view(keys(2)))
    await settle()
    expect(handle.getSnapshot()).toBe(before)
  })

  it("refuses an unknown predicate in full with data.unsupported-predicate and no request", () => {
    const { core, fake } = setup()
    const spec: ViewSpec = {
      kind: "full",
      object: TASK,
      where: { attribute: "nope", op: "eq", value: 1 },
    }
    expect(codeOf(() => core.view(spec))).toBe("data.unsupported-predicate")
    expect(codeOf(() => core.preload(spec))).toBe("data.unsupported-predicate")
    expect(fake.log).toHaveLength(0)
  })

  it("rejects limits that are not positive integers", () => {
    expect(() => setup({ limits: { horizonBuckets: 0 } })).toThrow(TypeError)
    expect(() => setup({ limits: { viewsMax: 1.5 } })).toThrow(TypeError)
    expect(() => setup({ limits: { releaseDelayMs: -1 } })).toThrow(TypeError)
  })
})

describe("tail re-read", () => {
  /** Версія 2 у пам'яті версій, потім застаріла репліка повертає версію 1. */
  async function staleInsert() {
    const h = setup()
    h.fake.insert(TASK, taskValues(1))
    const moment = h.fake.clock
    h.fake.edit(TASK, key(1), { title: "v2" })
    watch(h.core.view(keys(1))).unsubscribe()
    await settle()
    vi.advanceTimersByTime(RELEASE)
    expect(h.inspect.rowCount()).toBe(0)
    let holds = 1
    h.fake.hold = (read) => holds-- > 0 && isKeys(read)
    const handle = h.core.view(keys(1))
    const sub = watch(handle)
    const reads = h.fake.log.length
    return { ...h, handle, sub, reads, moment }
  }

  it("re-reads a stale-inserted key once", async () => {
    const { fake, handle, reads, moment } = await staleInsert()
    fake.take().answer(moment)
    await settle()
    const tail = fake.log.slice(reads)
    expect(tail.filter((r) => keysOf(r.query).includes(key(1)))).toHaveLength(1)
    expect(handle.getSnapshot().rows).toMatchObject([
      { key: key(1), state: "synced", values: { title: "v2" } },
    ])
  })

  it("does not write the tail result after the view is released", async () => {
    const { fake, handle, sub, inspect, moment } = await staleInsert()
    fake.hold = (read) => isKeys(read)
    fake.take().answer(moment)
    await settle()
    expect(handle.getSnapshot().rows[0]).toMatchObject({ state: "stale" })
    expect(fake.pending).toHaveLength(1)
    sub.unsubscribe()
    vi.advanceTimersByTime(RELEASE)
    fake.take().answer()
    await settle()
    expect(inspect.rowCount()).toBe(0)
    expect(inspect.violations()).toEqual([])
  })
})

describe("card", () => {
  it("shows a row from the store at once", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    watch(core.view(keys(1)))
    await settle()
    const snapshot = core.view(card(1)).getSnapshot()
    expect(snapshot.status).not.toBe("loading")
    expect(snapshot.rows).toMatchObject([
      { key: key(1), values: { title: "t1" } },
    ])
  })

  it("reads the card form for missing lazy fields only when mounted", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    watch(core.view(keys(1)))
    await settle()
    await core.preload(card(1))
    expect(fake.log.filter(isCard)).toHaveLength(0)
    const handle = core.view(card(1))
    watch(handle)
    await settle()
    expect(fake.log.filter(isCard)).toHaveLength(1)
    expect(handle.getSnapshot().rows).toMatchObject([
      { key: key(1), values: { notes: "body 1" }, staleFields: [] },
    ])
    // Нова версія рядка зі списку: ліниве поле stale, змонтована картка дочитує.
    fake.edit(TASK, key(1), { title: "x", notes: "body 2" })
    fake.hold = (read) => isCard(read)
    core.view(keys(1)).refresh()
    await settle()
    expect(handle.getSnapshot().rows).toMatchObject([
      { values: { title: "x", notes: "body 1" }, staleFields: ["notes"] },
    ])
    fake.take().answer()
    await settle()
    expect(handle.getSnapshot().rows).toMatchObject([
      { values: { notes: "body 2" }, staleFields: [] },
    ])
  })
})

describe("section", () => {
  const lines = [{ ref: key(901), qty: 1, lineNumber: 1 }]

  it("discards a result with a lower ownerVersion", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    const old = fake.setLines(TASK, key(1), "lines", lines)
    fake.setLines(TASK, key(1), "lines", [
      ...lines,
      { ref: key(902), qty: 2, lineNumber: 2 },
    ])
    const handle = core.view(section(1))
    watch(handle)
    await settle()
    const before = handle.getSnapshot().section
    expect(before?.lines).toHaveLength(2)
    fake.mode = "manual"
    handle.refresh()
    fake.take().answer(old)
    await settle()
    expect(handle.getSnapshot().section).toBe(before)
  })

  it("drops the lines when the last section view of the owner closes", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const handle = core.view(section(1))
    watch(handle).unsubscribe()
    await settle()
    vi.advanceTimersByTime(RELEASE)
    fake.mode = "manual"
    watch(handle)
    const snapshot = handle.getSnapshot()
    expect(snapshot.status).toBe("loading")
    expect(snapshot.section?.lines ?? []).toEqual([])
  })

  it("marks lines stale on a new header version and re-reads a mounted section", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    fake.setLines(TASK, key(1), "lines", lines)
    fake.setLines(TASK, key(2), "lines", lines)
    const header = core.view(keys(1, 2))
    watch(header)
    const mounted = core.view(section(1))
    watch(mounted)
    await core.preload(section(2))
    await settle()
    const v1 = fake.setLines(TASK, key(1), "lines", [
      { ref: key(903), qty: 5, lineNumber: 1 },
    ])
    fake.setLines(TASK, key(2), "lines", [])
    fake.hold = (read) => isSection(read)
    header.refresh()
    await settle()
    const stale = mounted.getSnapshot()
    expect(stale.section!.ownerVersion).toBeLessThan(v1)
    expect(fake.pending).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(mounted.getSnapshot().section).toMatchObject({
      ownerVersion: v1,
      complete: true,
      lines: [{ key: key(903) }],
    })
    // Незмонтований (preload) вигляд ТЧ не дочитує.
    expect(fake.log.filter(isSection)).toHaveLength(3)
  })

  it("re-reads a mounted section rejected under a horizon-hidden header once the tail resolves it", async () => {
    const { core, fake } = setup({
      limits: { seenMax: 1, tombstonesMax: 1, horizonBuckets: 1 },
    })
    seed(fake, 1, 3)
    fake.setLines(TASK, key(1), "lines", lines)
    let holding = true
    fake.hold = (read) =>
      holding && (keysOf(read.query).includes(key(1)) || isSection(read))
    const header = core.view(keys(1))
    watch(header)
    const sectionView = core.view(section(1))
    watch(sectionView)
    const headerRead = fake.take((r) => isKeys(r))
    const sectionRead = fake.take((r) => isSection(r))
    watch(core.view(keys(2, 3))).unsubscribe()
    await settle()
    vi.advanceTimersByTime(RELEASE)
    headerRead.answer()
    await settle()
    expect(header.getSnapshot().rows[0]).toMatchObject({
      state: "stale",
      values: {},
    })
    // Рядки ТЧ з читання до позначки шапки відкинуто: шапку сховано.
    sectionRead.answer()
    await settle()
    expect(sectionView.getSnapshot().section?.lines ?? []).toEqual([])
    holding = false
    fake.take().answer()
    await settle()
    expect(header.getSnapshot().rows[0]).toMatchObject({ state: "synced" })
    expect(sectionView.getSnapshot().section).toMatchObject({
      complete: true,
      lines: [{ key: key(901) }],
    })
  })
})

describe("section of a removed owner", () => {
  const lines = [{ ref: key(901), qty: 1, lineNumber: 1 }]
  const hideOnce = (fake: ReturnType<typeof setup>["fake"]) => {
    // Рядок відсутній для одного читання: скоуп на мить невидимий (RLS).
    fake.setVisibleScopes([])
    fake.take().answer()
    fake.setVisibleScopes(undefined)
  }

  it("shows no lines after a newer section read while the header stays removed", async () => {
    const { core, fake, inspect } = setup({ mode: "manual" })
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const cardView = core.view(card(1))
    watch(cardView)
    await settle()
    fake.take().answer()
    await settle()
    cardView.refresh()
    await settle()
    hideOnce(fake)
    await settle()
    expect(cardView.getSnapshot().rows[0]?.state).toBe("removed")
    const sectionView = core.view(section(1))
    watch(sectionView)
    await settle()
    fake.take().answer()
    await settle()
    expect(sectionView.getSnapshot().section?.lines ?? []).toEqual([])
    expect(sectionView.getSnapshot().section?.ownerVersion).toBeUndefined()
    expect(inspect.violations()).toEqual([])
  })

  it("re-reads a mounted section once a header re-read restores the owner", async () => {
    const { core, fake } = setup({ mode: "manual" })
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const cardView = core.view(card(1))
    watch(cardView)
    await settle()
    fake.take().answer()
    await settle()
    cardView.refresh()
    await settle()
    hideOnce(fake)
    await settle()
    const sectionView = core.view(section(1))
    watch(sectionView)
    await settle()
    fake.take().answer()
    await settle()
    expect(sectionView.getSnapshot().section?.lines ?? []).toEqual([])
    cardView.refresh()
    await settle()
    fake.take().answer()
    await settle()
    expect(cardView.getSnapshot().rows[0]?.state).toBe("synced")
    // Шапку відновлено: змонтований вигляд ТЧ дочитує рядки.
    expect(fake.pending.filter(isSection)).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(sectionView.getSnapshot().section).toMatchObject({
      complete: true,
      lines: [{ key: key(901) }],
    })
  })
})

describe("include", () => {
  const orgKey = (n: number) => key(10_000 + n)
  const full: ViewSpec = { kind: "full", object: TASK, include: ["org"] }

  function seedWithOrgs(fake: ReturnType<typeof setup>["fake"], count: number) {
    for (let n = 1; n <= count; n++) {
      fake.insert(ORG, { ref: orgKey(n) })
      fake.insert(TASK, taskValues(n, { org: orgKey(n) }))
    }
  }

  it("reads 450 targets in three requests through the limiter", async () => {
    const { core, fake } = setup()
    seedWithOrgs(fake, 450)
    const handle = core.view(full)
    watch(handle)
    await settle(2000)
    expect(readsOf(fake, ORG)).toHaveLength(3)
    expect(fake.maxInFlight).toBeLessThanOrEqual(
      DEFAULT_CORE_LIMITS.readParallel
    )
    const rows = handle.getSnapshot().rows
    expect(rows).toHaveLength(450)
    expect(rows[0]).toMatchObject({
      refs: { org: { key: orgKey(1), state: "synced" } },
    })
  })

  it("drops the target rows with the view", async () => {
    const { core, fake, inspect } = setup()
    seedWithOrgs(fake, 3)
    watch(core.view(full)).unsubscribe()
    await settle()
    expect(inspect.owners(ORG, orgKey(1))).toBe(1)
    vi.advanceTimersByTime(RELEASE)
    expect(inspect.rowCount()).toBe(0)
    expect(inspect.violations()).toEqual([])
  })

  it("gives null refs to a removed target", async () => {
    const { core, fake } = setup()
    seedWithOrgs(fake, 2)
    const handle = core.view(full)
    watch(handle)
    await settle()
    fake.remove(ORG, orgKey(1))
    handle.refresh()
    await settle()
    const [first, second] = handle.getSnapshot().rows
    expect(first).toMatchObject({ key: key(1), refs: { org: null } })
    expect(second).toMatchObject({ refs: { org: { key: orgKey(2) } } })
  })
})

describe("close", () => {
  it("gives one stable purged snapshot with the reason, without loading", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    const handle = core.view(keys(1))
    const { seen } = watch(handle)
    await settle()
    seen.length = 0
    core.close("signed-out")
    expect(seen).toHaveLength(1)
    const purged = seen[0]!
    expect(purged).toMatchObject({
      status: "purged",
      reason: "signed-out",
      rows: [],
    })
    expect(handle.getSnapshot()).toBe(purged)
    expect(core.view(keys(1)).getSnapshot()).toBe(purged)
    expect(core.view(card(7)).getSnapshot()).toBe(purged)
    expect(seen.some((s) => s.status === "loading")).toBe(false)
  })

  it("sends no queued request and writes no late response after close", async () => {
    const { core, fake, inspect, log } = setup({
      mode: "manual",
      limits: { readParallel: 1 },
    })
    seed(fake, 1, 2)
    watch(core.view(keys(1)))
    watch(core.view(keys(2)))
    expect(fake.pending).toHaveLength(1)
    core.close("disposed")
    fake.take().answer()
    await settle()
    expect(fake.log).toHaveLength(1)
    expect(inspect.rowCount()).toBe(0)
    expect(inspect.violations()).toEqual([])
    expect(log).toContainEqual(
      expect.objectContaining({ kind: "late-response" })
    )
    expect(vi.getTimerCount()).toBe(0)
    expect(core.view(keys(1)).subscribe(() => {})).toBeTypeOf("function")
    expect(fake.log).toHaveLength(1)
  })
})

void S

describe("fix round 1", () => {
  const lines = [{ ref: key(901), qty: 1, lineNumber: 1 }]

  it("re-reads a mounted section when its header changed during the section read", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const header = core.view(keys(1))
    watch(header)
    const mounted = core.view(section(1))
    watch(mounted)
    await settle()
    fake.hold = (read) => isSection(read)
    mounted.refresh()
    const before = fake.clock
    const v2 = fake.edit(TASK, key(1), { title: "v2" })
    header.refresh()
    await settle()
    fake.take().answer(before)
    await settle()
    expect(mounted.getSnapshot().section!.ownerVersion).toBeLessThan(v2)
    expect(fake.pending).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(mounted.getSnapshot().section!.ownerVersion).toBe(v2)
  })

  it("re-reads a mounted card when its row changed during the card read", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    const list = core.view(keys(1))
    watch(list)
    const handle = core.view(card(1))
    watch(handle)
    await settle()
    fake.hold = (read) => isCard(read)
    handle.refresh()
    const before = fake.clock
    fake.edit(TASK, key(1), { title: "x", notes: "body 2" })
    list.refresh()
    await settle()
    fake.take().answer(before)
    await settle()
    expect(handle.getSnapshot().rows[0]).toMatchObject({
      staleFields: ["notes"],
    })
    expect(fake.pending).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(handle.getSnapshot().rows[0]).toMatchObject({
      values: { notes: "body 2" },
      staleFields: [],
    })
  })

  it("keeps no row values in subsets after close", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    watch(core.view({ kind: "full", object: TASK, include: ["org"] }))
    await settle()
    const [s] = [...coreInternals(core).registry.subsets()]
    core.close("disposed")
    expect(s!.snapshot).toBeUndefined()
    expect(s!.layout).toEqual([])
    expect(s!.owned.size).toBe(0)
    expect(s!.included.size).toBe(0)
    expect(s!.refViews.size).toBe(0)
  })

  it("never repeats a row revision after its key is dropped", () => {
    const views = createRowViews()
    views.touch(TASK, key(1))
    const first = views.revision(TASK, key(1))
    views.settle(() => false)
    expect(views.revision(TASK, key(1))).toBe(0)
    views.touch(TASK, key(1))
    expect(views.revision(TASK, key(1))).not.toBe(first)
    expect(views.revision(TASK, key(1))).not.toBe(0)
  })

  it("leaves the view in error and no unowned row when applying a read throws", async () => {
    const { core, fake, inspect, log } = setup()
    seed(fake, 1, 2)
    const { ops } = coreInternals(core)
    const put = ops.put.bind(ops)
    let calls = 0
    const spy = vi.spyOn(ops, "put").mockImplementation((...args) => {
      if (++calls === 2) throw new Error("boom")
      return put(...args)
    })
    const handle = core.view(keys(1, 2))
    watch(handle)
    await settle()
    spy.mockRestore()
    expect(handle.getSnapshot()).toMatchObject({
      status: "error",
      error: { code: "command.internal" },
    })
    expect(inspect.rowCount()).toBe(0)
    expect(inspect.violations()).toEqual([])
    expect(log).toContainEqual(
      expect.objectContaining({ kind: "listener-failed" })
    )
  })
})
