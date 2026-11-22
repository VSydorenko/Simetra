import {
  ZERO_UUID,
  channelTopic,
  type CatalogEntry,
  type RightsRow,
  type RightsSnapshot,
} from "simetra/model"
import { describe, expect, it, vi } from "vitest"
import {
  SCOPE_KIND_ID,
  catalogEntry,
} from "../../../model/runtime/__tests__/entries"
import { createDataRuntime } from "../../runtime/runtime"
import { runtimeHandleOf } from "../../runtime/handle"
import {
  SERVER_HASH,
  clientCatalog,
  controlledTransport,
  sessionChanged,
} from "../../__tests__/support"
import { createFakeSource } from "../testing/fake-source"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import type { ViewSpec } from "../types"
import {
  TASK,
  key,
  seed,
  settle,
  setup,
  taskValues,
  S,
  task,
  org,
} from "./core-support"

/*
 * Підписки приймача (план B5b-3, задача 2; спека П4-B §8.4): які канали
 * змін тримає ядро за знімком прав і активними виглядами.
 */

const USER = "00000000-0000-4000-8000-0000000000a1"
const S2 = "00000000-0000-4000-8000-0000000000b2"
const S3 = "00000000-0000-4000-8000-0000000000b3"
const PLAIN_ID = "00000000-0000-4000-8000-0000000000d1"
const PLAIN = "Catalog.Plain"
const V1 = "1".repeat(64)
const V2 = "2".repeat(64)
const V3 = "3".repeat(64)

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

const read = (scope: string, over: Partial<RightsRow> = {}): RightsRow => ({
  level: "scope",
  levelId: null,
  scope,
  container: null,
  object: "task",
  action: "read",
  extent: "any",
  dimensionId: null,
  ...over,
})
const snapshotOf = (
  scopes: readonly string[],
  rights: RightsRow[] = scopes.map((scope) => read(scope))
): RightsSnapshot => ({
  userId: USER,
  scopeSets: scopes.map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
  rights,
  members: [],
  dimensionValues: [],
})

const changes = (object: string, scope: string, kind = SCOPE_KIND_ID) =>
  channelTopic({ kind: "changes", scopeKindId: kind, scope, object })
const taskChannel = (scope: string) => changes(task.id, scope)

const list = (...keys: string[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys,
})

function harness(
  snapshot: RightsSnapshot,
  options: { objects?: readonly CatalogEntry[]; rightsSnapshot?: boolean } = {}
) {
  const transport = createFakeSignalTransport()
  const subscribe = vi.spyOn(transport, "subscribe")
  const h = setup({
    rightsSnapshot: options.rightsSnapshot ?? true,
    signals: transport,
    objects: options.objects ?? [task, org, plain],
  })
  h.fake.rightsSnapshot = snapshot
  h.fake.rightsVersion = V1
  return { ...h, transport, subscribe }
}

const channelsOf = (t: ReturnType<typeof createFakeSignalTransport>) =>
  [...t.subscribed().keys()].sort()

const replaceSnapshot = async (
  h: ReturnType<typeof harness>,
  snapshot: RightsSnapshot,
  version: string
) => {
  h.fake.rightsSnapshot = snapshot
  h.fake.rightsVersion = version
  h.core.requestRights()
  await settle()
}

