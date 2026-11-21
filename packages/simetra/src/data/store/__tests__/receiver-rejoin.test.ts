import {
  ZERO_UUID,
  channelTopic,
  type CatalogEntry,
  type RightsRow,
} from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SCOPE_KIND_ID,
  catalogEntry,
} from "../../../model/runtime/__tests__/entries"
import { runtimeHandleOf } from "../../runtime/handle"
import { createDataRuntime } from "../../runtime/runtime"
import { SERVER_HASH, clientCatalog } from "../../__tests__/support"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import { createFakeSource } from "../testing/fake-source"
import { RECOVERED_SETTLE_MS, QUIET_MS, REJOIN_JITTER_MS } from "../receiver"
import type { Key, ViewSpec } from "../types"
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
 * Приєднання, розрив і відмови каналів (план B5b-3, задача 4; спека П4-B §8.4,
 * Р10–Р12): хвиля приєднання з одним строком у ядрі, `recovered`, позначки
 * «розрив», відмови `auth` і `final`. Фейковий канал над справжнім ядром;
 * кожен кейс рахує запити сервера.
 */

const USER = "00000000-0000-4000-8000-0000000000a1"
const PLAIN_ID = "00000000-0000-4000-8000-0000000000d1"
const PLAIN = "Catalog.Plain"

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const plain: CatalogEntry = (() => {
  const entry: CatalogEntry = catalogEntry({
    id: PLAIN_ID,
    name: "Plain",
    kindLabel: "plain",
    table: { schema: "public", name: "plain" },
    attributes: [],
    tabularSections: [],
  })
  delete entry.scopeKindId
  delete entry.scopeColumn
  return entry
})()

const read = (scope: string): RightsRow => ({
  level: "scope",
  levelId: null,
  scope,
  container: null,
  object: "task",
  action: "read",
  extent: "any",
  dimensionId: null,
})
const channelOf = (scope: string) =>
  channelTopic({
    kind: "changes",
    scopeKindId: SCOPE_KIND_ID,
    scope,
    object: task.id,
  })
const channel = channelOf(S)
const scopeN = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const keysView = (...keys: Key[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys,
})
const full: ViewSpec = { kind: "full", object: TASK }

function harness(scopes: readonly string[] = [S]) {
  const transport = createFakeSignalTransport()
  const h = setup({
    rightsSnapshot: true,
    signals: transport,
    objects: [task, org, plain],
  })
  h.fake.rightsSnapshot = {
    userId: USER,
    scopeSets: scopes.map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
    rights: [
      ...scopes.map(read),
      {
        ...read(S),
        object: "plain",
        level: "global" as const,
        scope: null,
      },
    ],
    members: [],
    dimensionValues: [],
  }
  h.fake.rightsVersion = "1".repeat(64)
  return { ...h, transport }
}

async function open(
  spec: ViewSpec,
  rows = 3,
  scopes?: readonly string[],
  epoch?: string
) {
  const h = harness(scopes)
  // Умовне читання (`known`) вимагає епохи версій.
  if (epoch !== undefined) h.fake.epoch = epoch
  // Рядок з усіма полями: лише такий іде в `known`.
  for (let n = 1; n <= rows; n++)
    h.fake.insert(TASK, taskValues(n, { status: null, subject: null }))
  const handle = h.core.view(spec)
  handle.subscribe(() => {})
  await settle()
  expect(h.transport.subscribed().has(channelOf(scopes?.[0] ?? S))).toBe(true)
  return { ...h, handle, from: h.fake.requests.length }
}
type Opened = Awaited<ReturnType<typeof open>>

const requestsSince = (h: Opened, from = h.from) => h.fake.requests.slice(from)
const keyReads = (h: Opened, from = h.from) =>
  h.fake.log.filter((r) => r.request >= from && keysOf(r.query).length > 0)
const advance = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}
const states = (h: Opened) => h.handle.getSnapshot().rows.map((r) => r.state)

