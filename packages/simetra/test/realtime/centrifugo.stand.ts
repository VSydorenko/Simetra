import { writeFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import {
  createCommandRunner,
  type CommandResult,
} from "../../src/data/spike-realtime/commands"
import { FakeCore, type Row } from "../../src/data/spike-realtime/core"
import {
  createSignalReceiver,
  type ReceiverSource,
} from "../../src/data/spike-realtime/receiver"
import {
  recordFrames,
  settle,
} from "../../src/data/spike-realtime/__tests__/support"
import { centrifugoTransport } from "./centrifugo-transport"
import { OBJECT_ID, TOPIC, up, type ConsumerMode, type Stand } from "./stand"

/**
 * Стенд спайку 3, профіль `postgres`: команда пише рядок і outbox в одній
 * транзакції, вбудований PG-споживач Centrifugo публікує сигнал, приймач
 * перечитує за ключами. Затримка мережі — емуляція: RTT/2 на кожен перехід
 * клієнт ↔ сервер (`run`, перечитування) і сервер сигналів → клієнт.
 */

let stand: Stand
const sleep = (ms: number) =>
  ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve()
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

beforeAll(async () => {
  stand = await up()
  const values = Array.from(
    { length: 300 },
    (_, i) =>
      `('${uuid(i + 1)}', 'row-${String(i + 1).padStart(5, "0")}', ${i + 1})`
  )
  await stand.db.query(
    `insert into item (id, name, n) values ${values.join(",")}`
  )
})

afterAll(() => stand?.down())

const toRow = (r: {
  id: string
  name: string
  n: number
  version: string
}): Row => ({
  id: r.id,
  name: r.name,
  n: r.n,
  version: Number(r.version),
})

/** Команда як ядро T3: CAS за версією, рядок outbox у тій самій транзакції. */
async function command(
  mode: ConsumerMode,
  id: string,
  values: { name?: string; n?: number },
  expectedVersion?: number
): Promise<{ result: CommandResult; committedAt: number }> {
  const c = await stand.db.connect()
  try {
    await c.query("begin")
    const res = await c.query(
      `update item set name = coalesce($2, name), n = coalesce($3, n), version = version + 1
       where id = $1 and ($4::bigint is null or version = $4) returning *`,
      [id, values.name ?? null, values.n ?? null, expectedVersion ?? null]
    )
    if (res.rowCount === 0) {
      await c.query("rollback")
      return {
        result: { ok: false, code: "command.conflict" },
        committedAt: Date.now(),
      }
    }
    const row = toRow(res.rows[0])
    await c.query(
      `insert into outbox_${mode} (method, payload) values ('publish', jsonb_build_object(
         'channel', $1::text,
         'data', jsonb_build_object('id', gen_random_uuid(), 'object', $2::text, 'op', 'update',
                                    'keys', jsonb_build_object('id', $3::text), 'row_ver', $4::bigint)))`,
      [TOPIC, OBJECT_ID, id, row.version]
    )
    await c.query("commit")
    return { result: { ok: true, rows: [row] }, committedAt: Date.now() }
  } finally {
    c.release()
  }
}

function sqlSource(
  rttMs: number,
  stats?: { readMs: number[] }
): ReceiverSource {
  return {
    async readByKeys(_o, ids) {
      const t0 = Date.now()
      await sleep(rttMs / 2)
      const res = await stand.db.query(
        "select * from item where id = any($1::uuid[])",
        [[...ids]]
      )
      await sleep(rttMs / 2)
      stats?.readMs.push(Date.now() - t0)
      return res.rows.map(toRow)
    },
    async readSubset() {
      throw new Error("not used on the stand")
    },
  }
}

async function client(
  mode: ConsumerMode,
  rttMs: number,
  opts: { quietMs?: number; stats?: { readMs: number[] } } = {}
) {
  const core = new FakeCore()
  const source = sqlSource(rttMs, opts.stats)
  const transport = centrifugoTransport({
    url: stand.wsUrl(mode),
    websocket: WebSocket,
    downDelayMs: rttMs / 2,
  })
  const signals: number[] = []
  const tapped = {
    ...transport,
    subscribe: (
      ch: readonly string[],
      on: (t: string, p: unknown) => void,
      err: (k: "auth" | "transport") => void
    ) =>
      transport.subscribe(
        ch,
        (t, p) => {
          signals.push(Date.now())
          on(t, p)
        },
        err
      ),
  }
  let subscribed = 0
  transport.onSubscribed(() => (subscribed += 1))
  const receiver = createSignalReceiver({
    core,
    transport: tapped,
    source,
    topics: [TOPIC],
    quietMs: opts.quietMs ?? 50,
    resyncDelayMs: () => 0,
  })
  const until = Date.now() + 10_000
  while (subscribed === 0 && Date.now() < until) await sleep(20)
  expect(subscribed).toBeGreaterThan(0)
  await settle(receiver)
  return {
    core,
    source,
    transport,
    receiver,
    signals,
    close: () => (receiver.dispose(), core.dispose(), transport.close()),
  }
}

async function loadCard(c: Awaited<ReturnType<typeof client>>, id: string) {
  const view = c.core.view({ kind: "card", object: OBJECT_ID, id })
  const rows = await c.source.readByKeys(OBJECT_ID, [id])
  c.core.apply(
    { object: OBJECT_ID, rows, origin: "load", subset: { viewId: view.id } },
    c.core.generation()
  )
  return view
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN
}

describe("стенд Centrifugo: ланцюжок outbox → споживач → клієнт", () => {
  it.each(["notify", "poll"] as const)(
    "сигнал команди доходить (%s)",
    async (mode) => {
      const c = await client(mode, 0)
      const view = await loadCard(c, uuid(1))
      await command(mode, uuid(1), { n: 1_001 })
      const until = Date.now() + 5_000
      while (c.core.versionOf(OBJECT_ID, uuid(1))! < 2 && Date.now() < until)
        await sleep(10)
      expect(view.getSnapshot().rows[0]!.row.n).toBe(1_001)
      c.close()
    }
  )
})

const results: string[] = []

describe("вимір: підтвердження власної дії — відповідь run проти сигналу", () => {
  for (const mode of ["notify", "poll"] as const)
    for (const rtt of [0, 50, 150])
      it(`${mode}, +RTT ${rtt} мс`, async () => {
        const stats = { readMs: [] as number[] }
        const c = await client(mode, rtt, { stats })
        const ids = Array.from({ length: 30 }, (_, i) => uuid(100 + i))
        for (const id of ids) await loadCard(c, id)
        const a: number[] = []
        const b: number[] = []
        const commitToSignal: number[] = []
        for (const id of ids) {
          const want = (c.core.versionOf(OBJECT_ID, id) ?? 0) + 1
          const sent = Date.now()
          // (а): відправлення → відповідь (RTT/2 туди, транзакція, RTT/2 назад).
          await sleep(rtt / 2)
          const { committedAt } = await command(mode, id, {
            n: -sent % 100_000,
          })
          await sleep(rtt / 2)
          a.push(Date.now() - sent)
          // (б): відправлення → сигнал → перечитування → рядок у сховищі.
          // Відповідь `run` у сховище не пишеться: міряємо лише шлях сигналу.
          const before = c.signals.length
          const until = Date.now() + 5_000
          while (
            (c.core.versionOf(OBJECT_ID, id) ?? 0) < want &&
            Date.now() < until
          )
            await sleep(1)
          b.push(Date.now() - sent)
          const sig = c.signals[before]
          if (sig !== undefined)
            commitToSignal.push(sig - committedAt - rtt / 2)
        }
        results.push(
          `| ${mode} | ${rtt} | ${pct(a, 50)} | ${pct(a, 95)} | ${pct(b, 50)} | ${pct(b, 95)} | ${pct(commitToSignal, 50)} | ${pct(commitToSignal, 95)} | ${pct(stats.readMs, 50)} |`
        )
        expect(b.every((x) => x < 5_000)).toBe(true)
        c.close()
      })

  afterAll(() => {
    const out = process.env.STAND_OUT
    if (out === undefined) return
    writeFileSync(
      out,
      [
        "| споживач | +RTT | (а) p50 | (а) p95 | (б) p50 | (б) p95 | коміт→сигнал p50 | p95 | перечитування p50 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...results,
      ].join("\n") + "\n"
    )
  })
})

describe("стенд Centrifugo: сценарії 1, 2, 4", () => {
  it("сценарій 1: сигнал власної команди раніше відповіді run — без відскоку", async () => {
    const c = await client("notify", 50, { quietMs: 5 })
    const id = uuid(201)
    const view = await loadCard(c, id)
    const rec = recordFrames(c.core, { card: view })
    // Відповідь затримується (повільна мережа назад), сигнал її обганяє.
    const runner = createCommandRunner({
      core: c.core,
      reread: async (_o, key) =>
        (await c.source.readByKeys(OBJECT_ID, [key]))[0],
      send: async (op) => {
        const { result } = await command(
          "notify",
          op.id,
          op.action === "update" ? (op.values as { name: string }) : {},
          op.expectedVersion
        )
        await sleep(400)
        return result
      },
    })
    const tx = runner.update(OBJECT_ID, id, { name: "renamed" })
    const until = Date.now() + 5_000
    while (c.core.versionOf(OBJECT_ID, id)! < 2 && Date.now() < until)
      await sleep(5)
    const echoFirst = view.getSnapshot().rows[0]!
    expect(await tx.done).toBe("synced")
    await settle(c.receiver)
    expect(echoFirst.state).toBe("pending") // сигнал дійшов, відповіді ще немає
    expect(rec.trace("card", id, "name")).toEqual(["row-00201", "renamed"])
    expect(rec.states("card", id)).toEqual(["synced", "pending", "synced"])
    c.close()
  })

  it("сценарій 2: чужа зміна поля під pending — значення користувача до рішення", async () => {
    const c = await client("notify", 50, { quietMs: 5 })
    const id = uuid(202)
    const view = await loadCard(c, id)
    const rec = recordFrames(c.core, { card: view })
    const runner = createCommandRunner({
      core: c.core,
      reread: async (_o, key) =>
        (await c.source.readByKeys(OBJECT_ID, [key]))[0],
      send: async (op) => {
        await sleep(300) // наша команда повільна; чужа встигає раніше
        return (
          await command(
            "notify",
            op.id,
            op.action === "update" ? (op.values as { name: string }) : {},
            op.expectedVersion
          )
        ).result
      },
    })
    const tx = runner.update(OBJECT_ID, id, { name: "mine" })
    await command("notify", id, { name: "theirs" })
    expect(await tx.done).toBe("conflict")
    await settle(c.receiver)
    const row = view.getSnapshot().rows[0]!
    expect(row).toMatchObject({ state: "conflict", row: { name: "mine" } })
    expect(row.serverRow?.name).toBe("theirs")
    c.core.cancel(1)
    await sleep(0)
    expect(rec.trace("card", id, "name")).toEqual([
      "row-00202",
      "mine",
      "theirs",
    ])
    c.close()
  })

  it("сценарій 4а: короткий розрив, 50 змін — recovery Centrifugo, без перечитування підмножин", async () => {
    const c = await client("notify", 0, { quietMs: 5 })
    const ids = Array.from({ length: 50 }, (_, i) => uuid(220 + i))
    const views = ids.map((id) =>
      c.core.view({ kind: "card", object: OBJECT_ID, id })
    )
    const rows = await c.source.readByKeys(OBJECT_ID, ids)
    views.forEach((v) =>
      c.core.apply(
        { object: OBJECT_ID, rows, origin: "load", subset: { viewId: v.id } },
        c.core.generation()
      )
    )
    const rec = recordFrames(
      c.core,
      Object.fromEntries(views.map((v, i) => [String(i), v]))
    )
    const resyncsBefore = c.receiver.stats.resyncs
    c.transport.client.disconnect()
    await sleep(100)
    for (const id of ids) await command("notify", id, { n: 5_000 })
    await sleep(300) // споживач опублікував усе в історію каналу
    c.transport.client.connect()
    const until = Date.now() + 10_000
    while (
      ids.some((id) => (c.core.versionOf(OBJECT_ID, id) ?? 0) < 2) &&
      Date.now() < until
    )
      await sleep(20)
    await settle(c.receiver)
    expect(c.receiver.stats.recovered).toBe(1)
    expect(c.receiver.stats.resyncs).toBe(resyncsBefore)
    expect(ids.every((id) => c.core.versionOf(OBJECT_ID, id)! >= 2)).toBe(true)
    for (let i = 0; i < views.length; i++)
      expect(rec.emptyFrames(String(i))).toBe(0)
    c.close()
  })

  it("сценарій 4б: рестарт Centrifugo (нова епоха), 50 змін — recovered=false, перечитування підмножин", async () => {
    const c = await client("notify", 0, { quietMs: 5 })
    const ids = Array.from({ length: 50 }, (_, i) => uuid(150 + i))
    const views = ids.map((id) =>
      c.core.view({ kind: "card", object: OBJECT_ID, id })
    )
    const rows = await c.source.readByKeys(OBJECT_ID, ids)
    views.forEach((v) =>
      c.core.apply(
        { object: OBJECT_ID, rows, origin: "load", subset: { viewId: v.id } },
        c.core.generation()
      )
    )
    const rec = recordFrames(
      c.core,
      Object.fromEntries(views.map((v, i) => [String(i), v]))
    )
    const resyncsBefore = c.receiver.stats.resyncs
    const restarting = stand.restartCentrifugo("notify")
    // Зміни в проміжку: сигнали губляться (історія в пам'яті рестарту не переживає).
    for (const id of ids) await command("notify", id, { n: 6_000 })
    await restarting
    const until = Date.now() + 15_000
    while (
      ids.some((id) => (c.core.versionOf(OBJECT_ID, id) ?? 0) < 2) &&
      Date.now() < until
    )
      await sleep(50)
    await settle(c.receiver)
    expect(c.receiver.stats.resyncs).toBeGreaterThan(resyncsBefore)
    expect(
      ids.every(
        (id) => views[ids.indexOf(id)]!.getSnapshot().rows[0]!.row.n === 6_000
      )
    ).toBe(true)
    for (let i = 0; i < views.length; i++)
      expect(rec.emptyFrames(String(i))).toBe(0)
    c.close()
  })
})