describe("receiver subscriptions", () => {
  it("subscribes the scopes of scopeSets the user may subscribe to, and no other", async () => {
    // S — з правом, S2 — у scopeSets без `read` (учасник), S3 — поза scopeSets.
    const h = harness(
      snapshotOf([S, S2], [read(S), read(S2, { action: "update" })])
    )
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(channelsOf(h.transport)).toEqual([taskChannel(S)])
  })

  it("opens no channel for a container-only right", async () => {
    const h = harness(
      snapshotOf([S], [read(S, { level: "container", container: S2 })])
    )
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(h.subscribe).not.toHaveBeenCalled()
  })

  it("takes the channel of an unscoped object from ZERO_UUID, and none for an object without a view or a signal", async () => {
    const h = harness({
      ...snapshotOf([S]),
      rights: [
        read(S),
        { ...read(S), object: "plain", level: "global", scope: null },
      ],
    })
    h.fake.insert(PLAIN, { ref: key(1) })
    h.core
      .view({ kind: "keys", object: PLAIN, keys: [key(1)] })
      .subscribe(() => {})
    await settle()
    expect(channelsOf(h.transport)).toEqual([
      changes(PLAIN_ID, ZERO_UUID, ZERO_UUID),
    ])
  })

  it("subscribes nothing for an object that takes no change signal", async () => {
    const quiet = { ...task, signal: false }
    const h = harness(snapshotOf([S]), { objects: [quiet, org, plain] })
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(h.subscribe).not.toHaveBeenCalled()
  })

  it("subscribes nothing before the first snapshot and nothing for a guest", async () => {
    const guest = { ...snapshotOf([S]), userId: null }
    const h = harness(guest)
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(h.subscribe).not.toHaveBeenCalled()
  })

  it("adds the scopes of the rows of active views for a scoped publicRead object", async () => {
    const open = { ...task, publicRead: "anon" as const }
    const h = harness(snapshotOf([S], []), { objects: [open, org, plain] })
    h.fake.insert(TASK, taskValues(1))
    h.fake.insert(TASK, taskValues(2, { org: S3 }))
    h.core.view(list(key(1), key(2))).subscribe(() => {})
    await settle()
    // Скоуп S3 — не в scopeSets, лише у рядку вигляду.
    expect(channelsOf(h.transport)).toEqual(
      [taskChannel(S), taskChannel(S3)].sort()
    )
  })

  it("adds one subscription when a snapshot adds a scope, and does not resubscribe the others", async () => {
    const h = harness(snapshotOf([S]))
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    await replaceSnapshot(h, snapshotOf([S, S2]), V2)
    expect(h.subscribe).toHaveBeenCalledTimes(2)
    expect(h.subscribe.mock.calls[1]![0]).toEqual([taskChannel(S2)])
    expect(channelsOf(h.transport)).toEqual(
      [taskChannel(S), taskChannel(S2)].sort()
    )
    // Знімок без змін у каналах — жодної нової підписки.
    await replaceSnapshot(
      h,
      snapshotOf([S, S2], [read(S), read(S2, { extent: "own" })]),
      V3
    )
    expect(h.subscribe).toHaveBeenCalledTimes(2)
  })

  it("unsubscribes exactly the channel a replacing snapshot no longer allows", async () => {
    const h = harness(snapshotOf([S, S2]))
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(channelsOf(h.transport)).toHaveLength(2)
    await replaceSnapshot(h, snapshotOf([S]), V2)
    expect(channelsOf(h.transport)).toEqual([taskChannel(S)])
  })

  it("adds the channel of an object whose first view appears later, without resubscribing the first", async () => {
    const h = harness({
      ...snapshotOf([S]),
      rights: [
        read(S),
        { ...read(S), object: "plain", level: "global", scope: null },
      ],
    })
    seed(h.fake, 1, 1)
    h.fake.insert(PLAIN, { ref: key(1) })
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(h.subscribe).toHaveBeenCalledTimes(1)
    h.core
      .view({ kind: "keys", object: PLAIN, keys: [key(1)] })
      .subscribe(() => {})
    await settle()
    expect(h.subscribe).toHaveBeenCalledTimes(2)
    expect(h.subscribe.mock.calls[1]![0]).toEqual([
      changes(PLAIN_ID, ZERO_UUID, ZERO_UUID),
    ])
  })

  it("does not repeat a channel refused with auth until the next snapshot replacement", async () => {
    const h = harness(snapshotOf([S, S2]))
    h.transport.refused.add(taskChannel(S2))
    seed(h.fake, 1, 2)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(channelsOf(h.transport)).toEqual([taskChannel(S)])
    expect(h.subscribe).toHaveBeenCalledTimes(2)
    // Новий вигляд пересчитує канали, але відхилений канал не повторюється.
    h.core.view(list(key(2))).subscribe(() => {})
    await settle()
    expect(h.subscribe).toHaveBeenCalledTimes(2)
    // Заміна знімка дозволяє повтор; тепер сервер приймає.
    h.transport.refused.clear()
    await replaceSnapshot(h, snapshotOf([S, S2]), V2)
    expect(h.subscribe).toHaveBeenCalledTimes(3)
    expect(channelsOf(h.transport)).toEqual(
      [taskChannel(S), taskChannel(S2)].sort()
    )
  })

  it("does not depend on whether auth comes before or after subscribe returns", async () => {
    const h = harness(snapshotOf([S]))
    // Транспорт, що відмовляє асинхронно: `auth` після повернення `Unsubscribe`.
    const off = vi.fn()
    let onError: ((e: { kind: "auth"; channel: string }) => void) | undefined
    h.subscribe.mockImplementation((channels, onSignal, error) => {
      onError = error as typeof onError
      return () => off(channels)
    })
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    onError!({ kind: "auth", channel: taskChannel(S) })
    expect(off).toHaveBeenCalledWith([taskChannel(S)])
    h.core.view(list(key(1), key(1))).subscribe(() => {})
    await settle()
    expect(h.subscribe).toHaveBeenCalledTimes(1)
  })

  it("has no receiver without the catalog flag: no subscriptions", async () => {
    const h = harness(snapshotOf([S]), { rightsSnapshot: false })
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(h.subscribe).not.toHaveBeenCalled()
    expect(h.transport.subscribed().size).toBe(0)
  })

  it("drops every subscription when the core closes", async () => {
    const h = harness(snapshotOf([S, S2]))
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(h.transport.subscribed().size).toBe(2)
    h.core.close("disposed")
    expect(h.transport.subscribed().size).toBe(0)
    await settle()
    expect(h.subscribe).toHaveBeenCalledTimes(2)
  })
})

