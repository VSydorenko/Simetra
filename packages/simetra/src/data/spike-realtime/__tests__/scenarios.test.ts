import { describe, expect, it } from "vitest"
import {
  createCommandRunner,
  type CommandOp,
  type CommandResult,
} from "../commands"
import { FakeCore, type Row, type SubsetSpec } from "../core"
import { createSignalReceiver } from "../receiver"
import {
  FakeChannel,
  FakeServer,
  OBJECT,
  TOPIC,
  recordFrames,
  settle,
  uuid,
  type ServerOptions,
} from "./support"

/**
 * Сценарії спайку 3 для оракула (бриф, «Сценарії для оракула спайку 2») і
 * доповнення архітекторки. Кожен перевіряє кадри ядра: значення не
 * «відскакує», порожнього кадру немає, склад видимого списку без дії
 * користувача не змінюється.
 */

const byName = (a: Row, b: Row) => String(a.name).localeCompare(String(b.name))
const all = () => true

async function setup(
  options: ServerOptions & {
    rows?: number
    page?: number
    card?: string
    full?: boolean
    quietMs?: number
    maxWaitMs?: number
  } = {}
) {
  const server = new FakeServer(options)
  server.seed(options.rows ?? 300, (i) => ({
    name: `row-${String(i).padStart(5, "0")}`,
    n: i,
  }))
  const channel = new FakeChannel()
  server.channels.push(channel)
  const core = new FakeCore()
  const pageSize = options.page ?? 100
  const source = server.source((rows) => rows.sort(byName).slice(0, pageSize))
  const token = core.generation()
  // Перше завантаження — як фасад: сторінка, потім вид над її ключами.
  const first = await source.readSubset({
    kind: "window",
    object: OBJECT,
    predicate: all,
    keys: [],
  })
  const list = core.view({
    kind: "window",
    object: OBJECT,
    predicate: all,
    keys: first.keys ?? [],
  })
  core.apply(
    {
      object: OBJECT,
      rows: first.rows,
      origin: "load",
      subset: { viewId: list.id, keys: first.keys },
    },
    token
  )
  const views: Record<string, ReturnType<FakeCore["view"]>> = { list }
  if (options.full) {
    const spec: SubsetSpec = {
      kind: "full",
      object: OBJECT,
      predicate: all,
      compare: byName,
    }
    const res = await source.readSubset(spec)
    core.apply({ object: OBJECT, rows: res.rows, origin: "load" }, token)
    views.full = core.view(spec)
  }
  if (options.card) {
    views.card = core.view({ kind: "card", object: OBJECT, id: options.card })
    const rows = await source.readByKeys(OBJECT, [options.card])
    core.apply(
      {
        object: OBJECT,
        rows,
        origin: "load",
        subset: { viewId: views.card.id },
      },
      token
    )
  }
  server.reads = []
  const receiver = createSignalReceiver({
    core,
    transport: channel,
    source,
    topics: [TOPIC],
    quietMs: options.quietMs ?? 5,
    maxWaitMs: options.maxWaitMs ?? 2_000,
    resyncDelayMs: () => 0,
  })
  // Відповіді `run` тримає тест: так задається порядок «сигнал раніше відповіді».
  const held: Array<() => void> = []
  let holdRun = false
  const runner = createCommandRunner({
    core,
    reread: async (_o, id) => (await source.readByKeys(OBJECT, [id]))[0],
    send: (op: CommandOp) =>
      new Promise<CommandResult>((resolve) => {
        const { result } = server.run(op)
        if (holdRun) held.push(() => resolve(result))
        else resolve(result)
      }),
  })
  await Promise.resolve()
  const rec = recordFrames(core, views)
  return {
    server,
    channel,
    core,
    source,
    receiver,
    runner,
    views,
    rec,
    holdRuns: (on: boolean) => (holdRun = on),
    releaseRuns: () => held.splice(0).forEach((f) => f()),
  }
}

describe("сценарій 1: сигнал власної команди раніше відповіді run", () => {
  it("значення не відскакує, стан pending → synced, відлуння не перечитується вдруге", async () => {
    const t = await setup()
    const id = uuid(1)
    t.holdRuns(true)
    const { done } = t.runner.update(OBJECT, id, { name: "renamed" })
    await settle(t.receiver) // сигнал дійшов і перечитаний, відповіді ще немає
    expect(t.server.reads.length).toBe(1)
    t.releaseRuns()
    expect(await done).toBe("synced")
    await settle(t.receiver)
    expect(t.rec.trace("list", id, "name")).toEqual(["row-00001", "renamed"])
    expect(t.rec.states("list", id)).toEqual(["synced", "pending", "synced"])
    expect(t.rec.emptyFrames("list")).toBe(0)
    expect(t.rec.orderChanges("list")).toBe(0)
  })

  it("відповідь раніше сигналу: сигнал — відлуння, перечитування немає", async () => {
    const t = await setup()
    const id = uuid(1)
    t.channel.hold = true
    expect(await t.runner.update(OBJECT, id, { name: "renamed" }).done).toBe(
      "synced"
    )
    t.channel.release()
    await settle(t.receiver)
    expect(t.server.reads.length).toBe(0)
    expect(t.rec.trace("list", id, "name")).toEqual(["row-00001", "renamed"])
  })
})

