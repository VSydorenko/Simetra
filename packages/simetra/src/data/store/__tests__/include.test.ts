import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { coreInternals } from "../core"
import type { FakeReadLog, FakeSource } from "../testing/fake-source"
import {
  DEFAULT_CORE_LIMITS,
  type Key,
  type RowView,
  type ViewSpec,
} from "../types"
import {
  ORG,
  TASK,
  isPage,
  key,
  keysOf,
  readsOf,
  settle,
  setup,
  taskValues,
  watch,
} from "./core-support"

const EA = "a".repeat(64)
const RELEASE = DEFAULT_CORE_LIMITS.releaseDelayMs

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/*
 * `include` тим самим запитом (спека П4-B §6.7, Р8, Р8а, І9): цілі приходять
 * рядками `included` частини вигляду; системне перечитування шле цілі, які
 * вигляд тримає, частиною `keys` з `known` у тому самому запиті.
 */

const orgKey = (n: number) => key(10_000 + n)
const LIST = { include: ["org"] }
const FULL: ViewSpec = { kind: "full", object: TASK, ...LIST }
const WINDOW: ViewSpec = { kind: "window", object: TASK, ...LIST }

/** Задачі `1..n`, кожна зі своєю організацією; повні рядки списку. */
function seedWithOrgs(fake: FakeSource, count: number) {
  fake.epoch = EA
  for (let n = 1; n <= count; n++) {
    fake.insert(ORG, { ref: orgKey(n) })
    fake.insert(
      TASK,
      taskValues(n, { org: orgKey(n), status: null, subject: null })
    )
  }
}

const includeOf = (read: FakeReadLog) =>
  read.query !== undefined && "include" in read.query
    ? read.query.include
    : undefined

/** Відповідь частини: самі маркери (число чи об'єкт з `$known`). */
const markersOnly = (read: FakeReadLog) =>
  (read.response as { rows: unknown[] }).rows.every(
    (row) =>
      typeof row === "number" ||
      (typeof row === "object" && row !== null && "$known" in row)
  )

/** The key of the `org` target a row shows, `null` for an empty `refs`. */
const orgOf = (row: RowView) =>
  row.state === "removed" ? undefined : (row.refs?.org?.key ?? null)

const orgRow = (core: ReturnType<typeof setup>["core"], k: Key) =>
  coreInternals(core).objects.get(ORG)!.rows.get(k)

describe.each([
  ["full", FULL],
  ["window", WINDOW],
])("a %s list with include", (_, spec) => {
  it("opens in one request: the page carries include, no target is read by key", async () => {
    const { core, fake } = setup()
    seedWithOrgs(fake, 3)
    const handle = core.view(spec)
    watch(handle)
    await settle()
    expect(fake.requests).toHaveLength(1)
    expect(fake.log).toHaveLength(1)
    expect(includeOf(fake.log[0]!)).toEqual(["org"])
    expect(readsOf(fake, ORG)).toHaveLength(0)
    expect(handle.getSnapshot().rows[0]).toMatchObject({
      refs: { org: { key: orgKey(1), state: "synced" } },
    })
  })

  it("writes the targets in the commit of the rows of the view", async () => {
    const { core, fake } = setup()
    seedWithOrgs(fake, 2)
    const { seen } = watch(core.view(spec))
    await settle()
    // Перший знімок із рядками вже має цілі: це один `commit`.
    const first = seen.find((s) => s.rows.length > 0)!
    expect(first.rows.map(orgOf)).toEqual([orgKey(1), orgKey(2)])
  })

  it("is the owner of the targets: they leave with the view", async () => {
    const { core, fake, inspect } = setup()
    seedWithOrgs(fake, 2)
    watch(core.view(spec)).unsubscribe()
    await settle()
    expect(inspect.owners(ORG, orgKey(1))).toBe(1)
    vi.advanceTimersByTime(RELEASE)
    expect(inspect.rowCount()).toBe(0)
    expect(inspect.violations()).toEqual([])
  })
})