// Відписка — порт транспорту: її виняток іде в журнал і не обриває кроку
// приймача — `purge` пари (Р12), відпускання каналів і закриття (Codex P1).
describe("an Unsubscribe that throws", () => {
  const throwingOff = (h: ReturnType<typeof harness>, bad: string) => {
    h.subscribe.mockRestore()
    const real = h.transport.subscribe.bind(h.transport)
    const spy = vi
      .spyOn(h.transport, "subscribe")
      .mockImplementation((channels, onSignal, onError) => {
        const off = real(channels, onSignal, onError)
        return () => {
          off()
          if (channels.includes(bad)) throw new Error("off failed")
        }
      })
    return spy
  }
  const failed = (h: ReturnType<typeof harness>) =>
    h.log.filter((e) => e.kind === "listener-failed")

  it("on auth: the rows of the pair are purged and the error is logged", async () => {
    const h = harness(snapshotOf([S]))
    throwingOff(h, taskChannel(S))
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(h.inspect.rowCount()).toBe(1)
    h.transport.fail({ kind: "auth", channel: taskChannel(S) })
    await settle()
    expect(h.inspect.rowCount()).toBe(0)
    expect(failed(h)).toHaveLength(1)
  })

  it("on release by a replacing snapshot: every channel it no longer allows is released", async () => {
    const h = harness(snapshotOf([S, S2, S3]))
    throwingOff(h, taskChannel(S2))
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(channelsOf(h.transport)).toHaveLength(3)
    await replaceSnapshot(h, snapshotOf([S]), V2)
    expect(channelsOf(h.transport)).toEqual([taskChannel(S)])
    expect(failed(h)).toHaveLength(1)
  })

  it("on close: every other subscription is dropped and the error is logged", async () => {
    const h = harness(snapshotOf([S, S2]))
    throwingOff(h, taskChannel(S))
    seed(h.fake, 1, 1)
    h.core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(h.transport.subscribed().size).toBe(2)
    h.core.close("disposed")
    expect(h.transport.subscribed().size).toBe(0)
    expect(failed(h)).toHaveLength(1)
  })
})

