import { describe, expect, it } from "vitest"
import { readQuerySchema, type OrderBy } from "simetra/model"
import { inspectCore } from "../core"
import { keysetAfter, reverseOrder, tupleComparator } from "../filter"
import type { CoreOptions, ViewSnapshot, ViewSpec } from "../types"
import { TASK, id, setup, taskSpec, watch } from "./support"

/*
 * Спайк 4: вигляд `window` — ланцюжок keyset-сторінок з `NULL`, краї,
 * переходи, оновлення без втрати рядка, вивантаження далеких сторінок у
 * знімки показу й межа їхньої пам'яті.
 */

const fields = { ...taskSpec.fields }

/** Детермінований ГПВЧ (mulberry32): відтворювані випадкові набори. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Рядки з дублями й `NULL` у полях сортування — нічиї розв'язує ключ. */
function seedRows(n: number, seed = 1) {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => ({
    id: id(i + 1),
    title: r() < 0.15 ? null : `t${Math.floor(r() * 20)}`,
    rank: r() < 0.2 ? null : Math.floor(r() * 30),
    done: r() < 0.5,
  }))
}

function serverOrder(
  rows: ReturnType<typeof seedRows>,
  orderBy: OrderBy,
  where?: (r: (typeof rows)[number]) => boolean
) {
  const cmp = tupleComparator(fields, orderBy)
  return rows
    .filter((r) => where?.(r) ?? true)
    .map((r) => ({ key: r.id, values: r as Record<string, unknown> }))
    .sort(cmp)
    .map((r) => r.key)
}

const keysOf = (snap: ViewSnapshot) => snap.rows.map((r) => r.key)

function windowSpec(orderBy: OrderBy, pageSize = 7): ViewSpec {
  return { kind: "window", object: TASK, orderBy, pageSize }
}

function setupWindow(
  rows: ReturnType<typeof seedRows>,
  options: Partial<CoreOptions> = {}
) {
  const env = setup({
    window: { unloadDelayMs: 0, marginPages: 1 },
    ...options,
  })
  env.server.seed(TASK, rows)
  env.transport.setAuto(true)
  return env
}

const ORDERS: OrderBy[] = [
  [{ attribute: "rank", direction: "asc" }],
  [{ attribute: "rank", direction: "desc" }],
  [{ attribute: "rank", direction: "asc", nulls: "first" }],
  [{ attribute: "rank", direction: "desc", nulls: "last" }],
  [
    { attribute: "title", direction: "asc" },
    { attribute: "rank", direction: "desc" },
  ],
  [
    { attribute: "done", direction: "desc" },
    { attribute: "title", direction: "desc", nulls: "last" },
    { attribute: "rank", direction: "asc", nulls: "first" },
  ],
]

describe("keyset з NULL", () => {
  it("умова проходить схему T0 і вкладається в бюджет фільтра", () => {
    for (const orderBy of ORDERS) {
      for (const values of [
        { title: null, rank: null, done: null },
        { title: "t1", rank: 3, done: true },
      ]) {
        for (const ob of [orderBy, reverseOrder(orderBy)]) {
          const where = keysetAfter(ob, { key: id(1), values }, true)
          const parsed = readQuerySchema.safeParse({
            object: taskSpec.ref,
            orderBy: ob,
            limit: 100,
            where,
          })
          expect(parsed.success, JSON.stringify(parsed.error)).toBe(true)
        }
      }
    }
  })

  it.each(ORDERS.map((o, i) => [i, o] as const))(
    "ланцюжок loadAfter = порядок сервера, без пропусків і дублів (порядок %i)",
    async (_, orderBy) => {
      const rows = seedRows(60, 7)
      const { session, transport } = setupWindow(rows)
      const h = session.view(windowSpec(orderBy))
      const v = watch(h)
      await transport.drain()
      while (!v.last.window?.atEnd) {
        h.loadAfter()
        await transport.drain()
      }
      expect(keysOf(v.last)).toEqual(serverOrder(rows, orderBy))
      v.unsubscribe()
    }
  )

  it.each(ORDERS.map((o, i) => [i, o] as const))(
    "goToEnd і loadBefore до початку дають той самий порядок (порядок %i)",
    async (_, orderBy) => {
      const rows = seedRows(60, 11)
      const { session, transport } = setupWindow(rows)
      const h = session.view(windowSpec(orderBy))
      const v = watch(h)
      await transport.drain()
      h.goToEnd()
      await transport.drain()
      expect(v.last.window?.target).toBe("end")
      expect(v.last.window?.atEnd).toBe(true)
      while (!v.last.window?.atStart) {
        h.loadBefore()
        await transport.drain()
      }
      expect(keysOf(v.last)).toEqual(serverOrder(rows, orderBy))
      v.unsubscribe()
    }
  )

  it("goTo(value) — від першого рядка з першим атрибутом не раніше значення", async () => {
    const rows = seedRows(60, 3)
    const orderBy: OrderBy = [{ attribute: "rank", direction: "asc" }]
    const { session, transport } = setupWindow(rows)
    const h = session.view(windowSpec(orderBy, 10))
    const v = watch(h)
    await transport.drain()
    h.goTo(12)
    await transport.drain()
    const all = serverOrder(rows, orderBy)
    const from = all.findIndex(
      (k) => (rows.find((r) => r.id === k)!.rank ?? Infinity) >= 12
    )
    expect(keysOf(v.last)).toEqual(all.slice(from, from + 10))
    expect(v.last.window?.atStart).toBe(false)
    v.unsubscribe()
  })
})

