import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  coreInternals,
  createCore,
  inspectCore,
  type CoreSession,
} from "../core"
import { createCoreSource, createReadLimiter } from "../source"
import type { FakeSource } from "../testing/fake-source"
import {
  DEFAULT_CORE_LIMITS,
  type CoreLimits,
  type CoreSnapshot,
  type ViewSnapshot,
  type ViewSpec,
  type Writer,
} from "../types"
import {
  ORG,
  TASK,
  isPage,
  key,
  seed,
  settle,
  setup,
  taskValues,
  watch,
} from "./core-support"

/*
 * SSR-знімок ядра (спека П4-B §6.6, план B3-6a, задача 1). Знімок — довірча
 * межа: те, що в ньому, йде в HTML, тож сентинели значень шукаємо в самому
 * JSON, а не в структурі, яку знає лише цей код.
 */

const RELEASE = DEFAULT_CORE_LIMITS.releaseDelayMs

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const write = (core: CoreSession, fn: (w: Writer) => void) =>
  core.commit(fn, core.token())

const keysView = (...ns: number[]): ViewSpec => ({
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
const win: ViewSpec = {
  kind: "window",
  object: TASK,
  orderBy: [{ attribute: "title", direction: "asc" }],
}
const full: ViewSpec = {
  kind: "full",
  object: TASK,
  orderBy: [{ attribute: "title", direction: "asc" }],
}
const lines = (qty: number) => [{ ref: key(900 + qty), qty, lineNumber: 1 }]

/** Titles that sort as the numbers do, so the order of `win` is the key order. */
const seedOrdered = (fake: FakeSource, to: number) => {
  for (let n = 1; n <= to; n++)
    fake.insert(
      TASK,
      taskValues(n, { title: `r${String(n).padStart(3, "0")}` })
    )
}

const jsonBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8")

/** Знімок, яким його бачить клієнт: пройшов через JSON, як через HTML. */
const through = (snapshot: CoreSnapshot): CoreSnapshot =>
  JSON.parse(JSON.stringify(snapshot)) as CoreSnapshot

/** A second core over the same fake server, counting its `version` requests. */
function coreOver(fake: FakeSource, limits: Partial<CoreLimits> = {}) {
  const versions = { calls: 0 }
  const merged = { ...DEFAULT_CORE_LIMITS, ...limits }
  const source = createCoreSource(
    () => fake.adapter,
    fake.index,
    createReadLimiter(merged.readParallel),
    {
      run: fake.server.run,
      version: () => {
        versions.calls++
        return fake.server.version()
      },
    }
  )
  const core = createCore({
    subject: "u1",
    source,
    index: fake.index,
    limits,
  })
  return { core, inspect: inspectCore(core), versions }
}

/**
 * Every view of the old core must show in the new one what it showed. A hidden
 * row is the exception by rule: its slot keeps the place and carries no facts
 * of the row, so only its key, `hidden` and the absence of values are compared.
 */
const expectSameViews = (
  from: CoreSession,
  to: CoreSession,
  specs: readonly ViewSpec[]
) => {
  const plain = (snapshot: ViewSnapshot) => ({
    ...snapshot,
    rows: snapshot.rows.map((row) =>
      row.state !== "removed" && row.hidden === true
        ? { key: row.key, hidden: true, values: row.values }
        : row
    ),
  })
  for (const spec of specs)
    expect(plain(to.view(spec).getSnapshot())).toEqual(
      plain(from.view(spec).getSnapshot())
    )
}

const heldSpecs = (core: CoreSession) =>
  [...coreInternals(core).registry.subsets()].map((s) => s.form.spec)

describe("what the snapshot carries", () => {
  it("a window of several pages: the rows of its own pages, the cursors and the edges", async () => {
    const { core, fake } = setup({ limits: { windowPage: 10 } })
    seedOrdered(fake, 45)
    const handle = core.view(win)
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    handle.loadAfter()
    await settle()
    const snapshot = through(core.dehydrate())
    expect(snapshot.format).toBe(1)
    const [sub] = snapshot.subsets
    expect(sub!.window!.pages.map((p) => p.size)).toEqual([10, 10, 10])
    expect(sub!.window!.pages.map((p) => p.lower.kind)).toEqual([
      "start",
      "after",
      "after",
    ])
    const lower = sub!.window!.pages[1]!.lower
    expect(lower.kind === "start" ? undefined : lower.cursor.key).toBe(key(10))
    expect(sub!.window!.atStart).toBe(true)
    expect(sub!.atEnd).toBe(false)
    // Рядки 31–45 ядро не читало: у знімку їх нема.
    expect(snapshot.objects[TASK]!.slots).toHaveLength(30)

    const next = coreOver(fake, { windowPage: 10 })
    next.core.hydrate(snapshot)
    expectSameViews(core, next.core, [win])
    expect(next.inspect.violations()).toEqual([])
  })

  it("a full view, a keys view and a card with a lazy field show the same after hydrate", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 4)
    const specs = [full, keysView(2, 3), card(1)]
    for (const spec of specs) watch(core.view(spec))
    await settle()
    const snapshot = through(core.dehydrate())
    // Ліниве поле картки йде з версією, з якою його прочитано.
    const cardRow = snapshot.objects[TASK]!.slots.find(
      (slot) => Array.isArray(slot) && slot[1]?.lazy !== undefined
    )
    expect(cardRow).toBeDefined()
    expect(core.view(card(1)).getSnapshot().rows[0]).toMatchObject({
      values: { notes: "body 1" },
    })

    const before = fake.log.length
    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    expectSameViews(core, next.core, specs)
    expect(next.core.view(card(1)).getSnapshot().rows[0]).toMatchObject({
      values: { notes: "body 1" },
      staleFields: [],
    })
    expect(fake.log.length).toBe(before)
    expect(next.inspect.violations()).toEqual([])
  })

  it("a tabular section with its lines and completeness", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines(5))
    const specs = [keysView(1), section(1)]
    for (const spec of specs) watch(core.view(spec))
    await settle()
    const snapshot = through(core.dehydrate())
    expect(snapshot.sections[TASK]).toMatchObject([
      { owner: key(1), section: "lines", complete: true },
    ])
    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    expectSameViews(core, next.core, specs)
    expect(
      next.core.view(section(1)).getSnapshot().section?.lines
    ).toHaveLength(1)
    expect(next.inspect.violations()).toEqual([])
  })

  it("a removed row is a slot without values and keeps its place", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const spec = keysView(1, 2, 3)
    watch(core.view(spec))
    await settle()
    fake.remove(TASK, key(2))
    void core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(core.view(spec).getSnapshot().rows[1]).toMatchObject({
      key: key(2),
      state: "removed",
    })
    const snapshot = through(core.dehydrate())
    expect(snapshot.objects[TASK]!.slots).toContainEqual({
      key: key(2),
      state: "removed",
      scope: expect.any(String),
    })
    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    expectSameViews(core, next.core, [spec])
  })

  it("a stale row is served with the stale flag, and the first read after hydrate clears it", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    const spec = keysView(1, 2)
    watch(core.view(spec))
    await settle()
    write(core, (w) => w.markStale(TASK, [key(1)], 99))
    expect(core.view(spec).getSnapshot().rows[0]).toMatchObject({
      state: "stale",
      stale: true,
    })
    const snapshot = through(core.dehydrate())
    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    expectSameViews(core, next.core, [spec])
    expect(next.core.view(spec).getSnapshot().rows[1]).not.toHaveProperty(
      "stale"
    )
    // Позначка «не доведено з гідратації» знімається звіркою після неї.
    const handle = next.core.view(spec)
    watch(handle)
    next.core.endHydration()
    await settle()
    expect(handle.getSnapshot().rows[0]).toMatchObject({ state: "synced" })
    expect(handle.getSnapshot().rows[0]).not.toHaveProperty("stale")
  })

  it("an include target is held with the view and shows in refs", async () => {
    const { core, fake } = setup()
    const org = key(10_001)
    fake.insert(ORG, { ref: org })
    fake.insert(TASK, taskValues(1, { org }))
    const spec: ViewSpec = { kind: "full", object: TASK, include: ["org"] }
    watch(core.view(spec))
    await settle()
    const snapshot = through(core.dehydrate())
    expect(snapshot.objects[ORG]!.slots).toHaveLength(1)
    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    expectSameViews(core, next.core, [spec])
    expect(next.inspect.violations()).toEqual([])
  })
})

