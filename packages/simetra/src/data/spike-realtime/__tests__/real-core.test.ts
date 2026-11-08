import { describe, expect, it } from "vitest"
import {
  CommandFailure,
  type CommandResult,
  type Operation,
  type ReadQuery,
} from "simetra/model"
import { createCoreSession } from "../../store/core"
import { FakeServer } from "../../store/testing/fake-source"
import type { CoreSource, ObjectSpec, ViewSpec } from "../../store/types"
import { realCoreAdapter } from "../real-core-adapter"
import { createSignalReceiver } from "../receiver"
import { FakeChannel, OBJECT, TOPIC, settle, uuid } from "./support"

/**
 * Сценарії спайку 3 над справжнім ядром спайку 1 (`spike/t4-core`). Сервер —
 * фейк спайку 1; сигнал шле обгортка після кожного запису, як ядро команд.
 */

const TASK = "Catalog.Task"
const spec: ObjectSpec = {
  ref: { kind: "Catalog", name: "Task" },
  fields: { title: "string", rank: "number" },
}

function signalOf(op: string, id: string, version: number) {
  return {
    id: crypto.randomUUID(),
    object: OBJECT,
    op,
    keys: { id },
    row_ver: version,
  }
}

async function setup(rows = 300) {
  const server = new FakeServer([spec])
  server.seed(
    TASK,
    Array.from({ length: rows }, (_, i) => ({
      id: uuid(i + 1),
      title: `t-${String(i + 1).padStart(5, "0")}`,
      rank: i + 1,
    }))
  )
  const channel = new FakeChannel()
  const publish = (op: string, id: string, version: number) =>
    channel.publish(TOPIC, signalOf(op, id, version))
  let holdRun = false
  let loseRun = false
  const held: Array<() => void> = []
  let reads = 0
  let lagNext = 0
  const prevVersion = new Map<string, Record<string, unknown>>()
  const source: CoreSource = {
    async read(query: ReadQuery) {
      reads += 1
      await Promise.resolve()
      const res = server.read(query)
      if (lagNext > 0) {
        lagNext -= 1
        return {
          ...res,
          rows: res.rows.map((r) => prevVersion.get(r.id as string) ?? r),
        }
      }
      return res
    },
    run(operations: readonly Operation[]) {
      // Команда комітиться й шле сигнал одразу; відповідь тримає тест.
      let result: CommandResult
      try {
        result = server.run(operations)
      } catch (e) {
        return Promise.reject(e)
      }
      for (const ch of result.changes ?? [])
        publish(ch.operation, ch.id, ch.version)
      if (loseRun)
        return Promise.reject(
          new CommandFailure({ code: "command.unavailable" })
        )
      if (!holdRun) return Promise.resolve(result)
      return new Promise((resolve) => held.push(() => resolve(result)))
    },
  }
  const session = createCoreSession({
    subject: "user-1",
    source,
    objects: [spec],
    releaseDelayMs: 0,
  })
  const core = realCoreAdapter({
    session,
    objects: { [OBJECT]: { name: TASK, fields: spec.fields } },
  })
  const receiverSource = {
    readByKeys: async (_o: string, ids: readonly string[]) => {
      const res = await source.read(
        {
          object: spec.ref,
          where: { attribute: "id", op: "in", value: [...ids] },
          limit: ids.length,
        },
        session.signal
      )
      return res.rows.map((r) => r as { id: string; version: number })
    },
    readSubset: async () => ({ rows: [] }),
  }
  const receiver = createSignalReceiver({
    core,
    transport: channel,
    source: receiverSource,
    topics: [TOPIC],
    quietMs: 5,
    resyncDelayMs: () => 0,
  })
  const mount = async (viewSpec: ViewSpec) => {
    const handle = session.view(viewSpec)
    const frames = [handle.getSnapshot()]
    handle.subscribe(() => frames.push(handle.getSnapshot()))
    core.track(viewSpec, handle)
    for (let i = 0; i < 30; i++) await Promise.resolve()
    await settle(receiver)
    return { handle, frames }
  }
  const trace = (
    frames: readonly ReturnType<
      ReturnType<typeof session.view>["getSnapshot"]
    >[],
    key: string,
    field: string
  ) => {
    const out: unknown[] = []
    for (const f of frames) {
      const r = f.rows.find((x) => x.key === key)
      const v = r === undefined ? "<absent>" : r.values[field]
      if (f.status === "ready" && out.at(-1) !== v) out.push(v)
    }
    return out
  }
  const states = (
    frames: readonly ReturnType<
      ReturnType<typeof session.view>["getSnapshot"]
    >[],
    key: string
  ) => {
    const out: string[] = []
    for (const f of frames) {
      const v = f.rows.find((x) => x.key === key)?.status.state ?? "<absent>"
      if (f.status === "ready" && out.at(-1) !== v) out.push(v)
    }
    return out
  }
  return {
    server,
    channel,
    session,
    core,
    receiver,
    mount,
    trace,
    states,
    publish,
    get reads() {
      return reads
    },
    resetReads: () => (reads = 0),
    holdRuns: (on: boolean) => (holdRun = on),
    loseRuns: (on: boolean) => (loseRun = on),
    releaseRuns: () => held.splice(0).forEach((f) => f()),
    lag: (n: number) => (lagNext = n),
    remember: (id: string) => {
      const row = server.row(TASK, id)
      if (row) prevVersion.set(id, { id, version: row.version, ...row.values })
    },
  }
}