describe("an adapter without capabilities.include", () => {
  it("reads the targets by key after the page, as before", async () => {
    const { core, fake } = setup({
      adapter: (fake) => ({
        capabilities: { include: false },
        read: fake.adapter.read,
      }),
    })
    seedWithOrgs(fake, 3)
    const handle = core.view(FULL)
    watch(handle)
    await settle()
    expect(includeOf(fake.log[0]!)).toBeUndefined()
    const byKey = readsOf(fake, ORG)
    expect(byKey).toHaveLength(1)
    expect(keysOf(byKey[0]!.query)).toEqual([orgKey(1), orgKey(2), orgKey(3)])
    expect(fake.requests).toHaveLength(2)
    expect(handle.getSnapshot().rows[0]).toMatchObject({
      refs: { org: { key: orgKey(1) } },
    })
  })
})

describe("the next page of a window", () => {
  it("asks no include and reads only the absent targets in the next request", async () => {
    const { core, fake } = setup({ limits: { windowPage: 2 } })
    fake.epoch = EA
    for (const n of [1, 2, 4]) fake.insert(ORG, { ref: orgKey(n) })
    // Задача 3 посилається на ціль першої сторінки: її не дочитуємо.
    const orgs = [1, 2, 1, 4]
    orgs.forEach((o, i) =>
      fake.insert(
        TASK,
        taskValues(i + 1, { org: orgKey(o), status: null, subject: null })
      )
    )
    const handle = core.view(WINDOW)
    watch(handle)
    await settle()
    expect(fake.log).toHaveLength(1)
    handle.loadAfter()
    await settle()
    const [, page, targets] = fake.log
    expect(isPage(page!)).toBe(true)
    expect(includeOf(page!)).toBeUndefined()
    expect(keysOf(targets!.query)).toEqual([orgKey(4)])
    expect(targets!.request).toBeGreaterThan(page!.request)
    expect(handle.getSnapshot().rows.map(orgOf)).toEqual([
      orgKey(1),
      orgKey(2),
      orgKey(1),
      orgKey(4),
    ])
  })
})

describe("a full list over its first page", () => {
  it("takes the targets of the further pages in the next request", async () => {
    const { core, fake } = setup({ limits: { fullPageSize: 2 } })
    seedWithOrgs(fake, 3)
    const handle = core.view(FULL)
    watch(handle)
    await settle()
    const [first, second, targets] = fake.log
    expect(includeOf(first!)).toEqual(["org"])
    expect(includeOf(second!)).toBeUndefined()
    expect(keysOf(targets!.query)).toEqual([orgKey(3)])
    expect(handle.getSnapshot().rows.map(orgOf)).toEqual([
      orgKey(1),
      orgKey(2),
      orgKey(3),
    ])
  })
})

describe.each([
  ["full", FULL],
  ["window", WINDOW],
])("the system re-read of a %s list with include", (_, spec) => {
  async function opened(count = 3) {
    const h = setup()
    seedWithOrgs(h.fake, count)
    const handle = h.core.view(spec)
    watch(handle)
    await settle()
    return { ...h, handle }
  }

  it("is one request with markers for the rows and for the targets", async () => {
    const { core, fake, handle, inspect } = await opened()
    const shown = JSON.stringify(handle.getSnapshot().rows)
    const requests = fake.requests.length
    const from = fake.log.length
    await core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(fake.requests.length).toBe(requests + 1)
    const reads = fake.log.slice(from)
    expect(reads).toHaveLength(2)
    const page = reads.find(isPage)!
    const targets = reads.find((r) => keysOf(r.query).length > 0)!
    // Цілі `include` `known` не беруть, тож частина вигляду йде без `include`.
    expect(includeOf(page)).toBeUndefined()
    expect(targets.known?.keys).toHaveLength(3)
    expect(markersOnly(page)).toBe(true)
    expect(markersOnly(targets)).toBe(true)
    expect(JSON.stringify(handle.getSnapshot().rows)).toBe(shown)
    expect(inspect.violations()).toEqual([])
  })

  it("is one request more, only with the new ids, when a reference changed", async () => {
    const { core, fake, handle } = await opened()
    fake.insert(ORG, { ref: orgKey(9) })
    fake.edit(TASK, key(1), { org: orgKey(9) })
    const requests = fake.requests.length
    const from = fake.log.length
    await core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(fake.requests.length).toBe(requests + 2)
    const fresh = fake.log
      .slice(from)
      .filter((r) => keysOf(r.query).length > 0 && r.known === undefined)
    expect(fresh.map((r) => keysOf(r.query))).toEqual([[orgKey(9)]])
    expect(handle.getSnapshot().rows[0]).toMatchObject({
      refs: { org: { key: orgKey(9) } },
    })
  })

  it("marks a held target the keys part did not answer as removed", async () => {
    const { core, fake, handle } = await opened()
    // Ціль зникла для читача (RLS чи видалення): частина `keys` її не віддає.
    fake.remove(ORG, orgKey(1))
    await core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(orgRow(core, orgKey(1))?.removed).toBeDefined()
    const [first, second] = handle.getSnapshot().rows
    expect(first).toMatchObject({ key: key(1), refs: { org: null } })
    expect(second).toMatchObject({ refs: { org: { key: orgKey(2) } } })
  })
})