describe("перехід і зміна ланцюжка без порожнього кадру", () => {
  it("goToEnd: старий ланцюжок видно (refreshing), новий — одним сповіщенням", async () => {
    const rows = seedRows(60, 5)
    const { session, transport } = setupWindow(rows)
    transport.setAuto(false)
    const h = session.view(
      windowSpec([{ attribute: "rank", direction: "asc" }])
    )
    const v = watch(h)
    await transport.drain()
    const before = v.frames.length
    h.goToEnd()
    await transport.settle()
    for (const f of v.frames.slice(before))
      expect(f.rows.length).toBeGreaterThan(0)
    expect(v.last.status).toBe("refreshing")
    const chain = v.last.window!.chain
    await transport.drain()
    expect(v.last.window!.chain).toBe(chain)
    expect(v.last.status).toBe("ready")
    for (const f of v.frames.slice(before))
      expect(f.rows.length).toBeGreaterThan(0)
    v.unsubscribe()
  })

  it("пізня відповідь старого ланцюжка нічого не пише", async () => {
    const rows = seedRows(60, 5)
    const { session, transport } = setupWindow(rows)
    transport.setAuto(false)
    const h = session.view(
      windowSpec([{ attribute: "rank", direction: "asc" }])
    )
    const v = watch(h)
    await transport.drain()
    h.loadAfter()
    await transport.settle()
    const edge = transport.take()
    h.goToEnd()
    await transport.drain()
    const shown = keysOf(v.last)
    edge.answer()
    await transport.settle()
    expect(keysOf(v.last)).toEqual(shown)
    v.unsubscribe()
  })

  it("dispose під час дочитування й повернення знімка — без запису", async () => {
    const rows = seedRows(200, 5)
    const { session, transport } = setupWindow(rows)
    const h = session.view(
      windowSpec([{ attribute: "rank", direction: "asc" }], 10)
    )
    const v = watch(h)
    await transport.drain()
    for (let i = 0; i < 8; i++) {
      h.loadAfter()
      await transport.drain()
    }
    const last = v.last.rows[v.last.rows.length - 1]!.key
    h.setVisibleRange(last, last)
    await transport.drain()
    transport.setAuto(false)
    const first = v.last.rows[0]!.key
    h.setVisibleRange(first, first)
    await transport.settle()
    expect(transport.calls.length).toBeGreaterThan(0)
    session.dispose()
    await transport.drain()
    expect(inspectCore(session).rows(TASK).size).toBe(0)
  })
})

