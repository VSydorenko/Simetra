import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DataError } from "../../errors"
import { DEFAULT_CORE_LIMITS, type ViewSpec } from "../types"
import {
  TASK,
  isPage,
  key,
  keysIn,
  seed,
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
    const { core, fake } = setup()
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
})
