import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CatalogEntry, RightsRow, RightsSnapshot } from "simetra/model"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import { coreInternals, type CoreSession } from "../core"
import type { FakeSource } from "../testing/fake-source"
import type { ViewSpec } from "../types"
import {
  ORG,
  S,
  TASK,
  isSection,
  key,
  keysOf,
  org,
  readsOf,
  seed,
  settle,
  setup,
  task,
  taskValues,
  watch,
} from "./core-support"

/*
 * Правило втрати доступу й звуження на заміні знімка прав (спека П4-B §6.2
 * правило 4, §14.1; план B5b-2 Р4–Р7, Р10): прохід пар сховища, бар'єр
 * знімка як віртуальний надгробок пари в `Epochs`, звуження до B6, перший
 * знімок (Р5а) і зміна користувача.
 */

const USER = "00000000-0000-4000-8000-0000000000a1"
const OTHER_USER = "00000000-0000-4000-8000-0000000000a2"
const T = "00000000-0000-4000-8000-0000000000b2"
const CONTAINER = "00000000-0000-4000-8000-0000000000c1"

const taskR: CatalogEntry = { ...task, rightsContract: true }
const orgR: CatalogEntry = { ...org, rightsContract: true }

const readRow = (scope: string, over: Partial<RightsRow> = {}): RightsRow => ({
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

const snapshotOf = (
  rights: RightsRow[],
  scopes: string[] = [S, T],
  userId: string | null = USER
): RightsSnapshot => ({
  userId,
  scopeSets: scopes.map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
  rights,
})

let versions = 0
/** The fake answers this snapshot from now on, with a new `rightsVersion`. */
function grant(fake: FakeSource, snapshot: RightsSnapshot) {
  fake.rightsSnapshot = snapshot
  fake.rightsVersion = (++versions).toString(16).padStart(64, "0")
}

const BOTH = () => snapshotOf([readRow(S), readRow(T)])
const ONLY_T = () => snapshotOf([readRow(T)])

function harness(options: Parameters<typeof setup>[0] = {}) {
  const h = setup({ rightsSnapshot: true, objects: [taskR, org], ...options })
  grant(h.fake, BOTH())
  return h
}

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
const keys = (...ns: number[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys: ns.map(key),
})
const lines = [{ ref: key(901), qty: 1, lineNumber: 1 }]

const rowsOf = (core: CoreSession) =>
  coreInternals(core).objects.get(TASK)!.rows
const linesOf = (core: CoreSession, n: number) =>
  coreInternals(core).objects.get(TASK)!.sections.get(key(n), "lines")

/** Reads of the fake that asked for the key (by keys, card or section owner). */
const readsOfKey = (fake: FakeSource, n: number) =>
  readsOf(fake, TASK).filter(
    (r) =>
      keysOf(r.query).includes(key(n)) ||
      (r.query !== undefined && "id" in r.query && r.query.id === key(n)) ||
      (r.query !== undefined && "owner" in r.query && r.query.owner === key(n))
  )

/** Applies the first snapshot (a packet of its own) and lets it settle. */
async function firstSnapshot(core: CoreSession) {
  core.requestRights()
  await settle()
  expect(core.rights()).toBeDefined()
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("the pass on a snapshot replacement", () => {
  it("purges a pair of the first snapshot that the store held before it", async () => {
    const { core, fake } = harness()
    // Перший пакет без знімка: рядки пари вже в сховищі, коли знімок прийде.
    fake.rightsError = { code: "command.unavailable" }
    seed(fake, 1, 1)
    const handle = core.view(card(1))
    watch(handle)
    await settle()
    expect(handle.getSnapshot().rows).toHaveLength(1)
    expect(core.rights()).toBeUndefined()
    fake.rightsError = undefined
    grant(fake, ONLY_T())
    fake.setVisibleScopes([T])
    core.requestRights()
    await settle()
    expect(rowsOf(core).get(key(1))).toBeUndefined()
    expect(handle.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "access-changed",
      rows: [],
    })
  })

  it("purges a pair granted, read and then revoked between two snapshots", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    fake.insert(TASK, taskValues(2, { org: T }))
    const one = core.view(card(1))
    const two = core.view(card(2))
    watch(one)
    watch(two)
    await settle()
    expect(rowsOf(core).get(key(1))).toBeDefined()
    grant(fake, ONLY_T())
    fake.setVisibleScopes([T])
    core.requestRights()
    await settle()
    expect(one.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "access-changed",
    })
    // Пара, що лишилась дозволеною, не страждає.
    expect(two.getSnapshot()).toMatchObject({
      status: "ready",
      rows: [{ key: key(2) }],
    })
  })

  it("reaches every holder of the pair: a window page, an include target, a card and its pending mutation", async () => {
    const { core, fake, inspect } = harness({
      objects: [task, orgR],
      // Запис висить: мутація картки лишається `pending`, поки її не стерто.
      server: (fake) => ({ ...fake.server, run: () => new Promise(() => {}) }),
    })
    grant(
      fake,
      snapshotOf([
        readRow(S, { object: "organization" }),
        readRow(T, { object: "organization" }),
      ])
    )
    fake.insert(ORG, { ref: S })
    fake.insert(ORG, { ref: T })
    seed(fake, 1, 1)
    fake.insert(TASK, taskValues(2, { org: T }))
    const window = core.view({ kind: "window", object: ORG })
    const list = core.view({ kind: "full", object: TASK, include: ["org"] })
    const owner = core.view({ kind: "card", object: ORG, key: S })
    watch(window)
    watch(list)
    watch(owner)
    await settle()
    const row = owner.getSnapshot().rows[0]!
    core.update(
      ORG,
      S,
      {},
      { expectedVersion: row.state === "removed" ? 0 : row.version }
    )
    expect(inspect.mutations()).toMatchObject([{ key: S, erased: false }])
    expect(list.getSnapshot().rows[0]).toMatchObject({
      refs: { org: { key: S } },
    })
    const listReads = readsOf(fake, TASK).length
    grant(fake, snapshotOf([readRow(T, { object: "organization" })]))
    fake.setVisibleScopes([T])
    core.requestRights()
    await settle()
    expect(coreInternals(core).objects.get(ORG)!.rows.get(S)).toBeUndefined()
    expect(window.getSnapshot().rows.map((r) => r.key)).toEqual([T])
    // Слот цілі показує причину без значень; батька не перечитано (Р6).
    expect(list.getSnapshot().rows[0]).toMatchObject({ refs: { org: null } })
    expect(list.getSnapshot().rows[1]).toMatchObject({
      refs: { org: { key: T } },
    })
    expect(readsOf(fake, TASK)).toHaveLength(listReads)
    expect(owner.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "access-changed",
    })
    expect(inspect.mutations()).toMatchObject([{ key: S, erased: true }])
  })

  it("purges a row held only as an include target of another object's view (Р6)", async () => {
    const { core, fake, inspect } = harness({ objects: [task, orgR] })
    grant(
      fake,
      snapshotOf([
        readRow(S, { object: "organization" }),
        readRow(T, { object: "organization" }),
      ])
    )
    fake.insert(ORG, { ref: S })
    seed(fake, 1, 1)
    const list = core.view({ kind: "full", object: TASK, include: ["org"] })
    watch(list)
    await settle()
    // Рядок організації тримає лише ціль `include` чужого вигляду.
    expect(inspect.owners(ORG, S)).toBe(1)
    const listReads = readsOf(fake, TASK).length
    grant(fake, snapshotOf([readRow(T, { object: "organization" })]))
    fake.setVisibleScopes([T])
    core.requestRights()
    await settle()
    expect(coreInternals(core).objects.get(ORG)!.rows.get(S)).toBeUndefined()
    expect(list.getSnapshot().rows[0]).toMatchObject({ refs: { org: null } })
    expect(readsOf(fake, TASK)).toHaveLength(listReads)
  })

  it("drops lines of an owner without a header when the object lost a read tuple", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    watch(core.view(section(1)))
    await settle()
    expect(linesOf(core, 1)?.scope).toBe("unknown")
    // Пари власника в сховищі немає: судити нема за чим, тож рядки прибрано.
    grant(fake, ONLY_T())
    fake.setVisibleScopes([T])
    core.requestRights()
    await settle()
    expect(linesOf(core, 1)).toBeUndefined()
  })

  it("keeps lines of an owner without a header when the object lost nothing", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    watch(core.view(section(1)))
    await settle()
    const reads = fake.log.filter(isSection).length
    grant(fake, snapshotOf([readRow(S), readRow(T)], [S, T, CONTAINER]))
    core.requestRights()
    await settle()
    expect(linesOf(core, 1)?.lines).toHaveLength(1)
    expect(fake.log.filter(isSection)).toHaveLength(reads)
  })

  it("drops the tabular section lines of a purged owner (§14.1)", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    const header = core.view(card(1))
    const owned = core.view(section(1))
    watch(header)
    watch(owned)
    await settle()
    expect(linesOf(core, 1)?.lines).toHaveLength(1)
    grant(fake, ONLY_T())
    fake.setVisibleScopes([T])
    core.requestRights()
    await settle()
    expect(linesOf(core, 1)).toBeUndefined()
    expect(owned.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "access-changed",
    })
  })

  it("keeps a pair held by a container right only, and purges it when that goes too", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    const handle = core.view(card(1))
    watch(handle)
    await settle()
    grant(
      fake,
      snapshotOf([
        readRow(S, { level: "container", container: CONTAINER }),
        readRow(T),
      ])
    )
    core.requestRights()
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ status: "ready" })
    expect(rowsOf(core).get(key(1))).toBeDefined()
    grant(fake, ONLY_T())
    fake.setVisibleScopes([T])
    core.requestRights()
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ status: "purged" })
  })

  it("does not judge an object without a rights contract", async () => {
    const { core, fake } = harness({ objects: [task, org] })
    seed(fake, 1, 1)
    const handle = core.view(card(1))
    watch(handle)
    await settle()
    grant(fake, snapshotOf([]))
    core.requestRights()
    await settle()
    expect(handle.getSnapshot()).toMatchObject({
      status: "ready",
      rows: [{ key: key(1) }],
    })
  })

  it("makes no request and no write for a replacement without changes", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    const handle = core.view(keys(1))
    const { seen } = watch(handle)
    await settle()
    const requests = fake.requests.length
    const commit = vi.spyOn(coreInternals(core).ops, "sweep")
    seen.length = 0
    // Той самий вміст, інша версія: знімок замінено, а правила нічого не дають.
    grant(fake, BOTH())
    core.requestRights()
    await settle()
    expect(core.rights()?.rightsVersion).toBe(fake.rightsVersion)
    expect(fake.requests.length).toBe(requests + 1)
    expect(commit).not.toHaveBeenCalled()
    expect(seen).toHaveLength(0)
  })

  it("purges every denied pair of one replacement in one commit and one notification", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    fake.insert(TASK, taskValues(2, { org: T }))
    const handle = core.view(keys(1, 2))
    const { seen } = watch(handle)
    await settle()
    const commit = vi.spyOn(coreInternals(core).ops, "sweep")
    seen.length = 0
    grant(fake, snapshotOf([]))
    fake.setVisibleScopes([])
    core.requestRights()
    await settle()
    expect(commit).toHaveBeenCalledOnce()
    expect(seen.filter((s) => s.rows.length === 0)).toHaveLength(1)
    expect(seen[0]!.rows).toEqual([])
  })

  it("applies two snapshots in a row, each with its own rule", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    fake.insert(TASK, taskValues(2, { org: T }))
    const one = core.view(card(1))
    const two = core.view(card(2))
    watch(one)
    watch(two)
    await settle()
    grant(fake, ONLY_T())
    fake.setVisibleScopes([T])
    core.requestRights()
    await settle()
    grant(fake, snapshotOf([]))
    fake.setVisibleScopes([])
    core.requestRights()
    await settle()
    expect(one.getSnapshot().status).toBe("purged")
    expect(two.getSnapshot().status).toBe("purged")
  })
})

