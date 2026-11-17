import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { keysetFilter, type ReadQuery } from "simetra/model"
import { coreInternals } from "../core"
import { checkFilterBudget, fieldInfoOf, nullableOf } from "../filter"
import { shareSnapshot } from "../snapshot"
import { createCoreSource, createReadLimiter } from "../source"
import { createCore, inspectCore } from "../core"
import { createFakeSource } from "../testing/fake-source"
import type { ViewSnapshot, ViewSpec } from "../types"
import { WINDOW_PAGE, reversedOrder } from "../window"
import {
  OBJECTS,
  TASK,
  isPage,
  key,
  keysIn,
  seed,
  settle,
  setup,
  task,
  taskValues,
  watch,
} from "./core-support"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const win: ViewSpec = { kind: "window", object: TASK }
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => key(from + i))

/** The held subset of the only window of a harness (tests reach into the core). */
const subsetOf = (core: Parameters<typeof coreInternals>[0]) =>
  [...coreInternals(core).registry.subsets()][0]!

const pageReads = (fake: ReturnType<typeof setup>["fake"]) =>
  fake.log.filter(isPage)

describe("window", () => {
  it("reads the first page from the start of the order", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    expect(handle.getSnapshot()).toMatchObject({
      status: "ready",
      strategy: "window",
      truncated: false,
      atStart: true,
      atEnd: false,
      chain: 1,
      target: "start",
    })
    expect(keysIn(handle.getSnapshot())).toEqual(range(1, WINDOW_PAGE))
    const reads = pageReads(fake)
    expect(reads).toHaveLength(1)
    expect(reads[0]!.query).toMatchObject({ limit: WINDOW_PAGE })
    expect(reads[0]!.query).not.toHaveProperty("where")
    expect(inspect.violations()).toEqual([])
  })

  it("reads the next page by a keyset after the last row, without gaps", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    handle.loadAfter()
    await settle()
    const snapshot = handle.getSnapshot()
    expect(keysIn(snapshot)).toEqual(range(1, 250))
    expect(snapshot).toMatchObject({ atEnd: true, chain: 1 })
    const [, second] = pageReads(fake)
    expect(second!.query).toMatchObject({
      where: keysetFilter(
        [],
        { values: {}, key: key(100), direction: "after" },
        "ref",
        () => false
      ),
    })
    expect(inspect.violations()).toEqual([])
  })

  it("asks no more once the order has ended", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 150)
    const handle = core.view(win)
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    expect(handle.getSnapshot().atEnd).toBe(true)
    const reads = pageReads(fake).length
    handle.loadAfter()
    await settle()
    expect(pageReads(fake)).toHaveLength(reads)
  })

  it("reads one page per direction at a time", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    fake.hold = (read) => isPage(read)
    handle.loadAfter()
    handle.loadAfter()
    await settle()
    expect(fake.pending).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual(range(1, 200))
  })

  it("keeps the server order of a sorted window across pages", async () => {
    const { core, fake } = setup()
    for (let n = 1; n <= 250; n++)
      fake.insert(TASK, taskValues(n, { title: `t${String(n % 7)}` }))
    const handle = core.view({
      kind: "window",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "desc" }],
    })
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    handle.loadAfter()
    await settle()
    const rows = handle.getSnapshot().rows
    expect(rows).toHaveLength(250)
    const titles = rows.map((r) =>
      r.state === "removed" ? "" : r.values.title
    )
    expect(titles).toEqual([...titles].sort().reverse())
    // Нічия за ключем: порядок у групі рівних заголовків — за зростанням ключа.
    const group = rows
      .filter((r) => r.state !== "removed" && r.values.title === "t6")
      .map((r) => r.key)
    expect(group).toEqual([...group].sort())
    expect(new Set(rows.map((r) => r.key)).size).toBe(250)
  })

  it("passes a keyset over NULL in the sort column inside the filter budget", async () => {
    const { core, fake } = setup()
    for (let n = 1; n <= 150; n++)
      fake.insert(TASK, taskValues(n, { status: n <= 99 ? "Open" : null }))
    const spec: ViewSpec = {
      kind: "window",
      object: TASK,
      where: { attribute: "title", op: "ne", value: "x" },
      orderBy: [{ attribute: "status", direction: "asc" }],
    }
    const handle = core.view(spec)
    watch(handle)
    await settle()
    // Граница сторінки лежить усередині групи NULL: курсор — NULL.
    handle.loadAfter()
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual(range(1, 150))
    const [, second] = pageReads(fake)
    const where = (second!.query as { where?: unknown }).where as Parameters<
      typeof checkFilterBudget
    >[0]
    expect(() => checkFilterBudget(where)).not.toThrow()
    const info = fieldInfoOf(task)
    expect(JSON.stringify(where)).toContain(
      JSON.stringify(
        keysetFilter(
          [{ attribute: "status", direction: "asc" }],
          {
            values: { status: null },
            key: key(100),
            direction: "after",
          },
          "ref",
          nullableOf(info)
        )
      )
    )
  })

  it("refuses a filter over the budget before any request", () => {
    const { core, fake } = setup()
    const where = {
      and: Array.from({ length: 62 }, () => ({
        attribute: "title",
        op: "ne" as const,
        value: "x",
      })),
    }
    expect(() =>
      core.view({
        kind: "window",
        object: TASK,
        where,
        orderBy: [{ attribute: "status", direction: "asc" }],
      })
    ).toThrow(
      expect.objectContaining({
        error: { code: "command.invalid", path: "where" },
      }) as unknown as Error
    )
    expect(fake.log).toHaveLength(0)
  })

  it("continues a page the response budget cut by a keyset from its last row", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 250)
    fake.responseRows = 40
    const handle = core.view(win)
    watch(handle)
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual(range(1, WINDOW_PAGE))
    const reads = pageReads(fake)
    expect(reads).toHaveLength(3)
    expect(reads.map((r) => (r.query as { limit: number }).limit)).toEqual([
      100, 60, 20,
    ])
    expect(reads[1]!.query).toMatchObject({
      where: keysetFilter(
        [],
        { values: {}, key: key(40), direction: "after" },
        "ref",
        () => false
      ),
    })
  })

  it("does not repeat a keyset read that did not move the cursor", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 250)
    let served = 0
    const adapter = {
      capabilities: fake.adapter.capabilities,
      read: async (items: Parameters<typeof fake.adapter.read>[0]) => {
        const result = await fake.adapter.read(items)
        served++
        return {
          ...result,
          items: result.items.map((item) =>
            item.ok && "rows" in item.value
              ? {
                  ...item,
                  value: {
                    ...item.value,
                    rows: served === 1 ? item.value.rows.slice(0, 30) : [],
                    more: true as const,
                  },
                }
              : item
          ),
        }
      },
    }
    const core = createCore({
      subject: "u1",
      source: createCoreSource(() => adapter, fake.index, createReadLimiter(4)),
      index: fake.index,
    })
    const handle = core.view(win)
    watch(handle)
    await settle()
    expect(served).toBe(2)
    expect(handle.getSnapshot()).toMatchObject({
      status: "ready",
      atEnd: false,
    })
    expect(handle.getSnapshot().rows).toHaveLength(30)
    expect(inspectCore(core).violations()).toEqual([])
  })

  it("reads the page before the first one backwards and puts it first", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    // Вікно, що почалося посеред порядку (так його ставитиме `goTo`).
    const s = subsetOf(core)
    const w = s.window!
    const second = w.pages[1]!
    s.window = { ...w, pages: [second], atStart: false }
    s.layout = [...second.keys]
    s.layoutSet = new Set(s.layout)
    s.dirty = true
    expect(handle.getSnapshot().atStart).toBe(false)

    handle.loadBefore()
    await settle()
    const snapshot = handle.getSnapshot()
    expect(keysIn(snapshot)).toEqual(range(1, 200))
    const read = pageReads(fake).at(-1)!
    expect(read.query).toMatchObject({
      orderBy: reversedOrder([], "ref"),
      where: keysetFilter(
        [],
        { values: {}, key: key(101), direction: "before" },
        "ref",
        () => false
      ),
    })
    // Сто рядків рівно: початок порядку ще не підтверджено.
    expect(snapshot.atStart).toBe(false)
    expect(s.window!.pages[0]!.lower).toMatchObject({
      kind: "from",
      cursor: { key: key(1) },
    })
    handle.loadBefore()
    await settle()
    expect(handle.getSnapshot().atStart).toBe(true)
    expect(keysIn(handle.getSnapshot())).toEqual(range(1, 200))
    expect(inspect.violations()).toEqual([])
  })

  it("moves on when a fetched page adds nothing the window did not hold", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    // Рядки 101-200 вікно вже тримає, а останньою сторінкою лишається перша.
    const s = subsetOf(core)
    const w = s.window!
    s.window = { ...w, pages: [w.pages[0]!] }
    s.layout = [...w.pages[0]!.keys]
    s.layoutSet = new Set(keysIn(handle.getSnapshot()))
    const before = pageReads(fake).length
    handle.loadAfter()
    await settle()
    expect(pageReads(fake)).toHaveLength(before + 1)
    handle.loadAfter()
    await settle()
    const reads = pageReads(fake).slice(before)
    expect(reads).toHaveLength(2)
    expect(JSON.stringify(reads[1]!.query)).not.toBe(
      JSON.stringify(reads[0]!.query)
    )
    expect(keysIn(handle.getSnapshot())).toEqual([
      ...range(1, WINDOW_PAGE),
      ...range(201, 250),
    ])
  })

  it("reads nothing more on loadAfter during the first load", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 250)
    fake.hold = (read) => isPage(read)
    const handle = core.view(win)
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    expect(fake.pending).toHaveLength(1)
    expect(pageReads(fake)).toHaveLength(1)
  })

  it("reads nothing on loadAfter after a first load that failed", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 250)
    fake.hold = (read) => isPage(read)
    const handle = core.view(win)
    watch(handle)
    await settle()
    fake.take().fail("command.unavailable")
    await settle()
    expect(handle.getSnapshot().status).toBe("error")
    const before = pageReads(fake).length
    handle.loadAfter()
    await settle()
    expect(pageReads(fake)).toHaveLength(before)
    expect(fake.pending).toHaveLength(0)
  })

  it("reads backwards with the mirrored order of a sorted window", async () => {
    const { core, fake } = setup()
    for (let n = 1; n <= 30; n++)
      fake.insert(TASK, taskValues(n, { status: n % 3 === 0 ? null : "Open" }))
    const handle = core.view({
      kind: "window",
      object: TASK,
      orderBy: [{ attribute: "status", direction: "asc" }],
    })
    watch(handle)
    await settle()
    const first = keysIn(handle.getSnapshot())
    expect(first).toHaveLength(30)
    const s = subsetOf(core)
    const w = s.window!
    const tail = first.slice(20)
    s.window = {
      ...w,
      pages: [{ ...w.pages[0]!, keys: tail }],
      atStart: false,
    }
    s.layout = tail
    s.layoutSet = new Set(tail)
    s.dirty = true
    handle.loadBefore()
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual(first)
    expect(handle.getSnapshot().atStart).toBe(true)
  })

  it("does not write a page whose chain was replaced meanwhile", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    fake.hold = (read) => isPage(read)
    handle.loadAfter()
    await settle()
    const late = fake.take()
    handle.refresh()
    await settle()
    fake.hold = undefined
    fake.take().answer()
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ chain: 2 })
    late.answer()
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual(range(1, WINDOW_PAGE))
    expect(inspect.violations()).toEqual([])
    expect(inspect.rowCount()).toBe(WINDOW_PAGE)
  })

  it("writes nothing and asks nothing after the core is closed", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    fake.hold = (read) => isPage(read)
    handle.loadAfter()
    await settle()
    const late = fake.take()
    core.close("disposed")
    late.answer()
    await settle()
    handle.loadAfter()
    await settle()
    expect(inspect.rowCount()).toBe(0)
    expect(fake.pending).toHaveLength(0)
    expect(pageReads(fake)).toHaveLength(2)
  })

  it("drops a purged key from the pages and the composition", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    core.commit((w) => w.purge(TASK, { keys: [key(5)] }), core.token())
    const keys = keysIn(handle.getSnapshot())
    expect(keys).toEqual(range(1, WINDOW_PAGE).filter((k) => k !== key(5)))
    expect(subsetOf(core).window!.pages[0]!.keys).toEqual(keys)
    expect(inspect.violations()).toEqual([])
  })

  it("keeps a window out of the composition changes of a system re-read", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    fake.edit(TASK, key(3), { title: "changed" })
    fake.remove(TASK, key(4))
    await core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const rows = handle.getSnapshot().rows
    expect(rows.map((r) => r.key)).toEqual(range(1, WINDOW_PAGE))
    expect(rows[2]).toMatchObject({ values: { title: "changed" } })
    expect(rows[3]).toMatchObject({ state: "removed" })
  })

  it("holds the include targets of every page it read", async () => {
    const { core, fake, inspect } = setup()
    fake.insert("Catalog.Organization", {
      ref: "00000000-0000-4000-8000-0000000000b1",
    })
    seed(fake, 1, 250)
    const handle = core.view({ kind: "window", object: TASK, include: ["org"] })
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    expect(handle.getSnapshot().rows[150]).toMatchObject({
      refs: { org: { key: "00000000-0000-4000-8000-0000000000b1" } },
    })
    expect(
      inspect.owners(
        "Catalog.Organization",
        "00000000-0000-4000-8000-0000000000b1"
      )
    ).toBe(1)
    expect(inspect.violations()).toEqual([])
  })
})

