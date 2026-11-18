import { describe, expect, it, vi } from "vitest"
import {
  CommandFailure,
  PAYLOAD_MAX_BYTES,
  jsonBytes,
  type CatalogEntry,
  type ClientCatalog,
  type DataRequest,
  type DataResponse,
  type DataTransport,
  type SourceAdapter,
} from "simetra/model"
import {
  createDataRuntime,
  type DataLogEntry,
  type DataRuntime,
  type DataRuntimeOptions,
} from "../index"
import { runtimeHandleOf } from "../runtime/handle"
import { inspectCore } from "../store/core"
import {
  OBJECTS,
  ORG,
  S,
  TASK,
  key,
  org,
  seed,
  settle,
  task,
} from "../store/__tests__/core-support"
import { createFakeSource, type FakeSource } from "../store/testing/fake-source"
import type { ViewSpec } from "../store/types"
import {
  OBJECT_ID,
  SERVER_HASH,
  SUBJECT,
  answeringTransport,
  clientCatalog,
  controlledTransport,
  failed,
  ok,
  sessionChanged,
} from "./support"

const ID = "11111111-1111-4111-8111-111111111111"
const DISPOSED = { code: "command.unavailable", reason: "disposed" }
const SESSION_CHANGED = {
  code: "command.unauthenticated",
  reason: "session-changed",
} as const

const card = (id = ID): DataRequest["request"] => ({
  type: "read",
  items: [{ type: "query", query: { object: OBJECT_ID, id } }],
})
const VERSION: DataRequest["request"] = {
  type: "read",
  items: [{ type: "version" }],
}

// Відмову перевіряємо за кодом і причиною, а не за текстом.
async function failureOf(promise: Promise<unknown>) {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(CommandFailure)
  return (error as CommandFailure).error
}

describe("createDataRuntime", () => {
  it("validates the catalog", () => {
    const { transport } = answeringTransport(ok(null))
    expect(() =>
      createDataRuntime({
        catalog: { ...clientCatalog(), format: 2 },
        transport,
        subject: SUBJECT,
      })
    ).toThrow()
  })

  it("exposes the subject and starts undisposed", () => {
    const { transport } = answeringTransport(ok(null))
    const runtime = createDataRuntime({
      catalog: clientCatalog(),
      transport,
      subject: SUBJECT,
    })
    expect(runtime.subject).toBe(SUBJECT)
    expect(runtime.disposed).toBe(false)
  })
})