describe("вивантаження далеких сторінок", () => {
  async function scrollTo(
    h: ReturnType<ReturnType<typeof setupWindow>["session"]["view"]>,
    transport: ReturnType<typeof setupWindow>["transport"],
    key: string
  ) {
    h.setVisibleRange(key, key)
    await transport.drain()
  }

  it("власні лише видимі ± запас; рядки сторінок, що вже були видимі, не зникають", async () => {
    const rows = seedRows(600, 9)
    const orderBy: OrderBy = [{ attribute: "rank", direction: "asc" }]
    const { session, transport } = setupWindow(rows)
    const h = session.view(windowSpec(orderBy, 10))
    const v = watch(h)
    await transport.drain()
    const all = serverOrder(rows, orderBy)
    // Вниз до кінця: сторінка за сторінкою, як прокрутка.
    for (let i = 0; i < all.length; i += 10)
      await scrollTo(h, transport, all[i]!)
    expect(keysOf(v.last)).toEqual(all)
    const pages = v.last.window!.pages
    expect(
      pages.filter((p) => p.tier === "resident").length
    ).toBeLessThanOrEqual(3)
    // Власність у сховищі обмежена запасом, а не прокрученим.
    expect(inspectCore(session).rows(TASK).size).toBeLessThanOrEqual(30)
    expect(inspectCore(session).violations()).toEqual([])
    // Назад до початку: у кожному кадрі склад і порядок ті самі.
    const from = v.frames.length
    for (let i = all.length - 1; i >= 0; i -= 10)
      await scrollTo(h, transport, all[i]!)
    for (const f of v.frames.slice(from)) expect(keysOf(f)).toEqual(all)
    expect(v.last.rows[0]!.status.state).toBe("synced")
    expect(v.last.rows[0]!.ghost).toBeUndefined()
    v.unsubscribe()
  })

  it("знімок показу — stale; повернення: зміна на сервері латається на місці, видалене — removed", async () => {
    const rows = seedRows(100, 2)
    const orderBy: OrderBy = [{ attribute: "rank", direction: "asc" }]
    const { session, transport, server } = setupWindow(rows)
    const h = session.view(windowSpec(orderBy, 10))
    const v = watch(h)
    await transport.drain()
    const all = serverOrder(rows, orderBy)
    for (let i = 0; i < all.length; i += 10)
      await scrollTo(h, transport, all[i]!)
    const g = v.last.rows[0]!
    expect(g.ghost).toBe(true)
    expect(g.status.state).toBe("stale")
    // Чужі зміни, поки сторінка — знімок: поле сортування й видалення.
    server.edit(TASK, all[0]!, { rank: 999, title: "moved" })
    server.remove(TASK, all[1]!)
    transport.setAuto(false)
    h.setVisibleRange(all[0]!, all[0]!)
    await transport.settle()
    // До відповіді — той самий знімок на тому самому місці.
    expect(keysOf(v.last)).toEqual(all)
    await transport.drain()
    expect(keysOf(v.last)).toEqual(all)
    const [a, b] = v.last.rows
    expect(a!.values.title).toBe("moved")
    expect(a!.status.state).toBe("synced")
    expect(b!.status.state).toBe("removed")
    v.unsubscribe()
  })

  it("межа байтів знімків: найдальші сторінки відкидаються з місцем, повернення дочитує ті самі ключі", async () => {
    const rows = seedRows(400, 4)
    const orderBy: OrderBy = [{ attribute: "rank", direction: "asc" }]
    const { session, transport } = setupWindow(rows, {
      window: { unloadDelayMs: 0, marginPages: 1, ghostBytes: 20_000 },
    })
    const h = session.view(windowSpec(orderBy, 10))
    const v = watch(h)
    await transport.drain()
    const all = serverOrder(rows, orderBy)
    for (let i = 0; i < all.length; i += 10)
      await scrollTo(h, transport, all[i]!)
    const w = v.last.window!
    expect(w.ghostBytes).toBeLessThanOrEqual(20_000)
    expect(w.atStart).toBe(false)
    expect(v.last.rows.length).toBeLessThan(all.length)
    expect(keysOf(v.last)).toEqual(all.slice(all.length - v.last.rows.length))
    // Назад до початку: край дочитується loadBefore, склад — той самий.
    for (let guard = 0; guard < 200 && !v.last.window!.atStart; guard++) {
      await scrollTo(h, transport, v.last.rows[0]!.key)
    }
    expect(keysOf(v.last).slice(0, 10)).toEqual(all.slice(0, 10))
    v.unsubscribe()
  })

  it("сторінка з незавершеною власною зміною не вивантажується (failed не зникає)", async () => {
    const rows = seedRows(200, 6)
    const orderBy: OrderBy = [{ attribute: "rank", direction: "asc" }]
    const { session, transport } = setupWindow(rows)
    const h = session.view(windowSpec(orderBy, 10))
    const v = watch(h)
    await transport.drain()
    const all = serverOrder(rows, orderBy)
    transport.setAuto(false)
    const m = session
      .begin({ policy: "predict" })
      .update(TASK, all[0]!, { title: "mine" })
      .commit()
    await transport.settle()
    transport.take().fail({ code: "command.forbidden" })
    await m.settled
    transport.setAuto(true)
    for (let i = 0; i < all.length; i += 10)
      await scrollTo(h, transport, all[i]!)
    const row = v.last.rows[0]!
    expect(row.ghost).toBeUndefined()
    expect(row.status.state).toBe("failed")
    expect(row.values.title).toBe("mine")
    v.unsubscribe()
  })

  it("purge прибирає рядок і з власних сторінок, і зі знімків показу", async () => {
    const rows = seedRows(200, 8)
    const orderBy: OrderBy = [{ attribute: "rank", direction: "asc" }]
    const { session, transport } = setupWindow(rows)
    const h = session.view(windowSpec(orderBy, 10))
    const v = watch(h)
    await transport.drain()
    const all = serverOrder(rows, orderBy)
    for (let i = 0; i < all.length; i += 10)
      await scrollTo(h, transport, all[i]!)
    const ghostKey = all[0]!
    const residentKey = all[all.length - 1]!
    session.commit(
      (w) => w.purge(TASK, [ghostKey, residentKey]),
      session.token()
    )
    expect(keysOf(v.last)).not.toContain(ghostKey)
    expect(keysOf(v.last)).not.toContain(residentKey)
    v.unsubscribe()
  })
})