describe("the runtime owns the signal transport", () => {
  const SUBJECT = "user-1"
  const READ = { type: "read" as const, items: [{ type: "version" }] }

  function runtimeWith(
    options: { rightsSnapshot?: boolean; onSessionChanged?: () => void } = {}
  ) {
    const transport = createFakeSignalTransport()
    const factory = vi.fn<(subject: string) => typeof transport>(
      () => transport
    )
    // Канал, що тримається напряму: закриття транспорту знімає його.
    transport.subscribe(
      ["held"],
      () => {},
      () => {}
    )
    const wire = controlledTransport()
    const runtime = createDataRuntime({
      catalog: {
        ...clientCatalog(),
        ...(options.rightsSnapshot === false ? {} : { rightsSnapshot: true }),
      },
      transport: wire.transport,
      subject: SUBJECT,
      signals: factory,
      log: () => {},
      ...(options.onSessionChanged === undefined
        ? {}
        : { onSessionChanged: options.onSessionChanged }),
    })
    return { runtime, transport, factory, wire }
  }

  it("creates the transport once, for the subject, and only with rightsSnapshot", () => {
    const withFlag = runtimeWith()
    expect(withFlag.factory).toHaveBeenCalledExactlyOnceWith(SUBJECT)
    const without = runtimeWith({ rightsSnapshot: false })
    expect(without.factory).not.toHaveBeenCalled()
  })

  it("closes the transport synchronously in dispose()", () => {
    const { runtime, transport } = runtimeWith()
    expect(transport.closed()).toBe(false)
    runtime.dispose()
    expect(transport.closed()).toBe(true)
    expect(transport.subscribed().size).toBe(0)
  })

  it("closes the transport in dispose() inside a commit, before the deferred core.close", () => {
    const { runtime, transport } = runtimeWith()
    const { core } = runtimeHandleOf(runtime)
    let closedInside: boolean | undefined
    core.commit(() => {
      runtime.dispose()
      closedInside = transport.closed()
    }, core.token())
    expect(closedInside).toBe(true)
  })

  it("closes the transport before onSessionChanged of the host", async () => {
    let seen: { closed: boolean; held: number } | undefined
    const ref: { transport?: ReturnType<typeof createFakeSignalTransport> } = {}
    const run = runtimeWith({
      onSessionChanged: () => {
        seen = {
          closed: ref.transport!.closed(),
          held: ref.transport!.subscribed().size,
        }
      },
    })
    ref.transport = run.transport
    const pending = runtimeHandleOf(run.runtime).send(READ)
    run.wire.respond(sessionChanged())
    await expect(pending).rejects.toBeDefined()
    expect(seen).toEqual({ closed: true, held: 0 })
  })
})