describe("runtime transport wrapper", () => {
  it("adds the subject to every request and returns the value", async () => {
    const { transport, calls } = answeringTransport(ok({ rows: [] }))
    const runtime = createDataRuntime({
      catalog: clientCatalog(),
      transport,
      subject: SUBJECT,
    })
    const { send } = runtimeHandleOf(runtime)
    await expect(send(card())).resolves.toEqual({ rows: [] })
    await expect(send(VERSION)).resolves.toEqual({ rows: [] })
    expect(calls).toEqual([
      { subject: SUBJECT, request: card() },
      { subject: SUBJECT, request: VERSION },
    ])
  })

  describe("payload limit", () => {
    // Тіло з кирилицею: символів менше за межу, а байтів UTF-8 — більше, тож
    // міра в символах пропустила б запит, який відкине host.
    const bodyOf = (bytes: number): DataRequest["request"] => {
      const overhead = jsonBytes({ subject: SUBJECT, request: card("") })
      const fill = bytes - overhead
      return card("ж".repeat(Math.floor(fill / 2)) + "a".repeat(fill % 2))
    }

    it("sends a body of exactly the limit", async () => {
      const { transport, calls } = answeringTransport(ok(null))
      const { send } = runtimeHandleOf(
        createDataRuntime({
          catalog: clientCatalog(),
          transport,
          subject: SUBJECT,
        })
      )
      const request = bodyOf(PAYLOAD_MAX_BYTES)
      expect(jsonBytes({ subject: SUBJECT, request })).toBe(PAYLOAD_MAX_BYTES)
      await send(request)
      expect(calls).toHaveLength(1)
    })

    it("refuses a body one UTF-8 byte over the limit without the transport", async () => {
      const { transport, calls } = answeringTransport(ok(null))
      const { send } = runtimeHandleOf(
        createDataRuntime({
          catalog: clientCatalog(),
          transport,
          subject: SUBJECT,
        })
      )
      const request = bodyOf(PAYLOAD_MAX_BYTES + 1)
      const body = { subject: SUBJECT, request }
      expect(JSON.stringify(body).length).toBeLessThan(PAYLOAD_MAX_BYTES)
      expect(await failureOf(send(request))).toEqual({
        code: "command.invalid",
        reason: "payload-too-large",
      })
      expect(calls).toHaveLength(0)
    })
  })

  describe("transport exception", () => {
    it.each([
      ["rejects", () => Promise.reject(new TypeError("network"))],
      [
        "throws",
        () => {
          throw new TypeError("network")
        },
      ],
    ] as const)(
      "%s: command.unavailable without a reason, the original to the log",
      async (_, fail) => {
        const log = vi.fn<(entry: DataLogEntry) => void>()
        const { send } = runtimeHandleOf(
          createDataRuntime({
            catalog: clientCatalog(),
            transport: fail,
            subject: SUBJECT,
            log,
          })
        )
        expect(await failureOf(send(card()))).toEqual({
          code: "command.unavailable",
        })
        expect(log).toHaveBeenCalledTimes(1)
        expect(log).toHaveBeenCalledWith({
          kind: "transport-failed",
          error: new TypeError("network"),
        })
      }
    )

    it("keeps the outcome when the log sink throws", async () => {
      const log = vi.fn(() => {
        throw new Error("sink down")
      })
      const { send } = runtimeHandleOf(
        createDataRuntime({
          catalog: clientCatalog(),
          transport: () => Promise.reject(new TypeError("network")),
          subject: SUBJECT,
          log,
        })
      )
      expect(await failureOf(send(card()))).toEqual({
        code: "command.unavailable",
      })
      expect(log).toHaveBeenCalledTimes(1)
    })
  })

  describe("session-changed", () => {
    it("calls onSessionChanged once and disposes the runtime", async () => {
      const { transport, respond } = controlledTransport()
      const onSessionChanged = vi.fn()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
        onSessionChanged,
      })
      const { send } = runtimeHandleOf(runtime)
      const first = send(card())
      const second = send(card())
      respond(sessionChanged())
      expect(await failureOf(first)).toEqual({
        code: "command.unauthenticated",
        reason: "session-changed",
      })
      expect(runtime.disposed).toBe(true)
      respond(sessionChanged())
      expect(await failureOf(second)).toEqual({
        code: "command.unauthenticated",
        reason: "session-changed",
      })
      expect(onSessionChanged).toHaveBeenCalledTimes(1)
    })

    it("aborts the core session signal", async () => {
      const { transport, respond } = controlledTransport()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const { core, send } = runtimeHandleOf(runtime)
      expect(core.signal.aborted).toBe(false)
      const request = send(card())
      respond(sessionChanged())
      await failureOf(request)
      expect(core.signal.aborted).toBe(true)
    })

    it("rejects with session-changed and re-raises a throwing callback asynchronously", async () => {
      // Підміна `queueMicrotask`: справжній кидок у мікрозадачі став би
      // необробленою помилкою прогону.
      const deferred: (() => void)[] = []
      const queue = vi
        .spyOn(globalThis, "queueMicrotask")
        .mockImplementation((task) => {
          deferred.push(task)
        })
      try {
        const { transport, respond } = controlledTransport()
        const thrown = new Error("callback failed")
        const runtime = createDataRuntime({
          catalog: clientCatalog(),
          transport,
          subject: SUBJECT,
          onSessionChanged: () => {
            throw thrown
          },
        })
        const request = runtimeHandleOf(runtime).send(card())
        respond(sessionChanged())
        expect(await failureOf(request)).toEqual(SESSION_CHANGED)
        expect(runtime.disposed).toBe(true)
        expect(deferred).toHaveLength(1)
        expect(() => deferred[0]!()).toThrow(thrown)
      } finally {
        queue.mockRestore()
      }
    })

    it("rejects a later success with the session-changed code", async () => {
      const { transport, respond } = controlledTransport()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const { send } = runtimeHandleOf(runtime)
      const first = send(card())
      const second = send(card())
      respond(sessionChanged())
      await failureOf(first)
      respond(ok({ rows: [{ id: ID }] }))
      expect((await failureOf(second)).reason).toBe("session-changed")
    })

    it("refuses a new request with session-changed without the transport", async () => {
      const { transport, calls, respond } = controlledTransport()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const { send } = runtimeHandleOf(runtime)
      const first = send(card())
      respond(sessionChanged())
      await failureOf(first)
      expect(await failureOf(send(card()))).toEqual(SESSION_CHANGED)
      expect(calls).toHaveLength(1)
    })
  })

  describe("dispose()", () => {
    it("marks the runtime disposed", () => {
      const { transport } = answeringTransport(ok(null))
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      expect(runtime.disposed).toBe(false)
      runtime.dispose()
      expect(runtime.disposed).toBe(true)
    })

    it("aborts the core session signal", () => {
      const { transport } = answeringTransport(ok(null))
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const { core } = runtimeHandleOf(runtime)
      expect(core.signal.aborted).toBe(false)
      runtime.dispose()
      expect(core.signal.aborted).toBe(true)
    })

    it("refuses a later request without the transport", async () => {
      const { transport, calls } = answeringTransport(ok(null))
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      runtime.dispose()
      expect(await failureOf(runtimeHandleOf(runtime).send(card()))).toEqual(
        DISPOSED
      )
      expect(calls).toHaveLength(0)
    })

    it("rejects an in-flight request whose response arrives after it", async () => {
      const { transport, respond } = controlledTransport()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const pending = runtimeHandleOf(runtime).send(card())
      runtime.dispose()
      respond(ok({ rows: [{ id: ID }] }))
      expect(await failureOf(pending)).toEqual(DISPOSED)
    })

    it("rejects an in-flight request whose transport fails after it", async () => {
      const { transport, pending } = controlledTransport()
      const log = vi.fn()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
        log,
      })
      const request = runtimeHandleOf(runtime).send(card())
      runtime.dispose()
      pending[0]!.fail(new TypeError("network"))
      expect(await failureOf(request)).toEqual(DISPOSED)
      expect(log).not.toHaveBeenCalled()
    })

    it("does not call onSessionChanged for a session-changed after it", async () => {
      const { transport, respond } = controlledTransport()
      const onSessionChanged = vi.fn()
      const runtime = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
        onSessionChanged,
      })
      const request = runtimeHandleOf(runtime).send(card())
      runtime.dispose()
      respond(sessionChanged())
      expect(await failureOf(request)).toEqual(DISPOSED)
      expect(onSessionChanged).not.toHaveBeenCalled()
    })
  })

  describe("isolation", () => {
    it("keeps two runtimes independent: disposing one leaves the other answering", async () => {
      const { transport } = answeringTransport(ok(null))
      const one = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      const two = createDataRuntime({
        catalog: clientCatalog(),
        transport,
        subject: SUBJECT,
      })
      one.dispose()
      expect(await failureOf(runtimeHandleOf(one).send(card()))).toEqual(
        DISPOSED
      )
      expect(await runtimeHandleOf(two).send(card())).toBeNull()
      expect(two.disposed).toBe(false)
    })
  })
})