const card = (n: number): ViewSpec => ({
  kind: "card",
  object: TASK,
  key: uuid(n),
})
const list: ViewSpec = {
  kind: "window",
  object: TASK,
  orderBy: [{ attribute: "title", direction: "asc" }],
  pageSize: 100,
}

describe("справжнє ядро: сценарій 1 — сигнал власної команди раніше відповіді", () => {
  it.each(["predict", "await"] as const)(
    "політика %s: значення не відскакує, ехо розв'язується версією",
    async (policy) => {
      const t = await setup()
      const c = await t.mount(card(1))
      t.resetReads()
      t.holdRuns(true)
      const m = t.session
        .begin({ policy })
        .update(TASK, uuid(1), { title: "renamed" })
        .commit()
      await settle(t.receiver)
      t.releaseRuns()
      expect((await m.settled).ok).toBe(true)
      await settle(t.receiver)
      expect(t.trace(c.frames, uuid(1), "title")).toEqual([
        "t-00001",
        "renamed",
      ])
      expect(t.states(c.frames, uuid(1)).at(-1)).toBe("synced")
    }
  )
})

describe("справжнє ядро: сценарій 2 — чужа зміна поля, яке користувач редагує", () => {
  it("predict: показ — значення користувача до рішення; конфлікт зберігає зміну", async () => {
    const t = await setup()
    const c = await t.mount(card(2))
    // Чужа зміна комітиться раніше нашої команди.
    const v = t.server.edit(TASK, uuid(2), { title: "theirs" })
    t.channel.hold = true
    t.publish("update", uuid(2), v)
    const m = t.session
      .begin({ policy: "predict" })
      .update(TASK, uuid(2), { title: "mine" })
      .commit()
    t.channel.release()
    await settle(t.receiver)
    const out = await m.settled
    expect(out.ok).toBe(false)
    await settle(t.receiver)
    const row = c.handle.getSnapshot().rows[0]!
    expect(row.values.title).toBe("mine")
    expect(row.status.state).toBe("conflict")
    t.session.cancel(m.id)
    await settle(t.receiver)
    expect(t.trace(c.frames, uuid(2), "title")).toEqual([
      "t-00002",
      "mine",
      "theirs",
    ])
  })
})

describe("справжнє ядро: сценарій 3 — сплеск над відкритим списком", () => {
  it("1000 сигналів по ключах списку → один запит за ключами на пачку", async () => {
    const t = await setup(1_000)
    const l = await t.mount(list)
    expect(l.handle.getSnapshot().rows).toHaveLength(100)
    t.resetReads()
    for (let i = 0; i < 1_000; i++) {
      const id = uuid(1 + (i % 100))
      t.publish("update", id, t.server.edit(TASK, id, { rank: -i }))
      if (i % 10 === 9) await new Promise((r) => setTimeout(r, 1))
    }
    await new Promise((r) => setTimeout(r, 30))
    await settle(t.receiver)
    expect(t.receiver.stats.signals).toBe(1_000)
    expect(t.reads).toBeLessThanOrEqual(t.receiver.stats.batches)
    expect(l.handle.getSnapshot().rows.map((r) => r.key)).toEqual(
      l.frames.find((f) => f.status === "ready")!.rows.map((r) => r.key)
    )
  })
})