describe("the runtime with a rights snapshot over a fake server", () => {
  const rightsRows = [
    read(S),
    { ...read(S), object: "plain", level: "global" as const, scope: null },
  ]
  function world() {
    const fake = createFakeSource({ objects: [task, org, plain] })
    fake.rightsSnapshot = snapshotOf([S], rightsRows)
    fake.rightsVersion = V1
    seed(fake, 1, 1)
    fake.insert(PLAIN, { ref: key(1) })
    const wire = async (body: { request: unknown }) => {
      const { items } = body.request as { items: unknown[] }
      const read = await fake.adapter.read(
        items as Parameters<typeof fake.adapter.read>[0]
      )
      return {
        ok: true as const,
        value: { ...read, epoch: null },
        serverHash: SERVER_HASH,
      }
    }
    const make = (transport = createFakeSignalTransport()) => ({
      transport,
      runtime: createDataRuntime({
        catalog: {
          ...clientCatalog(),
          objects: [task, org, plain],
          rightsSnapshot: true,
        },
        transport: wire,
        subject: "user-1",
        signals: () => transport,
        log: () => {},
      }),
    })
    return { fake, make }
  }
  const plainView: ViewSpec = { kind: "keys", object: PLAIN, keys: [key(1)] }

  it("never subscribes after the transport is closed: a recompute queued before a dispose() inside a commit", async () => {
    const { make } = world()
    const { runtime, transport } = make()
    const { core } = runtimeHandleOf(runtime)
    core.view(list(key(1))).subscribe(() => {})
    await settle()
    expect(transport.subscribed().size).toBe(1)
    // Новий вигляд ставить перерахунок підписок; `dispose()` усередині
    // `commit` — того ж ходу, до мікрозадачі перерахунку.
    core.view(plainView).subscribe(() => {})
    core.commit(() => runtime.dispose(), core.token())
    await settle()
    expect(transport.closed()).toBe(true)
    expect(transport.subscribesAfterClose()).toBe(0)
  })

  it("subscribes the channel of a hydrated view once the reconciliation brings the snapshot", async () => {
    const { make } = world()
    const server = make()
    runtimeHandleOf(server.runtime)
      .core.view(list(key(1)))
      .subscribe(() => {})
    await settle()
    const snapshot = JSON.parse(JSON.stringify(server.runtime.dehydrate()))
    server.runtime.dispose()
    const client = make()
    client.runtime.hydrate(snapshot)
    runtimeHandleOf(client.runtime)
      .core.view(list(key(1)))
      .subscribe(() => {})
    await settle()
    // Знімка прав ще немає: гідрація його не несе, каналів теж.
    expect(client.transport.subscribed().size).toBe(0)
    client.runtime.endHydration()
    await settle()
    expect([...client.transport.subscribed().keys()]).toEqual([taskChannel(S)])
  })

  it("closes the transport when building the runtime fails after the factory", () => {
    const transport = createFakeSignalTransport()
    expect(() =>
      createDataRuntime({
        catalog: {
          ...clientCatalog(),
          objects: [task, org, plain],
          rightsSnapshot: true,
        },
        transport: async () => {
          throw new Error("unused")
        },
        subject: "user-1",
        signals: () => transport,
        sources: {
          override: {
            [TASK]: () => {
              throw new Error("adapter factory failed")
            },
          },
        },
      })
    ).toThrow("adapter factory failed")
    expect(transport.closed()).toBe(true)
  })

  it("keeps the original build error and logs once when close() of the transport throws too", () => {
    const transport = createFakeSignalTransport()
    transport.close = () => {
      throw new Error("close boom")
    }
    const log = vi.fn()
    expect(() =>
      createDataRuntime({
        catalog: {
          ...clientCatalog(),
          objects: [task, org, plain],
          rightsSnapshot: true,
        },
        transport: async () => {
          throw new Error("unused")
        },
        subject: "user-1",
        signals: () => transport,
        log,
        sources: {
          override: {
            [TASK]: () => {
              throw new Error("adapter factory failed")
            },
          },
        },
      })
    ).toThrow("adapter factory failed")
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0]![0]).toMatchObject({ kind: "listener-failed" })
  })

  it("still closes the transport and the core when a channel Unsubscribe throws", async () => {
    const { make } = world()
    const { runtime, transport } = make()
    const real = transport.subscribe.bind(transport)
    vi.spyOn(transport, "subscribe").mockImplementation((...args) => {
      real(...args)
      return () => {
        throw new Error("unsubscribe boom")
      }
    })
    const { core } = runtimeHandleOf(runtime)
    const handle = core.view(list(key(1)))
    handle.subscribe(() => {})
    await settle()
    expect(transport.subscribed().size).toBe(1)
    runtime.dispose()
    expect(transport.closed()).toBe(true)
    await settle()
    expect(handle.getSnapshot().status).toBe("purged")
  })
})
