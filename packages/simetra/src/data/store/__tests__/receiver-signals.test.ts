import {
  READ_BATCH_MAX,
  channelTopic,
  jsonBytes,
  type CatalogEntry,
  type RightsRow,
} from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SCOPE_KIND_ID,
  catalogEntry,
} from "../../../model/runtime/__tests__/entries"
import { coreInternals } from "../core"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import { MAX_BATCH_MS, QUIET_MS, SEEN_SIGNALS_MAX } from "../receiver"
import { DISCARDS_MAX } from "../session"
import type { CoreLimits, Key, ViewSpec, Writer } from "../types"
import {
  TASK,
  key,
  keysOf,
  org,
  S,
  seed,
  settle,
  setup,
  task,
  taskValues,
} from "./core-support"

/*
 * Приймач сигналів: розбір, пачка й кроки 1–7 §8.4 (план B5b-3, задача 3).
 * Фейковий канал і справжнє ядро над фейковим сервером; кожен кейс рахує
 * запити сервера, а не виклики внутрішніх функцій.
 */

const USER = "00000000-0000-4000-8000-0000000000a1"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const read: RightsRow = {
  level: "scope",
  levelId: null,
  scope: S,
  container: null,
  object: "task",
  action: "read",
  extent: "any",
  dimensionId: null,
}

const channel = channelTopic({
  kind: "changes",
  scopeKindId: SCOPE_KIND_ID,
  scope: S,
  object: task.id,
})

const keysView = (...keys: Key[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys,
})

const S2 = "00000000-0000-4000-8000-0000000000b2"
const channelOf = (scope: string) =>
  channelTopic({
    kind: "changes",
    scopeKindId: SCOPE_KIND_ID,
    scope,
    object: task.id,
  })

function harness(
  server?: NonNullable<Parameters<typeof setup>[0]>["server"],
  scopes: readonly string[] = [S],
  limits?: Partial<CoreLimits>
) {
  const transport = createFakeSignalTransport()
  const h = setup({
    rightsSnapshot: true,
    signals: transport,
    ...(server === undefined ? {} : { server }),
    ...(limits === undefined ? {} : { limits }),
  })
  h.fake.rightsSnapshot = {
    userId: USER,
    scopeSets: scopes.map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
    rights: scopes.map((scope) => ({ ...read, scope })),
    members: [],
    dimensionValues: [],
  }
  h.fake.rightsVersion = "1".repeat(64)
  return { ...h, transport }
}
type Harness = ReturnType<typeof harness>

let seq = 0
const change = (
  op: "create" | "update" | "markDeletion" | "delete",
  k: Key,
  rowVer: number,
  id = String(++seq)
) => ({ id, object: task.id, op, keys: { id: k }, row_ver: rowVer })

/** Сигнал каналу змін; пачка закривається після тиші `QUIET_MS`. */
const emit = (h: Harness, payload: unknown, topic = channel) =>
  h.transport.emit(topic, payload)

/** Дає пачці закритись і відповідям осісти. */
const closeBatch = async () => {
  await vi.advanceTimersByTimeAsync(QUIET_MS)
  await settle()
}

const requestsSince = (h: Harness, from: number) => h.fake.requests.slice(from)

/** Відкриті на мить виклику читання ключів (запити пачки). */
const keyReadsSince = (h: Harness, from: number) =>
  h.fake.log.filter((r) => r.request >= from && keysOf(r.query).length > 0)

async function open(
  spec: ViewSpec,
  rows = 3,
  server?: Parameters<typeof harness>[0],
  scopes?: readonly string[],
  before?: (fake: Harness["fake"]) => void,
  limits?: Partial<CoreLimits>
) {
  const h = harness(server, scopes, limits)
  seed(h.fake, 1, rows)
  before?.(h.fake)
  const subscribe = vi.spyOn(h.transport, "subscribe")
  const handle = h.core.view(spec)
  const unsubscribe = handle.subscribe(() => {})
  await settle()
  expect(h.transport.subscribed().has(channel)).toBe(true)
  // Прямий виклик обробника: фейк доставляє сигнал лише підписникам каналу.
  const deliver = (topic: string, payload: unknown) =>
    subscribe.mock.calls[0]![1](topic, payload)
  return { ...h, handle, unsubscribe, deliver, from: h.fake.requests.length }
}

