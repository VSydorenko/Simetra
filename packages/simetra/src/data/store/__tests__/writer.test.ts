import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ZERO_UUID, channelTopic, type CatalogEntry } from "simetra/model"
import {
  OBJECT_ID,
  SCOPE_KIND_ID,
  catalogEntry,
  catalogEntryAttribute,
} from "../../../model/runtime/__tests__/entries"
import { coreInternals, type CoreSession } from "../core"
import {
  DEFAULT_CORE_LIMITS,
  type ViewSpec,
  type ViewSnapshot,
  type Writer,
} from "../types"
import {
  OBJECTS,
  ORG,
  S,
  TASK,
  isCard,
  isKeys,
  isPage,
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

/*
 * API ядра для приймача сигналів (план П4-B3-2, задача 8; спека П4-B §6.2
 * правило 5, §6.5, §8.4): `commit` з `Writer`, `purge` як виняток безпеки,
 * позначки, `activeViews`, `setVisible` і двофазний `revalidate`.
 */

const RELEASE = DEFAULT_CORE_LIMITS.releaseDelayMs
const T = "00000000-0000-4000-8000-0000000000b2"

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
const lines = [{ ref: key(901), qty: 1, lineNumber: 1 }]

const write = (core: CoreSession, fn: (w: Writer) => void) =>
  core.commit(fn, core.token())

/** Піднімає епоху сесії без видимих наслідків: надгробок чужого ключа. */
const bump = (core: CoreSession) =>
  write(core, (w) => w.purge(ORG, { keys: [key(99_999)] }))

const channel = (scope: string) =>
  channelTopic({
    kind: "changes",
    scopeKindId: SCOPE_KIND_ID,
    scope,
    object: OBJECT_ID,
  })

const sectionsOf = (core: CoreSession, n: number) =>
  coreInternals(core).objects.get(TASK)!.sections.get(key(n), "lines")

const stateOf = (snapshot: ViewSnapshot, n: number) =>
  snapshot.rows.find((r) => r.key === key(n))?.state

const valueOf = (snapshot: ViewSnapshot, n: number, field: string) => {
  const row = snapshot.rows.find((r) => r.key === key(n))
  return row === undefined || row.state === "removed"
    ? undefined
    : row.values[field]
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("Writer", () => {
  it("patches only keys that have an owner", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 2)
    const view = core.view(keys(1))
    watch(view)
    await settle()
    fake.edit(TASK, key(1), { title: "patched" })
    const epoch = core.readEpoch()
    // Ключ без власника не пишеться взагалі, а не прибирається `sweep` після.
    const put = vi.spyOn(coreInternals(core).ops, "put")
    write(core, (w) =>
      w.patch(TASK, [fake.row(TASK, key(1))!, fake.row(TASK, key(2))!], epoch)
    )
    expect(valueOf(view.getSnapshot(), 1, "title")).toBe("patched")
    expect(put.mock.calls.map((call) => call[2].key)).toEqual([key(1)])
    expect(inspect.rowCount()).toBe(1)
    expect(inspect.owners(TASK, key(2))).toBe(0)
    expect(inspect.violations()).toEqual([])
  })

  it("remove leaves the section view of the owner without lines", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const header = core.view(keys(1))
    const lineView = core.view(section(1))
    watch(header)
    watch(lineView)
    await settle()
    expect(lineView.getSnapshot().section?.lines).toHaveLength(1)
    write(core, (w) => w.remove(TASK, [key(1)], core.readEpoch()))
    await settle()
    expect(header.getSnapshot().rows).toEqual([
      { key: key(1), state: "removed" },
    ])
    expect(lineView.getSnapshot().section?.lines ?? []).toEqual([])
    expect(sectionsOf(core, 1)).toBeUndefined()
  })

  it("remove clears the lines of an owner without a header in the store", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const lineView = core.view(section(1))
    watch(lineView)
    await settle()
    expect(sectionsOf(core, 1)?.lines).toHaveLength(1)
    write(core, (w) => w.remove(TASK, [key(1)], core.readEpoch()))
    expect(sectionsOf(core, 1)).toBeUndefined()
    expect(lineView.getSnapshot().section?.lines ?? []).toEqual([])
  })

  it("markViews with a spec marks only that view", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    const one = core.view(keys(1))
    const two = core.view(keys(2))
    watch(one)
    watch(two)
    await settle()
    write(core, (w) => w.markViews(TASK, { needsRefresh: true }, keys(1)))
    expect(one.getSnapshot().needsRefresh).toBe(true)
    expect(two.getSnapshot().needsRefresh).toBe(false)
    write(core, (w) => w.markViews(TASK, { hasNewRows: true }))
    expect(one.getSnapshot().hasNewRows).toBe(true)
    expect(two.getSnapshot().hasNewRows).toBe(true)
  })

  it("markStale with minVersion 7 stays on a re-read of version 6 and clears on 7", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 4)
    expect(fake.edit(TASK, key(1), { title: "v5" })).toBe(5)
    const view = core.view(keys(1))
    watch(view)
    await settle()
    write(core, (w) => w.markStale(TASK, [key(1)], 7))
    expect(stateOf(view.getSnapshot(), 1)).toBe("stale")
    expect(fake.edit(TASK, key(1), { title: "v6" })).toBe(6)
    await core.revalidate(TASK, { visibleOnly: false })
    expect(view.getSnapshot().rows[0]).toMatchObject({
      version: 6,
      state: "stale",
    })
    expect(fake.edit(TASK, key(1), { title: "v7" })).toBe(7)
    await core.revalidate(TASK, { visibleOnly: false })
    expect(view.getSnapshot().rows[0]).toMatchObject({
      version: 7,
      state: "synced",
    })
  })

  it("markDisconnected(A) and clearDisconnected(A) leave rows of channel B alone", async () => {
    const { core, fake } = setup()
    fake.insert(TASK, taskValues(1))
    fake.insert(TASK, taskValues(2, { org: T }))
    const view = core.view(keys(1, 2))
    watch(view)
    await settle()
    write(core, (w) => w.markDisconnected(channel(S)))
    expect(stateOf(view.getSnapshot(), 1)).toBe("stale")
    expect(stateOf(view.getSnapshot(), 2)).toBe("synced")
    write(core, (w) => w.markDisconnected(channel(T)))
    write(core, (w) => w.clearDisconnected(channel(S)))
    expect(stateOf(view.getSnapshot(), 1)).toBe("synced")
    expect(stateOf(view.getSnapshot(), 2)).toBe("stale")
  })

  it("keeps the mark of the old channel when a marked row moves and the new channel is marked and cleared", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    const view = core.view(keys(1))
    watch(view)
    await settle()
    write(core, (w) => w.markDisconnected())
    fake.edit(TASK, key(1), { org: T })
    await core.revalidate(TASK, { visibleOnly: false })
    write(core, (w) => w.markDisconnected(channel(T)))
    write(core, (w) => w.clearDisconnected(channel(T)))
    // Пропущене в каналі S ще не відновлено: позначка лишається.
    expect(stateOf(view.getSnapshot(), 1)).toBe("stale")
    write(core, (w) => w.clearDisconnected(channel(S)))
    expect(stateOf(view.getSnapshot(), 1)).toBe("synced")
  })

  it("marks an unscoped object on the channel with ZERO_UUID for kind and scope", async () => {
    const base = catalogEntry()
    delete base.scopeKindId
    delete base.scopeColumn
    const note: CatalogEntry = {
      ...base,
      id: "00000000-0000-4000-8000-000000000201",
      name: "Note",
      kindLabel: "note",
      table: { schema: "public", name: "note" },
      attributes: [catalogEntryAttribute({ name: "title", column: "title" })],
      tabularSections: [],
    }
    const { core, fake } = setup({ objects: [...OBJECTS, note] })
    fake.insert("Catalog.Note", { ref: key(1), title: "n" })
    const view = core.view({
      kind: "keys",
      object: "Catalog.Note",
      keys: [key(1)],
    })
    watch(view)
    await settle()
    const zero = channelTopic({
      kind: "changes",
      scopeKindId: ZERO_UUID,
      scope: ZERO_UUID,
      object: note.id,
    })
    write(core, (w) => w.markDisconnected(zero))
    expect(stateOf(view.getSnapshot(), 1)).toBe("stale")
    write(core, (w) => w.clearDisconnected(zero))
    expect(stateOf(view.getSnapshot(), 1)).toBe("synced")
  })

  it("refuses every writer method once its commit has ended", () => {
    const { core } = setup()
    let saved: Writer | undefined
    write(core, (w) => {
      saved = w
    })
    expect(() => saved!.patch(TASK, [], 0)).toThrow("write scope is closed")
    expect(() => saved!.markViews(TASK, { needsRefresh: true })).toThrow(
      "write scope is closed"
    )
    expect(() => saved!.markDisconnected()).toThrow("write scope is closed")
  })

  it("does not call fn for an invalid token", () => {
    const { core, log } = setup()
    const fn = vi.fn()
    expect(core.commit(fn, { valid: false })).toBe(false)
    expect(fn).not.toHaveBeenCalled()
    expect(log).toContainEqual({ kind: "late-response", what: "writer" })
  })

  it("passes a throw of fn on and leaves no row without an owner", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1)
    watch(core.view(keys(1)))
    await settle()
    const sweep = vi.spyOn(coreInternals(core).ops, "sweep")
    expect(() =>
      write(core, (w) => {
        w.patch(TASK, [fake.row(TASK, key(1))!], core.readEpoch())
        throw new Error("boom")
      })
    ).toThrow("boom")
    expect(sweep).toHaveBeenCalledOnce()
    expect(inspect.violations()).toEqual([])
  })
})