describe("справжнє ядро: сценарій 5 і доповнення", () => {
  it("видалення іншим, поки картка відкрита: removed на місці", async () => {
    const t = await setup()
    const c = await t.mount(card(9))
    const v = t.server.row(TASK, uuid(9))!.version
    t.server.remove(TASK, uuid(9))
    t.publish("delete", uuid(9), v)
    await settle(t.receiver)
    const row = c.handle.getSnapshot().rows[0]!
    expect(row.status.state).toBe("removed")
    expect(row.values.title).toBe("t-00009")
    expect(
      c.frames.filter((f) => f.status === "ready" && f.rows.length === 0)
    ).toHaveLength(0)
  })

  it("дубль і перестановка: значення лише вперед за версією", async () => {
    const t = await setup()
    const c = await t.mount(card(11))
    t.channel.hold = true
    const v2 = t.server.edit(TASK, uuid(11), { rank: 2 })
    t.publish("update", uuid(11), v2)
    const v3 = t.server.edit(TASK, uuid(11), { rank: 3 })
    t.publish("update", uuid(11), v3)
    t.channel.release([1, 0, 1])
    await settle(t.receiver)
    expect(t.trace(c.frames, uuid(11), "rank")).toEqual([11, 3])
  })

  it("репліка відстає: stale до очікуваної версії, без блимання на звичайному сигналі", async () => {
    const t = await setup()
    const c = await t.mount(card(12))
    t.remember(uuid(12))
    t.lag(1)
    t.publish("update", uuid(12), t.server.edit(TASK, uuid(12), { rank: 42 }))
    await settle(t.receiver)
    expect(t.states(c.frames, uuid(12))).toEqual(["synced", "stale", "synced"])
    expect(c.handle.getSnapshot().rows[0]!.values.rank).toBe(42)
    // Звичайний сигнал без відставання — без проміжного stale.
    const before = c.frames.length
    t.publish("update", uuid(12), t.server.edit(TASK, uuid(12), { rank: 43 }))
    await settle(t.receiver)
    expect(t.states(c.frames.slice(before), uuid(12))).toEqual(["synced"])
  })

  it("відповідь run втрачено: unknown розв'язує перечитування без мерехтіння", async () => {
    const t = await setup()
    const c = await t.mount(card(13))
    t.loseRuns(true)
    const m = t.session
      .begin({ policy: "predict" })
      .update(TASK, uuid(13), { title: "mine" })
      .commit()
    await settle(t.receiver)
    await m.settled
    await settle(t.receiver)
    expect(t.trace(c.frames, uuid(13), "title")).toEqual(["t-00013", "mine"])
    expect(c.handle.getSnapshot().rows[0]!.status.state).toBe("synced")
  })

  it("розрив: stale без приховування; після SUBSCRIBED рядок без змін лишається stale (прогалина ядра)", async () => {
    const t = await setup()
    const c = await t.mount(card(14))
    t.channel.drop()
    await settle(t.receiver)
    expect(c.handle.getSnapshot().rows[0]!.status.state).toBe("stale")
    t.channel.join()
    await settle(t.receiver)
    // Перечитування повернуло ту саму версію: `markStale` без `minVersion`
    // чекає версії +1, тож позначка не знімається. Вимога до ядра — у звіті.
    expect(c.handle.getSnapshot().rows[0]!.status.state).toBe("stale")
  })

  it("після dispose сигнал і перечитування нічого не пишуть", async () => {
    const t = await setup()
    const c = await t.mount(card(15))
    t.publish("update", uuid(15), t.server.edit(TASK, uuid(15), { rank: 99 }))
    t.receiver.dispose()
    t.session.dispose()
    const frames = c.frames.length
    await new Promise((r) => setTimeout(r, 20))
    expect(c.frames.length).toBe(frames)
    expect(t.channel.active).toBe(false)
  })
})