describe("window snapshot sharing", () => {
  const base: ViewSnapshot = {
    status: "ready",
    rows: [],
    hasNewRows: false,
    needsRefresh: false,
    strategy: "window",
    truncated: false,
    atEnd: false,
    atStart: true,
    chain: 1,
    target: "start",
  }
  const next = (extra: Partial<ViewSnapshot>) => ({ ...base, ...extra })

  it("keeps the snapshot while nothing it carries changed", () => {
    const first = shareSnapshot(undefined, base)
    expect(shareSnapshot(first, next({}))).toBe(first)
  })

  it.each([
    { chain: 2 },
    { target: "end" as const },
    { atStart: false },
  ])("gives a new snapshot when only %o changed", (extra) => {
    const first = shareSnapshot(undefined, base)
    expect(shareSnapshot(first, next(extra))).not.toBe(first)
  })
})

describe("setVisibleRange", () => {
  it("changes nothing: no read, the same snapshot", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 250)
    const handle = core.view(win)
    watch(handle)
    await settle()
    const before = handle.getSnapshot()
    const reads = fake.log.length
    handle.setVisibleRange({ first: 10, last: 20 })
    await settle()
    expect(handle.getSnapshot()).toBe(before)
    expect(fake.log).toHaveLength(reads)
  })
})

