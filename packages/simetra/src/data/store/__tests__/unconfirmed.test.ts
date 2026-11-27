import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { coreInternals } from "../core"
import { derivedInputChanged } from "../sync/target-state"
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
      mine: isPage,
    },
    {
      kind: "keys",
      spec: { kind: "keys", object: TASK, keys: [key(2), key(3)] } as ViewSpec,
      held: reads(key(2)),
      // Ключ 3 читає лише цей вигляд: розбіжність готують над ключами 1–2.
      mine: reads(key(3)),
    },
  ])(
    "$kind, visible: reads again in the same flight until the composition holds the row",
    async ({ spec, held, mine }) => {
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
      // Завантаження й один повтор того самого польоту.
      expect(h.fake.log.filter(mine)).toHaveLength(2)
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

  // Прихована вкладка — гілка невидимого вигляду (§8.4, п. 7; §12, Р8):
  // повтору П15 на ній немає, вигляд показує `needsRefresh`, а `resume()`
  // читає його рівно раз.
  it("window, visible on a hidden tab: no repeat while hidden, one read on resume()", async () => {
    const h = setup()
    seed(h.fake, 1, 3)
    const bury = await divergence(h, key(2))
    h.fake.hold = isPage
    const spec: ViewSpec = { kind: "window", object: TASK }
    const handle = h.core.view(spec)
    watch(handle)
    await settle()
    const first = h.fake.take(isPage)
    await bury()
    h.core.suspend()
    const sent = h.fake.requests.length
    first.answer()
    await drain(h)
    expect(h.fake.requests.length).toBe(sent)
    expect(keysIn(handle.getSnapshot())).toEqual([key(1), key(3)])
    expect(handle.getSnapshot().needsRefresh).toBe(true)
    expect(handle.getSnapshot().staleComposition).toBe(true)
    h.core.resume()
    await drain(h)
    expect(h.fake.log.filter(isPage)).toHaveLength(2)
    expect(handle.getSnapshot().staleComposition).toBeUndefined()
    expect(handle.getSnapshot().needsRefresh).toBe(false)
  })

  // Повтор сторінки вимоги не знімає (сторінка підтверджує лише себе): після
  // нього та сама умова, що й після завантаження (§8.4, п. 7), — системне
  // перечитування вигляду одразу, а не такт інтервалу.
  it("window page of loadAfter: after its repeat the system re-read lifts the requirement at once", async () => {
    const h = setup({ limits: { windowPage: 2 } })
    seed(h.fake, 1, 5)
    const spec: ViewSpec = { kind: "window", object: TASK }
    const handle = h.core.view(spec)
    watch(handle)
    await settle()
    const bury = await divergence(h, key(3))
    h.fake.hold = isPage
    handle.loadAfter()
    await settle()
    const page = h.fake.take(isPage)
    await bury()
    const sent = h.fake.requests.length
    page.answer()
    await drain(h)
    expect(handle.getSnapshot().staleComposition).toBeUndefined()
    // Повтор сторінки й одне системне перечитування.
    expect(h.fake.requests.length).toBe(sent + 2)
    expect(keysIn(handle.getSnapshot())).toEqual([
      key(1),
      key(2),
      key(3),
      key(4),
    ])
    vi.advanceTimersByTime(30_000)
    await drain(h)
    expect(h.fake.requests.length).toBe(sent + 2)
  })

  // Системне перечитування, чию відповідь пропущено, бо завантаження вигляду
  // осіло раніше, — теж точка осідання (§8.4, п. 7): завантаження не
  // повторилось, бо бачило його в польоті, тож вимогу читає те саме правило
  // одразу, а не такт інтервалу.
  it("full, visible: a system re-read skipped because the load settled first reads the requirement at once", async () => {
    const h = setup()
    seed(h.fake, 1, 3)
    const handle = h.core.view({ kind: "full", object: TASK })
    watch(handle)
    await settle()
    h.fake.hold = () => true
    handle.refresh()
    await settle()
    const load = h.fake.take()
    const { epochs } = coreInternals(h.core)
    h.core.commit(
      (w) => w.apply(TASK, { rows: [], absent: [key(2)] }, epochs.next(), null),
      h.core.token()
    )
    h.core.commit((w) => w.hide(TASK, [key(1)]), h.core.token())
    await settle()
    expect(h.fake.pending.length).toBeGreaterThan(0)
    load.answer()
    await settle()
    const sent = h.fake.requests.length
    await drain(h)
    expect(handle.getSnapshot().staleComposition).toBeUndefined()
    expect(h.fake.requests.length).toBeGreaterThan(sent)
    const after = h.fake.requests.length
    vi.advanceTimersByTime(30_000)
    await drain(h)
    expect(h.fake.requests.length).toBe(after)
  })

  // Сторінка, відхилена на прихованій вкладці, — та сама гілка невидимого
  // (§8.4, п. 7; §12, Р8): повтору на ній немає, `resume()` читає раз.
  it("window page of loadAfter rejected on a hidden tab: no repeat while hidden, one read on resume()", async () => {
    const h = setup({ limits: { windowPage: 2 } })
    seed(h.fake, 1, 5)
    const spec: ViewSpec = { kind: "window", object: TASK }
    const handle = h.core.view(spec)
    watch(handle)
    await settle()
    const bury = await divergence(h, key(3))
    h.fake.hold = isPage
    handle.loadAfter()
    await settle()
    const page = h.fake.take(isPage)
    await bury()
    h.core.suspend()
    const sent = h.fake.requests.length
    page.answer()
    await drain(h)
    expect(h.fake.requests.length).toBe(sent)
    expect(handle.getSnapshot().needsRefresh).toBe(true)
    expect(handle.getSnapshot().staleComposition).toBe(true)
    h.core.resume()
    await drain(h)
    expect(h.fake.requests.length).toBe(sent + 1)
    expect(handle.getSnapshot().staleComposition).toBeUndefined()
    expect(handle.getSnapshot().needsRefresh).toBe(false)
  })

  // Позначку сторінки на прихованій вкладці знято в тому самому `commit`, що
  // пише відповідь, — до сповіщення: підписник, що в ньому просить наступну
  // сторінку, її дістає. Перевірку вкладки в точці осідання береже саме ця
  // мить, а не читання (повтор P3 відкладає шлюз; рішення архітекторки 25.11).
  it("window page rejected on a hidden tab: its mark is released before the notification, a next page asked there goes out", async () => {
    const h = setup({ limits: { windowPage: 2 } })
    seed(h.fake, 1, 7)
    const spec: ViewSpec = { kind: "window", object: TASK }
    const handle = h.core.view(spec)
    watch(handle)
    await settle()
    const bury = await divergence(h, key(3))
    h.fake.hold = isPage
    handle.loadAfter()
    await settle()
    const page = h.fake.take(isPage)
    await bury()
    h.core.suspend()
    let asked = false
    const stop = handle.subscribe(() => {
      if (asked) return
      asked = true
      handle.loadAfter()
    })
    const sent = h.fake.requests.length
    page.answer()
    await drain(h)
    stop()
    expect(asked).toBe(true)
    // Наступна сторінка з підписника пішла (P1 на прихованій вкладці допущено).
    expect(h.fake.requests.length).toBe(sent + 1)
  })

  // Дві сторінки в польоті, відхилені без руху епохи між відповідями,
  // дають ту саму вимогу: повтор іде за фактом відхилення кожної відповіді,
  // а не за зміною значення вимоги.
  it("window pages before and after in flight, both rejected: each repeats", async () => {
    const h = setup({ limits: { windowPage: 2 } })
    seed(h.fake, 1, 6)
    const spec: ViewSpec = { kind: "window", object: TASK }
    const handle = h.core.view(spec)
    watch(handle)
    await settle()
    handle.loadAfter()
    await settle()
    // Вікно посеред порядку: перша сторінка пішла з purge.
    h.core.commit(
      (w) => w.purge(TASK, { keys: [key(1), key(2)] }),
      h.core.token()
    )
    const s = [...coreInternals(h.core).registry.subsets()].find(
      (sub) => sub.form.spec.kind === "window"
    )!
    s.window = { ...s.window!, atStart: false }
    s.targetState = derivedInputChanged(s.targetState, "affected")
    expect(keysIn(handle.getSnapshot())).toEqual([key(3), key(4)])
    const bury = [await divergence(h, key(2)), await divergence(h, key(5))]
    h.fake.hold = isPage
    handle.loadBefore()
    handle.loadAfter()
    await settle()
    const before = h.fake.take(isPage)
    const after = h.fake.take(isPage)
    for (const b of bury) await b()
    before.answer()
    after.answer()
    await drain(h)
    expect(keysIn(handle.getSnapshot())).toEqual([
      key(1),
      key(2),
      key(3),
      key(4),
      key(5),
      key(6),
    ])
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
    // Після повтору — одне системне перечитування обох сторінок вікна (§8.4,
    // п. 7: сторінка вимоги не знімає), і жодної сторінки понад нього.
    expect(h.fake.log.filter(isPage)).toHaveLength(5)
  })
})
