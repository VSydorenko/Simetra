import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CORE_LIMITS, type Key, type ViewSpec } from "../types"
import {
  TASK,
  isKeys,
  isPage,
  key,
  keysIn,
  keysOf,
  seed,
  settle,
  setup,
  watch,
} from "./core-support"

/*
 * П15 (спека П4-B §6.2, правило 5): відповідь вигляду, чий рядок сховище
 * відхилило надгробком ключа, новішим за старт читання, лишає вимогу «склад
 * не підтверджено». Видимий вигляд читає ще раз тим самим польотом, доки
 * читання не підтвердить склад; невидимий — `needsRefresh`. Надгробок —
 * розбіжного «рядка немає»: старе читання за ключем лягло після новішого,
 * а слот без власників пішов із надгробком епохи позначки.
 */

const RELEASE = DEFAULT_CORE_LIMITS.releaseDelayMs

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

type Harness = ReturnType<typeof setup>

const reads = (k: Key) => (read: { query: Parameters<typeof keysOf>[0] }) =>
  keysOf(read.query).includes(k)

/**
 * Готує розбіжне «рядка немає» для `k`: старе читання за ключем тримається,
 * а інший вигляд пише рядок новішим читанням. Повертає дію, що відповідає старим
 * читанням (рядка тоді не видно) і звільняє обидва вигляди: слот `removed`
 * без власників іде з надгробком. Читання за ключем на цей час тримаються,
 * щоб хвіст не відновив слот раніше.
 */
async function divergence({ core, fake }: Harness, k: Key) {
  const handle = core.view({ kind: "keys", object: TASK, keys: [k] })
  const own = watch(handle)
  await settle()
  const hold = fake.hold
  fake.hold = (read) => reads(k)(read) || (hold?.(read) ?? false)
  handle.refresh()
  await settle()
  const older = fake.take(reads(k))
  fake.hold = hold
  const newer = watch(
    core.view({ kind: "keys", object: TASK, keys: [key(1), k] })
  )
  await settle()
  return async () => {
    const before = fake.hold
    fake.hold = (read) => isKeys(read) || (before?.(read) ?? false)
    fake.setVisibleScopes([])
    older.answer()
    fake.setVisibleScopes(undefined)
    await settle()
    for (const w of [own, newer]) w.unsubscribe()
    vi.advanceTimersByTime(RELEASE)
    await settle()
    fake.hold = before
  }
}

/** Відповідає на все, що тримається, доки нічого не лишиться. */
async function drain({ fake }: Harness) {
  fake.hold = undefined
  while (fake.pending.length > 0) {
    fake.take().answer()
    await settle()
  }
  await settle()
}

describe("a view answer rejected by a newer key tombstone (П15)", () => {
  it.each([
    {
      kind: "window",
      spec: { kind: "window", object: TASK } as ViewSpec,
      held: isPage,
    },
    {
      kind: "keys",
      spec: { kind: "keys", object: TASK, keys: [key(2), key(3)] } as ViewSpec,
      held: reads(key(2)),
    },
  ])(
    "$kind, visible: reads again in the same flight until the composition holds the row",
    async ({ spec, held }) => {
      const h = setup()
      seed(h.fake, 1, 3)
      const bury = await divergence(h, key(2))
      h.fake.hold = held
      const handle = h.core.view(spec)
      watch(handle)
      await settle()
      const first = h.fake.take(held)
      await bury()
      first.answer()
      await drain(h)
      expect(keysIn(handle.getSnapshot())).toContain(key(2))
      expect(handle.getSnapshot().needsRefresh).toBe(false)
    }
  )

  it("window, invisible: needsRefresh, no second read until it becomes visible, then one", async () => {
    const h = setup()
    seed(h.fake, 1, 3)
    const bury = await divergence(h, key(2))
    h.fake.hold = isPage
    const spec: ViewSpec = { kind: "window", object: TASK }
    const handle = h.core.view(spec)
    watch(handle)
    h.core.setVisible(spec, false)
    await settle()
    const first = h.fake.take(isPage)
    await bury()
    first.answer()
    await drain(h)
    expect(keysIn(handle.getSnapshot())).toEqual([key(1), key(3)])
    expect(handle.getSnapshot().needsRefresh).toBe(true)
    expect(h.fake.log.filter(isPage)).toHaveLength(1)
    // Склад не підтверджено (§8.4): видимість читає вигляд рівно раз.
    h.core.setVisible(spec, true)
    await drain(h)
    expect(h.fake.log.filter(isPage)).toHaveLength(2)
    h.core.setVisible(spec, false)
    h.core.setVisible(spec, true)
    await drain(h)
    expect(h.fake.log.filter(isPage)).toHaveLength(2)
  })

  it("window page of loadAfter: the repeat takes the place of its own page, in server order", async () => {
    const h = setup({ limits: { windowPage: 2 } })
    seed(h.fake, 1, 5)
    const spec: ViewSpec = { kind: "window", object: TASK }
    const handle = h.core.view(spec)
    watch(handle)
    await settle()
    expect(keysIn(handle.getSnapshot())).toEqual([key(1), key(2)])
    const bury = await divergence(h, key(3))
    h.fake.hold = isPage
    handle.loadAfter()
    await settle()
    const page = h.fake.take(isPage)
    await bury()
    page.answer()
    await settle()
    // Повтор у польоті тримає напрямок: ще один `loadAfter` нічого не шле.
    handle.loadAfter()
    await settle()
    expect(h.fake.log.filter(isPage)).toHaveLength(3)
    await drain(h)
    expect(keysIn(handle.getSnapshot())).toEqual([
      key(1),
      key(2),
      key(3),
      key(4),
    ])
    expect(h.fake.log.filter(isPage)).toHaveLength(3)
  })
})