// ------------------------------------------------------------ ядро рантайму

/*
 * Рантайм над ядром T4: транспорт тут — тонкий міст до фейкового сервера
 * ядра, тож запит іде справжньою обгорткою `send` і справжнім адаптером
 * Server Function, а тест сам вирішує, коли сервер відповідає.
 */
function serverTransport(fake: FakeSource) {
  const calls: DataRequest[] = []
  // Наступна відповідь замість читання (наприклад, `session-changed`).
  const replies: DataResponse[] = []
  const transport: DataTransport = async (body) => {
    calls.push(body)
    const reply = replies.shift()
    if (reply !== undefined) return reply
    if (body.request.type !== "read") return ok(null)
    // Частини `query` читає фейк; інша частина (`version` фабрики-
    // перевизначення) — без читання.
    const parts = body.request.items as {
      type: string
      query: Parameters<SourceAdapter["read"]>[0][number]["query"]
    }[]
    if (parts.some((part) => part.type !== "query")) return ok(null)
    return ok(
      await fake.adapter.read(parts as Parameters<SourceAdapter["read"]>[0])
    )
  }
  return { transport, calls, replies }
}

const catalogOf = (objects: readonly CatalogEntry[]): ClientCatalog => ({
  ...clientCatalog(),
  objects: [...objects],
})

const cardOf = (n: number): ViewSpec => ({
  kind: "card",
  object: TASK,
  key: key(n),
})

function runtimeOver(
  fake: FakeSource,
  options: Partial<DataRuntimeOptions> = {}
) {
  const wire = serverTransport(fake)
  const runtime = createDataRuntime({
    catalog: catalogOf(OBJECTS),
    transport: wire.transport,
    subject: SUBJECT,
    log: () => {},
    ...options,
  })
  return { runtime, core: runtimeHandleOf(runtime).core, ...wire }
}