describe("the snapshot barrier", () => {
  it("writes neither the header nor the lines of a pair read before the snapshot that denies it", async () => {
    const { core, fake } = harness({ mode: "manual" })
    await firstSnapshot(core)
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    // Обидва читання стартують в одну епоху, до відправки знімка; пари в
    // сховищі на заміні немає — прибирати проходу нічого.
    const header = core.view(card(1))
    const owned = core.view(section(1))
    watch(header)
    watch(owned)
    await settle()
    expect(fake.pending).toHaveLength(2)
    grant(fake, ONLY_T())
    core.requestRights()
    await settle()
    expect(core.rights()?.snapshot).toEqual(ONLY_T())
    fake.deliverAll()
    await settle()
    expect(rowsOf(core).get(key(1))).toBeUndefined()
    expect(linesOf(core, 1)).toBeUndefined()
    expect(header.getSnapshot().rows).toEqual([])
  })

  it("writes a read of the pair that started after the snapshot was applied", async () => {
    const { core, fake } = harness({ mode: "manual" })
    await firstSnapshot(core)
    seed(fake, 1, 1)
    grant(fake, ONLY_T())
    core.requestRights()
    await settle()
    // Пізніше читання сервер виконав після транзакції знімка: його судила RLS.
    const header = core.view(card(1))
    watch(header)
    await settle()
    fake.deliverAll()
    await settle()
    expect(header.getSnapshot()).toMatchObject({
      status: "ready",
      rows: [{ key: key(1) }],
    })
  })

  it("re-reads once the lines of an owner without a header that the barrier dropped from the first packet", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    // Та сама транзакція, що й `rights`, але бар'єр запиту не знає: ТЧ без
    // шапки відкинуто, і вигляд читає її ще раз — уже після знімка.
    const owned = core.view(section(1))
    watch(owned)
    await settle()
    expect(fake.log.filter(isSection)).toHaveLength(2)
    expect(linesOf(core, 1)?.lines).toHaveLength(1)
  })

  it("keeps a pair out of a read that started before a snapshot denied it and lands after the next one allowed it", async () => {
    const { core, fake } = harness({ mode: "manual" })
    await firstSnapshot(core)
    seed(fake, 1, 1)
    const header = core.view(card(1))
    watch(header)
    await settle()
    expect(fake.pending).toHaveLength(1)
    // Пари в сховищі немає: прохід нічого не ховає, надгробок дає лише бар'єр.
    grant(fake, ONLY_T())
    core.requestRights()
    await settle()
    grant(fake, BOTH())
    core.requestRights()
    await settle()
    fake.take().answer()
    await settle()
    expect(rowsOf(core).get(key(1))).toBeUndefined()
  })

  it("keeps every pair out of an older read when a snapshot opens the object by publicRead", async () => {
    const shared: CatalogEntry = { ...taskR, publicRead: "authenticated" }
    const { core, fake } = harness({ objects: [shared, org], mode: "manual" })
    // Гість: `publicRead` для автентифікованих пару не відкриває.
    grant(fake, snapshotOf([], [], null))
    fake.holdRights = true
    core.requestRights()
    await settle()
    seed(fake, 1, 1)
    const header = core.view(card(1))
    watch(header)
    await settle()
    fake.releaseRights()
    await settle()
    expect(core.rights()?.snapshot.userId).toBeNull()
    fake.holdRights = false
    grant(fake, snapshotOf([], [], USER))
    core.requestRights()
    await settle()
    fake.take().answer()
    await settle()
    expect(rowsOf(core).get(key(1))).toBeUndefined()
  })

  it("does not write lines of an owner without a header read between sending and applying a snapshot that denies it", async () => {
    const { core, fake } = harness({ mode: "manual" })
    await firstSnapshot(core)
    seed(fake, 1, 1)
    fake.setLines(TASK, key(1), "lines", lines)
    grant(fake, ONLY_T())
    fake.holdRights = true
    core.requestRights()
    await settle()
    // ТЧ стартує після відправки знімка, іншим запитом, до його застосування.
    const owned = core.view(section(1))
    watch(owned)
    await settle()
    fake.releaseRights()
    await settle()
    fake.deliverAll()
    await settle()
    expect(linesOf(core, 1)).toBeUndefined()
  })

  it("keeps a purged row out of a late answer even after the right returns", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    const handle = core.view(keys(1))
    watch(handle)
    await settle()
    fake.hold = (read) => keysOf(read.query).includes(key(1))
    void core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(fake.pending).toHaveLength(1)
    const late = fake.take()
    grant(fake, ONLY_T())
    fake.setVisibleScopes([T])
    core.requestRights()
    await settle()
    expect(rowsOf(core).get(key(1))).toBeUndefined()
    // Право повернулось: бар'єр нового знімка пари не забороняє, тож відповідь
    // зупиняє лише надгробок пари з проходу.
    grant(fake, BOTH())
    fake.setVisibleScopes(undefined)
    core.requestRights()
    await settle()
    late.answer()
    await settle()
    expect(rowsOf(core).get(key(1))).toBeUndefined()
  })
})