describe("signals of the change channel: echo, dedup and batch", () => {
  it("re-reads a changed key once, with its signal batched after QUIET_MS of silence", async () => {
    const h = await open(keysView(key(1), key(2)))
    const version = h.fake.edit(TASK, key(1), { title: "new" })
    emit(h, change("update", key(1), version))
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    expect(requestsSince(h, h.from)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(requestsSince(h, h.from)).toHaveLength(1)
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({
      values: { title: "new" },
    })
  })

  it("drops an echo: a stored version not below row_ver costs no request", async () => {
    const h = await open(keysView(key(1)))
    const stored = h.fake.row(TASK, key(1))!.version
    emit(h, change("update", key(1), stored))
    emit(h, change("update", key(1), stored - 1))
    await closeBatch()
    expect(requestsSince(h, h.from)).toHaveLength(0)
  })

  it("drops the echo of an own delete: a key not in the store costs no request", async () => {
    const h = await open(keysView(key(1)))
    emit(h, change("delete", key(9), 5))
    await closeBatch()
    expect(requestsSince(h, h.from)).toHaveLength(0)
  })

  it("re-reads a foreign delete although its version is below the stored one, and marks removed only on an empty answer", async () => {
    const h = await open(keysView(key(1), key(2)))
    const stored = h.fake.row(TASK, key(1))!.version
    // Серверу рядок ще віддається: `delete` нічого не прибирає.
    emit(h, change("delete", key(1), stored - 1))
    await closeBatch()
    expect(requestsSince(h, h.from)).toHaveLength(1)
    expect(h.handle.getSnapshot().rows[0]!.state).not.toBe("removed")
    // Тепер сервер справді видалив рядок.
    h.fake.remove(TASK, key(1))
    const from = h.fake.requests.length
    emit(h, change("delete", key(1), stored))
    await closeBatch()
    expect(requestsSince(h, from)).toHaveLength(1)
    expect(h.handle.getSnapshot().rows[0]!.state).toBe("removed")
    expect(h.handle.getSnapshot().rows[1]!.state).not.toBe("removed")
  })

  it("reads a duplicate id once, and at most one extra request once the id left the window", async () => {
    const h = await open(keysView(key(1)))
    // Новий ключ у сховище не пишеться, тож лише `id` відрізняє дублікат.
    const created = h.fake.insert(TASK, taskValues(50))
    emit(h, change("create", key(50), created, "1000"))
    await closeBatch()
    emit(h, change("create", key(50), created, "1000"))
    await closeBatch()
    expect(keyReadsSince(h, h.from)).toHaveLength(1)
    // Вікно дедуплікації витісняє «1000» новішими `id` (відлуння запиту не дають).
    const stored = h.fake.row(TASK, key(1))!.version
    for (let i = 0; i < SEEN_SIGNALS_MAX; i++)
      emit(h, change("update", key(1), stored, String(2000 + i)))
    await closeBatch()
    const from = h.fake.requests.length
    emit(h, change("create", key(50), created, "1000"))
    await closeBatch()
    expect(requestsSince(h, from)).toHaveLength(1)
  })

  it("takes a burst of 1000 signals over the longest window as one request per view per batch, composition and order intact", async () => {
    const h = await open(keysView(key(1), key(2), key(3)))
    const before = h.handle.getSnapshot().rows.map((r) => r.key)
    const burst = 1000
    const step = 3
    for (let i = 0; i < burst; i++) {
      const k = key(1 + (i % 3))
      emit(h, change("update", k, h.fake.edit(TASK, k, { title: `t${i}` })))
      await vi.advanceTimersByTimeAsync(step)
    }
    await closeBatch()
    const batches = Math.ceil((burst * step) / MAX_BATCH_MS) + 1
    const requests = requestsSince(h, h.from)
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests.length).toBeLessThanOrEqual(batches)
    // Один запит несе один вигляд: ключі вигляду читаються однією частиною.
    for (const parts of requests) expect(parts).toBe(1)
    expect(h.handle.getSnapshot().rows.map((r) => r.key)).toEqual(before)
  })

  it("closes a batch no later than MAX_BATCH_MS from its first signal while signals keep coming", async () => {
    const h = await open(keysView(key(1)))
    for (let elapsed = 0; elapsed < MAX_BATCH_MS - QUIET_MS; elapsed += 40) {
      const version = h.fake.edit(TASK, key(1), { title: `t${elapsed}` })
      emit(h, change("update", key(1), version))
      await vi.advanceTimersByTimeAsync(40)
    }
    expect(requestsSince(h, h.from)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(QUIET_MS + 40)
    await settle()
    expect(requestsSince(h, h.from)).toHaveLength(1)
  })
})

describe("budget: keys and objects of one batch", () => {
  // Ключі, яких у сховищі немає, — крок 5: усі йдуть у читання за ключами.
  const burstOfNewKeys = async (count: number) => {
    const h = await open(keysView(key(1)))
    for (let n = 100; n < 100 + count; n++) {
      const v = h.fake.insert(TASK, taskValues(n))
      emit(h, change("create", key(n), v))
    }
    await closeBatch()
    return h
  }

  it("reads 200 keys of one object by keys in one request", async () => {
    const h = await burstOfNewKeys(200)
    expect(requestsSince(h, h.from)).toHaveLength(1)
    expect(
      keyReadsSince(h, h.from).flatMap((r) => keysOf(r.query))
    ).toHaveLength(200)
  })

  it("reads 201 keys as a revalidate of the visible views and marks the invisible ones needsRefresh, in one request", async () => {
    const h = await open(keysView(key(1)))
    // Невидимий вигляд: утримується без слухача.
    const hidden = h.core.view({ kind: "full", object: TASK })
    void hidden
    await h.core.preload({ kind: "full", object: TASK })
    await settle()
    const from = h.fake.requests.length
    for (let n = 100; n < 301; n++) {
      const v = h.fake.insert(TASK, taskValues(n))
      emit(h, change("create", key(n), v))
    }
    await closeBatch()
    expect(requestsSince(h, from)).toHaveLength(1)
    // Ключів у запиті немає: читався вигляд, а не 201 ключ.
    expect(
      keyReadsSince(h, from).flatMap((r) => keysOf(r.query)).length
    ).toBeLessThanOrEqual(1)
    expect(
      h.core.view({ kind: "full", object: TASK }).getSnapshot()
    ).toMatchObject({
      needsRefresh: true,
    })
    expect(h.handle.getSnapshot().needsRefresh).toBe(false)
  })

  it("reads the keys of 16 objects in one request and of 17 in two", async () => {
    const run = async (count: number) => {
      const entries: CatalogEntry[] = Array.from({ length: count }, (_, i) => {
        const entry = catalogEntry({
          id: `00000000-0000-4000-8000-${String(5000 + i).padStart(12, "0")}`,
          name: `Obj${i}`,
          kindLabel: `obj${i}`,
          table: { schema: "public", name: `obj${i}` },
          tabularSections: [],
        })
        return entry
      })
      const transport = createFakeSignalTransport()
      const h = setup({
        rightsSnapshot: true,
        signals: transport,
        objects: [org, ...entries],
      })
      h.fake.rightsSnapshot = {
        userId: USER,
        scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
        rights: entries.map((e) => ({ ...read, object: e.kindLabel })),
        members: [],
        dimensionValues: [],
      }
      h.fake.rightsVersion = "1".repeat(64)
      for (const e of entries) {
        h.fake.insert(`Catalog.${e.name}`, taskValues(1))
        h.core
          .view({
            kind: "keys",
            object: `Catalog.${e.name}`,
            keys: [key(1)],
          })
          .subscribe(() => {})
      }
      await settle()
      const from = h.fake.requests.length
      for (const e of entries) {
        const v = h.fake.insert(`Catalog.${e.name}`, taskValues(2))
        transport.emit(
          channelTopic({
            kind: "changes",
            scopeKindId: SCOPE_KIND_ID,
            scope: S,
            object: e.id,
          }),
          {
            id: String(++seq),
            object: e.id,
            op: "create",
            keys: { id: key(2) },
            row_ver: v,
          }
        )
      }
      await vi.advanceTimersByTimeAsync(QUIET_MS)
      await settle()
      return h.fake.requests.slice(from)
    }
    expect(await run(READ_BATCH_MAX)).toHaveLength(1)
    expect(await run(READ_BATCH_MAX + 1)).toHaveLength(2)
  })

  it("keeps the bytes of a batch within 1.1 x useful + 2 KiB", async () => {
    const h = await open(keysView(key(1), key(2), key(3)), 3)
    for (const n of [1, 2, 3]) {
      const v = h.fake.edit(TASK, key(n), { title: `changed ${n}` })
      emit(h, change("update", key(n), v))
    }
    await closeBatch()
    const reads = h.fake.log.filter((r) => r.request >= h.from)
    expect(reads.length).toBeGreaterThan(0)
    const response = reads.reduce((sum, r) => sum + jsonBytes(r.response), 0)
    const useful = [1, 2, 3].reduce(
      (sum, n) => sum + jsonBytes(h.fake.row(TASK, key(n))!.values),
      0
    )
    expect(response).toBeLessThanOrEqual(1.1 * useful + 2048)
  })
})

describe("expected minimum version, new keys, sections and invalidate", () => {
  it("marks stale and re-reads three times with pauses of 500, 1000 and 2000 ms when the answer is below row_ver", async () => {
    const h = await open(keysView(key(1)))
    const served = h.fake.edit(TASK, key(1), { title: "v" })
    emit(h, change("update", key(1), served + 1))
    await closeBatch()
    expect(requestsSince(h, h.from)).toHaveLength(1)
    expect(h.handle.getSnapshot().rows[0]!.state).toBe("stale")
    for (const [pause, total] of [
      [500, 2],
      [1000, 3],
      [2000, 4],
    ] as const) {
      await vi.advanceTimersByTimeAsync(pause - 1)
      expect(requestsSince(h, h.from)).toHaveLength(total - 1)
      await vi.advanceTimersByTimeAsync(1)
      await settle()
      expect(requestsSince(h, h.from)).toHaveLength(total)
    }
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(requestsSince(h, h.from)).toHaveLength(4)
    expect(h.handle.getSnapshot().rows[0]!.state).toBe("stale")
  })

  it("stops re-reading once a read confirms the version", async () => {
    const h = await open(keysView(key(1)))
    const served = h.fake.edit(TASK, key(1), { title: "v" })
    emit(h, change("update", key(1), served + 1))
    await closeBatch()
    h.fake.edit(TASK, key(1), { title: "v2" })
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(requestsSince(h, h.from)).toHaveLength(2)
    expect(h.handle.getSnapshot().rows[0]!.state).not.toBe("stale")
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(requestsSince(h, h.from)).toHaveLength(2)
  })

  it("does not mark stale on an ordinary re-read", async () => {
    const h = await open(keysView(key(1)))
    const v = h.fake.edit(TASK, key(1), { title: "v" })
    emit(h, change("update", key(1), v))
    await closeBatch()
    expect(h.handle.getSnapshot().rows[0]!.state).not.toBe("stale")
    await vi.advanceTimersByTimeAsync(10_000)
    expect(requestsSince(h, h.from)).toHaveLength(1)
  })

  it("never writes a new key to the store and marks hasNewRows only on the view whose filter it passes", async () => {
    const h = await open(keysView(key(1)))
    const match = h.core.view({
      kind: "full",
      object: TASK,
      where: { attribute: "title", op: "eq", value: "fresh" },
    })
    const other = h.core.view({
      kind: "full",
      object: TASK,
      where: { attribute: "title", op: "eq", value: "nope" },
    })
    match.subscribe(() => {})
    other.subscribe(() => {})
    await settle()
    const rowsBefore = h.inspect.rowCount()
    const v = h.fake.insert(TASK, taskValues(77, { title: "fresh" }))
    emit(h, change("create", key(77), v))
    await closeBatch()
    expect(match.getSnapshot().hasNewRows).toBe(true)
    expect(other.getSnapshot().hasNewRows).toBe(false)
    expect(h.handle.getSnapshot().hasNewRows).toBe(false)
    expect(h.inspect.rowCount()).toBe(rowsBefore)
  })

  // Ключ, похований з початку читання (`purge` ключа), не «новий», як і
  // похована пара: `hasNewRows` виказав би рядок, який сховище прибрало.
  it("does not mark hasNewRows for a new key purged while its signal read is in flight", async () => {
    const h = await open(keysView(key(1)))
    const list = h.core.view({ kind: "full", object: TASK })
    list.subscribe(() => {})
    await settle()
    expect(list.getSnapshot().hasNewRows).toBe(false)
    h.fake.mode = "manual"
    const v = h.fake.insert(TASK, taskValues(78))
    emit(h, change("create", key(78), v))
    await closeBatch()
    expect(h.fake.pending).toHaveLength(1)
    h.core.commit((w) => w.purge(TASK, { keys: [key(78)] }), h.core.token())
    h.fake.mode = "auto"
    h.fake.deliverAll()
    await settle()
    expect(list.getSnapshot().hasNewRows).toBe(false)
  })

  it("re-reads the section of a mounted owner when the header version grows", async () => {
    const h = await open(keysView(key(1)))
    const lines = [{ ref: key(900), qty: 1, lineNumber: 1 }]
    h.fake.setLines(TASK, key(1), "lines", lines)
    const section = h.core.view({
      kind: "section",
      object: TASK,
      owner: key(1),
      section: "lines",
    })
    section.subscribe(() => {})
    await settle()
    const from = h.fake.requests.length
    const next = [{ ref: key(901), qty: 2, lineNumber: 1 }]
    const version = h.fake.setLines(TASK, key(1), "lines", next)
    emit(h, change("update", key(1), version))
    await closeBatch()
    const requests = requestsSince(h, from)
    // Шапка й ТЧ — один запит із двома частинами.
    expect(requests).toEqual([2])
    expect(JSON.stringify(section.getSnapshot().section?.lines)).toContain(
      key(901)
    )
  })

  it("on invalidate re-reads the visible views of the object in one request and marks the invisible ones needsRefresh", async () => {
    const h = await open(keysView(key(1)))
    await h.core.preload({ kind: "full", object: TASK })
    const lines = [{ ref: key(900), qty: 1, lineNumber: 1 }]
    h.fake.setLines(TASK, key(1), "lines", lines)
    h.core
      .view({ kind: "section", object: TASK, owner: key(1), section: "lines" })
      .subscribe(() => {})
    await settle()
    const from = h.fake.requests.length
    emit(h, {
      id: String(++seq),
      object: task.id,
      op: "invalidate",
    })
    await closeBatch()
    expect(requestsSince(h, from)).toHaveLength(1)
    expect(
      h.core.view({ kind: "full", object: TASK }).getSnapshot()
    ).toMatchObject({
      needsRefresh: true,
    })
  })
})

// §8.4: `needsRefresh`, поставлений механізмом свіжості невидимому вигляду,
// означає «склад не підтверджено» — перехід у видимість читає вигляд рівно
// раз. Той самий прапор з іншої причини (банер нових рядків, §6.5) лишається
// за `refresh()` користувача.
describe("a view marked needsRefresh while invisible", () => {
  const full: ViewSpec = { kind: "full", object: TASK }
  const invisibleFull = async () => {
    const h = await open(keysView(key(1)))
    const handle = h.core.view(full)
    handle.subscribe(() => {})
    h.core.setVisible(full, false)
    await settle()
    return { ...h, handle }
  }

  it("reads once on becoming visible after the receiver marked it", async () => {
    const h = await invisibleFull()
    emit(h, { id: String(++seq), object: task.id, op: "invalidate" })
    await closeBatch()
    expect(h.handle.getSnapshot().needsRefresh).toBe(true)
    const from = h.fake.requests.length
    h.core.setVisible(full, true)
    await settle()
    expect(requestsSince(h, from)).toHaveLength(1)
    h.core.setVisible(full, false)
    h.core.setVisible(full, true)
    await settle()
    expect(requestsSince(h, from)).toHaveLength(1)
  })

  // Вимога одна для всіх виглядів об'єкта: хвіст, якого не взято, бо вигляд
  // тим часом сховали, її не знімає.
  it("keeps the requirement of a view visible at the invalidate that turns invisible before its tail", async () => {
    const h = await open(full)
    h.fake.mode = "manual"
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(h.fake.pending).toHaveLength(1)
    emit(h, { id: String(++seq), object: task.id, op: "invalidate" })
    await closeBatch()
    // Вигляд у польоті: лише хвіст.
    expect(h.fake.pending).toHaveLength(1)
    expect(h.handle.getSnapshot().needsRefresh).toBe(false)
    h.core.setVisible(full, false)
    h.fake.mode = "auto"
    const from = h.fake.requests.length
    h.fake.take(0).answer()
    await settle()
    expect(requestsSince(h, from)).toHaveLength(0)
    expect(h.handle.getSnapshot().needsRefresh).toBe(true)
    h.core.setVisible(full, true)
    await settle()
    expect(requestsSince(h, from)).toHaveLength(1)
    expect(h.handle.getSnapshot().needsRefresh).toBe(false)
  })

  it("does not read again on a second transition while the read that lifts the requirement is in flight", async () => {
    const h = await invisibleFull()
    emit(h, { id: String(++seq), object: task.id, op: "invalidate" })
    await closeBatch()
    h.fake.mode = "manual"
    const from = h.fake.requests.length
    h.core.setVisible(full, true)
    await settle()
    h.core.setVisible(full, false)
    h.core.setVisible(full, true)
    await settle()
    expect(h.fake.pending).toHaveLength(1)
    h.fake.mode = "auto"
    h.fake.deliverAll()
    await settle()
    expect(requestsSince(h, from)).toHaveLength(1)
    expect(h.handle.getSnapshot().needsRefresh).toBe(false)
  })

  it("keeps the requirement over a page read: a page confirms only itself", async () => {
    const window: ViewSpec = { kind: "window", object: TASK }
    const h = await open(window, 5, undefined, undefined, undefined, {
      windowPage: 2,
    })
    h.core.setVisible(window, false)
    emit(h, { id: String(++seq), object: task.id, op: "invalidate" })
    await closeBatch()
    expect(h.handle.getSnapshot().needsRefresh).toBe(true)
    const from = h.fake.requests.length
    h.handle.loadAfter()
    await settle()
    expect(requestsSince(h, from)).toHaveLength(1)
    expect(h.handle.getSnapshot().needsRefresh).toBe(true)
    h.core.setVisible(window, true)
    await settle()
    expect(requestsSince(h, from)).toHaveLength(2)
    expect(h.handle.getSnapshot().needsRefresh).toBe(false)
  })

  it("does not read on becoming visible for needsRefresh of another reason", async () => {
    const h = await invisibleFull()
    h.core.commit(
      (w) => w.markViews(TASK, { needsRefresh: true }, full),
      h.core.token()
    )
    const from = h.fake.requests.length
    h.core.setVisible(full, true)
    await settle()
    expect(requestsSince(h, from)).toHaveLength(0)
    expect(h.handle.getSnapshot().needsRefresh).toBe(true)
  })
})

describe("forward compatibility and topics", () => {
  const invalidated = async (payload: unknown, topic = channel) => {
    const h = await open(keysView(key(1)))
    emit(h, payload, topic)
    await closeBatch()
    return requestsSince(h, h.from).length
  }

  it("treats an unknown op as invalidate of the topic object", async () => {
    expect(
      await invalidated({ ...change("update", key(1), 1), op: "teleport" })
    ).toBe(1)
  })

  it("treats an extra field as invalidate", async () => {
    expect(
      await invalidated({ ...change("update", key(1), 1), extra: 1 })
    ).toBe(1)
  })

  it("treats an unparsable message of a change channel as invalidate, not as a drop", async () => {
    expect(await invalidated("garbage")).toBe(1)
  })

  it("takes a payload for another object as invalidate of the topic object, before judging that object", async () => {
    const other = "00000000-0000-4000-8000-0000000000ff"
    expect(
      await invalidated({ ...change("update", key(1), 1), object: other })
    ).toBe(1)
  })

  it("ignores a channel that is not a change channel and a change topic outside the subscriptions: 0 requests", async () => {
    const h = await open(keysView(key(1)))
    h.deliver(`simetra-user:${USER}`, { id: "5", op: "rights" })
    h.deliver(
      channelTopic({
        kind: "changes",
        scopeKindId: SCOPE_KIND_ID,
        scope: "00000000-0000-4000-8000-0000000000e1",
        object: task.id,
      }),
      change("create", key(60), 9)
    )
    h.deliver("not-a-topic", change("create", key(61), 9))
    await closeBatch()
    expect(requestsSince(h, h.from)).toHaveLength(0)
  })
})

describe("flow control", () => {
  it("merges the batches closed while a read is in flight into one request after it settles", async () => {
    const h = await open(keysView(key(1)))
    h.fake.mode = "manual"
    const v1 = h.fake.edit(TASK, key(1), { title: "a" })
    emit(h, change("update", key(1), v1))
    await closeBatch()
    expect(h.fake.pending).toHaveLength(1)
    // Нові ключі: відповідь у польоті їх не покриває, тож відлунням вони не є.
    for (let i = 0; i < 3; i++) {
      const v = h.fake.insert(TASK, taskValues(60 + i))
      emit(h, change("create", key(60 + i), v))
      await closeBatch()
    }
    await vi.advanceTimersByTimeAsync(5000)
    expect(requestsSince(h, h.from)).toHaveLength(1)
    h.fake.mode = "auto"
    h.fake.deliverAll()
    await settle()
    expect(requestsSince(h, h.from)).toHaveLength(2)
    expect(
      keyReadsSince(h, h.from).at(-1)!.query &&
        keysOf(keyReadsSince(h, h.from).at(-1)!.query)
    ).toHaveLength(3)
  })

  it("writes the key answer of one object without waiting for the whole re-read of another object of the batch", async () => {
    // Два об'єкти одного скоупу: у пачці — ключ першого й `invalidate` другого.
    // Повний вигляд другого читається сторінками по одному рядку, тож його
    // перечитування триває довше за перший запит пачки.
    const entries = [0, 1].map((i) =>
      catalogEntry({
        id: `00000000-0000-4000-8000-${String(6000 + i).padStart(12, "0")}`,
        name: `Pair${i}`,
        kindLabel: `pair${i}`,
        table: { schema: "public", name: `pair${i}` },
        tabularSections: [],
      })
    )
    const [first, second] = entries as [CatalogEntry, CatalogEntry]
    const transport = createFakeSignalTransport()
    const h = setup({
      rightsSnapshot: true,
      signals: transport,
      objects: [org, ...entries],
      limits: { fullPageSize: 1 },
    })
    h.fake.rightsSnapshot = {
      userId: USER,
      scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
      rights: entries.map((e) => ({ ...read, object: e.kindLabel })),
      members: [],
      dimensionValues: [],
    }
    h.fake.rightsVersion = "1".repeat(64)
    const A = `Catalog.${first.name}`
    const B = `Catalog.${second.name}`
    h.fake.insert(A, taskValues(1))
    h.fake.insert(B, taskValues(1))
    h.fake.insert(B, taskValues(2))
    const view = h.core.view({ kind: "keys", object: A, keys: [key(1)] })
    view.subscribe(() => {})
    h.core.view({ kind: "full", object: B }).subscribe(() => {})
    await settle()
    const topic = (e: CatalogEntry) =>
      channelTopic({
        kind: "changes",
        scopeKindId: SCOPE_KIND_ID,
        scope: S,
        object: e.id,
      })
    h.fake.mode = "manual"
    const v = h.fake.edit(A, key(1), { title: "fresh" })
    transport.emit(topic(first), {
      id: String(++seq),
      object: first.id,
      op: "update",
      keys: { id: key(1) },
      row_ver: v,
    })
    transport.emit(topic(second), {
      id: String(++seq),
      object: second.id,
      op: "invalidate",
    })
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    // Перший запит пачки: ключ першого й перша сторінка другого.
    while (h.fake.pending.length > 0) h.fake.take().answer()
    await settle()
    // Наступна сторінка другого об'єкта ще в польоті.
    expect(h.fake.pending.some((r) => r.object === B)).toBe(true)
    expect(view.getSnapshot().rows[0]).toMatchObject({
      values: { title: "fresh" },
    })
    h.fake.mode = "auto"
    h.fake.deliverAll()
    await settle()
  })

  it("sends nothing on a hidden tab, marks needsRefresh and reads once on resume()", async () => {
    const h = await open(keysView(key(1)))
    h.core.suspend()
    const v = h.fake.edit(TASK, key(1), { title: "hidden" })
    emit(h, change("update", key(1), v))
    await closeBatch()
    await vi.advanceTimersByTimeAsync(5000)
    expect(requestsSince(h, h.from)).toHaveLength(0)
    expect(h.handle.getSnapshot().needsRefresh).toBe(true)
    h.core.resume()
    await settle()
    expect(requestsSince(h, h.from)).toHaveLength(1)
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({
      values: { title: "hidden" },
    })
  })

  // §8.4, п. 7 і §12 (Р8): вимога, що лишилась після читання, яке летіло,
  // коли вкладку сховали, — гілка невидимого вигляду: на прихованій вкладці
  // 0 запитів і `needsRefresh`, на `resume()` — одне читання, що її знімає.
  it.each(["system re-read", "first load"] as const)(
    "a %s in flight when a hidden-tab batch raised the requirement: nothing on the hidden tab, one read on resume()",
    async (what) => {
      const h = await open(keysView(key(3)))
      h.fake.mode = "manual"
      const view =
        what === "first load" ? h.core.view(keysView(key(1), key(2))) : h.handle
      if (what === "first load") view.subscribe(() => {})
      else void h.core.revalidate(TASK, { visibleOnly: true })
      await settle()
      expect(h.fake.pending).toHaveLength(1)
      h.core.suspend()
      const v = h.fake.edit(TASK, key(3), { title: "hidden" })
      emit(h, change("update", key(3), v))
      await closeBatch()
      const from = h.fake.requests.length
      h.fake.mode = "auto"
      h.fake.deliverAll()
      await vi.advanceTimersByTimeAsync(5000)
      await settle()
      expect(requestsSince(h, from)).toHaveLength(0)
      expect(view.getSnapshot().needsRefresh).toBe(true)
      expect(view.getSnapshot().staleComposition).toBe(true)
      h.core.resume()
      await settle()
      expect(requestsSince(h, from)).toHaveLength(1)
      expect(view.getSnapshot().staleComposition).toBeUndefined()
      // `needsRefresh` прихованої вкладки — вивід із вимоги: те саме
      // читання знімає обидва.
      expect(view.getSnapshot().needsRefresh).toBe(false)
    }
  )

  it("writes and sends nothing after dispose of the session", async () => {
    const h = await open(keysView(key(1)))
    const v = h.fake.edit(TASK, key(1), { title: "late" })
    emit(h, change("update", key(1), v))
    h.core.close("disposed")
    await closeBatch()
    // Прямий виклик обробника: закритий фейк нікому нічого не доставляє.
    h.deliver(channel, change("update", key(1), v + 1))
    h.deliver(channel, change("create", key(40), 9))
    await closeBatch()
    expect(requestsSince(h, h.from)).toHaveLength(0)
    expect(h.log.filter((e) => e.kind === "late-response")).toEqual([])
    expect(h.inspect.rowCount()).toBe(0)
  })
})

describe("purge of a pair", () => {
  const purge = (h: Awaited<ReturnType<typeof open>>, scope: string) =>
    h.core.commit((w) => w.purge(TASK, { scope }), h.core.token())
  const twoScopes = async (limits?: Partial<CoreLimits>) => {
    // Рядки на сервері вже до монтування: `hasNewRows` починається з `false`.
    const h = await open(
      { kind: "full", object: TASK },
      0,
      undefined,
      [S, S2],
      (fake) => {
        fake.insert(TASK, taskValues(1))
        fake.insert(TASK, taskValues(2, { org: S2 }))
      },
      limits
    )
    return { ...h, from: h.fake.requests.length }
  }

  it("drops the unclosed batch of the pair, and still reads a key of another pair of the object", async () => {
    const h = await twoScopes()
    const v1 = h.fake.insert(TASK, taskValues(10))
    const v2 = h.fake.insert(TASK, taskValues(11, { org: S2 }))
    emit(h, change("create", key(10), v1), channelOf(S))
    emit(h, change("create", key(11), v2), channelOf(S2))
    expect(purge(h, S)).toBe(true)
    await closeBatch()
    const keys = keyReadsSince(h, h.from).flatMap((r) => keysOf(r.query))
    expect(keys).toEqual([key(11)])
  })

  it("drops the batch waiting behind a read in flight", async () => {
    const h = await twoScopes()
    h.fake.mode = "manual"
    const v12 = h.fake.insert(TASK, taskValues(12))
    emit(h, change("create", key(12), v12), channelOf(S))
    await closeBatch()
    const v13 = h.fake.insert(TASK, taskValues(13))
    emit(h, change("create", key(13), v13), channelOf(S))
    await closeBatch()
    purge(h, S)
    h.fake.mode = "auto"
    h.fake.deliverAll()
    await settle()
    const keys = keyReadsSince(h, h.from).flatMap((r) => keysOf(r.query))
    expect(keys).toEqual([key(12)])
    // Ключ 13 пари S не записано й не підказано як новий.
    expect(h.handle.getSnapshot().hasNewRows).toBe(false)
    expect(h.handle.getSnapshot().rows.map((r) => r.key)).not.toContain(key(13))
  })

  it("drops a min-version re-read waiting out its pause: 0 requests after the purge", async () => {
    const h = await twoScopes()
    const served = h.fake.edit(TASK, key(1), { title: "v" })
    emit(h, change("update", key(1), served + 1), channelOf(S))
    await closeBatch()
    const sent = h.fake.requests.length
    purge(h, S)
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(h.fake.requests.length).toBe(sent)
  })

  // Відповідь, що стартувала до purge, лягає, коли вигляд уже знову тримає
  // ключ з новішого читання: правило «0 записів і 0 запитів після purge»
  // стосується й кроку 4 (мінімальна версія), не лише запису рядка.
  // Спільний хід: відповідь на сигнал з версією, якої сервер не має, стартує
  // до `disturb` і лягає після нього.
  const lateMinVersionAnswer = async (
    limits: Partial<CoreLimits> | undefined,
    disturb: (purge: (t: Parameters<Writer["purge"]>[1]) => void) => void
  ) => {
    const h = await twoScopes(limits)
    const served = h.fake.edit(TASK, key(1), { title: "v" })
    h.fake.mode = "manual"
    emit(h, change("update", key(1), served + 1), channelOf(S))
    await closeBatch()
    const old = h.fake.take(
      (r) => keysOf(r.query).length > 0 && keysOf(r.query)[0] === key(1)
    )
    disturb((t) => h.core.commit((w) => w.purge(TASK, t), h.core.token()))
    h.handle.refresh()
    await settle()
    h.fake.deliverAll()
    await settle()
    expect(h.handle.getSnapshot().rows.map((r) => r.key)).toContain(key(1))
    const sent = h.fake.requests.length
    old.answer()
    await settle()
    // Читання, поставлене відповіддю в чергу, чекає ручного режиму.
    h.fake.mode = "auto"
    h.fake.deliverAll()
    await settle()
    // Лише дрібний зсув: тік планувальника (60 с) не повинен виручати.
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    return { h, served, sent }
  }
  const markOf = (h: Harness) =>
    coreInternals(h.core).objects.get(TASK)!.rows.get(key(1))?.stale.minVersion

  it.each([
    { what: "pair", target: { scope: S } },
    { what: "key", target: { keys: [key(1)] } },
    // Надгробок ключа витіснено, новіший надгробок пари (другий purge) — ні.
    {
      what: "pair with the key tombstone evicted",
      target: { scope: S },
      limits: { tombstonesMax: 2 },
      after: [{ scope: S }, { keys: [key(5)] }],
    },
  ] as const)(
    "a min-version answer that started before a purge of the $what (a tombstone is alive) sets no mark and sends no re-read",
    async (c) => {
      const { h, sent } = await lateMinVersionAnswer(
        "limits" in c ? c.limits : undefined,
        (purge) => {
          purge(c.target)
          for (const t of "after" in c ? (c.after ?? []) : []) purge(t)
        }
      )
      expect(h.fake.requests.length).toBe(sent)
      expect(markOf(h)).toBeUndefined()
      expect(
        h.handle.getSnapshot().rows.find((r) => r.key === key(1))?.state
      ).not.toBe("stale")
    }
  )

  // Лишився тільки горизонт кошиків: надгробка немає, тож «purge» це чи хибний
  // збіг кошика — невідомо. Реакція сховища (§6.2, правило 1): сховати значення
  // й перечитати ключ без мінімальної версії; позначка, яку purge зробив би
  // нездійсненною, лишилась би без строку (#374).
  it.each([
    {
      what: "both tombstones of the key and the pair evicted",
      limits: { tombstonesMax: 2 },
      disturb: (purge: (t: Parameters<Writer["purge"]>[1]) => void) => {
        purge({ scope: S })
        purge({ keys: [key(5)] })
        purge({ keys: [key(6)] })
        purge({ keys: [key(7)] })
      },
    },
    // Один кошик: витіснення чужого надгробка піднімає горизонт і ключа 1,
    // хоча його власного надгробка й надгробка його пари ніколи не було.
    {
      what: "a foreign tombstone evicted from the shared bucket (no tombstone of the key or pair)",
      limits: { tombstonesMax: 1, horizonBuckets: 1 },
      disturb: (purge: (t: Parameters<Writer["purge"]>[1]) => void) => {
        purge({ keys: [key(5)] })
        purge({ keys: [key(6)] })
      },
    },
  ])(
    "a min-version answer that started before a horizon-only purge ($what) re-reads the key without a mark and shows the server version before a tick",
    async (c) => {
      const { h, served, sent } = await lateMinVersionAnswer(
        c.limits,
        c.disturb
      )
      expect(markOf(h)).toBeUndefined()
      const reads = keyReadsSince(h, sent)
      // Одне читання ключа: дочитування «хвоста», не повтор сигналу.
      expect(reads.map((r) => keysOf(r.query))).toEqual([[key(1)]])
      expect(requestsSince(h, sent)).toHaveLength(1)
      const row = h.handle.getSnapshot().rows.find((r) => r.key === key(1))
      expect(row?.state).not.toBe("stale")
      expect(row).toMatchObject({ version: served, values: { title: "v" } })
      expect(h.fake.row(TASK, key(1))?.version).toBe(served)
    }
  )
})

describe("a failed key read", () => {
  it("is not lost: the views of the object get needsRefresh and the failure is logged", async () => {
    const h = await open(keysView(key(1)))
    h.fake.mode = "manual"
    const v = h.fake.edit(TASK, key(1), { title: "x" })
    emit(h, change("update", key(1), v))
    await closeBatch()
    h.fake.take(0).fail("command.unavailable")
    await settle()
    expect(h.handle.getSnapshot().needsRefresh).toBe(true)
    expect(h.log.some((e) => e.kind === "listener-failed")).toBe(true)
    // Склад не підтверджено: вигляд, що стає видимим, читається раз.
    h.fake.mode = "auto"
    h.core.setVisible(keysView(key(1)), false)
    const from = h.fake.requests.length
    h.core.setVisible(keysView(key(1)), true)
    await settle()
    expect(requestsSince(h, from)).toHaveLength(1)
  })
})

const EA = "a".repeat(64)
const EB = "b".repeat(64)

describe("version epochs", () => {
  // Сесія переходить на епоху B через читання іншого ключа: рядок ключа 1
  // лишається в епосі A з позначкою «не доведено».
  async function switched() {
    // Перемикання епохи ставить перечитування виглядів у випадковий момент
    // вікна: тест тримає його далеко, щоб рахувати лише запити сигналу.
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    const h = harness()
    h.fake.epoch = EA
    seed(h.fake, 1, 2)
    const handle = h.core.view(keysView(key(1)))
    handle.subscribe(() => {})
    await settle()
    h.fake.epoch = EB
    h.core.view(keysView(key(2))).subscribe(() => {})
    await settle()
    return { ...h, handle, from: h.fake.requests.length }
  }

  it("does not take a row of another version epoch for an echo, and writes the answer with its own epoch", async () => {
    const h = await switched()
    expect(
      coreInternals(h.core).objects.get(TASK)!.rows.get(key(1))
    ).toMatchObject({ versionEpoch: EA })
    const stored = h.fake.row(TASK, key(1))!.version
    emit(h, change("update", key(1), stored))
    await closeBatch()
    expect(requestsSince(h, h.from)).toHaveLength(1)
    expect(
      coreInternals(h.core).objects.get(TASK)!.rows.get(key(1))
    ).toMatchObject({ versionEpoch: EB })
  })

  it("does not take a row of the current epoch that waits for the proof after a switch for an echo", async () => {
    const h = await switched()
    // Рядок ключа 2 прочитано в епосі B, але читання почалось до перемикання:
    // позначка перемикання на ньому лишається, тож сигнал його перечитує.
    const stored = h.fake.row(TASK, key(2))!.version
    emit(h, change("update", key(2), stored))
    await closeBatch()
    expect(requestsSince(h, h.from)).toHaveLength(1)
  })

  it("discards the answer of an abandoned epoch that carries no rows: the key is not removed", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99)
    const h = harness()
    h.fake.epoch = EA
    seed(h.fake, 1, 2)
    const handle = h.core.view(keysView(key(1)))
    handle.subscribe(() => {})
    await settle()
    const stored = h.fake.row(TASK, key(1))!.version
    // Читання за ключем летить, сервер уже видалив рядок.
    h.fake.mode = "manual"
    h.fake.remove(TASK, key(1))
    emit(h, change("delete", key(1), stored))
    await closeBatch()
    expect(h.fake.pending).toHaveLength(1)
    const old = h.fake.take(0)
    // Сесія переходить на епоху B іншим читанням.
    h.fake.epoch = EB
    h.core.view(keysView(key(2))).subscribe(() => {})
    await settle()
    h.fake.take(0).answer()
    await settle()
    expect(h.inspect.versionEpochs().current).toBe(EB)
    // Відповідь без рядків із покинутої епохи A.
    h.fake.epoch = EA
    old.answer()
    await settle()
    expect(handle.getSnapshot().rows[0]!.state).not.toBe("removed")
  })

  it("takes a row proved in the current epoch with a version not below row_ver for an echo", async () => {
    const h = await switched()
    // Читання, що почалось після перемикання, доводить рядки поточної епохи.
    await h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const from = h.fake.requests.length
    const stored = h.fake.row(TASK, key(1))!.version
    emit(h, change("update", key(1), stored))
    await closeBatch()
    expect(requestsSince(h, from)).toHaveLength(0)
  })

  // Після перемикання на B кожна відповідь покинутої A відкидається:
  // перечитування доводять сесію до межі відкинутих (§6.2).
  async function exhaust(h: Awaited<ReturnType<typeof switched>>) {
    h.fake.epoch = EA
    for (let i = 0; i < 4 * DISCARDS_MAX; i++) {
      if (h.inspect.versionEpochs().unavailable) break
      h.handle.refresh()
      await vi.advanceTimersByTimeAsync(60_000)
      await settle()
    }
    expect(h.inspect.versionEpochs().unavailable).toBe(true)
  }

  it("starts no read by a signal after the discard limit: 0 requests for a key or an invalidate", async () => {
    const h = await switched()
    await exhaust(h)
    const from = h.fake.requests.length
    const version = h.fake.edit(TASK, key(1), { title: "late" })
    emit(h, change("update", key(1), version))
    emit(h, { id: String(++seq), object: task.id, op: "invalidate" })
    await closeBatch()
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(requestsSince(h, from)).toHaveLength(0)
  })

  // Зупинка збору — наслідок осідання за межею (Р-SK1-7), а не допуск: читання
  // пачки відмовив би й шлюз, але зупинка береже й не-читальні ефекти пачки —
  // діагностику сигналу, сплеск і вимогу «склад не підтверджено» виглядам.
  it("collects no signal after the discard limit: no signal read, no burst, no requirement", async () => {
    const h = await switched()
    await exhaust(h)
    const seen: string[] = []
    h.inspect.watchSignalReads((object, signal) => {
      if (signal.by === "batch") seen.push(object)
    })
    const logged = h.log.length
    const version = h.fake.edit(TASK, key(1), { title: "late" })
    emit(h, change("update", key(1), version))
    emit(h, { id: String(++seq), object: task.id, op: "invalidate" })
    await closeBatch()
    await settle()
    expect(seen).toEqual([])
    expect(
      h.log.slice(logged).filter((e) => e.kind === "revalidate-burst")
    ).toEqual([])
    expect(
      h.inspect
        .sync()
        .flatMap((state) => state.requirements)
        .filter((r) => r.kind === "composition-unconfirmed")
    ).toEqual([])
  })

  it("drops the batch waiting behind a read in flight once the discard limit is reached", async () => {
    const h = await switched()
    h.fake.mode = "manual"
    h.fake.epoch = EA
    // Межа без одного відкинутого проходу: відкинута відповідь повторюється
    // після паузи, кожен повтор — ще один прохід. Системне перечитування, а не
    // `refresh()`: його повтор — строк планувальника, який межа знімає.
    void h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    for (let i = 0; i < 1000; i++) {
      if (h.inspect.versionEpochs().discards === DISCARDS_MAX - 1) break
      if (h.fake.pending.length > 0) h.fake.take(0).answer()
      else await vi.advanceTimersByTimeAsync(50)
      await settle()
    }
    expect(h.inspect.versionEpochs().discards).toBe(DISCARDS_MAX - 1)
    // Повтор відкинутої відповіді вигляду вже летить.
    const retried = h.fake.pending.length
    // Читання за сигналом у польоті, друга пачка чекає за ним.
    const stored = h.fake.row(TASK, key(1))!.version
    emit(h, change("update", key(1), stored + 1))
    await closeBatch()
    expect(h.fake.pending).toHaveLength(retried + 1)
    emit(h, change("update", key(1), stored + 2))
    await closeBatch()
    expect(h.fake.pending).toHaveLength(retried + 1)
    const from = h.fake.requests.length
    // Відповіді покинутої A — останній відкинутий прохід.
    h.fake.deliverAll()
    await settle()
    expect(h.inspect.versionEpochs().unavailable).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    await settle()
    expect(requestsSince(h, from)).toHaveLength(0)
  })
})