describe("runtime core", () => {
  it("purges every view in one notification before onSessionChanged", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 1)
    const events: string[] = []
    const { core, replies } = runtimeOver(fake, {
      onSessionChanged: () => events.push("onSessionChanged"),
    })
    const handle = core.view(cardOf(1))
    handle.subscribe(() => {
      const s = handle.getSnapshot()
      events.push(`${s.status}:${s.reason ?? ""}:${s.rows.length}`)
    })
    await settle()
    expect(handle.getSnapshot().status).toBe("ready")
    replies.push(sessionChanged())
    handle.refresh()
    events.length = 0
    await settle()
    expect(events).toEqual(["purged:session-changed:0", "onSessionChanged"])
    expect(inspectCore(core).rowCount()).toBe(0)
  })

  it("dispose() purges the views, drops a late response and sends nothing new", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    seed(fake, 1, 2)
    const { runtime, core, calls } = runtimeOver(fake)
    const handle = core.view(cardOf(1))
    handle.subscribe(() => {})
    await settle()
    expect(fake.pending).toHaveLength(1)
    runtime.dispose()
    const purged = handle.getSnapshot()
    expect(purged).toMatchObject({ status: "purged", reason: "disposed" })
    fake.deliverAll()
    await settle()
    expect(handle.getSnapshot()).toBe(purged)
    expect(inspectCore(core).rowCount()).toBe(0)
    const sent = calls.length
    handle.refresh()
    core.view(cardOf(2)).subscribe(() => {})
    await settle()
    expect(calls).toHaveLength(sent)
    expect(core.view(cardOf(2)).getSnapshot()).toBe(purged)
  })

  it("keeps rows of two runtimes of the same subject apart", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    seed(fake, 1, 1)
    const one = runtimeOver(fake)
    const two = runtimeOver(fake)
    const first = one.core.view(cardOf(1))
    first.subscribe(() => {})
    await settle()
    fake.deliverAll()
    await settle()
    expect(first.getSnapshot().rows).toHaveLength(1)
    const second = two.core.view(cardOf(1))
    second.subscribe(() => {})
    await settle()
    // Другий рантайм читає сам: рядка першого він не бачить.
    expect(second.getSnapshot()).toMatchObject({ status: "loading", rows: [] })
    expect(two.calls).toHaveLength(1)
    expect(inspectCore(two.core).rowCount()).toBe(0)
  })

  it("sends the subject of its own runtime with every core read", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 1)
    const one = runtimeOver(fake)
    const two = runtimeOver(fake, { subject: "user-2" })
    one.core.view(cardOf(1)).subscribe(() => {})
    two.core.view(cardOf(1)).subscribe(() => {})
    await settle()
    expect(one.calls.map((c) => c.subject)).toEqual([SUBJECT])
    expect(two.calls.map((c) => c.subject)).toEqual(["user-2"])
  })

  it("passes the core log to the runtime log and applies fullLimit", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 4)
    const log = vi.fn<(entry: DataLogEntry) => void>()
    const { core } = runtimeOver(fake, { fullLimit: 3, log })
    const handle = core.view({ kind: "full", object: TASK })
    handle.subscribe(() => {})
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ truncated: true })
    expect(log).toHaveBeenCalledWith({
      kind: "full-truncated",
      object: TASK,
      limit: 3,
    })
  })

  it("lets fullLimit override limits.fullLimit", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 4)
    const { core } = runtimeOver(fake, {
      fullLimit: 4,
      limits: { fullLimit: 3 },
    })
    const handle = core.view({ kind: "full", object: TASK })
    handle.subscribe(() => {})
    await settle()
    expect(handle.getSnapshot()).toMatchObject({ truncated: false })
    expect(handle.getSnapshot().rows).toHaveLength(4)
  })

  it.each([0, 1.5, -1])("refuses fullLimit %s with TypeError", (fullLimit) => {
    const fake = createFakeSource({ objects: OBJECTS })
    expect(() => runtimeOver(fake, { fullLimit })).toThrow(TypeError)
  })

  it("refuses an override of an object outside the catalog with TypeError", () => {
    const fake = createFakeSource({ objects: OBJECTS })
    const factory = vi.fn(() => fake.adapter)
    expect(() =>
      runtimeOver(fake, {
        sources: { override: { "Catalog.Missing": factory } },
      })
    ).toThrow(TypeError)
    expect(factory).not.toHaveBeenCalled()
  })

  it("reads only the overridden object through the override", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 1)
    fake.insert(ORG, { ref: S })
    const reads: string[] = []
    const override: SourceAdapter = {
      capabilities: fake.adapter.capabilities,
      read: (items) => {
        reads.push(...items.map((item) => item.query.object))
        return fake.adapter.read(items)
      },
    }
    const { core, calls } = runtimeOver(fake, {
      sources: { override: { [ORG]: () => override } },
    })
    const orgView = core.view({ kind: "card", object: ORG, key: S })
    orgView.subscribe(() => {})
    core.view(cardOf(1)).subscribe(() => {})
    await settle()
    expect(orgView.getSnapshot().rows).toHaveLength(1)
    expect(reads).toEqual([org.id])
    expect(
      calls.map(
        (c) =>
          c.request.type === "read" &&
          (c.request.items[0] as { query: { object: string } }).query.object
      )
    ).toEqual([task.id])
  })

  it("closes on session-changed from an override adapter, then calls onSessionChanged once", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 1)
    fake.insert(ORG, { ref: S })
    const events: string[] = []
    // Адаптер звіряє `sub` сам (§5.3) і відмовляє без запиту.
    let refuse = false
    const override: SourceAdapter = {
      capabilities: fake.adapter.capabilities,
      read: (items) =>
        refuse
          ? Promise.reject(new CommandFailure(SESSION_CHANGED))
          : fake.adapter.read(items),
    }
    const { runtime, core } = runtimeOver(fake, {
      sources: { override: { [ORG]: () => override } },
      onSessionChanged: () => events.push("onSessionChanged"),
    })
    const taskView = core.view(cardOf(1))
    taskView.subscribe(() => {
      const s = taskView.getSnapshot()
      events.push(`${s.status}:${s.reason ?? ""}:${s.rows.length}`)
    })
    const one = core.view({ kind: "card", object: ORG, key: S })
    one.subscribe(() => {})
    const two = core.view({ kind: "full", object: ORG })
    two.subscribe(() => {})
    await settle()
    expect(taskView.getSnapshot().rows).toHaveLength(1)
    refuse = true
    events.length = 0
    // Дві відмови в польоті: друга колбека вже не кличе.
    one.refresh()
    two.refresh()
    await settle()
    expect(events).toEqual(["purged:session-changed:0", "onSessionChanged"])
    expect(runtime.disposed).toBe(true)
    expect(inspectCore(core).rowCount()).toBe(0)
  })

  it("refuses limits.readParallel 0 with TypeError and takes the default for undefined", () => {
    const fake = createFakeSource({ objects: OBJECTS })
    expect(() => runtimeOver(fake, { limits: { readParallel: 0 } })).toThrow(
      TypeError
    )
    expect(() =>
      runtimeOver(fake, { limits: { readParallel: undefined } })
    ).not.toThrow()
  })

  it("never sends a read queued in the limiter when disposed", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    seed(fake, 1, 2)
    const { runtime, core, calls } = runtimeOver(fake, {
      limits: { readParallel: 1 },
    })
    core.view(cardOf(1)).subscribe(() => {})
    core.view(cardOf(2)).subscribe(() => {})
    await settle()
    expect(calls).toHaveLength(1)
    runtime.dispose()
    fake.deliverAll()
    await settle()
    expect(calls).toHaveLength(1)
  })

  it("takes effect when dispose() is called from the log sink during a commit", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 4)
    const target: { runtime?: DataRuntime } = {}
    const { runtime, core } = runtimeOver(fake, {
      fullLimit: 3,
      log: (entry) => {
        if (entry.kind === "full-truncated") target.runtime?.dispose()
      },
    })
    target.runtime = runtime
    const handle = core.view({ kind: "full", object: TASK })
    handle.subscribe(() => {})
    await settle()
    expect(runtime.disposed).toBe(true)
    expect(handle.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "disposed",
    })
    expect(inspectCore(core).rowCount()).toBe(0)
  })

  it("gives the override factory this runtime's subject and send; drops its response after dispose()", async () => {
    const fake = createFakeSource({ objects: OBJECTS, mode: "manual" })
    fake.insert(ORG, { ref: S })
    const factory = vi.fn(
      (context: {
        subject: string
        send: (request: DataRequest["request"]) => Promise<unknown>
      }) => {
        void context.send(VERSION)
        return fake.adapter
      }
    )
    const { runtime, core, calls } = runtimeOver(fake, {
      subject: "user-2",
      sources: { override: { [ORG]: factory } },
    })
    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory.mock.calls[0]![0].subject).toBe("user-2")
    expect(calls).toEqual([{ subject: "user-2", request: VERSION }])
    const handle = core.view({ kind: "card", object: ORG, key: S })
    handle.subscribe(() => {})
    await settle()
    expect(fake.pending).toHaveLength(1)
    runtime.dispose()
    fake.deliverAll()
    await settle()
    expect(handle.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "disposed",
      rows: [],
    })
    expect(inspectCore(core).rowCount()).toBe(0)
    handle.refresh()
    await settle()
    expect(fake.log).toHaveLength(1)
  })
})