describe("purge", () => {
  it("gives the card of a purged key purged with access-changed", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1)
    const handle = core.view(card(1))
    const { seen } = watch(handle)
    await settle()
    seen.length = 0
    write(core, (w) => w.purge(TASK, { keys: [key(1)] }))
    expect(seen).toHaveLength(1)
    expect(handle.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "access-changed",
      rows: [],
    })
    // Прибрана картка не дочитує й лишається `purged`.
    handle.refresh()
    await settle()
    expect(handle.getSnapshot().status).toBe("purged")
    expect(inspect.rowCount()).toBe(0)
    expect(inspect.violations()).toEqual([])
  })

  it("purge({ scope }) drops the removed slot and the section lines of the owner", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 2)
    fake.setLines(TASK, key(1), "lines", lines)
    const header = core.view(keys(1, 2))
    watch(header)
    watch(core.view(section(1)))
    await settle()
    fake.remove(TASK, key(2))
    header.refresh()
    await settle()
    expect(stateOf(header.getSnapshot(), 2)).toBe("removed")
    write(core, (w) => w.purge(TASK, { scope: S }))
    expect(header.getSnapshot().rows).toEqual([])
    expect(sectionsOf(core, 1)).toBeUndefined()
    expect(inspect.rowCount()).toBe(0)
    expect(inspect.violations()).toEqual([])
  })

  it("purge({ scope }) clears the lines of a header that moved into the purged scope", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const header = core.view(keys(1))
    watch(header)
    await settle()
    watch(core.view(section(1)))
    await settle()
    // Рядки ТЧ записано зі скоупом S; шапка переїжджає в T, а
    // перечитування ТЧ лишається в польоті.
    fake.hold = (read) => isSection(read)
    fake.edit(TASK, key(1), { org: T })
    header.refresh()
    await settle()
    expect(sectionsOf(core, 1)?.scope).toBe(S)
    write(core, (w) => w.purge(TASK, { scope: T }))
    expect(sectionsOf(core, 1)).toBeUndefined()
    fake.deliverAll()
    await settle()
    expect(sectionsOf(core, 1)).toBeUndefined()
  })

  it("purge({ scope }) drops a scope-kind root and the include refs to it", async () => {
    const { core, fake, inspect } = setup()
    fake.insert(ORG, { ref: S })
    seed(fake, 1, 1)
    const root = core.view({ kind: "keys", object: ORG, keys: [S] })
    const full = core.view({ kind: "full", object: TASK, include: ["org"] })
    watch(root)
    watch(full)
    await settle()
    expect(full.getSnapshot().rows[0]).toMatchObject({
      refs: { org: { key: S } },
    })
    write(core, (w) => w.purge(ORG, { scope: S }))
    expect(root.getSnapshot().rows).toEqual([])
    expect(full.getSnapshot().rows[0]).toMatchObject({ refs: { org: null } })
    expect(inspect.owners(ORG, S)).toBe(0)
    expect(inspect.rowCount()).toBe(1)
    expect(inspect.violations()).toEqual([])
  })

  it("does not write a row of the purged scope from a full load in flight and re-reads the view", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 2)
    fake.hold = (read) => isPage(read)
    const handle = core.view({ kind: "full", object: TASK })
    watch(handle)
    const page = fake.take()
    const visible = fake.clock
    fake.setVisibleScopes([])
    write(core, (w) => w.purge(TASK, { scope: S }))
    page.answer(visible)
    await settle()
    expect(inspect.rowCount()).toBe(0)
    expect(fake.pending).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(inspect.rowCount()).toBe(0)
    expect(readsOf(fake, TASK).filter(isPage)).toHaveLength(2)
    expect(handle.getSnapshot()).toMatchObject({ status: "ready", rows: [] })
  })

  it("keeps owner counts exact after a purge and a re-read", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 2)
    const list = core.view(keys(1, 2))
    const full = core.view({ kind: "full", object: TASK })
    watch(list)
    watch(full)
    await settle()
    expect(inspect.owners(TASK, key(1))).toBe(2)
    write(core, (w) => w.purge(TASK, { keys: [key(1)] }))
    expect(keysIn(list.getSnapshot())).toEqual([key(2)])
    expect(keysIn(full.getSnapshot())).toEqual([key(2)])
    expect(core.activeViews(TASK).map((v) => v.keys)).toEqual([
      [key(2)],
      [key(2)],
    ])
    expect(inspect.violations()).toEqual([])
    list.refresh()
    full.refresh()
    await settle()
    expect(inspect.owners(TASK, key(1))).toBe(2)
    expect(inspect.owners(TASK, key(2))).toBe(2)
    expect(inspect.violations()).toEqual([])
  })

  it("writes nothing from section and card loads in flight for an owner outside the store", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    fake.hold = (read) => isCard(read) || isSection(read)
    const cardView = core.view(card(1))
    const lineView = core.view(section(1))
    watch(cardView)
    watch(lineView)
    const held = [fake.take(), fake.take()]
    const visible = fake.clock
    fake.setVisibleScopes([])
    write(core, (w) => w.purge(TASK, { scope: S }))
    for (const read of held) read.answer(visible)
    await settle()
    expect(inspect.rowCount()).toBe(0)
    expect(sectionsOf(core, 1)).toBeUndefined()
    // Хвостові перечитування після purge бачать стан сервера.
    fake.deliverAll()
    await settle()
    expect(inspect.rowCount()).toBe(0)
    expect(sectionsOf(core, 1)).toBeUndefined()
    expect(cardView.getSnapshot().rows).toEqual([])
    expect(inspect.violations()).toEqual([])
  })

  it("does not return a purged key as a removed slot from a revalidate in flight; the card stays purged", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 2)
    const cardView = core.view(card(1))
    const list = core.view(keys(1, 2))
    watch(cardView)
    watch(list)
    await settle()
    fake.hold = (read) => isKeys(read)
    const done = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(fake.pending.length).toBeGreaterThan(0)
    fake.remove(TASK, key(1))
    write(core, (w) => w.purge(TASK, { keys: [key(1)] }))
    fake.deliverAll()
    await settle()
    // Відкинутий прохід повторюється: доставляємо й його читання.
    fake.deliverAll()
    await done
    await settle()
    expect(list.getSnapshot().rows).toMatchObject([
      { key: key(2), state: "synced" },
    ])
    expect(cardView.getSnapshot().status).toBe("purged")
    expect(list.getSnapshot().hasNewRows).toBe(false)
    expect(inspect.rowCount()).toBe(1)
    expect(inspect.violations()).toEqual([])
  })

  it("drops a revalidate in flight when the object is purged and re-reads the views: no lines of the purged scope are written", async () => {
    const { core, fake, log } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const header = core.view(keys(1))
    watch(header)
    await settle()
    watch(core.view(section(1)))
    await settle()
    expect(sectionsOf(core, 1)?.scope).toBe(S)
    // На сервері шапка переїжджає в T з новими рядками ТЧ.
    fake.edit(TASK, key(1), { org: T })
    fake.setLines(TASK, key(1), "lines", [
      { ref: key(902), qty: 9, lineNumber: 1 },
    ])
    fake.hold = (read) => isKeys(read) || isSection(read)
    const done = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const held = [...fake.pending].map(() => fake.take())
    expect(held).toHaveLength(2)
    const moment = fake.clock
    fake.setVisibleScopes([S])
    // У сховищі шапка ще в S: purge(T) нічого не прибирає.
    write(core, (w) => w.purge(TASK, { scope: T }))
    for (const read of held) read.answer(moment)
    await settle()
    expect(sectionsOf(core, 1)?.lines.map((l) => l.key)).toEqual([key(901)])
    expect(valueOf(header.getSnapshot(), 1, "org")).toBe(S)
    expect(log.some((e) => e.kind === "late-response")).toBe(false)
    // Повторний прохід revalidate після purge.
    expect(fake.pending).toHaveLength(2)
    fake.deliverAll()
    await done
    await settle()
    expect(stateOf(header.getSnapshot(), 1)).toBe("removed")
    expect(sectionsOf(core, 1)).toBeUndefined()
  })

  it("re-runs a revalidate dropped by a purge without changing the remaining composition or order", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const full = core.view({
      kind: "full",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "asc" }],
    })
    watch(full)
    await settle()
    fake.hold = (read) => isPage(read)
    const done = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const page = fake.take()
    // Сервер міняє порядок і додає рядок: завантаження переставило б склад.
    fake.edit(TASK, key(1), { title: "z" })
    fake.insert(TASK, taskValues(4, { title: "a" }))
    write(core, (w) => w.purge(TASK, { keys: [key(2)] }))
    fake.hold = undefined
    page.answer()
    await done
    await settle()
    const snapshot = full.getSnapshot()
    expect(keysIn(snapshot)).toEqual([key(1), key(3)])
    expect(valueOf(snapshot, 1, "title")).toBe("z")
    expect(snapshot.hasNewRows).toBe(true)
    expect(snapshot.needsRefresh).toBe(true)
    expect(coreInternals(core).objects.get(TASK)!.rows.get(key(4))).toBe(
      undefined
    )
    expect(readsOf(fake, TASK).filter(isPage)).toHaveLength(3)
  })

  it("hides a stored row that an older read returns in a purged scope and re-reads it to removed", async () => {
    const { core, fake, log } = setup()
    seed(fake, 1, 1)
    const view = core.view(keys(1))
    watch(view)
    await settle()
    const early = core.readEpoch()
    fake.edit(TASK, key(1), { org: T, title: "moved" })
    fake.setVisibleScopes([S])
    write(core, (w) => w.purge(TASK, { scope: T }))
    fake.hold = (read) => isKeys(read)
    write(core, (w) => w.patch(TASK, [fake.row(TASK, key(1))!], early))
    expect(view.getSnapshot().rows[0]).toMatchObject({
      state: "stale",
      values: {},
    })
    expect(log).toContainEqual({
      kind: "horizon-hidden",
      object: TASK,
      count: 1,
    })
    expect(fake.pending).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(stateOf(view.getSnapshot(), 1)).toBe("removed")
  })

  it("does not purge the card or section of an accessible owner whose unknown-scope lines a purge of another scope wipes; the section re-reads", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const lineView = core.view(section(1))
    watch(lineView)
    await settle()
    expect(sectionsOf(core, 1)?.scope).toBe("unknown")
    const cardView = core.view(card(1))
    watch(cardView)
    await settle()
    expect(cardView.getSnapshot().status).toBe("ready")
    const sectionReads = fake.log.filter(isSection).length
    write(core, (w) => w.purge(TASK, { scope: T }))
    await settle()
    expect(cardView.getSnapshot()).toMatchObject({
      status: "ready",
      rows: [{ key: key(1) }],
    })
    expect(lineView.getSnapshot().status).not.toBe("purged")
    expect(fake.log.filter(isSection).length).toBe(sectionReads + 1)
    expect(lineView.getSnapshot().section).toMatchObject({
      lines: [{ key: key(901) }],
    })
  })

  it("marks the section view of an owner without a header purged when its unknown-scope lines are wiped", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const lineView = core.view(section(1))
    watch(lineView)
    await settle()
    expect(sectionsOf(core, 1)?.scope).toBe("unknown")
    write(core, (w) => w.purge(TASK, { scope: T }))
    expect(sectionsOf(core, 1)).toBeUndefined()
    expect(lineView.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "access-changed",
    })
  })

  it("releases include targets that only the purged rows referred to", async () => {
    const { core, fake, inspect } = setup()
    const orgKey = (n: number) => key(10_000 + n)
    for (const n of [1, 2]) {
      fake.insert(ORG, { ref: orgKey(n) })
      fake.insert(TASK, taskValues(n, { org: orgKey(n) }))
    }
    watch(core.view({ kind: "full", object: TASK, include: ["org"] }))
    await settle()
    expect(inspect.owners(ORG, orgKey(1))).toBe(1)
    write(core, (w) => w.purge(TASK, { scope: orgKey(1) }))
    expect(inspect.owners(ORG, orgKey(1))).toBe(0)
    expect(inspect.owners(ORG, orgKey(2))).toBe(1)
    expect(inspect.violations()).toEqual([])
  })

  it("does not write an include target from a read in flight during purge of its scope", async () => {
    const { core, fake, inspect } = setup()
    fake.insert(ORG, { ref: S })
    seed(fake, 1, 1)
    fake.hold = (read) => read.object === ORG
    const full = core.view({ kind: "full", object: TASK, include: ["org"] })
    watch(full)
    await settle()
    const include = fake.take()
    write(core, (w) => w.purge(ORG, { scope: S }))
    include.answer()
    await settle()
    expect(inspect.owners(ORG, S)).toBe(0)
    expect(coreInternals(core).objects.get(ORG)!.rows.get(S)).toBeUndefined()
    expect(inspect.violations()).toEqual([])
  })

  it("re-queues a tail re-read in flight during purge", async () => {
    const { core, fake } = setup({
      limits: { seenMax: 1, tombstonesMax: 1, horizonBuckets: 1 },
    })
    seed(fake, 1, 3)
    let holding = true
    fake.hold = (read) => holding && keysOf(read.query).includes(key(1))
    const handle = core.view(keys(1))
    watch(handle)
    const first = fake.take()
    watch(core.view(keys(2, 3))).unsubscribe()
    await settle()
    vi.advanceTimersByTime(RELEASE)
    first.answer()
    await settle()
    expect(handle.getSnapshot().rows[0]).toMatchObject({ state: "stale" })
    const tail = fake.take()
    write(core, (w) => w.purge(TASK, { keys: [key(77)] }))
    holding = false
    tail.answer()
    await settle()
    expect(handle.getSnapshot().rows[0]).toMatchObject({
      state: "synced",
      values: { title: "t1" },
    })
  })
})

