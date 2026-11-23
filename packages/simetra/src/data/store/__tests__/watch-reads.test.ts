import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  catalogIndex,
  type CommandErrorCode,
  type MetadataRef,
  type SourceAdapter,
  type WireReadParts,
} from "simetra/model"
import { DataError } from "../../errors"
import { createBatcher } from "../batcher"
import {
  createCoreSource,
  createReadLimiter,
  requestOf,
  type CorePart,
  type CoreReadItem,
  type CoreSource,
  type ReadEvent,
  type ReadLimiter,
  type ReadOptions,
} from "../source"
import { SITE_CODES, type ReadIntent } from "../sync/vocabulary"
import { createFakeSource, type FakeSource } from "../testing/fake-source"
import type { ViewSpec } from "../types"
import {
  ORG,
  OBJECTS,
  TASK,
  key,
  seed,
  settle,
  setup,
  watch,
} from "./core-support"

/*
 * Подія `watchReads` (спека ядра синхронізації §5.13, план SK-0 Р3, Р11):
 * одна подія на кожну живу частину кожного запиту з номером, що дорівнює
 * `requestOf` відповіді. Походження йде за слотом: тест на кожен крок, що
 * змінює слоти, бере дві живі частини різних цілей, тож переставлене
 * походження дає подію з чужим номером запиту чи чужим кодом.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const TASK_REF: MetadataRef = { kind: "Catalog", name: "Task" }
const ORG_REF: MetadataRef = { kind: "Catalog", name: "Organization" }
const SLEEP: ReadOptions["sleep"] = () => Promise.resolve()

// Походження слота: код рядка — свій на кожен слот, ціль чергується між двома
// об'єктами, тож будь-яка перестановка змінює пару «код — запит».
const originAt = (slot: number): ReadIntent => ({
  reason: "user",
  target: { kind: "keys", object: slot % 2 === 0 ? TASK : ORG },
  site: SITE_CODES[slot]!,
})

const queryOf = (object: MetadataRef, n: number): CorePart => ({
  type: "query",
  query: { object, id: key(n) },
})

/** Слот частини за її кодом: так подію співставляють з відповіддю частини. */
const slotOfSite = (site: ReadEvent["site"]) =>
  SITE_CODES.indexOf(site as (typeof SITE_CODES)[number])

/** Кожен слот має рівно одну подію, і її номер — `requestOf` відповіді слота. */
const expectEventsMatchAnswers = (
  events: readonly ReadEvent[],
  items: readonly CoreReadItem[],
  slots: readonly number[]
) => {
  expect(events.map((e) => slotOfSite(e.site)).sort((a, b) => a - b)).toEqual(
    [...slots].sort((a, b) => a - b)
  )
  for (const slot of slots) {
    const event = events.find((e) => e.site === SITE_CODES[slot])!
    expect(event.request).toBe(requestOf(items[slot]!))
    expect(event.target).toEqual(originAt(slot).target)
  }
}

/** Адаптер-обгортка: інша тотожність `read`, тож частини йдуть окремим запитом. */
const wrapped = (
  fake: FakeSource,
  capabilities: SourceAdapter["capabilities"] = fake.adapter.capabilities
): SourceAdapter => ({
  capabilities,
  read: (wires) => fake.adapter.read(wires),
})

/** Ядро джерела з адаптером на об'єкт: Task — перший, Organization — другий. */
function twoAdapters(options: {
  limiter?: ReadLimiter
  first?: SourceAdapter
}) {
  const fake = createFakeSource({ objects: OBJECTS })
  const first = options.first ?? wrapped(fake)
  const second = wrapped(fake)
  const source = createCoreSource(
    (object) => (object.name === "Task" ? first : second),
    catalogIndex(OBJECTS),
    options.limiter ?? createReadLimiter(4),
    fake.server
  )
  const events: ReadEvent[] = []
  const read = (
    parts: readonly CorePart[],
    origins: readonly (ReadIntent | undefined)[]
  ) =>
    source.read(parts, {
      sleep: SLEEP,
      origins,
      onRead: (event) => events.push(event),
    })
  return { fake, source, events, read }
}