describe("сценарій 2: сигнал чужої зміни поля, яке користувач редагує", () => {
  it("показ лишається значенням користувача до його рішення; конфлікт — з серверним рядком", async () => {
    const t = await setup({ card: uuid(2) })
    const id = uuid(2)
    // Чужа зміна комітиться першою; наша команда піде з базою v1 і отримає конфлікт.
    t.holdRuns(true)
    t.channel.hold = true
    const mine = t.runner.update(OBJECT, id, { name: "mine" })
    t.server.write(id, { name: "theirs" })
    t.channel.release()
    await settle(t.receiver)
    t.releaseRuns()
    expect(await mine.done).toBe("conflict")
    await settle(t.receiver)
    const card = t.views.card!.getSnapshot().rows[0]!
    expect(card.state).toBe("conflict")
    expect(card.row.name).toBe("mine")
    expect(card.serverRow?.name).toBe("theirs")
    // Явна дія користувача «прийняти серверне» — лише тоді значення змінюється.
    t.core.cancel(mine.txId)
    await settle(t.receiver)
    expect(t.rec.trace("card", id, "name")).toEqual([
      "row-00002",
      "mine",
      "theirs",
    ])
    expect(t.rec.emptyFrames("card")).toBe(0)
  })

  it("чужа зміна іншого поля під pending: обидва значення видно, без відскоку", async () => {
    const t = await setup({ card: uuid(3) })
    const id = uuid(3)
    t.holdRuns(true)
    const mine = t.runner.update(OBJECT, id, { name: "mine" })
    // Сервер виконав нашу команду (v2), а потім чужу зміну `n` (v3).
    await new Promise((r) => setTimeout(r, 0))
    t.server.write(id, { n: 999 })
    await settle(t.receiver)
    t.releaseRuns()
    expect(await mine.done).toBe("synced")
    await settle(t.receiver)
    const card = t.views.card!.getSnapshot().rows[0]!
    expect(card).toMatchObject({
      state: "synced",
      row: { name: "mine", n: 999 },
    })
    expect(t.rec.trace("card", id, "name")).toEqual(["row-00003", "mine"])
    expect(t.rec.trace("card", id, "n")).toEqual([3, 999])
  })
})

describe("сценарій 3: сплеск 1000 сигналів за секунду над відкритим списком", () => {
  it("розкидані ключі: запитів ≤ N активних підмножин за вікно пачки", async () => {
    // N = 2: вікно (100 рядків) і картка. Вікно пачки maxWait = 2 с ≥ сплеску.
    const t = await setup({ rows: 5_000, card: uuid(7), quietMs: 50 })
    const started = Date.now()
    for (let i = 0; i < 1_000; i++) {
      t.server.write(uuid(1 + ((i * 37) % 5_000)), { n: -i })
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 10))
    }
    const burstMs = Date.now() - started
    await settle(t.receiver)
    await new Promise((r) => setTimeout(r, 80))
    await settle(t.receiver)
    expect(burstMs).toBeLessThan(2_000)
    expect(t.receiver.stats.signals).toBe(1_000)
    expect(t.receiver.stats.batches).toBe(1)
    expect(t.server.reads.length).toBeLessThanOrEqual(2)
    expect(t.rec.orderChanges("list")).toBe(0)
    expect(t.rec.emptyFrames("list")).toBe(0)
  })

  it("гарячі ключі списку: один запит за ключами на пачку", async () => {
    const t = await setup({ rows: 1_000, quietMs: 50 })
    for (let i = 0; i < 1_000; i++) {
      t.server.write(uuid(1 + (i % 100)), { n: -i })
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 10))
    }
    await new Promise((r) => setTimeout(r, 80))
    await settle(t.receiver)
    expect(t.receiver.stats.batches).toBe(1)
    expect(t.server.reads).toEqual([{ kind: "keys", size: 100 }])
    // Значення останні: кожен рядок показує останню записану версію.
    const shown = t.views
      .list!.getSnapshot()
      .rows.find((r) => r.id === uuid(100))!
    expect(shown.row.n).toBe(-999)
  })
})

