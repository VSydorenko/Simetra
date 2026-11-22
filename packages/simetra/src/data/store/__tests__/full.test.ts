import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DataError } from "../../errors"
import { DEFAULT_CORE_LIMITS, type ViewSpec } from "../types"
import {
  ORG,
  S,
  TASK,
  isKeys,
  isPage,
  key,
  keysIn,
  keysOf,
  seed,
  type FakeRead,
  settle,
  setup,
  taskValues,
  watch,
} from "./core-support"

const RELEASE = DEFAULT_CORE_LIMITS.releaseDelayMs
const full: ViewSpec = { kind: "full", object: TASK }

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("full", () => {
  it("is not over the limit with 5 000 rows and a full last page", async () => {
    const { core, fake, log } = setup()
    seed(fake, 1, 5_000)
    const handle = core.view(full)
    watch(handle)
    await settle(5_000)
    const snapshot = handle.getSnapshot()
    expect(snapshot).toMatchObject({
      status: "ready",
      strategy: "full",
      truncated: false,
    })
    expect(snapshot.rows).toHaveLength(5_000)
    // 25 повних сторінок і порожня: повна сторінка не зупиняє вибірки.
    expect(fake.log.filter(isPage)).toHaveLength(26)
    expect(log.some((e) => e.kind === "full-truncated")).toBe(false)
  })

  it("throws data.full-too-large over the limit with strict", async () => {
    const { core, fake, inspect } = setup({ strict: true })
    seed(fake, 1, 5_001)
    const handle = core.view(full)
    watch(handle)
    await settle(5_000)
    const snapshot = handle.getSnapshot()
    expect(snapshot.status).toBe("error")
    expect(snapshot.error).toBeInstanceOf(DataError)
    expect((snapshot.error as DataError).code).toBe("data.full-too-large")
    expect(inspect.rowCount()).toBe(0)
  })

  it("turns into a truncated window of 100 rows over the limit without strict", async () => {
    const { core, fake, log, inspect } = setup()
    seed(fake, 1, 5_001)
    const handle = core.view(full)
    watch(handle)
    await settle(5_000)
    const snapshot = handle.getSnapshot()
    expect(snapshot).toMatchObject({
      status: "ready",
      strategy: "window",
      truncated: true,
      atEnd: false,
    })
    expect(keysIn(snapshot)).toEqual(
      Array.from({ length: 100 }, (_, i) => key(i + 1))
    )
    expect(log).toContainEqual({
      kind: "full-truncated",
      object: TASK,
      limit: 5_000,
    })
    expect(inspect.rowCount()).toBe(100)
    expect(inspect.violations()).toEqual([])
  })

  it("filters and orders locally", async () => {
    // Сервер віддає рядки у зворотному порядку: порядок дає лише компаратор ядра.
    const { core, fake } = setup({ reverseRows: true })
    const titles = ["b", "a", "C", "ä", "c", "B", "x"]
    titles.forEach((title, i) =>
      fake.insert(TASK, taskValues(i + 1, { title }))
    )
    const handle = core.view({
      kind: "full",
      object: TASK,
      where: { attribute: "title", op: "ne", value: "x" },
      orderBy: [{ attribute: "title", direction: "desc" }],
    })
    watch(handle)
    await settle()
    const collator = new Intl.Collator()
    const expected = titles
      .map((title, i) => ({ title, key: key(i + 1) }))
      .filter((r) => r.title !== "x")
      .sort(
        (a, b) =>
          -collator.compare(a.title, b.title) || (a.key < b.key ? -1 : 1)
      )
    expect(keysIn(handle.getSnapshot())).toEqual(expected.map((r) => r.key))
  })

  it("leaves no revisions or cached row views after every view and timer is released", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 20)
    const a = watch(core.view(full))
    const b = watch(
      core.view({ kind: "keys", object: TASK, keys: [key(1), key(2)] })
    )
    await settle()
    core.view(full).getSnapshot()
    a.unsubscribe()
    b.unsubscribe()
    vi.advanceTimersByTime(RELEASE)
    // Перепланування планувальника після відписки — мікрозадача.
    await settle()
    expect(inspect.rowCount()).toBe(0)
    // Ревізія чи кешований RowView ключа поза сховищем — порушення.
    expect(inspect.violations()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it("keeps NULL in the sort field across a page boundary", async () => {
    const { core, fake } = setup({ limits: { fullPageSize: 2 } })
    const statuses = ["Open", null, null, "Closed", "Open"]
    statuses.forEach((status, i) =>
      fake.insert(TASK, taskValues(i + 1, { status }))
    )
    const handle = core.view({
      kind: "full",
      object: TASK,
      orderBy: [{ attribute: "status", direction: "asc" }],
    })
    watch(handle)
    await settle()
    // Мітки: closed < open; NULL за asc — у кінці; нічия — за ключем.
    expect(keysIn(handle.getSnapshot())).toEqual([
      key(4),
      key(1),
      key(5),
      key(2),
      key(3),
    ])
  })

  it("keeps a removed row in its place, past the filter and the comparator", async () => {
    const { core, fake } = setup()
    ;["c", "b", "a"].forEach((title, i) =>
      fake.insert(TASK, taskValues(i + 1, { title }))
    )
    const handle = core.view({
      kind: "full",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "asc" }],
    })
    watch(handle)
    const single = core.view({ kind: "keys", object: TASK, keys: [key(2)] })
    watch(single)
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual([key(3), key(2), key(1)])

    const moment = fake.edit(TASK, key(1), { title: "0" })
    fake.hold = (read) => isPage(read)
    handle.refresh()
    // Сторінка вийшла окремим запитом: інакше відповідь на `single` чекала б
    // на утримане читання сторінки в одному пакеті.
    await settle()
    fake.remove(TASK, key(2))
    single.refresh()
    await settle()
    expect(handle.getSnapshot().rows).toMatchObject([
      { key: key(3) },
      { key: key(2), state: "removed" },
      { key: key(1) },
    ])
    // Читання, почате до позначки, рядка не відновлює, а склад змінює лише
    // для живих рядків: `removed` тримає попередню позицію.
    fake.take().answer(moment)
    await settle()
    expect(handle.getSnapshot().rows).toMatchObject([
      { key: key(1), values: { title: "0" } },
      { key: key(2), state: "removed" },
      { key: key(3) },
    ])
  })

  it("reads include targets of a removed row that the same read restores", async () => {
    const { core, fake, inspect } = setup()
    fake.insert(ORG, { ref: S })
    // Єдиний рядок із ціллю `S`: інакше ціль прийшла б від сусіда.
    seed(fake, 1, 1)
    const single = core.view({ kind: "keys", object: TASK, keys: [key(1)] })
    watch(single)
    await settle()
    fake.remove(TASK, key(1))
    single.refresh()
    await settle()
    expect(single.getSnapshot().rows[0]).toMatchObject({ state: "removed" })

    // Рядок повернувся на сервер: читання `full`, почате після позначки,
    // знімає `removed` у своєму ж застосуванні, тож і ціль `include` має
    // прийти з цього читання — пізнішого читання цілей не буде.
    fake.insert(TASK, taskValues(1))
    const handle = core.view({ kind: "full", object: TASK, include: ["org"] })
    watch(handle)
    await settle()
    const row = handle.getSnapshot().rows.find((r) => r.key === key(1))
    expect(row).toMatchObject({ refs: { org: { key: S } } })
    expect(row?.state).not.toBe("removed")
    expect(inspect.owners(ORG, S)).toBeGreaterThan(0)
  })

  it("does not own include targets of a row whose put is rejected and stays removed", async () => {
    const { core, fake, inspect } = setup()
    fake.insert(ORG, { ref: S })
    seed(fake, 1, 1)
    const single = core.view({ kind: "keys", object: TASK, keys: [key(1)] })
    watch(single)
    await settle()
    const handle = core.view({ kind: "full", object: TASK, include: ["org"] })
    // Читання `full` почате до позначки: його відповідь для `removed` застаріла.
    fake.hold = (read) => isPage(read)
    watch(handle)
    await settle()
    const late = fake.take(isPage)
    fake.hold = undefined
    fake.remove(TASK, key(1))
    single.refresh()
    await settle()
    expect(single.getSnapshot().rows[0]).toMatchObject({ state: "removed" })
    late.answer(late.issuedAt)
    await settle()
    expect(inspect.owners(ORG, S)).toBe(0)
  })

  // П15: відповідь завантаження, відхилена новішою позначкою `removed` (старше
  // читання сказало «рядка немає» вже після його старту), лишає вимогу «склад
  // не підтверджено»: видимий вигляд завантажується ще раз, невидимий — лише
  // `needsRefresh`.
  it.each([
    { visible: true, pages: 2, keys: [key(1), key(2)], needsRefresh: false },
    { visible: false, pages: 1, keys: [key(2)], needsRefresh: true },
  ])(
    "a load answer rejected by a newer removed mark of an older read, visible $visible: $pages page reads",
    async ({ visible, pages, keys, needsRefresh }) => {
      const { core, fake } = setup()
      seed(fake, 1, 2)
      const single = core.view({ kind: "keys", object: TASK, keys: [key(1)] })
      watch(single)
      await settle()
      // Старе читання за ключем: його «рядка немає» ляже після новіших читань.
      fake.hold = (read) => isKeys(read)
      single.refresh()
      await settle()
      const older = fake.take(isKeys)
      // Новіше читання картки пише рядок: старе «рядка немає» стане розбіжним.
      watch(core.view({ kind: "card", object: TASK, key: key(1) }))
      await settle()
      // Завантаження `full` стартує до розбіжної позначки.
      fake.hold = (read) => isKeys(read) || isPage(read)
      const handle = core.view(full)
      watch(handle)
      if (!visible) core.setVisible(full, false)
      await settle()
      const page = fake.take(isPage)
      fake.setVisibleScopes([])
      older.answer()
      fake.setVisibleScopes(undefined)
      await settle()
      expect(single.getSnapshot().rows[0]).toMatchObject({ state: "removed" })
      // Відповідь має рядок, але сховище його відхиляє: позначка новіша за
      // старт читання.
      page.answer()
      await settle()
      fake.hold = undefined
      while (fake.pending.length > 0) {
        fake.take().answer()
        await settle()
      }
      await settle()
      expect(keysIn(handle.getSnapshot())).toEqual(keys)
      expect(handle.getSnapshot().needsRefresh).toBe(needsRefresh)
      expect(fake.log.filter(isPage)).toHaveLength(pages)
    }
  )

  // Межа повторів — умова, не лічильник: спробу, відхилену ще новішою
  // позначкою, вимога переносить на неї, і завантаження йде знову, доки
  // читання не підтвердить склад.
  it("two rejected answers in a row: the load goes on until a read confirms the composition", async () => {
    const { core, fake } = setup()
    seed(fake, 1, 2)
    const singles = [key(1), key(2)].map((k) => {
      const handle = core.view({ kind: "keys", object: TASK, keys: [k] })
      watch(handle)
      return handle
    })
    await settle()
    // Старі читання за ключем, кожне своїм запитом: їхні «рядка немає»
    // лягають після новіших.
    fake.hold = (read) => isKeys(read)
    const older: FakeRead[] = []
    for (const [i, single] of singles.entries()) {
      single.refresh()
      await settle()
      older.push(fake.take((read) => keysOf(read.query).includes(key(i + 1))))
    }
    for (const k of [key(1), key(2)])
      watch(core.view({ kind: "card", object: TASK, key: k }))
    await settle()
    fake.hold = (read) => isKeys(read) || isPage(read)
    const handle = core.view(full)
    watch(handle)
    await settle()
    // Кожна спроба завантаження стартує до своєї розбіжної позначки.
    for (const read of older) {
      const page = fake.take(isPage)
      fake.setVisibleScopes([])
      read.answer()
      fake.setVisibleScopes(undefined)
      await settle()
      page.answer()
      await settle()
    }
    fake.hold = undefined
    while (fake.pending.length > 0) {
      fake.take().answer()
      await settle()
    }
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual([key(1), key(2)])
    expect(handle.getSnapshot().needsRefresh).toBe(false)
    expect(fake.log.filter(isPage)).toHaveLength(3)
  })

  it("stops reading pages and targets once the view is released", async () => {
    const { core, fake, inspect } = setup()
    seed(fake, 1, 1_000)
    fake.hold = (read) => isPage(read)
    const handle = core.view({ kind: "full", object: TASK, include: ["org"] })
    watch(handle).unsubscribe()
    await settle()
    const first = fake.take()
    vi.advanceTimersByTime(RELEASE)
    first.answer()
    await settle()
    expect(fake.log.filter(isPage)).toHaveLength(1)
    expect(fake.pending).toHaveLength(0)
    expect(inspect.rowCount()).toBe(0)
  })
})
