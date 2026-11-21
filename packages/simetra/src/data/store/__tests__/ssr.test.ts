import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  coreInternals,
  createCore,
  inspectCore,
  type CoreSession,
} from "../core"
import type { ServerFunctionAdapter } from "../../adapter"
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
import type { CatalogEntry, RightsRow, RightsSnapshot } from "simetra/model"
import {
  SCOPE_KIND_ID,
  catalogRights,
} from "../../../model/runtime/__tests__/entries"
import {
  ORG,
  S,
  TASK,
  isPage,
  key,
  seed,
  settle,
  setup,
  task,
  org,
  taskValues,
  watch,
} from "./core-support"

/*
 * SSR-знімок ядра (спека П4-B §6.6). Знімок — довірча
 * межа: те, що в ньому, йде в HTML, тож сентинели значень шукаємо в самому
 * JSON, а не в структурі, яку знає лише цей код.
 */

const T = "00000000-0000-4000-8000-0000000000b2"
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
function coreOver(
  fake: FakeSource,
  limits: Partial<CoreLimits> = {},
  rightsSnapshot = false
) {
  const versions = { calls: 0 }
  const merged = { ...DEFAULT_CORE_LIMITS, ...limits }
  // Той самий `read` в адаптері й порту: версія йде в запиті частин об'єктів.
  const read: ServerFunctionAdapter["read"] = (items) => {
    versions.calls += items.filter((item) => item.type === "version").length
    return fake.adapter.read(items)
  }
  const adapter: ServerFunctionAdapter = {
    capabilities: fake.adapter.capabilities,
    read,
  }
  const source = createCoreSource(
    () => adapter,
    fake.index,
    createReadLimiter(merged.readParallel),
    { run: fake.server.run, read }
  )
  const core = createCore({
    subject: "u1",
    source,
    index: fake.index,
    limits,
    ...(rightsSnapshot ? { rightsSnapshot: true } : {}),
  })
  return { core, inspect: inspectCore(core), versions }
}

