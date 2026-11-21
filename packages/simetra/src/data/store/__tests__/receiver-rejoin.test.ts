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
import { QUIET_MS, REJOIN_JITTER_MS } from "../receiver"
import type { Key, ViewSpec } from "../types"
import {
  ORG,
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
    // Пакет хвилі: `version`, `rights` з `known` і читання вигляду з `known`.
    expect(requestsSince(h)).toEqual([3])
    const reads = h.fake.log.filter((r) => r.request >= h.from && r.query)
    expect(reads).toHaveLength(1)
    expect(reads[0]!.known).toBeDefined()
    expect(h.fake.rightsLog.at(-1)!.known).toBeDefined()
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

  it("sends one request for 19 scopes of Task and the unscoped Plain, whatever the random", async () => {
    const scopes = Array.from({ length: 19 }, (_, n) => scopeN(100 + n))
    const h = await open(full, 3, scopes)
    h.core
      .view({ kind: "keys", object: PLAIN, keys: [key(1)] })
      .subscribe(() => {})
    h.fake.insert(PLAIN, { ref: key(1) })
    await settle()
    const zero = channelTopic({
      kind: "changes",
      scopeKindId: ZERO_UUID,
      scope: ZERO_UUID,
      object: PLAIN_ID,
    })
    expect(h.transport.subscribed().has(zero)).toBe(true)
    const from = h.fake.requests.length
    let n = 0
    vi.spyOn(Math, "random").mockImplementation(() => (n++ % 5) / 5)
    for (const scope of scopes) h.transport.join(channelOf(scope), false)
    h.transport.join(zero, false)
    await advance(REJOIN_JITTER_MS)
    // `version`, `rights`, Task і Plain — один пакет.
    expect(requestsSince(h, from)).toEqual([4])
  })

  it("lifts the mark of a row of an invisible view only when that row is read, and sends nothing for it in the wave", async () => {
    const h = await open(keysView(key(1)))
    const hidden = keysView(key(2))
    const other = h.core.view(hidden)
    other.subscribe(() => {})
    await settle()
    h.core.setVisible(hidden, false)
    const from = h.fake.requests.length
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    // Невидимому вигляду — лише `needsRefresh`, у пакеті його читання немає.
    expect(other.getSnapshot().needsRefresh).toBe(true)
    expect(h.fake.log.filter((r) => r.request >= from && r.query)).toHaveLength(
      1
    )
    // Рядок, який хвиля прочитала після приєднання, доведено; рядок
    // невидимого вигляду — ні, і склад цього вигляду теж.
    expect(states(h)).toEqual(["synced"])
    expect(other.getSnapshot().rows.map((r) => r.state)).toEqual(["stale"])
    expect(other.getSnapshot().staleComposition).toBe(true)
    await advance(20_000)
    expect(other.getSnapshot().rows.map((r) => r.state)).toEqual(["stale"])
    h.core.setVisible(hidden, true)
    await advance(0)
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(other.getSnapshot().rows.map((r) => r.state)).toEqual(["synced"])
    expect(other.getSnapshot().staleComposition).toBeUndefined()
  })

  it("lifts the mark on a later successful re-read after the wave read failed", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    h.fake.mode = "manual"
    await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
    h.fake.take(0).fail("command.unavailable")
    h.fake.mode = "auto"
    await settle()
    expect(h.handle.getSnapshot().status).toBe("error")
    expect(states(h)).toContain("stale")
    const from = h.fake.requests.length
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(h.handle.getSnapshot().status).not.toBe("error")
    expect(states(h)).not.toContain("stale")
    // Знімає саме відстежене читання: нових запитів для цього не було.
    expect(h.fake.requests.length - from).toBe(1)
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

describe("recovered: true is not trusted for freshness", () => {
  it("joins the wave: the mark stays until the jitter, then one re-read lifts it", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, true)
    await advance(REJOIN_JITTER_MS / 2 - 1)
    // Тиші після `recovered` немає, що її можна було б брати за доказ свіжості.
    expect(states(h)).toEqual(["stale"])
    expect(requestsSince(h)).toHaveLength(0)
    await advance(1)
    expect(requestsSince(h)).toHaveLength(1)
    expect(states(h)).not.toContain("stale")
  })

  it.each([
    ["recovered, then not", true, false],
    ["not recovered, then recovered", false, true],
  ])(
    "lifts no mark before the wave when two joins follow a gap (%s)",
    async (_, first, second) => {
      const h = await open(keysView(key(1), key(2)))
      h.fake.edit(TASK, key(2), { title: "missed" })
      h.transport.fail({ kind: "transport", channel })
      h.transport.join(channel, first)
      h.transport.join(channel, second)
      await advance(REJOIN_JITTER_MS / 2 - 1)
      expect(states(h)).toEqual(["stale", "stale"])
      expect(requestsSince(h)).toHaveLength(0)
      await advance(1)
      expect(requestsSince(h)).toHaveLength(1)
      expect(states(h)).not.toContain("stale")
      expect(h.handle.getSnapshot().rows[1]).toMatchObject({
        values: { title: "missed" },
      })
    }
  )

  it("keeps the mark when a recovered invalidate settles only an invisible view", async () => {
    const h = await open(keysView(key(1)))
    h.core.setVisible(keysView(key(1)), false)
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, true)
    h.transport.emit(channel, {
      id: "9101",
      object: task.id,
      op: "invalidate",
    })
    await advance(QUIET_MS)
    expect(states(h)).toEqual(["stale"])
    // І хвиля невидимому вигляду дає лише `needsRefresh`: рядок не прочитано.
    await advance(REJOIN_JITTER_MS)
    expect(states(h)).toEqual(["stale"])
    expect(h.handle.getSnapshot().needsRefresh).toBe(true)
  })

  it("does not stick: a view in error recovers by a later successful re-read", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, true)
    h.fake.mode = "manual"
    await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
    h.fake.take(0).fail("command.unavailable")
    h.fake.mode = "auto"
    await settle()
    expect(h.handle.getSnapshot().status).toBe("error")
    expect(states(h)).toContain("stale")
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(states(h)).not.toContain("stale")
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

  it("lifts the marks and purges in one commit: no frame shows the gap rows as fresh", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    await settle()
    const frames: string[][] = []
    h.handle.subscribe(() =>
      frames.push(h.handle.getSnapshot().rows.map((r) => r.state))
    )
    h.transport.fail({ kind: "auth", channel })
    await settle()
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) expect(frame).not.toContain("synced")
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

describe("a newer gap is not lifted by an older wave", () => {
  const hiddenSpec = keysView(key(2))
  async function withHiddenView() {
    const h = await open(keysView(key(1)))
    const other = h.core.view(hiddenSpec)
    other.subscribe(() => {})
    await settle()
    h.core.setVisible(hiddenSpec, false)
    return h
  }

  it("keeps the mark of a new transport gap when the row is read later without a new join", async () => {
    const h = await withHiddenView()
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    expect(states(h)).toEqual(["synced"])
    await advance(5_000)
    // Новий розрив без нового `onSubscribed`.
    h.transport.fail({ kind: "transport", channel })
    await settle()
    h.core.setVisible(hiddenSpec, true)
    await advance(0)
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    // Вигляд ключа 1 читався до нового розриву: позначка лишається.
    expect(states(h)).toEqual(["stale"])
  })

  it("keeps the mark of a new gap when the wave read failed earlier and a view recovers", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    h.fake.mode = "manual"
    await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
    h.fake.take(0).fail("command.unavailable")
    h.fake.mode = "auto"
    await settle()
    h.transport.fail({ kind: "transport", channel })
    await settle()
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(states(h)).toEqual(["stale"])
  })

  it("keeps the mark of a gap that came while the wave read was in flight", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    h.fake.mode = "manual"
    await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
    h.transport.fail({ kind: "transport", channel })
    await settle()
    h.fake.mode = "auto"
    h.fake.deliverAll()
    await settle()
    expect(states(h)).toEqual(["stale"])
  })

  it.each([
    ["of the channel", { kind: "transport", channel } as const],
    ["without a channel", { kind: "transport" } as const],
  ])(
    "keeps the mark when a new gap %s comes before the jitter of the wave",
    async (_, error) => {
      const h = await open(keysView(key(1)))
      h.transport.fail({ kind: "transport", channel })
      h.transport.join(channel, false)
      h.transport.fail(error)
      await advance(REJOIN_JITTER_MS)
      expect(requestsSince(h)).toHaveLength(1)
      expect(states(h)).toEqual(["stale"])
    }
  )

  it("keeps the mark when a new gap comes after a recovered join, before the jitter", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, true)
    h.transport.fail({ kind: "transport", channel })
    await advance(REJOIN_JITTER_MS)
    expect(states(h)).toEqual(["stale"])
  })

  it("a view that fails after the wave read keeps its proved row; the other row waits for its own read", async () => {
    const h = await withHiddenView()
    const other = h.core.view(hiddenSpec)
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    expect(states(h)).toEqual(["synced"])
    // Вигляд ключа 1 уже прочитано після приєднання; збій пізнішого читання
    // доказу не відбирає.
    h.fake.mode = "manual"
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    h.fake.take(0).fail("command.unavailable")
    h.fake.mode = "auto"
    await settle()
    expect(h.handle.getSnapshot().status).toBe("error")
    expect(states(h)).toEqual(["synced"])
    expect(h.handle.getSnapshot().staleComposition).toBeUndefined()
    expect(other.getSnapshot().rows.map((r) => r.state)).toEqual(["stale"])
    h.core.setVisible(hiddenSpec, true)
    h.core.setVisible(keysView(key(1)), false)
    await advance(0)
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(other.getSnapshot().rows.map((r) => r.state)).toEqual(["synced"])
  })
})