describe("оновлення сторінки посередині", () => {
  it("рядки між сторінками не губляться: вставки на межах, видалення, переїзд", async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: id(i + 1),
      title: `t${i}`,
      rank: (i + 1) * 10,
      done: false,
    }))
    const orderBy: OrderBy = [{ attribute: "rank", direction: "asc" }]
    const { session, transport, server } = setupWindow(rows, {
      window: { unloadDelayMs: 0, marginPages: 3 },
    })
    const h = session.view(windowSpec(orderBy, 10))
    const v = watch(h)
    await transport.drain()
    for (let i = 0; i < 5; i++) {
      h.loadAfter()
      await transport.drain()
    }
    // Видимою стає третя сторінка (ранги 210..300).
    h.setVisibleRange(id(21), id(30))
    await transport.drain()
    // Між другою й третьою сторінкою (200 | 210), на межі третьої й
    // четвертої (300 | 310), видалення в третій, переїзд з першої в третю.
    server.seed(TASK, [
      { id: id(501), title: "between-2-3", rank: 205, done: false },
      { id: id(502), title: "between-3-4", rank: 305, done: false },
    ])
    server.remove(TASK, id(25))
    server.edit(TASK, id(3), { rank: 255 })
    h.refresh()
    await transport.drain()
    const shown = keysOf(v.last)
    const truth = serverOrder(
      [...server.tables.get(TASK)!].map(([k, r]) => ({
        id: k,
        ...(r.values as { title: string; rank: number; done: boolean }),
      })),
      orderBy
    )
    // Перші дві сторінки без змін (рядок 3 переїхав — його старе місце
    // звільнено), далі — суцільний відрізок серверного порядку після 200.
    expect(shown.slice(0, 19)).toEqual(
      Array.from({ length: 20 }, (_, i) => id(i + 1)).filter((k) => k !== id(3))
    )
    const tail = shown.slice(19)
    const at = truth.indexOf(tail[0]!)
    expect(tail).toEqual(truth.slice(at, at + tail.length))
    expect(tail).toContain(id(501))
    expect(tail).toContain(id(502))
    expect(tail).toContain(id(3))
    expect(tail).not.toContain(id(25))
    expect(new Set(shown).size).toBe(shown.length)
    v.unsubscribe()
  })
})

describe("правило стабільності у вікні", () => {
  it("сигнал і перечитування не змінюють складу й порядку", async () => {
    const rows = seedRows(100, 12)
    const orderBy: OrderBy = [{ attribute: "rank", direction: "asc" }]
    const { session, transport, server } = setupWindow(rows)
    const h = session.view(windowSpec(orderBy, 10))
    const v = watch(h)
    await transport.drain()
    h.loadAfter()
    await transport.drain()
    const shown = keysOf(v.last)
    const [a, b] = shown
    server.edit(TASK, a!, { rank: 9999 })
    server.remove(TASK, b!)
    server.seed(TASK, [{ id: id(900), title: "new", rank: -1, done: false }])
    await session.revalidate(TASK)
    await transport.drain()
    session.commit(
      (w) => w.markViews(TASK, { hasNewRows: true }),
      session.token()
    )
    expect(keysOf(v.last)).toEqual(shown)
    expect(v.last.rows[0]!.values.rank).toBe(9999)
    expect(v.last.rows[1]!.status.state).toBe("removed")
    expect(v.last.needsRefresh).toBe(true)
    expect(v.last.hasNewRows).toBe(true)
    v.unsubscribe()
  })
})