/**
 * Every view of the old core must show in the new one what it showed. A hidden
 * row is the exception by rule only for its `version` and `stale`: its slot
 * keeps the place and carries no facts of the row.
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
        ? { ...row, version: undefined, stale: undefined }
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
    const requests = fake.requests.length
    next.core.endHydration()
    // Запити поставлено до першої мікрозадачі: між об'єктами `await` нема, тож
    // збирач віддає їх разом із `version` одним запитом.
    await Promise.resolve()
    expect(fake.log.length).toBeGreaterThan(before)
    expect(fake.requests.length).toBe(requests + 1)
    await settle()
    expect(fake.requests.length).toBe(requests + 1)
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

describe("a hydrated view first shown after the reconciliation", () => {
  /**
   * A snapshot of the views and a core hydrated from it, `endHydration` done:
   * the reconciliation read every view of the snapshot, subscribed or not.
   * `since` — the log length before `endHydration`.
   */
  async function hydrated(
    specs: readonly ViewSpec[],
    options: { preload?: boolean; keep?: readonly ViewSpec[] } = {}
  ) {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    // Без ліниві полів: картка над такою організацією читається лише через
    // довіру до рядка, не через `notes`.
    for (const ref of [S, T]) fake.insert(ORG, { ref })
    fake.setLines(TASK, key(1), "lines", lines(5))
    for (const spec of specs) {
      if (options.preload === true) await core.preload(spec)
      else watch(core.view(spec))
    }
    await settle()
    const snapshot = through(core.dehydrate())
    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    for (const spec of options.keep ?? []) watch(next.core.view(spec))
    const since = fake.log.length
    next.core.endHydration()
    await settle()
    return { ...next, fake, since, reads: () => fake.log.length }
  }

  it("a view preloaded into the snapshot, first subscribed after endHydration, is read once", async () => {
    const t = await hydrated([keysView(1, 2)], { preload: true })
    watch(t.core.view(keysView(1, 2)))
    await settle()
    // Читання — звірки (вигляд знімка), підписка нового не додає.
    expect(t.reads() - t.since).toBe(1)
    expect(t.inspect.violations()).toEqual([])
  })

  it("a conditional mount within the release delay reads once", async () => {
    const t = await hydrated([keysView(1), keysView(2)])
    vi.advanceTimersByTime(RELEASE - 1)
    watch(t.core.view(keysView(2)))
    await settle()
    // По читанню на вигляд знімка, зроблених звіркою; пізня підписка нового не додає.
    expect(t.reads() - t.since).toBe(2)
  })

  it("a hydrated card subscribed late reads once", async () => {
    const t = await hydrated([card(1)])
    watch(t.core.view(card(1)))
    await settle()
    expect(t.reads() - t.since).toBe(1)
  })

  it("a hydrated tabular section subscribed late reads once", async () => {
    const t = await hydrated([section(1)])
    watch(t.core.view(section(1)))
    await settle()
    expect(t.reads() - t.since).toBe(1)
  })

  it("a hydrated view with visible false reads once on setVisible(true)", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const spec = keysView(1, 2)
    watch(core.view(spec))
    await settle()
    const next = coreOver(fake)
    next.core.hydrate(through(core.dehydrate()))
    watch(next.core.view(spec))
    next.core.setVisible(spec, false)
    next.core.endHydration()
    await settle()
    // Невидимий вигляд звірка не читає.
    expect(next.versions.calls).toBe(1)
    const before = fake.log.length
    next.core.setVisible(spec, true)
    await settle()
    expect(fake.log.length - before).toBe(1)
    next.core.setVisible(spec, false)
    next.core.setVisible(spec, true)
    await settle()
    expect(fake.log.length - before).toBe(1)
  })

  it("a view the reconciliation already read is not read again on a new subscription", async () => {
    const spec = keysView(1, 2)
    const t = await hydrated([spec], { keep: [spec] })
    const before = t.reads()
    watch(t.core.view(spec))
    await settle()
    expect(t.reads() - before).toBe(0)
  })

  it("a card mounted after endHydration over a row held only by an invisible hydrated list adds no read: the reconciliation read the list", async () => {
    // Організація без лінивих полів: читання картки — лише від недовіри до
    // рядка, який записала гідратація.
    const orgs: ViewSpec = { kind: "keys", object: ORG, keys: [S, T] }
    const orgCard = (ref: string): ViewSpec => ({
      kind: "card",
      object: ORG,
      key: ref,
    })
    const t = await hydrated([orgs], { preload: true })
    // Список знімка звірка прочитала, тож рядки вже довірені: картки над
    // ними нового читання не дають.
    watch(t.core.view(orgCard(S)))
    watch(t.core.view(orgCard(T)))
    await settle()
    expect(t.reads() - t.since).toBe(1)
    expect(t.inspect.violations()).toEqual([])
  })

  it("a view over an include target written only by the hydration reads it", async () => {
    const withOrg: ViewSpec = {
      kind: "full",
      object: TASK,
      include: ["org"],
    }
    // Власні рядки (1–3) перечитує підписка до `endHydration`; ціль `include`
    // (ORG) — ні: її записала лише гідратація.
    const t = await hydrated([withOrg], {
      preload: true,
      keep: [keysView(1, 2, 3)],
    })
    watch(t.core.view(withOrg))
    await settle()
    expect(
      t.fake.log
        .slice(t.since)
        .some((l) => l.query?.object.name === "Organization")
    ).toBe(true)
  })

  it("two subscriptions to one view over hydration-only rows, while its read is in flight, read once", async () => {
    const t = await hydrated([keysView(1, 2)], { preload: true })
    const before = t.reads()
    watch(t.core.view(card(1)))
    watch(t.core.view(card(1)))
    await settle()
    expect(t.reads() - before).toBe(1)
  })

  it("a card over a row already re-read after the hydration is not read", async () => {
    const t = await hydrated([keysView(1, 2)], { preload: true })
    const first = watch(t.core.view(card(1)))
    await settle()
    // Картка прочитала рядок після гідратації: повторне монтування — без читання.
    first.unsubscribe()
    const before = t.reads()
    watch(t.core.view(card(1)))
    await settle()
    expect(t.reads() - before).toBe(0)
  })

  it.each([
    ["card", card(1)],
    ["keys view", keysView(1, 2)],
  ])(
    "a %s over a row the server deleted is not re-read on later subscriptions",
    async (_name, spec) => {
      const t = await hydrated([spec], { preload: true })
      t.fake.remove(TASK, key(1))
      const first = watch(t.core.view(spec))
      await settle()
      const before = t.reads()
      first.unsubscribe()
      for (let n = 0; n < 3; n++) {
        const w = watch(t.core.view(spec))
        await settle()
        if (n === 1) w.unsubscribe()
      }
      expect(t.reads() - before).toBe(0)
    }
  )

  it("a view over a removed slot of the snapshot is not re-read repeatedly", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const spec = keysView(1, 2)
    watch(core.view(spec))
    await settle()
    fake.remove(TASK, key(2))
    void core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const next = coreOver(fake)
    next.core.hydrate(through(core.dehydrate()))
    next.core.endHydration()
    await settle()
    const first = watch(next.core.view(spec))
    await settle()
    const before = fake.log.length
    first.unsubscribe()
    for (let n = 0; n < 3; n++) {
      watch(next.core.view(spec))
      await settle()
    }
    expect(fake.log.length - before).toBe(0)
  })

  it("a resubscription while the reconciliation read is in flight adds no read", async () => {
    const baseline = async (resubscribe: boolean) => {
      const { core, fake } = setup()
      seed(fake, 1, 3)
      const specs = [keysView(1), keysView(2)]
      for (const spec of specs) watch(core.view(spec))
      await settle()
      const next = coreOver(fake)
      next.core.hydrate(through(core.dehydrate()))
      const subs = specs.map((spec) => watch(next.core.view(spec)))
      const from = fake.log.length
      next.core.endHydration()
      if (resubscribe) {
        // StrictMode: отписка й нова підписка до відповіді звірки.
        for (const sub of subs) sub.unsubscribe()
        for (const spec of specs) watch(next.core.view(spec))
      }
      await settle()
      return fake.log.length - from
    }
    const once = await baseline(false)
    expect(once).toBeGreaterThan(0)
    expect(await baseline(true)).toBe(once)
  })

  it("a new view and loadBefore/loadAfter of a stale-client object send no request and carry the stale-client code", async () => {
    const { core, fake } = setup()
    seedOrdered(fake, 6)
    watch(core.view(win))
    await settle()
    core.staleClient(TASK)
    const before = fake.log.length
    core.view(win).loadAfter()
    core.view(win).loadBefore()
    const fresh = core.view(keysView(1, 2))
    watch(fresh)
    await settle()
    expect(fake.log.length - before).toBe(0)
    expect(core.view(win).getSnapshot()).toMatchObject({
      status: "ready",
      isStale: true,
    })
    expect(fresh.getSnapshot()).toMatchObject({
      isStale: true,
      error: { code: "command.stale-client" },
    })
  })

  it("a stale-client object is not read", async () => {
    const t = await hydrated([card(1)])
    t.core.staleClient(TASK)
    const before = t.reads()
    const handle = t.core.view(card(1))
    watch(handle)
    await settle()
    expect(t.reads() - before).toBe(0)
    expect(handle.getSnapshot().isStale).toBe(true)
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

/*
 * Частина `rights` в SSR (план B5b-2, Р1, Р3, Р5а): перший пакет сервера її
 * несе, знімок прав у HTML не їде, звірка гідратації застосовує загальне
 * правило заміни тим самим одним запитом.
 */
describe("the rights part of SSR", () => {
  const USER = "00000000-0000-4000-8000-0000000000a1"
  const taskR: CatalogEntry = { ...task, rights: catalogRights() }
  const readRow = (
    scope: string,
    over: Partial<RightsRow> = {}
  ): RightsRow => ({
    level: "scope",
    levelId: null,
    scope,
    container: null,
    object: "task",
    action: "read",
    extent: "any",
    dimensionId: null,
    ...over,
  })
  const snapshotOf = (rights: RightsRow[]): RightsSnapshot => ({
    userId: USER,
    scopeSets: [S, T].map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
    rights,
    members: [],
    dimensionValues: [],
  })
  let versions = 0
  const grant = (fake: FakeSource, snapshot: RightsSnapshot) => {
    fake.rightsSnapshot = snapshot
    fake.rightsVersion = (++versions).toString(16).padStart(64, "0")
  }

  /** Server core over a world with a scoped object: tasks 1, 2 in S, 3 in T. */
  async function serverSnapshot() {
    const h = setup({ rightsSnapshot: true, objects: [taskR, org] })
    grant(h.fake, snapshotOf([readRow(S), readRow(T)]))
    h.fake.epoch = "e".repeat(64)
    const plain = { status: null, subject: null }
    for (const n of [1, 2]) h.fake.insert(TASK, taskValues(n, plain))
    h.fake.insert(TASK, taskValues(3, { org: T, ...plain }))
    void h.core.preload(keysView(1, 2))
    void h.core.preload(keysView(3))
    void h.core.preload(card(1))
    void h.core.preload(card(3))
    await settle()
    return { ...h, snapshot: through(h.core.dehydrate()) }
  }

  /** Bytes of the answer of the request `from` the way the transport carries it. */
  const answerBytes = (fake: FakeSource, from: number) =>
    jsonBytes({ snapshotHash: fake.snapshotHash, objects: fake.kernelHashes }) +
    fake.rightsLog
      .filter((r) => r.request === from)
      .reduce((sum, r) => sum + jsonBytes(r.response), 0) +
    fake.log
      .filter((r) => r.request === from)
      .reduce((sum, r) => sum + jsonBytes(r.response), 0)

  it("the first packet of the server core carries rights without known; the snapshot has no rights data", async () => {
    const { fake, snapshot } = await serverSnapshot()
    expect(fake.rightsReads).toEqual([undefined])
    // Частина `rights` і читання одного пакета.
    expect(fake.requests).toEqual([5])
    expect(snapshot.subsets.length).toBeGreaterThan(0)
    const text = JSON.stringify(snapshot)
    for (const sentinel of [
      USER,
      "scopeSets",
      "rightsVersion",
      fake.rightsVersion,
    ])
      expect(text).not.toContain(sentinel)
  })

  it("rights did not change: one request, version and rights without known and the re-reads with known, within the SSR row of spec §12", async () => {
    const { fake, snapshot } = await serverSnapshot()
    const next = coreOver(fake, {}, true)
    next.core.hydrate(snapshot)
    const handles = [keysView(1, 2), keysView(3), card(1), card(3)].map(
      (spec) => next.core.view(spec)
    )
    for (const handle of handles) watch(handle)
    const from = fake.requests.length
    next.core.endHydration()
    await settle()
    expect(fake.requests).toHaveLength(from + 1)
    expect(fake.requests[from]).toBe(6)
    expect(next.versions.calls).toBe(1)
    expect(fake.rightsLog.filter((r) => r.request === from)).toMatchObject([
      { known: undefined },
    ])
    const reads = fake.log.filter((r) => r.request === from)
    expect(reads).toHaveLength(4)
    expect(reads.every((r) => r.known !== undefined)).toBe(true)
    expect(next.core.rights()).toBeDefined()
    expect(handles[0]!.getSnapshot()).toMatchObject({ status: "ready" })
    expect(handles[0]!.getSnapshot().rows).toHaveLength(2)
    expect(handles[1]!.getSnapshot()).toMatchObject({ status: "ready" })
    // 2 КіБ + 128 Б × об'єктів + знімок прав + маркери 8 Б на рядок.
    const rightsAnswer = jsonBytes(
      fake.rightsLog.find((r) => r.request === from)!.response
    )
    expect(answerBytes(fake, from)).toBeLessThanOrEqual(
      2048 + 128 * 2 + rightsAnswer + 8 * 6
    )
  })

  it("rights changed between render and reconcile: the lost pair is purged access-changed in that same request", async () => {
    const { fake, snapshot } = await serverSnapshot()
    grant(fake, snapshotOf([readRow(T)]))
    fake.setVisibleScopes([T])
    const next = coreOver(fake, {}, true)
    next.core.hydrate(snapshot)
    const lost = next.core.view(card(1))
    const kept = next.core.view(card(3))
    watch(lost)
    watch(kept)
    const from = fake.requests.length
    next.core.endHydration()
    await settle()
    // Втрата пари й причина — у відповіді того самого пакета: version,
    // rights без known і два читання; другої частини `rights` немає.
    expect(fake.requests).toHaveLength(from + 1)
    expect(fake.requests[from]).toBe(6)
    expect(fake.rightsReads).toEqual([undefined, undefined])
    expect(lost.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "access-changed",
      rows: [],
    })
    expect(kept.getSnapshot()).toMatchObject({
      status: "ready",
      rows: [{ key: key(3) }],
    })
  })

  it("an extent narrowed inside an allowed pair: the row goes removed from the re-read of the same request", async () => {
    const { fake, snapshot } = await serverSnapshot()
    grant(fake, snapshotOf([readRow(S, { extent: "own" }), readRow(T)]))
    fake.remove(TASK, key(2))
    const next = coreOver(fake, {}, true)
    next.core.hydrate(snapshot)
    const view = next.core.view(keysView(1, 2))
    watch(view)
    const from = fake.requests.length
    next.core.endHydration()
    await settle()
    expect(fake.requests).toHaveLength(from + 1)
    const rows = view.getSnapshot().rows
    expect(view.getSnapshot().status).toBe("ready")
    expect(rows[0]).toMatchObject({ key: key(1), state: "synced" })
    expect(rows[1]).toMatchObject({ key: key(2), state: "removed" })
  })

  it("without the rightsSnapshot flag the reconciliation is the main one: no rights part", async () => {
    const { core, fake } = setup({ objects: [taskR, org] })
    seed(fake, 1, 2)
    watch(core.view(keysView(1, 2)))
    await settle()
    const snapshot = through(core.dehydrate())
    const next = coreOver(fake)
    next.core.hydrate(snapshot)
    watch(next.core.view(keysView(1, 2)))
    const from = fake.requests.length
    next.core.endHydration()
    await settle()
    expect(fake.requests.slice(from)).toEqual([2])
    expect(fake.rightsReads).toEqual([])
    expect(next.core.rights()).toBeUndefined()
  })
})