describe("the disconnect mark and the composition on session epochs", () => {
  const rows = (handle: {
    getSnapshot(): { rows: readonly { state: string }[] }
  }) => handle.getSnapshot().rows.map((r) => r.state)

  it("lifts the mark by a read after the last join when an older wave read answers last", async () => {
    const h = await open(keysView(key(1)))
    const v1 = keysView(key(1))
    const v2 = keysView(key(2))
    h.core.view(v2).subscribe(() => {})
    await settle()
    h.core.setVisible(v2, false)
    // Хвиля A: читання вигляду ключа 1 затримане.
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    h.fake.mode = "manual"
    await vi.advanceTimersByTimeAsync(REJOIN_JITTER_MS)
    expect(h.fake.pending.length).toBe(1)
    const slowA = h.fake.take(0)
    h.fake.mode = "auto"
    // Новий розрив і приєднання — хвиля B, перед нею видимість міняється.
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    h.core.setVisible(v1, false)
    h.core.setVisible(v2, true)
    await advance(0)
    await advance(2 * REJOIN_JITTER_MS)
    expect(states(h)).toEqual(["stale"])
    // Читання хвилі A почалось до другого розриву: не доводить нічого.
    slowA.answer()
    await settle()
    expect(states(h)).toEqual(["stale"])
    expect(h.handle.getSnapshot().staleComposition).toBe(true)
    h.core.setVisible(v1, true)
    await advance(0)
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(states(h)).toEqual(["synced"])
    expect(h.handle.getSnapshot().staleComposition).toBeUndefined()
  })

  it("does not take a read started before the gap in the same clock tick for proof", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0)
    const h = await open(keysView(key(1)))
    await advance(5)
    h.fake.mode = "manual"
    void h.core.revalidate(TASK, { visibleOnly: true })
    await Promise.resolve()
    expect(h.fake.pending.length).toBe(1)
    // Той самий такт годинника: розрив і тихе приєднання.
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    h.core.setVisible(keysView(key(1)), false)
    h.fake.deliverAll()
    h.fake.mode = "auto"
    await settle()
    expect(h.handle.getSnapshot().status).not.toBe("error")
    expect(states(h)).toEqual(["stale"])
    expect(h.handle.getSnapshot().staleComposition).toBe(true)
  })

  it("marks a row read between fail and join: an edit in the gap is not shown synced", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport", channel })
    await settle()
    const second = h.core.view(keysView(key(2)))
    second.subscribe(() => {})
    await settle()
    expect(rows(second)).toEqual(["stale"])
    // Правка в розриві: сигнал не дійшов.
    h.fake.edit(TASK, key(2), { title: "missed" })
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(rows(second)).toEqual(["stale"])
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    expect(second.getSnapshot().rows[0]).toMatchObject({
      state: "synced",
      values: { title: "missed" },
    })
  })

  it("keeps the composition unconfirmed after a missed create until a read after the join", async () => {
    const h = await open(full)
    expect(h.handle.getSnapshot().staleComposition).toBeUndefined()
    h.transport.fail({ kind: "transport", channel })
    await settle()
    expect(h.handle.getSnapshot().staleComposition).toBe(true)
    // Створення в розриві: сигнал не дійшов.
    h.fake.insert(TASK, taskValues(4, { status: null, subject: null }))
    h.transport.join(channel, true)
    await settle()
    expect(h.handle.getSnapshot().staleComposition).toBe(true)
    await advance(REJOIN_JITTER_MS)
    expect(h.handle.getSnapshot()).toMatchObject({ hasNewRows: true })
    expect(h.handle.getSnapshot().staleComposition).toBeUndefined()
  })

  it("keeps the composition of a first load started before the gap unconfirmed", async () => {
    const h = await open(keysView(key(1)))
    h.fake.mode = "manual"
    const list = h.core.view(full)
    list.subscribe(() => {})
    await Promise.resolve()
    h.transport.fail({ kind: "transport", channel })
    h.transport.join(channel, false)
    h.core.setVisible(full, false)
    h.fake.deliverAll()
    h.fake.mode = "auto"
    await settle()
    expect(list.getSnapshot().status).toBe("ready")
    expect(list.getSnapshot().staleComposition).toBe(true)
  })

  it("keeps the composition unconfirmed when the only successful read started before the gap", async () => {
    const h = await open(full)
    h.fake.mode = "manual"
    void h.core.revalidate(TASK, { visibleOnly: true })
    await Promise.resolve()
    h.transport.fail({ kind: "transport", channel })
    h.fake.insert(TASK, taskValues(4, { status: null, subject: null }))
    h.transport.join(channel, false)
    h.core.setVisible(full, false)
    h.fake.deliverAll()
    h.fake.mode = "auto"
    await settle()
    expect(h.handle.getSnapshot().status).not.toBe("error")
    expect(h.handle.getSnapshot().staleComposition).toBe(true)
  })

  it("an unsubscribed channel keeps the mark of an include target until a read after the release", async () => {
    const h = harness()
    h.fake.rightsSnapshot = {
      ...h.fake.rightsSnapshot!,
      rights: [
        ...h.fake.rightsSnapshot!.rights,
        { ...read(S), object: "organization" },
      ],
    }
    h.fake.insert(ORG, { ref: S })
    h.fake.insert(TASK, taskValues(1, { org: S }))
    const tasks = h.core.view({ kind: "full", object: TASK, include: ["org"] })
    tasks.subscribe(() => {})
    const orgs: ViewSpec = { kind: "keys", object: ORG, keys: [S] }
    const off = h.core.view(orgs).subscribe(() => {})
    await settle()
    const orgChannel = channelTopic({
      kind: "changes",
      scopeKindId: SCOPE_KIND_ID,
      scope: S,
      object: org.id,
    })
    expect(h.transport.subscribed().has(orgChannel)).toBe(true)
    h.transport.fail({ kind: "transport", channel: orgChannel })
    await settle()
    const target = () => {
      const row = tasks.getSnapshot().rows[0]
      return row?.state === "removed" ? undefined : row?.refs?.org?.state
    }
    expect(target()).toBe("stale")
    off()
    // Відписка — після затримки звільнення, до будь-якого перечитування.
    await advance(1_000)
    expect(h.transport.subscribed().has(orgChannel)).toBe(false)
    expect(target()).toBe("stale")
    // Відпущений канал сигналів не чекає: читання цілі після відпускання
    // доводить її на свою мить (такт інтервалу перечитує вигляд з цілями).
    await advance(60_000)
    expect(target()).toBe("synced")
  })
})