describe("watchReads at the source: one event per live part of a request", () => {
  it("pairs each origin with the request number of its own answer across adapter groups", async () => {
    const { events, read } = twoAdapters({})
    const parts = [
      queryOf(TASK_REF, 1),
      queryOf(ORG_REF, 2),
      queryOf(TASK_REF, 3),
      queryOf(ORG_REF, 4),
    ]
    const { items } = await read(
      parts,
      parts.map((_, i) => originAt(i))
    )
    expectEventsMatchAnswers(events, items, [0, 1, 2, 3])
    // Дві різні групи — два різні запити: перестановка слотів помітна.
    expect(requestOf(items[0]!)).not.toBe(requestOf(items[1]!))
    expect(requestOf(items[0]!)).toBe(requestOf(items[2]!))
  })

  it("keeps each origin with its slot when READ_BATCH_MAX splits one group into requests", async () => {
    const { events, read } = twoAdapters({})
    const parts = Array.from({ length: 33 }, (_, i) => queryOf(TASK_REF, i + 1))
    const { items } = await read(
      parts,
      parts.map((_, i) => originAt(i))
    )
    expectEventsMatchAnswers(
      events,
      items,
      parts.map((_, i) => i)
    )
    expect(new Set(events.map((e) => e.request)).size).toBe(3)
  })

  it("keeps the origin of a part without an object (version) when the group puts it first", async () => {
    const { events, read } = twoAdapters({})
    const parts: CorePart[] = [
      queryOf(ORG_REF, 1),
      queryOf(TASK_REF, 2),
      { type: "version" },
    ]
    const origins: ReadIntent[] = [
      originAt(0),
      originAt(1),
      {
        reason: "interval",
        target: { kind: "service", service: "version" },
        site: "S1",
      },
    ]
    const { items } = await read(parts, origins)
    expect(events).toHaveLength(3)
    for (const [slot, origin] of origins.entries()) {
      const event = events.find((e) => e.site === origin.site)!
      expect(event.target).toEqual(origin.target)
      expect(event.reason).toBe(origin.reason)
      expect(event.request).toBe(requestOf(items[slot]!))
    }
  })

  it("gives no event to a part without an origin", async () => {
    const { events, read } = twoAdapters({})
    const parts = [queryOf(TASK_REF, 1), queryOf(ORG_REF, 2)]
    const { items } = await read(parts, [undefined, originAt(1)])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      site: SITE_CODES[1],
      request: requestOf(items[1]!),
    })
  })

  it("carries the origin through a part copy of an adapter without capabilities.include", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    const { events, read } = twoAdapters({
      first: wrapped(fake, { include: false }),
    })
    const parts: CorePart[] = [
      {
        type: "query",
        query: { object: TASK_REF, limit: 5, include: ["org"] },
      },
      queryOf(ORG_REF, 2),
    ]
    const { items } = await read(
      parts,
      parts.map((_, i) => originAt(i))
    )
    expectEventsMatchAnswers(events, items, [0, 1])
    expect(requestOf(items[0]!)).not.toBe(requestOf(items[1]!))
  })

  it("gives no event to a part refused without a request, and keeps the origin of the live one", async () => {
    // Обмежувач тримає обидві задачі, доки не відкриємо: частину об'єкта,
    // закритого `refuse`, задача бачить відмовленою.
    const inner = createReadLimiter(4)
    let open!: () => void
    const gate = new Promise<void>((resolve) => (open = resolve))
    const limiter: ReadLimiter = {
      close: () => inner.close(),
      run: (task) => inner.run(() => gate.then(task)),
    }
    const { source, events, read } = twoAdapters({ limiter })
    const parts = [queryOf(TASK_REF, 1), queryOf(ORG_REF, 2)]
    const reading = read(
      parts,
      parts.map((_, i) => originAt(i))
    )
    source.refuse?.("Catalog.Task")
    open()
    const { items } = await reading
    expect(requestOf(items[0]!)).toBeUndefined()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      site: SITE_CODES[1],
      request: requestOf(items[1]!),
    })
  })

  it("gives no event when the limiter is closed", async () => {
    const { source, events, read } = twoAdapters({})
    source.close()
    const parts = [queryOf(TASK_REF, 1)]
    await expect(read(parts, [originAt(0)])).rejects.toThrow()
    expect(events).toEqual([])
  })
})