describe("the rejoin wave", () => {
  it("re-reads once after the jitter, with known versions, and nothing before it", async () => {
    const h = await open(full, 3, undefined, "a".repeat(64))
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS / 2 - 1)
    expect(requestsSince(h)).toHaveLength(0)
    await advance(1)
    expect(requestsSince(h)).toHaveLength(1)
    const reads = h.fake.log.filter((r) => r.request >= h.from && r.query)
    expect(reads).toHaveLength(1)
    expect(reads[0]!.known).toBeDefined()
    // Нічого не змінилось: рядки ті самі, позначок немає.
    expect(states(h)).not.toContain("stale")
  })

  it("lifts the disconnect mark only after the re-read settled", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    await settle()
    expect(states(h)).toEqual(["stale"])
    expect(requestsSince(h)).toHaveLength(0)
    h.transport.join(channel, false)
    await settle()
    expect(states(h)).toEqual(["stale"])
    await advance(REJOIN_JITTER_MS)
    expect(requestsSince(h)).toHaveLength(1)
    expect(states(h)).not.toContain("stale")
  })

  it("keeps the marks when the re-read fails and the view goes to error", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    h.fake.mode = "manual"
    await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
    h.fake.take(0).fail("command.unavailable")
    h.fake.mode = "auto"
    await settle()
    expect(h.handle.getSnapshot().status).toBe("error")
    // Вигляд в `error` не довів, що дані свіжі: позначка «розрив» лишається.
    expect(states(h)).toContain("stale")
  })

  it("sends one request for 20 channels of one window, whatever the random", async () => {
    const scopes = Array.from({ length: 20 }, (_, n) => scopeN(100 + n))
    const h = await open(full, 3, scopes)
    h.fake.insert(TASK, taskValues(50, { org: scopes[3]! }))
    const from = h.fake.requests.length
    let n = 0
    vi.spyOn(Math, "random").mockImplementation(() => (n++ % 7) / 7)
    for (const scope of scopes) h.transport.join(channelOf(scope), false)
    await advance(REJOIN_JITTER_MS)
    expect(requestsSince(h, from)).toHaveLength(1)
  })

  it.each([0, 0.999999])(
    "fires within the window at random = %s",
    async (value) => {
      vi.spyOn(Math, "random").mockReturnValue(value)
      const h = await open(keysView(key(1)))
      h.transport.join(channel, false)
      await advance(REJOIN_JITTER_MS)
      expect(requestsSince(h)).toHaveLength(1)
    }
  )

  it("does not fire more often than once per REJOIN_JITTER_MS under flapping", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const h = await open(keysView(key(1)))
    const times: number[] = []
    let seen = h.from
    for (let at = 0; at < 20; at++) {
      h.transport.join(channel, false)
      await advance(300)
      if (h.fake.requests.length > seen) {
        times.push(at)
        seen = h.fake.requests.length
      }
    }
    // 20 × 300 мс = 6 с: хвилі не частіше разу на 2 с (кроки по 300 мс).
    expect(times.length).toBeGreaterThanOrEqual(3)
    expect(times.length).toBeLessThanOrEqual(4)
    for (let i = 1; i < times.length; i++)
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(6)
    expect(requestsSince(h)).toHaveLength(times.length)
  })

  it("sends one request before the jitter (the open view) and one after it", async () => {
    const h = harness()
    seed(h.fake, 1, 2)
    h.core.view(keysView(key(1))).subscribe(() => {})
    await settle()
    const mount = h.fake.requests.length
    expect(mount).toBeGreaterThan(0)
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    expect(h.fake.requests.length).toBe(mount + 1)
  })

  it("reads nothing on a hidden tab until resume()", async () => {
    const h = await open(keysView(key(1)))
    h.core.suspend()
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    await advance(10 * REJOIN_JITTER_MS)
    expect(requestsSince(h)).toHaveLength(0)
    expect(states(h)).toEqual(["stale"])
    h.core.resume()
    await settle()
    expect(requestsSince(h).length).toBeGreaterThan(0)
    // Хвилю бере `resume()`: вона ж знімає «розрив» після осідання.
    expect(states(h)).not.toContain("stale")
  })

  it("takes a wave that is not due yet on resume(), and lifts the mark after it", async () => {
    const h = await open(keysView(key(1)))
    h.core.suspend()
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    await advance(1)
    h.core.resume()
    await settle()
    expect(states(h)).not.toContain("stale")
    expect(requestsSince(h)).toHaveLength(1)
  })

  it("sends nothing and leaves no timer when the core closes during the jitter", async () => {
    const h = await open(keysView(key(1)))
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS / 4)
    h.core.close("disposed")
    await advance(10 * REJOIN_JITTER_MS)
    expect(requestsSince(h)).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe("recovered: true", () => {
  const edited = (h: Opened, n: number) => {
    const rows: Key[] = []
    for (let i = 1; i <= n; i++) {
      h.fake.edit(TASK, key(i), { title: `v${i}` })
      rows.push(key(i))
    }
    return rows
  }

  it("re-reads only the keys of the batch and lifts the mark after it", async () => {
    const h = await open(full, 50)
    h.transport.fail({ kind: "transport", channel })
    await settle()
    expect(states(h)).toContain("stale")
    h.transport.join(channel, true)
    const rows = edited(h, 50)
    rows.forEach((k, i) =>
      h.transport.emit(channel, {
        id: String(900 + i),
        object: task.id,
        op: "update",
        keys: { id: k },
        row_ver: h.fake.row(TASK, k)!.version,
      })
    )
    // Пачка ще не закрита: відновлені сигнали не покривають «розрив».
    await vi.advanceTimersByTimeAsync(QUIET_MS - 1)
    expect(states(h)).toContain("stale")
    await advance(1)
    expect(states(h)).not.toContain("stale")
    // Один запит — читання ключів пачки; перечитування виглядів немає.
    expect(requestsSince(h)).toHaveLength(1)
    expect(keyReads(h).flatMap((r) => keysOf(r.query))).toHaveLength(50)
  })

  it("lifts the mark after RECOVERED_SETTLE_MS of silence, with no request", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, true)
    await advance(RECOVERED_SETTLE_MS - 1)
    expect(states(h)).toEqual(["stale"])
    await advance(1)
    expect(states(h)).not.toContain("stale")
    await advance(10 * REJOIN_JITTER_MS)
    expect(requestsSince(h)).toHaveLength(0)
  })
})