describe("сценарій 4: розрив і відновлення з 50 пропущеними змінами", () => {
  it("stale без приховування, одне перечитування на видиму підмножину, без порожнього кадру й стрибка", async () => {
    const t = await setup({ card: uuid(5) })
    t.channel.join()
    await settle(t.receiver)
    t.server.reads = []
    t.channel.drop()
    await settle(t.receiver)
    expect(t.views.list!.getSnapshot().stale).toBe(true)
    expect(t.views.list!.getSnapshot().rows).toHaveLength(100)
    // 50 змін, поки зв'язку немає: 45 оновлень, 3 видалення, 2 нові рядки на початку сортування.
    for (let i = 1; i <= 45; i++) t.server.write(uuid(i), { n: 1_000 + i })
    for (const i of [46, 47, 48]) t.server.remove(uuid(i))
    t.server.write(uuid(9_001), { name: "a-new-1", n: 0 })
    t.server.write(uuid(9_002), { name: "a-new-2", n: 0 })
    expect(t.channel.lost).toBe(50)
    t.channel.join()
    await settle(t.receiver)
    const list = t.views.list!.getSnapshot()
    expect(list.stale).toBe(false)
    expect(list.hasNewRows).toBe(true)
    expect(list.rows.find((r) => r.id === uuid(10))!.row.n).toBe(1_010)
    expect(
      list.rows.filter((r) => r.state === "removed").map((r) => r.id)
    ).toEqual([uuid(46), uuid(47), uuid(48)])
    // Перечитування: сторінка вікна + дочитування ключів, що випали, + картка.
    expect(t.server.reads.length).toBeLessThanOrEqual(3)
    expect(t.rec.emptyFrames("list")).toBe(0)
    expect(t.rec.orderChanges("list")).toBe(0)
    // Дія користувача перебудовує список.
    t.views.list!.showNew()
    await Promise.resolve()
    expect(
      t.views.list!.getSnapshot().rows.some((r) => r.state === "removed")
    ).toBe(false)
  })

  it("заміна вмісту атомарна: між stale і відновленим кадром немає проміжних кадрів списку", async () => {
    const t = await setup()
    t.channel.drop()
    await Promise.resolve() // кадр stale записано
    for (let i = 1; i <= 50; i++) t.server.write(uuid(i), { n: -i })
    const before = t.rec.frames.length
    t.channel.join()
    await settle(t.receiver)
    const listFrames = t.rec.frames.slice(before).map((f) => f.list)
    const distinct = new Set(listFrames)
    // stale-кадр уже був; після join — рівно один новий знімок списку.
    expect(distinct.size).toBe(1)
    expect(
      listFrames
        .at(-1)!
        .rows.every(
          (r) =>
            r.row.n === -Number.parseInt(r.id.slice(-4), 16) ||
            Number.parseInt(r.id.slice(-4), 16) > 50
        )
    ).toBe(true)
  })
})

describe("сценарій 5: видалення рядка іншим користувачем, поки картка відкрита", () => {
  it("картка показує останній рядок зі станом removed, без порожнього кадру", async () => {
    const t = await setup({ card: uuid(9) })
    t.server.remove(uuid(9))
    await settle(t.receiver)
    const card = t.views.card!.getSnapshot()
    expect(card.rows[0]).toMatchObject({
      state: "removed",
      row: { name: "row-00009" },
    })
    expect(t.rec.emptyFrames("card")).toBe(0)
    // У списку — на місці, стан removed.
    expect(t.views.list!.getSnapshot().rows[8]).toMatchObject({
      id: uuid(9),
      state: "removed",
    })
  })

  it("власне видалення: pending на місці, зникає лише після підтвердження", async () => {
    const t = await setup()
    t.holdRuns(true)
    const del = t.runner.delete(OBJECT, uuid(4))
    await settle(t.receiver) // ехо видалення прийшло раніше відповіді
    expect(t.views.list!.getSnapshot().rows[3]).toMatchObject({
      id: uuid(4),
      state: "pending",
    })
    t.releaseRuns()
    expect(await del.done).toBe("synced")
    await settle(t.receiver)
    expect(t.views.list!.getSnapshot().rows.some((r) => r.id === uuid(4))).toBe(
      false
    )
    expect(t.rec.states("list", uuid(4))).toEqual([
      "synced",
      "pending",
      "<absent>",
    ])
  })
})