describe("residency", () => {
  it("is window unless the settings name the object", () => {
    const fake = createFakeSource({ objects: OBJECTS })
    expect(runtimeOver(fake).core.residencyOf(TASK)).toBe("window")
    const { core } = runtimeOver(fake, { residency: { [TASK]: "full" } })
    expect(core.residencyOf(TASK)).toBe("full")
  })

  it("refuses an object outside the catalog or a strategy it does not know", () => {
    const fake = createFakeSource({ objects: OBJECTS })
    expect(() =>
      runtimeOver(fake, { residency: { "Catalog.Nope": "full" } })
    ).toThrow(TypeError)
    expect(() =>
      runtimeOver(fake, {
        residency: { [TASK]: "both" as unknown as "full" },
      })
    ).toThrow(TypeError)
  })
})

// ------------------------------------------------- версія й позначка «застарілий»

// Не збігається з kernelHash фікстур (усі нулі).
const BAD_HASH = "1".repeat(64)

/** The raw value of a `read` request with one `version` part (spec §10). */
const versionAnswer = (
  snapshotHash: string,
  staleObjects: readonly CatalogEntry[] = []
): DataResponse => ({
  ...ok({
    epoch: null,
    items: [
      {
        ok: true,
        value: {
          snapshotHash,
          objects: Object.fromEntries(
            OBJECTS.map((o) => [
              o.id,
              staleObjects.includes(o) ? BAD_HASH : o.kernelHash,
            ])
          ),
        },
      },
    ],
  }),
  // Сервер кладе в `serverHash` той самий `snapshotHash`, що й у значення.
  serverHash: snapshotHash,
})