describe("watchReads at the source: re-sent rounds", () => {
  const refusal = (code: CommandErrorCode, reason?: string) => ({
    ok: false as const,
    error: { code, ...(reason === undefined ? {} : { reason }) },
  })
  const okPart = (n: number) => ({
    ok: true as const,
    value: { rows: [{ id: key(n), version: "1", title: `t${n}` }] },
  })

  const scripted = (replies: WireReadParts[]) => {
    let call = 0
    const adapter: SourceAdapter = {
      capabilities: { include: true },
      read: () => Promise.resolve(replies[call++]!),
    }
    const events: ReadEvent[] = []
    const source = createCoreSource(
      () => adapter,
      catalogIndex(OBJECTS),
      createReadLimiter(4),
      createFakeSource({ objects: OBJECTS }).server
    )
    const read = (parts: readonly CorePart[]) =>
      source.read(parts, {
        sleep: SLEEP,
        origins: parts.map((_, i) => originAt(i)),
        onRead: (event) => events.push(event),
      })
    return { events, read }
  }

  it("emits new events for the re-sent parts, each with its own origin and new request number", async () => {
    const { events, read } = scripted([
      {
        epoch: null,
        items: [
          okPart(1),
          okPart(2),
          refusal("command.timeout"),
          refusal("command.unavailable", "batch-aborted"),
          refusal("command.unavailable", "batch-aborted"),
        ],
      },
      { epoch: null, items: [okPart(4), okPart(5)] },
    ])
    const parts = [1, 2, 3, 4, 5].map((n) => queryOf(TASK_REF, n))
    const { items } = await read(parts)
    expect(events.map((e) => [slotOfSite(e.site), e.request] as const)).toEqual(
      [
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
        [3, 2],
        [4, 2],
      ]
    )
    expect(requestOf(items[3]!)).toBe(2)
    expect(requestOf(items[2]!)).toBe(1)
  })

  it("sends a batch-budget part in a request of its own with its own origin", async () => {
    const { events, read } = scripted([
      {
        epoch: null,
        items: [okPart(1), refusal("command.unavailable", "batch-budget")],
      },
      { epoch: null, items: [okPart(2)] },
    ])
    const parts = [1, 2].map((n) => queryOf(TASK_REF, n))
    const { items } = await read(parts)
    expect(events.map((e) => [slotOfSite(e.site), e.request])).toEqual([
      [0, 1],
      [1, 1],
      [1, 2],
    ])
    expect(requestOf(items[1]!)).toBe(2)
  })
})