describe("what the snapshot never carries", () => {
  it("rows of a released view and of a view that is reading again, whose rows stay in the store", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    for (const n of [1, 2, 3]) fake.edit(TASK, key(n), { title: `SECRET-${n}` })
    const gone = watch(core.view(keysView(1)))
    watch(core.view(keysView(2)))
    const again = core.view(keysView(3))
    watch(again)
    await settle()
    gone.unsubscribe()
    vi.advanceTimersByTime(RELEASE)
    // Вигляд 3 читає наново: його рядки ще в сховищі, але він не `ready`.
    fake.hold = () => true
    again.refresh()
    await settle()
    expect(again.getSnapshot().status).toBe("refreshing")
    expect(
      coreInternals(core).objects.get(TASK)!.rows.get(key(3))
    ).toBeDefined()
    const text = JSON.stringify(core.dehydrate())
    expect(text).toContain("SECRET-2")
    expect(text).not.toContain("SECRET-1")
    expect(text).not.toContain("SECRET-3")
    expect(coreInternals(core).objects.get(TASK)!.rows.get(key(1))).toBe(
      undefined
    )
  })

  it("the values of a hidden key, and the lines of its tabular section", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    fake.edit(TASK, key(1), { title: "SECRET-HIDDEN", notes: "SECRET-NOTES" })
    fake.edit(TASK, key(2), { title: "OPEN-ROW" })
    fake.setLines(TASK, key(1), "lines", lines(7_777_777))
    const specs = [keysView(1, 2), card(1), section(1)]
    for (const spec of specs) watch(core.view(spec))
    await settle()
    // Позитивний контроль: до позначки ті самі значення в знімку є.
    const open = JSON.stringify(core.dehydrate())
    for (const sentinel of ["SECRET-HIDDEN", "SECRET-NOTES", "7777777"])
      expect(open).toContain(sentinel)

    // Ключ зі старою позначкою `stale` теж іде слотом без фактів рядка.
    write(core, (w) => w.markStale(TASK, [key(1)], 99))
    fake.hold = () => true
    write(core, (w) => w.hide(TASK, [key(1)]))
    const snapshot = core.dehydrate()
    const text = JSON.stringify(snapshot)
    for (const sentinel of ["SECRET-HIDDEN", "SECRET-NOTES", "7777777"])
      expect(text).not.toContain(sentinel)
    expect(text).toContain("OPEN-ROW")
    expect(snapshot.objects[TASK]!.slots).toContainEqual({
      key: key(1),
      state: "hidden",
      scope: expect.any(String),
    })

    const next = coreOver(fake)
    next.core.hydrate(through(snapshot))
    expectSameViews(core, next.core, specs)
    expect(next.core.view(keysView(1, 2)).getSnapshot().rows[0]).toMatchObject({
      hidden: true,
      values: {},
    })
  })

  it("the lines of an owner hidden by the horizon, which stay in the store", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines(8_888_888))
    for (const spec of [keysView(1), section(1)]) watch(core.view(spec))
    await settle()
    expect(JSON.stringify(core.dehydrate())).toContain("8888888")
    // Горизонт ставить ту саму позначку, що й `hide`, але рядки ТЧ не стирає.
    coreInternals(core).objects.get(TASK)!.rows.get(key(1))!.stale.hidden = {
      epoch: 1_000_000,
    }
    expect(
      coreInternals(core).objects.get(TASK)!.sections.get(key(1), "lines")
    ).toBeDefined()
    const snapshot = core.dehydrate()
    expect(JSON.stringify(snapshot)).not.toContain("8888888")
    expect(snapshot.sections[TASK] ?? []).toEqual([])

    const next = coreOver(fake)
    next.core.hydrate(through(snapshot))
    expect(next.core.view(section(1)).getSnapshot().section).toMatchObject({
      ownerVersion: undefined,
      complete: false,
      lines: [],
    })
  })

  it("the sort values of a cursor whose row is hidden: the window is left out", async () => {
    const { core, fake } = setup({ limits: { windowPage: 10 } })
    for (let n = 1; n <= 25; n++)
      fake.insert(
        TASK,
        taskValues(n, {
          title:
            n === 10 ? "r10-CURSOR-SECRET" : `r${String(n).padStart(2, "0")}`,
        })
      )
    const handle = core.view(win)
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    // Позитивний контроль: курсор другої сторінки несе значення ключа 10.
    expect(JSON.stringify(core.dehydrate().subsets[0]!.window)).toContain(
      "CURSOR-SECRET"
    )
    fake.hold = () => true
    write(core, (w) => w.hide(TASK, [key(10)]))
    const snapshot = core.dehydrate()
    expect(JSON.stringify(snapshot)).not.toContain("CURSOR-SECRET")
    expect(snapshot.subsets).toEqual([])
  })
})