describe("a full over its limit", () => {
  it("becomes a window that reads on from its first page with the filter", async () => {
    const { core, fake, log, inspect } = setup({ limits: { fullLimit: 300 } })
    seed(fake, 1, 450)
    fake.insert(TASK, taskValues(451, { title: "x" }))
    const handle = core.view({
      kind: "full",
      object: TASK,
      where: { attribute: "title", op: "ne", value: "x" },
    })
    watch(handle)
    await settle()
    expect(handle.getSnapshot()).toMatchObject({
      strategy: "window",
      truncated: true,
      atStart: true,
      atEnd: false,
      chain: 1,
    })
    expect(keysIn(handle.getSnapshot())).toEqual(range(1, WINDOW_PAGE))
    expect(log).toContainEqual({
      kind: "full-truncated",
      object: TASK,
      limit: 300,
    })
    const before = fake.log.length
    handle.loadAfter()
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual(range(1, 200))
    const read = fake.log[before]!.query as ReadQuery & { where?: unknown }
    // Продовження читає фільтр на сервері: `full` відфільтровував локально.
    expect(JSON.stringify(read.where)).toContain('"title"')
    expect(inspect.violations()).toEqual([])
  })

  it("reaches matching rows when the filter matches none of the first fullLimit rows", async () => {
    const { core, fake, inspect } = setup({ limits: { fullLimit: 120 } })
    for (let n = 1; n <= 250; n++)
      fake.insert(TASK, taskValues(n, { title: "x" }))
    for (let n = 251; n <= 300; n++)
      fake.insert(TASK, taskValues(n, { title: "y" }))
    const handle = core.view({
      kind: "full",
      object: TASK,
      where: { attribute: "title", op: "eq", value: "y" },
    })
    watch(handle)
    await settle()
    expect(handle.getSnapshot()).toMatchObject({
      strategy: "window",
      truncated: true,
      atEnd: false,
    })
    expect(handle.getSnapshot().rows).toHaveLength(0)
    handle.loadAfter()
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual(range(251, 300))
    expect(inspect.violations()).toEqual([])
  })

  it("is a full again once the object fits", async () => {
    const { core, fake } = setup({ limits: { fullLimit: 120 } })
    seed(fake, 1, 150)
    const handle = core.view({ kind: "full", object: TASK })
    watch(handle)
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ strategy: "window" })
    for (let n = 1; n <= 40; n++) fake.remove(TASK, key(n))
    handle.refresh()
    await settle()
    expect(handle.getSnapshot()).toMatchObject({
      strategy: "full",
      truncated: false,
      atEnd: true,
    })
    expect(handle.getSnapshot()).not.toHaveProperty("chain")
    expect(handle.getSnapshot().rows).toHaveLength(110)
  })
})