describe("a full list whose reference changed", () => {
  it("lets the old target go out of the held ones", async () => {
    const { core, fake } = setup()
    seedWithOrgs(fake, 2)
    fake.insert(ORG, { ref: orgKey(9) })
    watch(core.view(FULL))
    await settle()
    fake.edit(TASK, key(1), { org: orgKey(9) })
    await core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const [s] = [...coreInternals(core).registry.subsets()]
    expect([...s!.included.get(ORG)!].sort()).toEqual(
      [orgKey(2), orgKey(9)].sort()
    )
  })
})

// І9: несумісна ціль `include` живої частини нічого не пише й не стає
// `removed`: ні коли була такою до запиту, ні коли стала, поки відповідь
// летіла.
describe("an incompatible include target", () => {
  it("is not asked for and is not written when it was incompatible before the request", async () => {
    const { core, fake, inspect } = setup()
    seedWithOrgs(fake, 2)
    core.staleClient(ORG)
    const handle = core.view(FULL)
    watch(handle)
    await settle()
    expect(includeOf(fake.log[0]!)).toBeUndefined()
    expect(readsOf(fake, ORG)).toHaveLength(0)
    expect(orgRow(core, orgKey(1))).toBeUndefined()
    expect(handle.getSnapshot().rows).toHaveLength(2)
    expect(handle.getSnapshot().rows[0]).toMatchObject({ refs: { org: null } })
    expect(inspect.violations()).toEqual([])
  })

  it("writes nothing and removes no key when it became incompatible while the answer was in flight", async () => {
    const { core, fake } = setup({ limits: { fullPageSize: 2 } })
    seedWithOrgs(fake, 3)
    const handle = core.view(FULL)
    watch(handle)
    await settle()
    expect(orgRow(core, orgKey(1))?.removed).toBeUndefined()
    // Ціль першої сторінки зникла на сервері: відповідь її не віддасть, і
    // без захисту ключ став би `removed` уже несумісної цілі.
    fake.remove(ORG, orgKey(1))
    // Дочитування цілей третьої задачі стоїть: між відповіддю сторінок і
    // застосуванням ціль стає несумісною.
    fake.hold = (read) => read.object === ORG
    handle.refresh()
    await settle()
    const targets = fake.take()
    core.staleClient(ORG)
    targets.answer()
    await settle()
    expect(orgRow(core, orgKey(1))?.removed).toBeUndefined()
    expect(handle.getSnapshot().rows).toHaveLength(3)
  })
})

describe("a card read with the header and the lines of its owner", () => {
  it("goes in one request when the list holding the header has include", async () => {
    const { core, fake } = setup()
    seedWithOrgs(fake, 2)
    fake.setLines(TASK, key(1), "lines", [
      { ref: key(901), qty: 1, lineNumber: 1 },
    ])
    watch(core.view(FULL))
    await settle()
    const requests = fake.requests.length
    watch(core.view({ kind: "card", object: TASK, key: key(1) }))
    watch(
      core.view({
        kind: "section",
        object: TASK,
        owner: key(1),
        section: "lines",
      })
    )
    await settle()
    expect(fake.requests.length).toBe(requests + 1)
    expect(fake.requests.at(-1)).toBe(2)
  })
})