describe("revalidate", () => {
  it("applies three views in one commit with one notification each", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const a = core.view(keys(1))
    const b = core.view(keys(2))
    const c = core.view({ kind: "full", object: TASK })
    const seenB: ViewSnapshot[] = []
    const seenC: ViewSnapshot[] = []
    let atA: (string | undefined)[] = []
    let countA = 0
    a.subscribe(() => {
      countA++
      atA = [
        valueOf(b.getSnapshot(), 2, "title") as string | undefined,
        valueOf(c.getSnapshot(), 3, "title") as string | undefined,
      ]
    })
    b.subscribe(() => seenB.push(b.getSnapshot()))
    c.subscribe(() => seenC.push(c.getSnapshot()))
    await settle()
    countA = 0
    seenB.length = 0
    seenC.length = 0
    for (const n of [1, 2, 3]) fake.edit(TASK, key(n), { title: `new${n}` })
    await core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(countA).toBe(1)
    expect(seenB).toHaveLength(1)
    expect(seenC).toHaveLength(1)
    // На мить сповіщення першого вигляду інші вже мають нові значення.
    expect(atA).toEqual(["new2", "new3"])
  })

  it("leaves two of three views updated and one in error when its read fails", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const a = core.view(keys(1))
    const b = core.view(keys(2))
    const c = core.view(keys(3))
    for (const h of [a, b, c]) watch(h)
    await settle()
    const before = b.getSnapshot().rows
    for (const n of [1, 2, 3]) fake.edit(TASK, key(n), { title: `new${n}` })
    fake.hold = (read) => keysOf(read.query).includes(key(2))
    const done = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    fake.take().fail("command.unavailable")
    await done
    expect(valueOf(a.getSnapshot(), 1, "title")).toBe("new1")
    expect(valueOf(c.getSnapshot(), 3, "title")).toBe("new3")
    expect(b.getSnapshot()).toMatchObject({
      status: "error",
      error: { code: "command.unavailable" },
    })
    expect(b.getSnapshot().rows).toBe(before)
  })

  it("shows a vanished key of keys as removed in place, composition unchanged", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const list = core.view(keys(1, 2, 3))
    watch(list)
    await settle()
    fake.remove(TASK, key(2))
    await core.revalidate(TASK, { visibleOnly: false })
    expect(keysIn(list.getSnapshot())).toEqual([key(1), key(2), key(3)])
    expect(stateOf(list.getSnapshot(), 2)).toBe("removed")
  })

  it("shows a vanished key of full as removed in place, order unchanged", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const full = core.view({
      kind: "full",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "desc" }],
    })
    watch(full)
    await settle()
    expect(keysIn(full.getSnapshot())).toEqual([key(3), key(2), key(1)])
    fake.remove(TASK, key(2))
    await core.revalidate(TASK, { visibleOnly: false })
    expect(keysIn(full.getSnapshot())).toEqual([key(3), key(2), key(1)])
    expect(stateOf(full.getSnapshot(), 2)).toBe("removed")
    expect(full.getSnapshot().needsRefresh).toBe(false)
  })

  it("hides a row on an empty answer of a read started before its write, and the tail restores it when visible with removed-restored", async () => {
    const { core, fake, log } = setup()
    seed(fake, 1, 1)
    const view = core.view(keys(1))
    watch(view)
    await settle()
    const hidden = fake.setVisibleScopes([])
    fake.setVisibleScopes(undefined)
    fake.hold = (read) => isKeys(read)
    const done = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const early = fake.take()
    // Пізніше розпочате читання встигає записати рядок.
    bump(core)
    fake.hold = undefined
    view.refresh()
    await settle()
    fake.hold = (read) => isKeys(read)
    early.answer(hidden)
    await done
    await settle()
    expect(stateOf(view.getSnapshot(), 1)).toBe("removed")
    expect(fake.pending).toHaveLength(1)
    fake.take().answer()
    await settle()
    expect(view.getSnapshot().rows[0]).toMatchObject({
      state: "synced",
      values: { title: "t1" },
    })
    const restored = log.filter((e) => e.kind === "removed-restored")
    expect(restored).toEqual([
      { kind: "removed-restored", object: TASK, count: 1 },
    ])
  })

  it("re-reads a mounted section once the tail restores a divergent removed header", async () => {
    const { core, fake, log } = setup()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", [
      { ref: key(901), qty: 1, lineNumber: 1 },
    ])
    const view = core.view(keys(1))
    watch(view)
    const sectionView = core.view(section(1))
    watch(sectionView)
    await settle()
    expect(sectionView.getSnapshot().section?.lines).toHaveLength(1)
    const hidden = fake.setVisibleScopes([])
    fake.setVisibleScopes(undefined)
    fake.hold = (read) => isKeys(read)
    const done = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const early = fake.take()
    bump(core)
    fake.hold = undefined
    view.refresh()
    await settle()
    fake.hold = (read) => isKeys(read)
    early.answer(hidden)
    await done
    await settle()
    expect(stateOf(view.getSnapshot(), 1)).toBe("removed")
    expect(sectionView.getSnapshot().section).toMatchObject({
      ownerState: "removed",
      lines: [],
    })
    fake.take().answer()
    await settle()
    expect(log.filter((e) => e.kind === "removed-restored")).toHaveLength(1)
    expect(stateOf(view.getSnapshot(), 1)).toBe("synced")
    expect(sectionView.getSnapshot().section).toMatchObject({
      ownerState: "synced",
      complete: true,
      lines: [{ key: key(901) }],
    })
  })

  it("keeps a divergent removed row hidden when the tail finds it invisible", async () => {
    const { core, fake, log } = setup()
    seed(fake, 1, 1)
    const view = core.view(keys(1))
    watch(view)
    await settle()
    fake.hold = (read) => isKeys(read)
    const done = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const early = fake.take()
    bump(core)
    fake.hold = undefined
    view.refresh()
    await settle()
    fake.setVisibleScopes([])
    early.answer()
    await done
    await settle()
    expect(stateOf(view.getSnapshot(), 1)).toBe("removed")
    expect(readsOf(fake, TASK).filter(isKeys).length).toBe(4)
    expect(log.some((e) => e.kind === "removed-restored")).toBe(false)
  })

  it("logs nothing for an ordinary re-read after removed", async () => {
    const { core, fake, log } = setup()
    seed(fake, 1, 1)
    const view = core.view(keys(1))
    watch(view)
    await settle()
    fake.setVisibleScopes([])
    await core.revalidate(TASK, { visibleOnly: false })
    expect(stateOf(view.getSnapshot(), 1)).toBe("removed")
    fake.setVisibleScopes(undefined)
    await core.revalidate(TASK, { visibleOnly: false })
    expect(stateOf(view.getSnapshot(), 1)).toBe("synced")
    expect(log.some((e) => e.kind === "removed-restored")).toBe(false)
  })

  it("keeps a row with a changed sort field in place with new values and needsRefresh", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    const full = core.view({
      kind: "full",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "asc" }],
    })
    watch(full)
    await settle()
    fake.edit(TASK, key(1), { title: "z" })
    await core.revalidate(TASK, { visibleOnly: false })
    const snapshot = full.getSnapshot()
    expect(keysIn(snapshot)).toEqual([key(1), key(2), key(3)])
    expect(valueOf(snapshot, 1, "title")).toBe("z")
    expect(snapshot.needsRefresh).toBe(true)
  })

  it("keeps a row that left the filter in place with needsRefresh", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    const full = core.view({
      kind: "full",
      object: TASK,
      where: { attribute: "title", op: "ne", value: "gone" },
    })
    watch(full)
    await settle()
    fake.edit(TASK, key(1), { title: "gone" })
    await core.revalidate(TASK, { visibleOnly: false })
    const snapshot = full.getSnapshot()
    expect(keysIn(snapshot)).toEqual([key(1), key(2)])
    expect(valueOf(snapshot, 1, "title")).toBe("gone")
    expect(snapshot.needsRefresh).toBe(true)
  })

  it("marks full hasNewRows for a new key on the server without storing it", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 2)
    const full = core.view({ kind: "full", object: TASK })
    watch(full)
    await settle()
    fake.insert(TASK, taskValues(3))
    const put = vi.spyOn(coreInternals(core).ops, "put")
    await core.revalidate(TASK, { visibleOnly: false })
    expect(put.mock.calls.map((call) => call[2].key)).toEqual([key(1), key(2)])
    const snapshot = full.getSnapshot()
    expect(snapshot.hasNewRows).toBe(true)
    expect(snapshot.needsRefresh).toBe(false)
    expect(keysIn(snapshot)).toEqual([key(1), key(2)])
    expect(coreInternals(core).objects.get(TASK)!.rows.get(key(3))).toBe(
      undefined
    )
    expect(inspect.violations()).toEqual([])
  })

  it("marks keys hasNewRows for a key that appeared on the server without storing it", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1)
    const list = core.view(keys(1, 2))
    watch(list)
    await settle()
    fake.insert(TASK, taskValues(2))
    const put = vi.spyOn(coreInternals(core).ops, "put")
    await core.revalidate(TASK, { visibleOnly: false })
    expect(put.mock.calls.map((call) => call[2].key)).toEqual([key(1)])
    expect(list.getSnapshot().hasNewRows).toBe(true)
    expect(keysIn(list.getSnapshot())).toEqual([key(1)])
    expect(coreInternals(core).objects.get(TASK)!.rows.get(key(2))).toBe(
      undefined
    )
    expect(inspect.violations()).toEqual([])
  })

  it("does not mark a card hasNewRows when its key appears on the server", async () => {
    const { core, fake } = setup()
    const handle = core.view(card(1))
    watch(handle)
    await settle()
    fake.insert(TASK, taskValues(1))
    await core.revalidate(TASK, { visibleOnly: false })
    expect(handle.getSnapshot().hasNewRows).toBe(false)
  })

  it("does not mark a truncated full hasNewRows for rows past its window, only for one before its last row", async () => {
    const { core, fake } = setup({
      limits: { fullLimit: 120, fullPageSize: 50 },
    })
    for (let n = 1; n <= 150; n++) fake.insert(TASK, taskValues(n + 10))
    const full = core.view({ kind: "full", object: TASK })
    watch(full)
    await settle()
    expect(full.getSnapshot()).toMatchObject({
      truncated: true,
      strategy: "window",
    })
    expect(full.getSnapshot().rows).toHaveLength(100)
    await core.revalidate(TASK, { visibleOnly: false })
    expect(full.getSnapshot().hasNewRows).toBe(false)
    // Ключ, що в серверному порядку стає перед останнім рядком вікна, — новий.
    fake.insert(TASK, taskValues(1))
    await core.revalidate(TASK, { visibleOnly: false })
    expect(full.getSnapshot().hasNewRows).toBe(true)
  })

  it("confirms by key a row that moved between pages of the full re-read: values on place and needsRefresh, not removed", async () => {
    const { core, fake } = setup({ limits: { fullPageSize: 2 } })
    seed(fake, 1, 5)
    const full = core.view({
      kind: "full",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "asc" }],
    })
    watch(full)
    await settle()
    expect(keysIn(full.getSnapshot())).toEqual([1, 2, 3, 4, 5].map(key))
    fake.mode = "manual"
    const done = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    fake.take().answer()
    await settle()
    // Між сторінками рядок 3 переїжджає на початок порядку й проскакує keyset.
    fake.edit(TASK, key(3), { title: "a" })
    for (;;) {
      await settle()
      if (fake.pending.length === 0) break
      fake.deliverAll()
    }
    await done
    const snapshot = full.getSnapshot()
    expect(keysIn(snapshot)).toEqual([1, 2, 3, 4, 5].map(key))
    expect(snapshot.rows[2]).toMatchObject({
      state: "synced",
      values: { title: "a" },
    })
    expect(snapshot.needsRefresh).toBe(true)
  })

  it("reads nine views at most four at a time", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 9)
    for (let n = 1; n <= 9; n++) watch(core.view(keys(n)))
    await settle()
    fake.mode = "manual"
    fake.resetCounters()
    const done = core.revalidate(TASK, { visibleOnly: false })
    let reads = 0
    for (;;) {
      await settle()
      if (fake.pending.length === 0) break
      expect(fake.pending.length).toBeLessThanOrEqual(4)
      reads += fake.pending.length
      fake.deliverAll()
    }
    await done
    expect(reads).toBe(9)
    expect(fake.maxInFlight).toBe(4)
  })

  it("re-reads only visible views with visibleOnly and keeps disconnect marks", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    const shown = core.view(keys(1))
    const hidden = core.view(keys(2))
    watch(shown)
    watch(hidden)
    await settle()
    core.setVisible(keys(2), false)
    write(core, (w) => w.markDisconnected())
    fake.edit(TASK, key(1), { title: "new1" })
    fake.edit(TASK, key(2), { title: "new2" })
    const reads = fake.log.length
    await core.revalidate(TASK, { visibleOnly: true })
    expect(fake.log.slice(reads).flatMap((r) => keysOf(r.query))).toEqual([
      key(1),
    ])
    expect(shown.getSnapshot().rows[0]).toMatchObject({
      state: "stale",
      values: { title: "new1" },
    })
    expect(valueOf(hidden.getSnapshot(), 2, "title")).toBe("t2")
  })

  it("writes nothing from a revalidate in flight after close and sends no request after it", async () => {
    const { core, fake, inspect, log } = setup()
    seed(fake, 1, 2)
    watch(core.view(keys(1)))
    watch(core.view(keys(2)))
    await settle()
    fake.mode = "manual"
    const done = core.revalidate(TASK, { visibleOnly: false })
    await settle()
    fake.edit(TASK, key(1), { title: "late" })
    core.close("signed-out")
    fake.deliverAll()
    await done
    await settle()
    expect(inspect.rowCount()).toBe(0)
    expect(log).toContainEqual({
      kind: "late-response",
      what: `revalidate ${TASK}`,
    })
    const reads = fake.log.length
    await core.revalidate(TASK, { visibleOnly: false })
    expect(fake.log).toHaveLength(reads)
    expect(core.activeViews(TASK)).toEqual([])
    expect(core.commit(() => {}, core.token())).toBe(false)
  })

  it("lists active views with the visible ones first", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 3)
    watch(core.view(keys(1)))
    watch(core.view(keys(2)))
    watch(core.view(card(3)))
    await core.preload(keys(3))
    await settle()
    core.setVisible(keys(1), false)
    const views = core.activeViews(TASK)
    expect(views.map((v) => [v.spec, v.keys, v.visible])).toEqual([
      [keys(2), [key(2)], true],
      [card(3), [key(3)], true],
      [keys(1), [key(1)], false],
      [keys(3), [key(3)], false],
    ])
    expect(core.activeViews(ORG)).toEqual([])
  })
})