describe("watchReads at the batcher: origins follow the slots", () => {
  /** Джерело, що пам'ятає опції кожного виклику. */
  function recording() {
    const seen: (readonly (ReadIntent | undefined)[] | undefined)[] = []
    const source: CoreSource = {
      read: (parts, options) => {
        seen.push(options.origins)
        return Promise.resolve({
          items: parts.map((_, i): CoreReadItem => ({
            ok: true,
            rows: { rows: [{ ref: key(i) }] },
            epoch: null,
          })),
        })
      },
      run: () => Promise.reject(new Error("unexpected run")),
      refuse: () => {},
      close: () => {},
    }
    return { source, seen }
  }

  it("merges the calls of one window: origins stay in the order of the sent parts", async () => {
    const r = recording()
    const batcher = createBatcher(r.source, { sleep: SLEEP })
    const first = batcher.read([queryOf(TASK_REF, 1)], [originAt(0)])
    const second = batcher.read(
      [queryOf(ORG_REF, 2), queryOf(TASK_REF, 3)],
      [originAt(1), originAt(2)]
    )
    await Promise.all([first, second])
    expect(r.seen).toEqual([[originAt(0), originAt(1), originAt(2)]])
  })

  it("drops the origin of a part refused while it queued and keeps the origin of the live one", async () => {
    const r = recording()
    const batcher = createBatcher(r.source, { sleep: SLEEP })
    const reading = batcher.read(
      [queryOf(TASK_REF, 1), queryOf(ORG_REF, 2)],
      [originAt(0), originAt(1)]
    )
    batcher.refuse?.("Catalog.Task")
    await reading
    expect(r.seen).toEqual([[originAt(1)]])
  })

  it("keeps the origin of a refused part from shifting the origins of later calls", async () => {
    const r = recording()
    const batcher = createBatcher(r.source, { sleep: SLEEP })
    const first = batcher.read([queryOf(TASK_REF, 1)], [originAt(0)])
    const second = batcher.read([queryOf(ORG_REF, 2)], [originAt(1)])
    const third = batcher.read([queryOf(ORG_REF, 3)], [originAt(3)])
    batcher.refuse?.("Catalog.Task")
    await Promise.all([first, second, third])
    expect(r.seen).toEqual([[originAt(1), originAt(3)]])
  })

  it("re-runs the calls one by one after a mapping refusal with the same origins", async () => {
    const seen: (readonly (ReadIntent | undefined)[] | undefined)[] = []
    const source: CoreSource = {
      read: (parts, options) => {
        seen.push(options.origins)
        if (parts.length > 1)
          return Promise.reject(new DataError("data.unsupported-predicate"))
        return Promise.resolve({
          items: [{ ok: true, rows: { rows: [] }, epoch: null }],
        })
      },
      run: () => Promise.reject(new Error("unexpected run")),
      close: () => {},
    }
    const batcher = createBatcher(source, { sleep: SLEEP })
    await Promise.all([
      batcher.read([queryOf(TASK_REF, 1)], [originAt(0)]),
      batcher.read([queryOf(ORG_REF, 2)], [originAt(1)]),
    ])
    expect(seen).toEqual([
      [originAt(0), originAt(1)],
      [originAt(0)],
      [originAt(1)],
    ])
  })

  it("passes no origin for a call that had none", async () => {
    const r = recording()
    const batcher = createBatcher(r.source, { sleep: SLEEP })
    await Promise.all([
      batcher.read([queryOf(TASK_REF, 1)]),
      batcher.read([queryOf(ORG_REF, 2)], [originAt(1)]),
    ])
    expect(r.seen).toEqual([[undefined, originAt(1)]])
  })
})