describe("own mutation in the journal", () => {
  it("keeps the queue and the state of the key when a signal re-reads it", async () => {
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await open(keysView(key(1)), 3, (fake) => ({
      ...fake.server,
      run: async (request) => {
        await held
        return fake.server.run(request)
      },
    }))
    const m = h.core.update(
      TASK,
      key(1),
      { title: "mine" },
      { expectedVersion: h.fake.row(TASK, key(1))!.version }
    )
    await settle()
    const v = h.fake.edit(TASK, key(1), { title: "theirs" })
    emit(h, change("update", key(1), v))
    await closeBatch()
    // Показується підтверджене значення з сервера, а мутація лишається в черзі.
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({
      state: "pending",
      values: { title: "theirs" },
      mutation: { id: m.id },
    })
    expect(h.inspect.mutations()).toHaveLength(1)
    release()
    await settle()
  })
})

// Несумісний об'єкт у пачці (§10): ключі відмовляє шлюз (K1, K2), а гілки
// прихованої вкладки й цілого об'єкта стереже іменована перевірка приймача —
// ні позначок виглядів, ні діагностики, ні сплеску (рішення архітекторки
// 25.11). Контроль — та сама пачка над сумісним об'єктом.
describe("a stale-client object in a signal batch", () => {
  it.each([
    ["on a hidden tab", "hidden"],
    ["invalidated whole", "whole"],
    ["of changed keys", "keys"],
  ] as const)(
    "a batch %s: nothing for the stale object, the effects for the live one",
    async (_, branch) => {
      for (const stale of [false, true]) {
        const h = await open(keysView(key(1)))
        const seen: string[] = []
        h.inspect.watchSignalReads((object, signal) => {
          if (signal.by === "batch") seen.push(object)
        })
        if (stale) h.core.staleClient(TASK)
        await settle()
        if (branch === "hidden") h.core.suspend()
        const logged = h.log.length
        const from = h.fake.log.length
        const v = h.fake.edit(TASK, key(1), { title: "changed" })
        emit(
          h,
          branch === "whole"
            ? { id: String(++seq), object: task.id, op: "invalidate" }
            : change("update", key(1), v)
        )
        await closeBatch()
        const bursts = h.log
          .slice(logged)
          .filter((e) => e.kind === "revalidate-burst")
        const taskReads = h.fake.log
          .slice(from)
          .filter((r) => r.query?.object.name === "Task")
        const label = `${branch}, stale: ${stale}`
        if (stale) {
          expect(seen, label).toEqual([])
          expect(bursts, label).toEqual([])
          expect(taskReads, label).toEqual([])
          expect(h.handle.getSnapshot().needsRefresh, label).toBe(false)
        } else {
          expect(seen, label).toEqual([TASK])
          if (branch === "hidden") {
            expect(taskReads, label).toEqual([])
            expect(h.handle.getSnapshot().needsRefresh, label).toBe(true)
          } else {
            expect(bursts, label).toHaveLength(1)
            expect(taskReads, label).toHaveLength(1)
          }
        }
      }
    }
  )
})