const isVersion = (call: DataRequest) =>
  call.request.type === "read" &&
  (call.request.items[0] as { type: string }).type === "version"

const versionCalls = (calls: readonly DataRequest[]) =>
  calls.filter(isVersion).length

const changed = (response: DataResponse, serverHash: string): DataResponse => ({
  ...response,
  serverHash,
})

function controlled(options: Partial<DataRuntimeOptions> = {}) {
  const wire = controlledTransport()
  const runtime = createDataRuntime({
    catalog: catalogOf(OBJECTS),
    transport: wire.transport,
    subject: SUBJECT,
    log: () => {},
    ...options,
  })
  const handle = runtimeHandleOf(runtime)
  return { runtime, core: handle.core, send: handle.send, ...wire }
}

describe("version check and the stale mark (§10)", () => {
  it("a changed serverHash asks for the version exactly once, and the answer asks for nothing", async () => {
    const t = controlled()
    const first = t.send(card())
    t.respond(changed(ok(null), "server-2"))
    await first
    await settle()
    expect(versionCalls(t.calls)).toBe(1)
    // Хеш уже запам'ятано: той самий хеш, поки версія летить, запиту не дає.
    const again = t.send(card())
    // Черга: спершу `version` (одна частина), потім другий запит.
    t.respond(versionAnswer("server-3"))
    t.respond(changed(ok(null), "server-2"))
    await again
    await settle()
    // `server-2` після `server-3` — зміна хеша: це відповідь не з частиною
    // `version`, тож вона просить версію; сама відповідь `version` — ні.
    expect(versionCalls(t.calls)).toBe(2)
    t.respond(versionAnswer("server-2"))
    await settle()
    expect(versionCalls(t.calls)).toBe(2)
    expect(t.pending).toHaveLength(0)
    // Хеш `server-2` запам'ятано: відповідь з ним нового запиту не дає.
    const third = t.send(card())
    t.respond(changed(ok(null), "server-2"))
    await third
    await settle()
    expect(versionCalls(t.calls)).toBe(2)
  })

  it("the first hash is compared with the snapshotHash of the client catalog", async () => {
    const t = controlled()
    const same = t.send(card())
    t.respond(ok(null))
    await same
    await settle()
    expect(versionCalls(t.calls)).toBe(0)
  })

  it("a refusal carries the hash too", async () => {
    const t = controlled()
    const refused = failureOf(t.send(card()))
    t.respond({
      ok: false,
      error: { code: "command.forbidden" },
      serverHash: "server-2",
    })
    await refused
    await settle()
    expect(versionCalls(t.calls)).toBe(1)
  })

  it("two calls within a microtask make one version part", async () => {
    const t = controlled()
    t.core.requestVersion()
    t.core.requestVersion()
    await settle()
    expect(versionCalls(t.calls)).toBe(1)
  })

  it("three calls while the request flies make exactly one tail", async () => {
    const t = controlled()
    t.core.requestVersion()
    await settle()
    expect(versionCalls(t.calls)).toBe(1)
    t.core.requestVersion()
    t.core.requestVersion()
    t.core.requestVersion()
    await settle()
    expect(versionCalls(t.calls)).toBe(1)
    t.respond(versionAnswer(SERVER_HASH))
    await settle()
    expect(versionCalls(t.calls)).toBe(2)
    t.respond(versionAnswer(SERVER_HASH))
    await settle()
    expect(versionCalls(t.calls)).toBe(2)
    expect(t.pending).toHaveLength(0)
  })

  it("the version answer only updates the hash: no request, rows untouched", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 1)
    const { core, calls, replies } = runtimeOver(fake)
    const handle = core.view(cardOf(1))
    handle.subscribe(() => {})
    await settle()
    const rows = handle.getSnapshot().rows
    const before = calls.length
    replies.push(versionAnswer("server-2"))
    core.requestVersion()
    await settle()
    expect(calls).toHaveLength(before + 1)
    expect(handle.getSnapshot().rows).toBe(rows)
  })

  it("isStale is sticky: a version answer without a divergence never clears it, onStaleClient once", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 1)
    const onStaleClient = vi.fn<(object: string) => void>()
    const { core, replies } = runtimeOver(fake, { onStaleClient })
    const handle = core.view(cardOf(1))
    const notified = vi.fn()
    handle.subscribe(notified)
    await settle()
    expect(handle.getSnapshot().isStale).toBeUndefined()
    const ask = async (answer: DataResponse) => {
      replies.push(answer)
      core.requestVersion()
      await settle()
    }
    await ask(versionAnswer(SERVER_HASH, [OBJECTS[0]!]))
    expect(handle.getSnapshot().isStale).toBe(true)
    expect(onStaleClient.mock.calls).toEqual([[TASK]])
    // Той самий стан: ні нового сповіщення, ні другого виклику колбека.
    const seen = notified.mock.calls.length
    await ask(versionAnswer(SERVER_HASH, [OBJECTS[0]!]))
    expect(notified.mock.calls.length).toBe(seen)
    expect(onStaleClient).toHaveBeenCalledTimes(1)
    // Розкатка по черзі: відповідь без розбіжності позначки не знімає (§10).
    await ask(versionAnswer(SERVER_HASH))
    expect(handle.getSnapshot().isStale).toBe(true)
    await ask(versionAnswer(SERVER_HASH, [OBJECTS[0]!]))
    expect(handle.getSnapshot().isStale).toBe(true)
    expect(onStaleClient).toHaveBeenCalledTimes(1)
  })

  it("an object the server does not know is stale", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 1)
    const { core, replies } = runtimeOver(fake)
    const handle = core.view(cardOf(1))
    handle.subscribe(() => {})
    await settle()
    replies.push(
      ok({
        epoch: null,
        items: [
          {
            ok: true,
            value: {
              snapshotHash: SERVER_HASH,
              objects: { [OBJECTS[1]!.id]: OBJECTS[1]!.kernelHash },
            },
          },
        ],
      })
    )
    core.requestVersion()
    await settle()
    expect(handle.getSnapshot().isStale).toBe(true)
  })

  it("a write to a marked object is refused stale-client without the transport", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 1)
    const onStaleClient = vi.fn<(object: string) => void>()
    const { core, calls, replies } = runtimeOver(fake, { onStaleClient })
    core.view(cardOf(1)).subscribe(() => {})
    await settle()
    replies.push(versionAnswer(SERVER_HASH, [OBJECTS[0]!]))
    core.requestVersion()
    await settle()
    const sent = calls.length
    const m = core.update(TASK, key(1), { title: "x" }, { expectedVersion: 1 })
    expect(await m.settled).toMatchObject({
      ok: false,
      error: { code: "command.stale-client" },
    })
    await settle()
    expect(calls).toHaveLength(sent)
    // Відповіді сервера не було: колбек лише за переходом позначки.
    expect(onStaleClient).toHaveBeenCalledTimes(1)
  })

  it("a response after dispose() or session-changed starts no version request and no onStaleClient", async () => {
    const onStaleClient = vi.fn<(object: string) => void>()
    const disposed = controlled({ onStaleClient })
    const late = failureOf(disposed.send(card()))
    disposed.runtime.dispose()
    disposed.respond(changed(ok(null), "server-2"))
    await late
    await settle()
    expect(versionCalls(disposed.calls)).toBe(0)

    const changedSession = controlled({ onStaleClient })
    const refused = failureOf(changedSession.send(card()))
    changedSession.respond(changed(sessionChanged(), "server-2"))
    await refused
    await settle()
    expect(versionCalls(changedSession.calls)).toBe(0)
    expect(onStaleClient).not.toHaveBeenCalled()
  })

  it("an answer of a version request that arrives after dispose() marks nothing", async () => {
    const onStaleClient = vi.fn<(object: string) => void>()
    const t = controlled({ onStaleClient })
    t.core.requestVersion()
    await settle()
    t.runtime.dispose()
    t.respond(versionAnswer(SERVER_HASH, [OBJECTS[0]!]))
    await settle()
    expect(onStaleClient).not.toHaveBeenCalled()
  })

  it("a stale-client of a read part marks the object, calls onStaleClient(object) once and asks for the version", async () => {
    const onStaleClient = vi.fn<(object: string) => void>()
    const t = controlled({ onStaleClient })
    const read = t.send(card())
    t.respond(
      ok({
        epoch: null,
        items: [
          {
            ok: false,
            error: { code: "command.stale-client", object: OBJECT_ID },
          },
        ],
      })
    )
    await read
    await settle()
    expect(onStaleClient.mock.calls).toEqual([[TASK]])
    expect(versionCalls(t.calls)).toBe(1)
    // Відповідь `version` без розбіжності: позначка липка, колбек не повторюється.
    t.respond(versionAnswer(SERVER_HASH))
    await settle()
    expect(onStaleClient).toHaveBeenCalledTimes(1)
  })

  it("a stale-client part without an object names the object of its query", async () => {
    const onStaleClient = vi.fn<(object: string) => void>()
    const t = controlled({ onStaleClient })
    const read = t.send(card())
    t.respond(
      ok({
        epoch: null,
        items: [{ ok: false, error: { code: "command.stale-client" } }],
      })
    )
    await read
    await settle()
    expect(onStaleClient.mock.calls).toEqual([[TASK]])
  })

  it("a whole read refused stale-client calls onStaleClient(object) for the object of the refusal", async () => {
    const onStaleClient = vi.fn<(object: string) => void>()
    const t = controlled({ onStaleClient })
    const read = failureOf(
      t.send({
        type: "read",
        items: [
          { type: "query", query: { object: task.id, id: ID } },
          { type: "query", query: { object: org.id, id: ID } },
        ],
      })
    )
    t.respond(failed({ code: "command.stale-client", object: task.id }))
    expect(await read).toMatchObject({ code: "command.stale-client" })
    await settle()
    expect(onStaleClient.mock.calls).toEqual([[TASK]])
  })

  it("a whole read refused stale-client without an object names each object of its items", async () => {
    const onStaleClient = vi.fn<(object: string) => void>()
    const t = controlled({ onStaleClient })
    const read = failureOf(
      t.send({
        type: "read",
        items: [
          { type: "query", query: { object: task.id, id: ID } },
          { type: "query", query: { object: org.id, id: ID } },
          { type: "version" },
        ],
      })
    )
    t.respond(failed({ code: "command.stale-client" }))
    expect(await read).toMatchObject({ code: "command.stale-client" })
    await settle()
    expect(onStaleClient.mock.calls).toEqual([[TASK], [ORG]])
  })

  it("a whole read refused stale-client after dispose() calls nothing", async () => {
    const onStaleClient = vi.fn<(object: string) => void>()
    const t = controlled({ onStaleClient })
    const read = failureOf(t.send(card()))
    t.runtime.dispose()
    t.respond(failed({ code: "command.stale-client" }))
    await read
    await settle()
    expect(onStaleClient).not.toHaveBeenCalled()
  })

  it("a stale-client part answered after dispose() calls nothing", async () => {
    const onStaleClient = vi.fn<(object: string) => void>()
    const t = controlled({ onStaleClient })
    const read = failureOf(t.send(card()))
    t.runtime.dispose()
    t.respond(
      ok({
        epoch: null,
        items: [{ ok: false, error: { code: "command.stale-client" } }],
      })
    )
    await read
    await settle()
    expect(onStaleClient).not.toHaveBeenCalled()
    expect(versionCalls(t.calls)).toBe(0)
  })

  it("a write answered session-changed closes the runtime: onSessionChanged once, the card is purged", async () => {
    const fake = createFakeSource({ objects: OBJECTS })
    seed(fake, 1, 1)
    const onSessionChanged = vi.fn()
    const { runtime, core, replies } = runtimeOver(fake, { onSessionChanged })
    const handle = core.view(cardOf(1))
    handle.subscribe(() => {})
    await settle()
    replies.push(sessionChanged())
    const m = core.update(TASK, key(1), { title: "x" }, { expectedVersion: 1 })
    expect(await m.settled).toMatchObject({
      ok: false,
      error: { code: "command.unauthenticated", reason: "session-changed" },
    })
    await settle()
    expect(runtime.disposed).toBe(true)
    expect(onSessionChanged).toHaveBeenCalledTimes(1)
    expect(handle.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "session-changed",
    })
  })
})