describe("watchReads in the core", () => {
  const view: ViewSpec = { kind: "keys", object: ORG, keys: [key(1)] }
  const withInclude: ViewSpec = {
    kind: "full",
    object: TASK,
    include: ["org"],
  }

  /** Ядро, де частина `rights` йде окремим запитом від частини виду. */
  const build = (options: { rights?: boolean } = {}) => {
    const order: ("rights" | "query")[] = []
    const h = setup({
      mode: "auto",
      rightsSnapshot: options.rights === true,
      adapter: (fake) => ({
        capabilities: fake.adapter.capabilities,
        read: (wires) => {
          order.push("query")
          return fake.adapter.read(wires)
        },
      }),
      server: (fake) => ({
        run: fake.server.run,
        read: (wires) => {
          order.push("rights")
          return fake.adapter.read(wires)
        },
      }),
    })
    if (options.rights === true) {
      h.fake.rightsSnapshot = {
        userId: "00000000-0000-4000-8000-0000000000a1",
        scopeSets: [],
        rights: [],
        members: [],
        dimensionValues: [],
      }
      h.fake.rightsVersion = "1".repeat(64)
    }
    const events: ReadEvent[] = []
    const off = h.inspect.watchReads((event) => events.push(event))
    return { ...h, order, events, off }
  }

  it("emits the injected rights part with its own row S3 and the view part with the origin of the call, each with the number of its request", async () => {
    const h = build({ rights: true })
    seed(h.fake, 1, 2)
    watch(h.core.view(view))
    await settle()
    const rights = h.events.find((e) => e.site === "S3")!
    expect(rights.target).toEqual({ kind: "service", service: "rights" })
    const others = h.events.filter((e) => e.site !== "S3")
    expect(others.length).toBeGreaterThan(0)
    for (const event of others) {
      expect(event.target).toEqual({ kind: "view", object: ORG })
    }
    // Частина `rights` пішла запитом, що викликав сервер-адаптер, частина
    // виду — запитом адаптера: номер запиту кожної події — місце її виклику.
    expect(h.order[rights.request - 1]).toBe("rights")
    for (const event of others) {
      expect(h.order[event.request - 1]).toBe("query")
    }
  })

  it("gives no event to a part of an object marked stale: only the version part of the request has one", async () => {
    const h = build()
    seed(h.fake, 1, 2)
    h.core.staleClient(ORG)
    watch(h.core.view(view))
    await settle()
    // Запит усе ж іде — з частиною `version`; частини об'єкта в ньому немає.
    expect(h.fake.requests).toEqual([1])
    expect(h.events).toEqual([
      expect.objectContaining({
        target: { kind: "service", service: "version" },
        request: 1,
      }),
    ])
  })

  it("keeps the event of a view part whose include target went stale (a copy of the part)", async () => {
    const h = build()
    seed(h.fake, 1, 2)
    h.core.staleClient(ORG)
    watch(h.core.view(withInclude))
    await settle()
    const viewEvents = h.events.filter((e) => e.target.kind === "view")
    expect(viewEvents).toEqual([
      expect.objectContaining({
        reason: "mount",
        target: { kind: "view", object: TASK },
        request: 1,
      }),
    ])
  })

  it("supports several listeners and unsubscribes one without touching the others", async () => {
    const h = build()
    seed(h.fake, 1, 2)
    const second: ReadEvent[] = []
    const offSecond = h.inspect.watchReads((event) => second.push(event))
    watch(h.core.view(view))
    await settle()
    expect(h.events.length).toBeGreaterThan(0)
    expect(second).toEqual(h.events)
    const before = h.events.length
    h.off()
    offSecond()
    const third: ReadEvent[] = []
    h.inspect.watchReads((event) => third.push(event))
    h.off()
    watch(h.core.view({ kind: "keys", object: ORG, keys: [key(2)] }))
    await settle()
    expect(h.events).toHaveLength(before)
    expect(second).toHaveLength(before)
    expect(third.length).toBeGreaterThan(0)
  })

  it("does not change the reads: the same fake log with and without a listener, even a throwing one", async () => {
    const run = async (listener?: () => void) => {
      const h = build()
      seed(h.fake, 1, 2)
      if (listener !== undefined) h.inspect.watchReads(listener)
      watch(h.core.view(view))
      await settle()
      return { requests: h.fake.requests, log: h.fake.log.map((r) => r.query) }
    }
    const without = await run()
    expect(await run(() => {})).toEqual(without)
    expect(
      await run(() => {
        throw new Error("a listener bug")
      })
    ).toEqual(without)
    expect(without.requests.length).toBeGreaterThan(0)
  })

  it("keeps the origins out of the log of the core", async () => {
    const h = build({ rights: true })
    seed(h.fake, 1, 2)
    watch(h.core.view(view))
    await settle()
    expect(h.events.length).toBeGreaterThan(0)
    const logged = JSON.stringify(h.log)
    for (const event of h.events) {
      expect(logged).not.toContain(`"${event.site}"`)
      expect(logged).not.toContain(JSON.stringify(event.target))
    }
    expect(logged).not.toContain('"request"')
  })
})