describe("narrowing", () => {
  const ORG_RIGHTS = (extent: string) =>
    snapshotOf([
      readRow(S, { object: "organization", extent }),
      readRow(T, { object: "organization" }),
    ])

  it("re-reads an invisible view of a narrowed object", async () => {
    const { core, fake } = harness({ objects: [task, orgR] })
    grant(fake, ORG_RIGHTS("any"))
    fake.insert(ORG, { ref: S })
    const spec: ViewSpec = { kind: "keys", object: ORG, keys: [S] }
    const hidden = core.view(spec)
    watch(hidden)
    await settle()
    core.setVisible(spec, false)
    const reads = readsOf(fake, ORG).length
    // `any` → `own` у тому самому скоупі: пара лишилась, обсяг звузився.
    grant(fake, ORG_RIGHTS("own"))
    core.requestRights()
    await settle()
    expect(readsOf(fake, ORG)).toHaveLength(reads + 1)
    expect(hidden.getSnapshot().status).toBe("ready")
  })

  it("re-reads a view of another object that holds the narrowed object as an include target", async () => {
    const { core, fake } = harness({ objects: [task, orgR] })
    grant(fake, ORG_RIGHTS("any"))
    fake.insert(ORG, { ref: S })
    seed(fake, 1, 1)
    watch(core.view({ kind: "full", object: TASK, include: ["org"] }))
    await settle()
    const reads = readsOf(fake, TASK).length
    grant(fake, ORG_RIGHTS("own"))
    core.requestRights()
    await settle()
    expect(readsOf(fake, TASK).length).toBeGreaterThan(reads)
  })

  it("re-reads a view once when one snapshot narrows its object and its include target", async () => {
    const { core, fake } = harness({ objects: [taskR, orgR] })
    const both = (extent: string) =>
      snapshotOf([
        readRow(S, { extent }),
        readRow(T),
        readRow(S, { object: "organization", extent }),
        readRow(T, { object: "organization" }),
      ])
    grant(fake, both("any"))
    fake.insert(ORG, { ref: S })
    seed(fake, 1, 1)
    watch(core.view({ kind: "full", object: TASK, include: ["org"] }))
    await settle()
    const reads = readsOf(fake, TASK).length
    grant(fake, both("own"))
    core.requestRights()
    await settle()
    expect(readsOf(fake, TASK)).toHaveLength(reads + 1)
  })

  it("re-reads the views of an unscoped object with a rights contract when scopeSets change", async () => {
    const unscoped: CatalogEntry = {
      ...taskR,
      scopeKindId: undefined,
      scopeColumn: undefined,
    }
    const { core, fake } = harness({ objects: [unscoped, org] })
    grant(fake, snapshotOf([readRow(S, { level: "global", scope: null })]))
    seed(fake, 1, 1)
    watch(core.view(keys(1)))
    await settle()
    const reads = readsOf(fake, TASK).length
    grant(fake, snapshotOf([readRow(S, { level: "global", scope: null })], [S]))
    core.requestRights()
    await settle()
    expect(readsOf(fake, TASK).length).toBeGreaterThan(reads)
  })

  it("re-reads nothing when the rights of the object did not narrow", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 1)
    watch(core.view(keys(1)))
    await settle()
    const reads = readsOf(fake, TASK).length
    // Ширше: новий кортеж і новий скоуп у `scopeSets` — не звуження.
    grant(
      fake,
      snapshotOf(
        [readRow(S), readRow(T), readRow(S, { extent: "own" })],
        [S, T, CONTAINER]
      )
    )
    core.requestRights()
    await settle()
    expect(readsOf(fake, TASK).length).toBe(reads)
  })
})