describe("доповнення: дубль, перестановка, репліка, повторне створення", () => {
  it("дубль і перестановка сигналів: значення лише вперед за версією", async () => {
    const t = await setup()
    const id = uuid(11)
    t.channel.hold = true
    t.server.write(id, { n: 2 })
    t.server.write(id, { n: 3 })
    // Порядок доставки: v3, v2, дубль v3.
    t.channel.release([1, 0, 1])
    await settle(t.receiver)
    expect(t.receiver.stats.duplicates).toBe(1)
    expect(t.rec.trace("list", id, "n")).toEqual([11, 3])
    expect(t.server.reads.length).toBe(1)
  })

  it("перечитування з репліки старше за сигнал: ключ stale, доки версія не наздожене", async () => {
    const t = await setup()
    const id = uuid(12)
    t.server.lagReads = 1
    t.server.write(id, { n: 42 })
    await settle(t.receiver)
    expect(t.rec.states("list", id)).toEqual(["synced", "stale", "synced"])
    const end = t.views.list!.getSnapshot().rows.find((r) => r.id === id)!
    expect(end).toMatchObject({ state: "synced", row: { n: 42 } })
    expect(t.rec.trace("list", id, "n")).toEqual([12, 42])
  })

  it("репліка не наздогнала за ліміт спроб: рядок лишається stale, а не synced", async () => {
    const t = await setup()
    const id = uuid(13)
    t.server.lagReads = 100
    t.server.write(id, { n: 42 })
    await settle(t.receiver, 10)
    expect(
      t.views.list!.getSnapshot().rows.find((r) => r.id === id)!.state
    ).toBe("stale")
  })

  it("видалення й повторне створення того самого ключа: потрібна монотонна версія сервера", async () => {
    // Версія з 1 на кожне створення: нове створення (v1) старше за бачену v1→v2 —
    // ядро за Рд24 його не покаже. Доказ вимоги до сервера.
    for (const versioning of ["row", "sequence"] as const) {
      const t = await setup({ versioning, card: uuid(14) })
      const id = uuid(14)
      t.server.write(id, { n: 1 }) // v2 (row) чи v(n) (sequence)
      await settle(t.receiver)
      t.server.remove(id)
      await settle(t.receiver)
      t.server.write(id, { name: "reborn", n: 7 })
      await settle(t.receiver)
      // Картка відкрита: її оновлення — дія користувача (наприклад, повторне відкриття).
      t.channel.join()
      await settle(t.receiver)
      const card = t.views.card!.getSnapshot().rows[0]!
      if (versioning === "sequence")
        expect(card).toMatchObject({ state: "synced", row: { name: "reborn" } })
      else expect(card.row.name).not.toBe("reborn")
    }
  })
})

describe("резервний шлях: відповідь run втрачено", () => {
  it("unknown розв'язує сигнал із перечитуванням, без мерехтіння", async () => {
    const server = new FakeServer()
    server.seed(5, (i) => ({ name: `r${i}`, n: i }))
    const channel = new FakeChannel()
    server.channels.push(channel)
    const core = new FakeCore()
    const source = server.source()
    const receiver = createSignalReceiver({
      core,
      transport: channel,
      source,
      topics: [TOPIC],
      quietMs: 1,
      resyncDelayMs: () => 0,
    })
    let offline = true
    const runner = createCommandRunner({
      core,
      timeoutMs: 10,
      // Команда комітиться, а відповідь губиться в мережі.
      send: (op) => {
        server.run(op)
        return new Promise<CommandResult>(() => {})
      },
      reread: async (_o, id) => {
        if (offline) throw new Error("offline")
        return (await source.readByKeys(OBJECT, [id]))[0]
      },
    })
    const rows = await source.readByKeys(OBJECT, [uuid(1)])
    const card = core.view({ kind: "card", object: OBJECT, id: uuid(1) })
    core.apply(
      { object: OBJECT, rows, origin: "load", subset: { viewId: card.id } },
      core.generation()
    )
    const rec = recordFrames(core, { card })
    // Сигнал теж притримано, доки клієнт «офлайн»; приходить після тайм-ауту.
    channel.hold = true
    const tx = runner.update(OBJECT, uuid(1), { name: "mine" })
    expect(await tx.done).toBe("unknown")
    offline = false
    channel.release()
    await settle(receiver)
    expect(rec.trace("card", uuid(1), "name")).toEqual(["r1", "mine"])
    expect(rec.states("card", uuid(1))).toEqual([
      "synced",
      "pending",
      "unknown",
      "synced",
    ])
  })
})