describe("held and released channels (liveness, R-a…R-c)", () => {
  const S2 = scopeN(2)
  const rightsOf = (scopeSets: readonly string[], reads = scopeSets) => ({
    userId: USER,
    scopeSets: scopeSets.map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
    rights: reads.map(read),
    members: [],
    dimensionValues: [],
  })
  let version = 2
  const replaceRights = async (
    h: Opened,
    scopeSets: readonly string[],
    reads?: readonly string[]
  ) => {
    h.fake.rightsSnapshot = rightsOf(scopeSets, reads)
    h.fake.rightsVersion = String(version++ % 10).repeat(64)
    h.core.requestRights()
    await settle()
    await advance(1_000)
  }
  const withOrgTarget = async () => {
    const h = harness()
    h.fake.rightsSnapshot = {
      ...h.fake.rightsSnapshot!,
      rights: [
        ...h.fake.rightsSnapshot!.rights,
        { ...read(S), object: "organization" },
      ],
    }
    return h
  }

  it("A: a channel dropped by a rights replacement does not keep the composition unconfirmed after a connection gap", async () => {
    const h = await open(full, 3, [S, S2])
    const dropped = channelOf(S2)
    h.transport.join(channel, false)
    h.transport.join(dropped, false)
    await advance(REJOIN_JITTER_MS)
    await replaceRights(h, [S])
    expect(h.transport.subscribed().has(dropped)).toBe(false)
    h.transport.fail({ kind: "transport" })
    await settle()
    expect(h.handle.getSnapshot().staleComposition).toBe(true)
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    expect(states(h)).toEqual(["synced", "synced", "synced"])
    expect(h.handle.getSnapshot().staleComposition).toBeUndefined()
  })

  it("A2: a gap of a channel that is then dropped does not stick the composition", async () => {
    const h = await open(full, 3, [S, S2])
    const dropped = channelOf(S2)
    h.transport.join(channel, false)
    h.transport.join(dropped, false)
    await advance(REJOIN_JITTER_MS)
    h.transport.fail({ kind: "transport", channel: dropped })
    await settle()
    expect(h.handle.getSnapshot().staleComposition).toBe(true)
    await replaceRights(h, [S])
    expect(h.handle.getSnapshot().staleComposition).toBeUndefined()
    expect(states(h)).toEqual(["synced", "synced", "synced"])
  })

  it("B: a connection gap does not mark an include target of an object the receiver holds no channel for", async () => {
    const h = await withOrgTarget()
    h.fake.insert(ORG, { ref: S })
    h.fake.insert(TASK, taskValues(1, { org: S }))
    const tasks = h.core.view({ kind: "full", object: TASK, include: ["org"] })
    tasks.subscribe(() => {})
    await settle()
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    const target = () => {
      const row = tasks.getSnapshot().rows[0]
      return row?.state === "removed" ? undefined : row?.refs?.org?.state
    }
    h.transport.fail({ kind: "transport" })
    await settle()
    expect(target()).toBe("synced")
    expect(tasks.getSnapshot().rows[0]?.state).toBe("stale")
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    expect(target()).toBe("synced")
    expect(tasks.getSnapshot().rows[0]?.state).toBe("synced")
  })

  it("B2: an include target first read after a connection gap is not marked", async () => {
    const h = await withOrgTarget()
    h.fake.insert(TASK, taskValues(1, {}))
    const tasks = h.core.view({ kind: "full", object: TASK, include: ["org"] })
    tasks.subscribe(() => {})
    await settle()
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    h.transport.fail({ kind: "transport" })
    await settle()
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    h.fake.insert(ORG, { ref: S })
    h.fake.insert(TASK, taskValues(2, { org: S }))
    tasks.showNew()
    await settle()
    const rows = tasks.getSnapshot().rows
    expect(
      rows.map((r) => (r.state === "removed" ? null : r.refs?.org?.state))
    ).not.toContain("stale")
  })

  it("C: a connection gap before the first onSubscribed counts for the held channel", async () => {
    const h = await open(keysView(key(1)))
    h.transport.fail({ kind: "transport" })
    await settle()
    expect(states(h)).toEqual(["stale"])
    expect(h.handle.getSnapshot().staleComposition).toBe(true)
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    expect(states(h)).toEqual(["synced"])
    expect(h.handle.getSnapshot().staleComposition).toBeUndefined()
  })

  it("judges a released channel point-in-time: a create lost in a gap keeps the composition unconfirmed until a read after the release", async () => {
    const h = await open(full, 3, [S, S2])
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    h.transport.fail({ kind: "transport", channel })
    await settle()
    h.fake.insert(TASK, taskValues(4, { status: null, subject: null }))
    await replaceRights(h, [S2], [S, S2])
    expect(h.transport.subscribed().has(channel)).toBe(false)
    expect(h.handle.getSnapshot().staleComposition).toBe(true)
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(h.handle.getSnapshot()).toMatchObject({ hasNewRows: true })
    expect(h.handle.getSnapshot().staleComposition).toBeUndefined()
  })

  it("a release without a gap leaves the composition confirmed", async () => {
    const h = await open(full, 3, [S, S2])
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    await replaceRights(h, [S2], [S, S2])
    expect(h.transport.subscribed().has(channel)).toBe(false)
    expect(h.handle.getSnapshot().staleComposition).toBeUndefined()
  })

  it("D: unsubscribe, an edit, resubscribe — the stored row is not shown synced with the old value", async () => {
    // Читання лишається, канал знімає лише перелік скоупів.
    const h = await open(keysView(key(1)), 3, [S])
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    h.core.setVisible(keysView(key(1)), false)
    await replaceRights(h, [S2], [S, S2])
    expect(h.transport.subscribed().has(channel)).toBe(false)
    expect(states(h)).toEqual(["synced"])
    h.fake.edit(TASK, key(1), { title: "missed" })
    await replaceRights(h, [S], [S, S2])
    expect(h.transport.subscribed().has(channel)).toBe(true)
    expect(states(h)).toEqual(["stale"])
    h.transport.join(channel, false)
    await advance(REJOIN_JITTER_MS)
    // Невидимий вигляд хвиля не читає: позначка лишається, не старе значення.
    expect(states(h)).toEqual(["stale"])
    h.core.setVisible(keysView(key(1)), true)
    await advance(0)
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(h.handle.getSnapshot().rows[0]).toMatchObject({
      state: "synced",
      values: { title: "missed" },
    })
  })
})