describe("the first snapshot (Р5а)", () => {
  it("re-reads the views of parts that went in another request than rights", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 17)
    // 16 частин запиту (`rights` + 15) і ще два запити по одній — понад межу.
    for (let n = 1; n <= 16; n++) watch(core.view(keys(n)))
    void core.preload(keys(17))
    await settle()
    expect(fake.requests.slice(0, 2)).toEqual([16, 2])
    expect(core.rights()).toBeDefined()
    // Частини другого запиту, зокрема невидимого вигляду, перечитано.
    expect(readsOfKey(fake, 16).length).toBeGreaterThan(1)
    expect(readsOfKey(fake, 17).length).toBeGreaterThan(1)
    // Частини запиту `rights` того самого об'єкта — ні.
    for (let n = 1; n <= 15; n++) expect(readsOfKey(fake, n)).toHaveLength(1)
  })

  it("re-reads nothing when the first packet is one request", async () => {
    const { core, fake } = harness()
    seed(fake, 1, 3)
    for (let n = 1; n <= 3; n++) watch(core.view(keys(n)))
    await settle()
    expect(fake.requests).toEqual([4])
    for (let n = 1; n <= 3; n++) expect(readsOfKey(fake, n)).toHaveLength(1)
  })

  it("re-reads views that settled before the first snapshot", async () => {
    const { core, fake } = harness()
    fake.rightsError = { code: "command.unavailable" }
    seed(fake, 1, 1)
    watch(core.view(keys(1)))
    await settle()
    expect(readsOfKey(fake, 1)).toHaveLength(1)
    fake.rightsError = undefined
    core.requestRights()
    await settle()
    expect(readsOfKey(fake, 1)).toHaveLength(2)
  })
})

