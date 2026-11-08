import { execSync } from "node:child_process"
import { RealtimeClient } from "@supabase/realtime-js"
import pg from "pg"
import { ZERO_UUID, channelTopic } from "simetra/model"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  createCommandRunner,
  type CommandResult,
} from "../../src/data/spike-realtime/commands"
import { FakeCore } from "../../src/data/spike-realtime/core"
import {
  createSignalReceiver,
  type SignalPort,
} from "../../src/data/spike-realtime/receiver"
import {
  FakeServer,
  OBJECT,
  recordFrames,
  settle,
  uuid,
} from "../../src/data/spike-realtime/__tests__/support"
import { runTag, testDatabaseUrl } from "../db/connection"

/**
 * Спайк 3, другий адаптер: справжній Supabase Realtime спільного стеку.
 * Публічний канал (без політик на `realtime.messages` спільного стеку), топік
 * з тегом прогону в сегменті скоупу; свої рядки `realtime.messages`
 * прибираються за топіком. Дані — сервер у пам'яті; сигнал шле
 * `realtime.send` з бази, як ядро команд.
 */

// Тег прогону `[0-9a-z]{6}` → 12 шістнадцяткових цифр сегмента скоупу.
const scope = `00000000-0000-4000-8000-${[...runTag()].map((c) => c.charCodeAt(0).toString(16)).join("")}`
const topic = channelTopic({
  kind: "changes",
  scopeKindId: ZERO_UUID,
  scope,
  object: OBJECT,
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

let db: pg.Client
let env: Record<string, string>

beforeAll(async () => {
  env = Object.fromEntries(
    execSync("./node_modules/.bin/supabase status -o env", {
      cwd: "../..",
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [
        l.slice(0, l.indexOf("=")),
        JSON.parse(l.slice(l.indexOf("=") + 1)) as string,
      ])
  )
  db = new pg.Client({ connectionString: testDatabaseUrl() })
  await db.connect()
})

afterAll(async () => {
  await db.query("delete from realtime.messages where topic = $1", [topic])
  await db.end()
})

function supabaseTransport(client: RealtimeClient): SignalPort {
  const subscribed = new Set<(info?: { recovered: boolean }) => void>()
  return {
    subscribe(channels, onSignal, onError) {
      const subs = channels.map((t) => {
        const ch = client.channel(t, { config: { private: false } })
        ch.on("broadcast", { event: "change" }, (m) => onSignal(t, m.payload))
        ch.subscribe((status) => {
          if (status === "SUBSCRIBED") for (const h of subscribed) h()
          else onError("transport")
        })
        return ch
      })
      return () => subs.forEach((ch) => void client.removeChannel(ch))
    },
    onSubscribed(handler) {
      subscribed.add(handler)
      return () => subscribed.delete(handler)
    },
  }
}

async function setup() {
  const server = new FakeServer()
  server.seed(100, (i) => ({ name: `row-${i}`, n: i }))
  // Сигнал сервера — справжній `realtime.send` у базу стеку.
  server.channels.push({
    publish: (_t: string, payload: unknown) =>
      void db.query("select realtime.send($1::jsonb, 'change', $2, false)", [
        JSON.stringify(payload),
        topic,
      ]),
  } as never)
  const client = new RealtimeClient(
    `${env.API_URL!.replace(/^http/, "ws")}/realtime/v1`,
    {
      params: { apikey: env.ANON_KEY! },
    }
  )
  const transport = supabaseTransport(client)
  let joins = 0
  transport.onSubscribed(() => (joins += 1))
  const core = new FakeCore()
  const source = server.source()
  const receiver = createSignalReceiver({
    core,
    transport,
    source,
    topics: [topic],
    quietMs: 5,
    resyncDelayMs: () => 0,
  })
  const until = Date.now() + 10_000
  while (joins === 0 && Date.now() < until) await sleep(20)
  return { server, client, core, source, receiver, joins: () => joins }
}

async function card(t: Awaited<ReturnType<typeof setup>>, id: string) {
  const view = t.core.view({ kind: "card", object: OBJECT, id })
  const rows = await t.source.readByKeys(OBJECT, [id])
  t.core.apply(
    { object: OBJECT, rows, origin: "load", subset: { viewId: view.id } },
    t.core.generation()
  )
  return view
}

const waitVersion = async (
  t: Awaited<ReturnType<typeof setup>>,
  id: string,
  v: number
) => {
  const until = Date.now() + 5_000
  while ((t.core.versionOf(OBJECT, id) ?? 0) < v && Date.now() < until)
    await sleep(5)
}

describe("Supabase Realtime спільного стеку (публічний канал з тегом)", () => {
  it("сценарій 1: сигнал власної команди раніше відповіді run — без відскоку", async () => {
    const t = await setup()
    const id = uuid(1)
    const view = await card(t, id)
    // Канал «теплий»: чужа зміна дійшла.
    t.server.write(uuid(2), { n: 0 })
    await sleep(300)
    const rec = recordFrames(t.core, { card: view })
    const runner = createCommandRunner({
      core: t.core,
      reread: async (_o, key) => (await t.source.readByKeys(OBJECT, [key]))[0],
      send: async (op) => {
        const { result } = t.server.run(op)
        await sleep(300) // відповідь повільна, сигнал її обганяє
        return result as CommandResult
      },
    })
    const tx = runner.update(OBJECT, id, { name: "renamed" })
    await waitVersion(t, id, 2)
    expect(view.getSnapshot().rows[0]!.state).toBe("pending")
    expect(await tx.done).toBe("synced")
    await settle(t.receiver)
    expect(rec.trace("card", id, "name")).toEqual(["row-1", "renamed"])
    expect(rec.states("card", id)).toEqual(["synced", "pending", "synced"])
    t.receiver.dispose()
    t.client.disconnect()
  })

  it("сценарій 2: чужа зміна поля під pending — значення користувача до рішення", async () => {
    const t = await setup()
    const id = uuid(3)
    const view = await card(t, id)
    const rec = recordFrames(t.core, { card: view })
    const runner = createCommandRunner({
      core: t.core,
      reread: async (_o, key) => (await t.source.readByKeys(OBJECT, [key]))[0],
      send: async (op) => {
        await sleep(300)
        return t.server.run(op).result
      },
    })
    const tx = runner.update(OBJECT, id, { name: "mine" })
    t.server.write(id, { name: "theirs" })
    expect(await tx.done).toBe("conflict")
    await settle(t.receiver)
    expect(view.getSnapshot().rows[0]).toMatchObject({
      state: "conflict",
      row: { name: "mine" },
    })
    t.core.cancel(tx.txId)
    await sleep(0)
    expect(rec.trace("card", id, "name")).toEqual(["row-3", "mine", "theirs"])
    t.receiver.dispose()
    t.client.disconnect()
  })

  it("сценарій 4: обрив сокета, 50 змін у проміжку — сигнали втрачено, перечитування на SUBSCRIBED", async () => {
    const t = await setup()
    const ids = Array.from({ length: 50 }, (_, i) => uuid(40 + i))
    const views = await Promise.all(ids.map((id) => card(t, id)))
    const rec = recordFrames(
      t.core,
      Object.fromEntries(views.map((v, i) => [String(i), v]))
    )
    const joinsBefore = t.joins()
    const signalsBefore = t.receiver.stats.signals
    const resyncsBefore = t.receiver.stats.resyncs
    t.client.disconnect()
    await sleep(200)
    for (const id of ids) t.server.write(id, { n: 7_000 })
    await sleep(300)
    t.client.connect()
    const until = Date.now() + 15_000
    while (t.joins() === joinsBefore && Date.now() < until) await sleep(50)
    await settle(t.receiver)
    expect(t.joins()).toBeGreaterThan(joinsBefore)
    // Realtime не буферизує: жоден із 50 сигналів проміжку не дійшов,
    // значення дало перечитування на SUBSCRIBED.
    expect(t.receiver.stats.signals).toBe(signalsBefore)
    expect(t.receiver.stats.resyncs).toBeGreaterThan(resyncsBefore)
    expect(views.every((v) => v.getSnapshot().rows[0]!.row.n === 7_000)).toBe(
      true
    )
    for (let i = 0; i < views.length; i++)
      expect(rec.emptyFrames(String(i))).toBe(0)
    t.receiver.dispose()
    t.client.disconnect()
  })
})