describe("доповнення: втрата доступу, dispose, вихід в іншій вкладці", () => {
  it("втрата доступу без сигналу по рядку: дані прибираються негайно, перечитування в польоті не воскрешає", async () => {
    const t = await setup()
    t.server.readDelayMs = 20
    const lost = (row: Row) => (row.n as number) <= 10
    t.server.write(uuid(1), { n: 1 })
    await new Promise((r) => setTimeout(r, 8)) // перечитування в польоті
    t.server.visible = (row) => !lost(row)
    t.core.purge((_o, row) => lost(row), t.core.generation())
    await settle(t.receiver)
    const rows = t.views.list!.getSnapshot().rows
    expect(rows.some((r) => lost(r.row))).toBe(false)
    expect(rows).toHaveLength(90)
  })

  it("після dispose сигнал і перечитування нічого не пишуть", async () => {
    const t = await setup()
    t.server.readDelayMs = 20
    t.server.write(uuid(1), { n: 100 })
    await new Promise((r) => setTimeout(r, 8))
    const reads = t.server.reads.length
    t.receiver.dispose()
    t.core.dispose()
    await new Promise((r) => setTimeout(r, 40))
    t.server.write(uuid(2), { n: 200 })
    await new Promise((r) => setTimeout(r, 40))
    expect(t.channel.active).toBe(false)
    expect(t.server.reads.length).toBe(reads)
    expect(t.core.versionOf(OBJECT, uuid(1))).toBeUndefined()
    expect(t.core.activeSubsets()).toHaveLength(0)
  })

  it("вихід в одній вкладці: інша закриває ядро й приймач, пізні відповіді нікуди не йдуть", async () => {
    const server = new FakeServer()
    server.seed(10, (i) => ({ name: `r${i}`, n: i }))
    const bus = new EventTarget() // замість BroadcastChannel у тесті
    const tabs = [0, 1].map(() => {
      const channel = new FakeChannel()
      server.channels.push(channel)
      const core = new FakeCore()
      const source = server.source()
      const receiver = createSignalReceiver({
        core,
        transport: channel,
        source,
        topics: [TOPIC],
        quietMs: 1,
        resyncDelayMs: () => 0,
      })
      bus.addEventListener("logout", () => {
        receiver.dispose()
        core.dispose()
      })
      return { channel, core, source, receiver }
    })
    const b = tabs[1]!
    const rows = await b.source.readByKeys(OBJECT, [uuid(1)])
    const card = b.core.view({ kind: "card", object: OBJECT, id: uuid(1) })
    b.core.apply(
      { object: OBJECT, rows, origin: "load", subset: { viewId: card.id } },
      b.core.generation()
    )
    server.readDelayMs = 10
    server.write(uuid(1), { n: 77 })
    await new Promise((r) => setTimeout(r, 5))
    bus.dispatchEvent(new Event("logout"))
    await new Promise((r) => setTimeout(r, 30))
    expect(b.core.closed).toBe(true)
    expect(b.core.versionOf(OBJECT, uuid(1))).toBeUndefined()
    expect(tabs.every((tab) => !tab.channel.active)).toBe(true)
  })
})

describe("кілька вкладок одного користувача", () => {
  it("зміна у вкладці A доходить до B через сигнал без проміжних значень", async () => {
    const server = new FakeServer()
    server.seed(10, (i) => ({ name: `r${i}`, n: i }))
    const tabs = [0, 1].map(() => {
      const channel = new FakeChannel()
      server.channels.push(channel)
      const core = new FakeCore()
      const source = server.source()
      const receiver = createSignalReceiver({
        core,
        transport: channel,
        source,
        topics: [TOPIC],
        quietMs: 1,
        resyncDelayMs: () => 0,
      })
      const runner = createCommandRunner({
        core,
        reread: async (_o, id) => (await source.readByKeys(OBJECT, [id]))[0],
        send: async (op) => server.run(op).result,
      })
      return { core, source, receiver, runner }
    })
    for (const tab of tabs) {
      const rows = await tab.source.readByKeys(OBJECT, [uuid(1)])
      const v = tab.core.view({ kind: "card", object: OBJECT, id: uuid(1) })
      tab.core.apply(
        { object: OBJECT, rows, origin: "load", subset: { viewId: v.id } },
        tab.core.generation()
      )
    }
    const [a, b] = tabs as [(typeof tabs)[0], (typeof tabs)[0]]
    const rec = recordFrames(b.core, {
      card: b.core.view({ kind: "card", object: OBJECT, id: uuid(1) }),
    })
    expect(
      await a.runner.update(OBJECT, uuid(1), { name: "from-a" }).done
    ).toBe("synced")
    await settle(b.receiver)
    expect(rec.trace("card", uuid(1), "name")).toEqual(["r1", "from-a"])
    expect(rec.states("card", uuid(1))).toEqual(["synced"])
  })
})