describe("a change of the user", () => {
  it("goes the session-changed path and writes nothing of the packet", async () => {
    const changed = vi.fn()
    const { core, fake } = harness({ onSessionChanged: changed })
    seed(fake, 1, 1)
    const handle = core.view(card(1))
    const { seen } = watch(handle)
    await settle()
    const first = core.rights()
    fake.edit(TASK, key(1), { title: "other user" })
    grant(fake, snapshotOf([readRow(S), readRow(T)], [S, T], OTHER_USER))
    // Знімок і перечитування картки — одним пакетом.
    core.requestRights()
    void core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(changed).toHaveBeenCalledOnce()
    expect(core.rights()).toBe(first)
    expect(handle.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "session-changed",
      rows: [],
    })
    expect(inspectRows(core)).toBe(0)
    // Жодне сповіщення не несло рядка пакета.
    expect(
      seen.some((snapshot) =>
        snapshot.rows.some(
          (row) => row.state !== "removed" && row.values.title === "other user"
        )
      )
    ).toBe(false)
  })

  it.each([
    ["a guest by a user", null, USER],
    ["a user by a guest", USER, null],
  ])("replaces %s as a normal replacement", async (_, before, after) => {
    const changed = vi.fn()
    const { core, fake } = harness({ onSessionChanged: changed })
    seed(fake, 1, 1)
    grant(fake, snapshotOf([readRow(S), readRow(T)], [S, T], before))
    const handle = core.view(card(1))
    watch(handle)
    await settle()
    grant(fake, snapshotOf([readRow(S), readRow(T)], [S, T], after))
    core.requestRights()
    await settle()
    expect(changed).not.toHaveBeenCalled()
    expect(core.rights()?.snapshot.userId).toBe(after)
    expect(handle.getSnapshot()).toMatchObject({
      status: "ready",
      rows: [{ key: key(1) }],
    })
  })

  it("replaces a guest snapshot by a guest snapshot as usual", async () => {
    const changed = vi.fn()
    const { core, fake } = harness({ onSessionChanged: changed })
    grant(fake, snapshotOf([], [], null))
    await firstSnapshot(core)
    grant(fake, snapshotOf([], [S], null))
    core.requestRights()
    await settle()
    expect(changed).not.toHaveBeenCalled()
    expect(core.rights()?.snapshot.scopeSets).toHaveLength(1)
  })
})

const inspectRows = (core: CoreSession) =>
  [...coreInternals(core).objects.values()].reduce(
    (n, o) => n + [...o.rows.keys()].length,
    0
  )