describe("refusals and breaks", () => {
  it("purges the pair of a refused channel with no request, and does not re-subscribe it", async () => {
    const h = await open(keysView(key(1)))
    const calls = vi.spyOn(h.transport, "subscribe")
    h.transport.fail({ kind: "auth", channel })
    await advance(REJOIN_JITTER_MS)
    expect(requestsSince(h)).toHaveLength(0)
    // Пара зникла з пам'яті: вигляд лишається, рядків у ньому немає.
    expect(h.handle.getSnapshot().rows).toEqual([])
    expect(h.inspect.rowCount()).toBe(0)
    expect(h.transport.subscribed().has(channel)).toBe(false)
    expect(calls).not.toHaveBeenCalled()
  })

  it("purges an unscoped object by ZERO_UUID", async () => {
    const h = harness()
    h.fake.insert(PLAIN, { ref: key(1) })
    const handle = h.core.view({ kind: "keys", object: PLAIN, keys: [key(1)] })
    handle.subscribe(() => {})
    await settle()
    const zero = channelTopic({
      kind: "changes",
      scopeKindId: ZERO_UUID,
      scope: ZERO_UUID,
      object: PLAIN_ID,
    })
    expect(h.transport.subscribed().has(zero)).toBe(true)
    const from = h.fake.requests.length
    h.transport.fail({ kind: "auth", channel: zero })
    await settle()
    expect(handle.getSnapshot().rows).toEqual([])
    expect(h.fake.requests.length).toBe(from)
  })

  it("drops the unclosed batch of a refused channel", async () => {
    const h = await open(keysView(key(1)))
    const version = h.fake.edit(TASK, key(1), { title: "new" })
    h.transport.emit(channel, {
      id: "7001",
      object: task.id,
      op: "update",
      keys: { id: key(1) },
      row_ver: version,
    })
    h.transport.fail({ kind: "auth", channel })
    await advance(QUIET_MS)
    expect(keyReads(h)).toHaveLength(0)
  })

  it("sends one version request for auth without a channel, however many in one microtask", async () => {
    const h = await open(keysView(key(1)))
    for (let i = 0; i < 5; i++) h.transport.fail({ kind: "auth" })
    await settle()
    expect(requestsSince(h)).toHaveLength(1)
    expect(h.fake.log.filter((r) => r.request >= h.from)).toHaveLength(0)
  })

  it("marks the rows of the channel on a transport error with no request, and all rows without a channel", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport" })
    await advance(REJOIN_JITTER_MS)
    expect(states(h)).toEqual(["stale"])
    expect(requestsSince(h)).toHaveLength(0)
  })

  it("closes the core with connection-refused on a final auth", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "auth", final: true })
    await settle()
    expect(h.handle.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "connection-refused",
    })
    expect(requestsSince(h)).toHaveLength(0)
  })
})

describe("a refused connection closes the runtime", () => {
  function world() {
    const fake = createFakeSource({ objects: [task, org] })
    fake.rightsSnapshot = {
      userId: USER,
      scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
      rights: [read(S)],
      members: [],
      dimensionValues: [],
    }
    fake.rightsVersion = "1".repeat(64)
    seed(fake, 1, 1)
    const wire = async (body: { request: unknown }) => {
      const { items } = body.request as { items: unknown[] }
      const rows = await fake.adapter.read(
        items as Parameters<typeof fake.adapter.read>[0]
      )
      return {
        ok: true as const,
        value: { ...rows, epoch: null },
        serverHash: SERVER_HASH,
      }
    }
    const transport = createFakeSignalTransport()
    const onSessionChanged = vi.fn()
    const runtime = createDataRuntime({
      catalog: {
        ...clientCatalog(),
        objects: [task, org],
        rightsSnapshot: true,
      },
      transport: wire,
      subject: "user-1",
      signals: () => transport,
      log: () => {},
      onSessionChanged,
    })
    return { runtime, transport, onSessionChanged }
  }

  it("answers a mutation and a request with command.unavailable, not unauthenticated", async () => {
    const { runtime, transport, onSessionChanged } = world()
    const { core, send } = runtimeHandleOf(runtime)
    const handle = core.view(keysView(key(1)))
    handle.subscribe(() => {})
    await settle()
    transport.fail({ kind: "auth", final: true })
    await settle()
    expect(runtime.disposed).toBe(true)
    expect(transport.closed()).toBe(true)
    expect(handle.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "connection-refused",
    })
    const mutation = core.update(
      TASK,
      key(1),
      { title: "x" },
      { expectedVersion: 1 }
    )
    await expect(mutation.settled).resolves.toMatchObject({
      ok: false,
      error: { code: "command.unavailable" },
    })
    await expect(send({ type: "read", items: [] })).rejects.toMatchObject({
      error: { code: "command.unavailable" },
    })
    expect(onSessionChanged).not.toHaveBeenCalled()
  })
})