describe("an owner header held by a view that is not ready", () => {
  it("the section view shows the same owner state without the header row in the snapshot", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.edit(TASK, key(1), { title: "SECRET-HEADER" })
    fake.setLines(TASK, key(1), "lines", lines(3))
    const header = core.view(keysView(1))
    watch(header)
    watch(core.view(section(1)))
    await settle()
    fake.hold = () => true
    header.refresh()
    await settle()
    expect(core.view(section(1)).getSnapshot().section?.ownerState).toBe(
      "synced"
    )
    const snapshot = through(core.dehydrate())
    expect(JSON.stringify(snapshot)).not.toContain("SECRET-HEADER")
    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    expectSameViews(core, next.core, [section(1)])
  })
})

describe("hydrate", () => {
  it("makes the views ready and loaded: a subscription starts no read, a re-read takes them", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 5)
    const specs = [full, card(1), keysView(2)]
    for (const spec of specs) watch(core.view(spec))
    await settle()
    const snapshot = through(core.dehydrate())

    const before = fake.log.length
    const next = coreOver(fake)
    const timers = vi.getTimerCount()
    next.core.hydrate(snapshot)
    expect(vi.getTimerCount()).toBe(timers)
    for (const spec of specs) {
      const subset = coreInternals(next.core).registry.find(spec)!
      expect(subset).toMatchObject({ loaded: true, status: "ready" })
      watch(next.core.view(spec))
    }
    await settle()
    expect(fake.log.length).toBe(before)

    void next.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    // Склад і картка перечитуються: це доводить, що `revalidate` їх бере.
    expect(fake.log.length).toBeGreaterThan(before)
    expect(fake.log.slice(before).filter(isPage)).toHaveLength(1)
  })

  it("the snapshot holds a view until its first subscription; endHydration releases the rest after the delay, once", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const specs = [keysView(1), keysView(2)]
    for (const spec of specs) watch(core.view(spec))
    await settle()
    const snapshot = through(core.dehydrate())

    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    watch(next.core.view(specs[0]!))
    next.core.endHydration()
    await settle()
    const before = fake.log.length
    const timers = vi.getTimerCount()
    expect(heldSpecs(next.core)).toHaveLength(2)
    vi.advanceTimersByTime(RELEASE)
    // Невзята підмножина звільнилась, взята тримається.
    expect(heldSpecs(next.core)).toEqual([specs[0]])
    expect(next.inspect.violations()).toEqual([])

    next.core.endHydration()
    expect(fake.log.length).toBe(before)
    expect(vi.getTimerCount()).toBeLessThanOrEqual(timers)
    expect(next.versions.calls).toBe(1)
  })

  it("endHydration asks for the version and re-reads the visible views of every object, synchronously", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    fake.insert(ORG, { ref: key(10_001) })
    const specs = [
      keysView(1),
      keysView(2),
      { kind: "keys", object: ORG, keys: [key(10_001)] } as const,
    ]
    for (const spec of specs) watch(core.view(spec))
    await settle()
    const snapshot = through(core.dehydrate())

    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    for (const spec of specs) watch(next.core.view(spec))
    const before = fake.log.length
    next.core.endHydration()
    // Запити поставлено до першої мікрозадачі: між об'єктами `await` нема.
    expect(fake.log.length).toBeGreaterThan(before)
    await settle()
    expect(next.versions.calls).toBe(1)
    const objects = new Set(
      fake.log
        .slice(before)
        .map((r) => `${r.query!.object.kind}.${r.query!.object.name}`)
    )
    expect(objects).toEqual(new Set([TASK, ORG]))
  })

  it.each([
    ["another format", (s: CoreSnapshot) => ({ ...s, format: 2 })],
    [
      "an unknown object",
      (s: CoreSnapshot) => ({
        ...s,
        objects: { "Catalog.Nope": { epoch: null, slots: [] } },
      }),
    ],
    [
      "a layout out of the slots",
      (s: CoreSnapshot) => ({
        ...s,
        subsets: s.subsets.map((sub) => ({ ...sub, layout: [0, 99] })),
      }),
    ],
    [
      "lines nobody holds",
      (s: CoreSnapshot) => ({
        ...s,
        sections: {
          [TASK]: [
            {
              owner: key(1),
              section: "lines",
              lines: [],
              ownerVersion: 1,
              epoch: null,
              complete: true,
              scope: null,
            },
          ],
        },
      }),
    ],
  ])("refuses %s with a TypeError and writes nothing", async (_, break_) => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    watch(core.view(keysView(1, 2)))
    await settle()
    const snapshot = through(core.dehydrate())
    const next = coreOver(fake)
    expect(() => next.core.hydrate(break_(snapshot) as CoreSnapshot)).toThrow(
      TypeError
    )
    expect(next.inspect.rowCount()).toBe(0)
    expect(heldSpecs(next.core)).toEqual([])
    // Отказ не витрачає гідратацію: правильний знімок ще береться.
    next.core.hydrate(snapshot)
    expect(heldSpecs(next.core)).toHaveLength(1)
  })

  it("is taken once, and only into a core without views", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    watch(core.view(keysView(1)))
    await settle()
    const snapshot = through(core.dehydrate())

    const hydrated = coreOver(fake)
    hydrated.core.hydrate(snapshot)
    expect(() => hydrated.core.hydrate(snapshot)).toThrow(TypeError)

    const busy = coreOver(fake)
    watch(busy.core.view(keysView(2)))
    expect(() => busy.core.hydrate(snapshot)).toThrow(TypeError)
    expect(busy.inspect.rowCount()).toBe(0)
  })

  it("does nothing after close, and a closed core gives no snapshot", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    watch(core.view(keysView(1)))
    await settle()
    const snapshot = through(core.dehydrate())
    const next = coreOver(fake)
    next.core.close("disposed")
    const before = fake.log.length
    next.core.hydrate(snapshot)
    next.core.endHydration()
    await settle()
    expect(fake.log.length).toBe(before)
    expect(next.inspect.rowCount()).toBe(0)
    expect(() => next.core.dehydrate()).toThrow(TypeError)
  })
})

describe("dehydrate after a write", () => {
  it("throws a TypeError while the journal of mutations is not empty and writes nothing", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    watch(core.view(keysView(1)))
    await settle()
    const rows = fake.log.length
    const version = fake.row(TASK, key(1))!.version
    const mutation = core.update(
      TASK,
      key(1),
      { title: "x" },
      { expectedVersion: version }
    )
    expect(() => core.dehydrate()).toThrow(TypeError)
    expect(fake.log.length).toBe(rows)
    await mutation.settled
    await settle()
  })
})

describe("size", () => {
  it("is within 10 % of the rows of its own pages plus 2 KiB (spec §12)", async () => {
    const { core, fake } = setup({ limits: { windowPage: 25 } })
    seedOrdered(fake, 100)
    const handle = core.view(win)
    watch(handle)
    await settle()
    for (let i = 0; i < 3; i++) {
      handle.loadAfter()
      await settle()
    }
    const rows = handle.getSnapshot().rows
    expect(rows).toHaveLength(100)
    const own = rows.map((row) => (row.state === "removed" ? {} : row.values))
    const snapshot = core.dehydrate()
    expect(jsonBytes(snapshot)).toBeLessThanOrEqual(1.1 * jsonBytes(own) + 2048)
  })
})
