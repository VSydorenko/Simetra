import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type {
  CatalogEntry,
  ClientCatalog,
  DataRequest,
  DataResponse,
  DataTransport,
  SourceAdapter,
} from "simetra/model"
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
} from "../../store/__tests__/core-support"
import {
  createFakeSource,
  type FakeSource,
} from "../../store/testing/fake-source"
import { coreInternals, inspectCore } from "../../store/core"
import type { ViewSnapshot, ViewSpec } from "../../store/types"
import { clientCatalog, ok, SERVER_HASH } from "../../__tests__/support"
import { createRuntimeHolder } from "../holder"
import { runtimeHandleOf } from "../handle"
import {
  createDataRuntime,
  type DataRuntime,
  type DataRuntimeOptions,
  type DataSnapshot,
} from "../runtime"

/*
 * Знімок рантайму, гідрація й звірка (спека П4-B §6.6, §10). Транспорт — міст до фейкового сервера, що вміє відповісти
 * `stale-client` об'єкта (частиною читання, записом чи відповіддю `version`).
 */

const BAD_HASH = "1".repeat(64)
const SUBJECT_A = "user-a"
const SUBJECT_B = "user-b"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

const catalogOf = (objects: readonly CatalogEntry[]): ClientCatalog => ({
  ...clientCatalog(),
  objects: [...objects],
})

interface Wire {
  readonly calls: DataRequest[]
  /** Objects (ids) whose query parts the server refuses `stale-client`. */
  readonly refuse: Set<string>
  /** Objects (ids) the `version` answer shows with a foreign kernel hash. */
  readonly foreign: Set<string>
  /** The `snapshotHash` and `serverHash` of the answers. */
  hash: string
  /** The refusal every `run` gets, when set. */
  runRefusal?: { code: "command.stale-client" }
  /** Every request is answered `session-changed`. */
  sessionChanged: boolean
  /** Holds every answer until {@link Wire.release}. */
  hold: boolean
  /** Requests held, not yet delivered. */
  readonly held: { readonly body: DataRequest; deliver(): void }[]
  /**
   * Delivers every held request that `which` accepts (all by default), in
   * order, and stops holding; returns how many were delivered.
   */
  release(which?: (body: DataRequest) => boolean): number
}

/** A transport over the fake server; answers are computed on delivery. */
function serverWire(fake: FakeSource): Wire & { transport: DataTransport } {
  const wire: Wire = {
    calls: [],
    refuse: new Set(),
    foreign: new Set(),
    hash: SERVER_HASH,
    sessionChanged: false,
    hold: false,
    held: [],
    release(which = () => true) {
      wire.hold = false
      const now = wire.held.filter((h) => which(h.body))
      for (const h of now) {
        wire.held.splice(wire.held.indexOf(h), 1)
        h.deliver()
      }
      return now.length
    },
  }
  const transport: DataTransport = async (body) => {
    wire.calls.push(body)
    if (wire.hold) {
      await new Promise<void>((resolve) => {
        wire.held.push({ body, deliver: resolve })
      })
    }
    const answer = (value: DataResponse): DataResponse => ({
      ...value,
      serverHash: wire.hash,
    })
    if (wire.sessionChanged)
      return answer({
        ok: false,
        error: { code: "command.unauthenticated", reason: "session-changed" },
        serverHash: wire.hash,
      })
    const { request } = body
    if (request.type === "run") {
      return wire.runRefusal === undefined
        ? answer(ok(null))
        : answer({ ok: false, error: wire.runRefusal, serverHash: wire.hash })
    }
    if (request.type !== "read") return answer(ok(null))
    const parts = request.items as {
      type: string
      query?: { object: string }
    }[]
    const queries = parts.filter((part) => part.type === "query")
    const read =
      queries.length === 0
        ? { items: [] }
        : await fake.adapter.read(
            queries as unknown as Parameters<SourceAdapter["read"]>[0]
          )
    let next = 0
    const items = parts.map((part) => {
      if (part.type === "version")
        return {
          ok: true,
          value: {
            snapshotHash: wire.hash,
            objects: Object.fromEntries(
              OBJECTS.map((o) => [
                o.id,
                wire.foreign.has(o.id) ? BAD_HASH : o.kernelHash,
              ])
            ),
          },
        }
      const item = read.items[next++]
      return wire.refuse.has(part.query!.object)
        ? {
            ok: false,
            error: { code: "command.stale-client", object: part.query!.object },
          }
        : item
    })
    return answer(ok({ ...read, epoch: null, items }))
  }
  return Object.assign(wire, { transport })
}

function runtimeOver(
  fake: FakeSource,
  options: Partial<DataRuntimeOptions> = {}
) {
  const wire = serverWire(fake)
  const runtime = createDataRuntime({
    catalog: catalogOf(OBJECTS),
    transport: wire.transport,
    subject: SUBJECT_A,
    log: () => {},
    limits: { readParallel: 8 },
    ...options,
  })
  return { runtime, wire, core: runtimeHandleOf(runtime).core }
}

const card = (n: number): ViewSpec => ({
  kind: "card",
  object: TASK,
  key: key(n),
})
const list: ViewSpec = { kind: "keys", object: TASK, keys: [key(1), key(2)] }
const lines: ViewSpec = {
  kind: "section",
  object: TASK,
  owner: key(1),
  section: "lines",
}
const orgCard: ViewSpec = { kind: "card", object: ORG, key: S }

function serverWorld() {
  const fake = createFakeSource({ objects: OBJECTS })
  fake.insert(ORG, { ref: S })
  seed(fake, 1, 3)
  fake.setLines(TASK, key(1), "lines", [
    { ref: key(901), qty: 5, lineNumber: 1 },
  ])
  return fake
}

/** The snapshot of a server runtime that loaded the views, as the host takes it. */
async function takeSnapshot(
  fake: FakeSource,
  views: readonly ViewSpec[],
  subject = SUBJECT_A
): Promise<DataSnapshot> {
  const { runtime, core } = runtimeOver(fake, { subject })
  for (const spec of views) core.view(spec).subscribe(() => {})
  await settle()
  const snapshot = runtime.dehydrate()
  runtime.dispose()
  return snapshot
}

const wired = (snapshot: DataSnapshot) =>
  JSON.parse(JSON.stringify(snapshot)) as DataSnapshot

const titleOf = (snapshot: ViewSnapshot) =>
  (snapshot.rows[0] as { values: { title?: string } }).values.title

describe("the snapshot of a runtime", () => {
  it("names only the subject", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    expect(snapshot.meta).toEqual({ subject: SUBJECT_A })
  })

  it("hydrates a view the same through JSON as directly", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1), list, lines])
    const direct = runtimeOver(fake)
    direct.runtime.hydrate(snapshot)
    const viaJson = runtimeOver(fake)
    viaJson.runtime.hydrate(wired(snapshot))
    for (const spec of [card(1), list, lines]) {
      const a = direct.core.view(spec).getSnapshot()
      expect(a.status).toBe("ready")
      expect(viaJson.core.view(spec).getSnapshot()).toEqual(a)
    }
    expect(direct.wire.calls).toHaveLength(0)
    expect(titleOf(direct.core.view(card(1)).getSnapshot())).toBe("t1")
  })

  it("refuses to dehydrate once disposed", async () => {
    const { runtime } = runtimeOver(serverWorld())
    runtime.dispose()
    expect(() => runtime.dehydrate()).toThrow(TypeError)
  })
})

describe("hydrate refuses without writing", () => {
  it("never takes a snapshot of another subject", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const b = runtimeOver(fake, { subject: SUBJECT_B })
    expect(() => b.runtime.hydrate(snapshot)).toThrow(TypeError)
    expect(inspectCore(b.core).rowCount()).toBe(0)
    expect([...coreInternals(b.core).registry.subsets()]).toHaveLength(0)
    b.runtime.endHydration()
    await settle()
    expect(b.wire.calls).toHaveLength(0)
  })

  it("refuses a second hydration and one into a runtime that holds views", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const once = runtimeOver(fake)
    once.runtime.hydrate(snapshot)
    const shown = once.core.view(card(1)).getSnapshot()
    expect(() => once.runtime.hydrate(snapshot)).toThrow(TypeError)
    expect(once.core.view(card(1)).getSnapshot()).toBe(shown)

    const held = runtimeOver(fake)
    held.core.view(card(2)).subscribe(() => {})
    expect(() => held.runtime.hydrate(snapshot)).toThrow(TypeError)
    expect(inspectCore(held.core).rowCount()).toBe(0)
  })

  it("refuses an unknown format and a malformed meta", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const a = runtimeOver(fake)
    expect(() =>
      a.runtime.hydrate({
        meta: snapshot.meta,
        core: { ...snapshot.core, format: 2 } as never,
      })
    ).toThrow(TypeError)
    expect([...coreInternals(a.core).registry.subsets()]).toHaveLength(0)
    a.runtime.endHydration()
    await settle()
    expect(a.wire.calls).toHaveLength(0)
    expect(() => a.runtime.hydrate({ core: snapshot.core } as never)).toThrow(
      TypeError
    )
    expect(inspectCore(a.core).rowCount()).toBe(0)
  })

  it("does nothing after dispose()", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const a = runtimeOver(fake)
    a.runtime.dispose()
    a.runtime.hydrate(snapshot)
    a.runtime.endHydration()
    await settle()
    expect(a.wire.calls).toHaveLength(0)
    expect(a.core.view(card(1)).getSnapshot()).toMatchObject({
      status: "purged",
    })
  })
})

describe("RuntimeHolder.hydrateFrom", () => {
  it("creates the runtime of the snapshot's subject and holds it", async () => {
    const fake = serverWorld()
    const snapshot = wired(await takeSnapshot(fake, [card(1)]))
    const holder = createRuntimeHolder()
    const create = vi.fn(
      (subject: string) => runtimeOver(fake, { subject }).runtime
    )
    holder.hydrateFrom(snapshot, create)
    expect(create.mock.calls).toEqual([[SUBJECT_A]])
    const held = holder.current()!
    expect(held.subject).toBe(SUBJECT_A)
    expect(runtimeHandleOf(held).core.view(card(1)).getSnapshot().status).toBe(
      "ready"
    )
  })

  it("refuses a created runtime of another subject: disposed, holder untouched", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const previous = runtimeOver(fake).runtime
    const holder = createRuntimeHolder(previous)
    const listener = vi.fn()
    holder.subscribe(listener)
    let created: DataRuntime | undefined
    expect(() =>
      holder.hydrateFrom(snapshot, () => {
        created = runtimeOver(fake, { subject: SUBJECT_B }).runtime
        return created
      })
    ).toThrow(TypeError)
    expect(created!.disposed).toBe(true)
    expect(holder.current()).toBe(previous)
    expect(previous.disposed).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it("refuses a created runtime that is the held one: it stays held and alive", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const held = runtimeOver(fake).runtime
    const holder = createRuntimeHolder(held)
    const listener = vi.fn()
    holder.subscribe(listener)
    expect(() => holder.hydrateFrom(snapshot, () => held)).toThrow(TypeError)
    expect(holder.current()).toBe(held)
    expect(held.disposed).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it("refuses a created runtime that is already disposed: the held one stays", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const held = runtimeOver(fake).runtime
    const holder = createRuntimeHolder(held)
    const listener = vi.fn()
    holder.subscribe(listener)
    expect(() =>
      holder.hydrateFrom(snapshot, (subject) => {
        const dead = runtimeOver(fake, { subject }).runtime
        dead.dispose()
        return dead
      })
    ).toThrow(TypeError)
    expect(holder.current()).toBe(held)
    expect(held.disposed).toBe(false)
    expect(listener).not.toHaveBeenCalled()
  })

  it("disposes the new runtime when its hydration is refused", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const holder = createRuntimeHolder()
    let created: DataRuntime | undefined
    expect(() =>
      holder.hydrateFrom(
        { meta: snapshot.meta, core: { ...snapshot.core, format: 2 } as never },
        (subject) => {
          created = runtimeOver(fake, { subject }).runtime
          return created
        }
      )
    ).toThrow(TypeError)
    expect(created!.disposed).toBe(true)
    expect(holder.current()).toBeUndefined()
  })
})

describe("the reconciliation after hydration", () => {
  it("sends one request: the version part first and a re-read of every visible view", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1), list, orgCard])
    const a = runtimeOver(fake)
    a.runtime.hydrate(snapshot)
    // Невидимий вигляд не перечитується.
    a.core.view(orgCard).subscribe(() => {})
    a.core.setVisible(orgCard, false)
    a.core.view(card(1)).subscribe(() => {})
    a.core.view(list).subscribe(() => {})
    a.wire.hold = true
    a.runtime.endHydration()
    await settle()
    // Жодної відповіді ще не було: збирач віддав усе одним запитом.
    expect(a.wire.calls).toHaveLength(1)
    expect(a.wire.held).toHaveLength(1)
    const request = a.wire.calls[0]!.request
    const parts = (request.type === "read" ? request.items : []) as {
      type: string
    }[]
    expect(parts.map((part) => part.type)).toEqual([
      "version",
      "query",
      "query",
    ])
    expect(a.wire.release()).toBe(1)
    await settle()
    expect(a.wire.calls).toHaveLength(1)
  })

  it("answers the version and the re-reads in one response: no second version request", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1), list])
    const a = runtimeOver(fake)
    a.runtime.hydrate(snapshot)
    a.core.view(card(1)).subscribe(() => {})
    a.core.view(list).subscribe(() => {})
    a.wire.hold = true
    a.runtime.endHydration()
    await settle()
    const isVersion = (b: DataRequest) =>
      b.request.type === "read" &&
      (b.request.items[0] as { type: string }).type === "version"
    expect(a.wire.held).toHaveLength(1)
    expect(a.wire.release(isVersion)).toBe(1)
    await settle()
    expect(a.wire.calls).toHaveLength(1)
    expect(a.wire.calls.filter(isVersion)).toHaveLength(1)
  })

  it.each<[string, ViewSpec]>([
    ["full", { kind: "full", object: TASK, include: ["org"] }],
    ["window", { kind: "window", object: TASK, include: ["org"] }],
  ])(
    "sends one request for a %s view whose row refers to a target nobody can read",
    async (_name, spec) => {
      const fake = serverWorld()
      // Посилання на ціль без рядка: знімок гідратації ключа цілі не несе, а
      // читання її лишається порожнім — вона не мусить мати власного запиту.
      fake.insert(TASK, { ref: key(77), org: key(88_888), title: "x" })
      const snapshot = await takeSnapshot(fake, [spec])
      const a = runtimeOver(fake)
      a.runtime.hydrate(snapshot)
      a.core.view(spec).subscribe(() => {})
      a.runtime.endHydration()
      await settle()
      expect(a.wire.calls).toHaveLength(1)
      const request = a.wire.calls[0]!.request
      const parts = (request.type === "read" ? request.items : []) as {
        type: string
      }[]
      expect(parts.map((part) => part.type)).toEqual([
        "version",
        "query",
        "query",
      ])
    }
  )

  it("does it once: a repeat of endHydration sends nothing", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const a = runtimeOver(fake)
    a.runtime.hydrate(snapshot)
    a.core.view(card(1)).subscribe(() => {})
    a.runtime.endHydration()
    await settle()
    const sent = a.wire.calls.length
    a.runtime.endHydration()
    await settle()
    expect(a.wire.calls).toHaveLength(sent)
  })

  it("refreshes the rows the server changed meanwhile", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    fake.edit(TASK, key(1), { title: "changed" })
    const a = runtimeOver(fake)
    a.runtime.hydrate(snapshot)
    const handle = a.core.view(card(1))
    handle.subscribe(() => {})
    expect(titleOf(handle.getSnapshot())).toBe("t1")
    a.runtime.endHydration()
    await settle()
    expect(titleOf(handle.getSnapshot())).toBe("changed")
  })

  it("closes at the first request when the subject changed (session-changed)", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1), orgCard])
    const onSessionChanged = vi.fn()
    const a = runtimeOver(fake, { onSessionChanged })
    a.runtime.hydrate(snapshot)
    const handles = [card(1), orgCard].map((spec) => a.core.view(spec))
    // Одне сповіщення `purged` на вигляд.
    const purges = handles.map(() => 0)
    handles.forEach((h, i) =>
      h.subscribe(() => {
        if (h.getSnapshot().status === "purged") purges[i]!++
      })
    )
    a.wire.sessionChanged = true
    a.runtime.endHydration()
    await settle()
    expect(onSessionChanged).toHaveBeenCalledTimes(1)
    expect(a.runtime.disposed).toBe(true)
    for (const h of handles)
      expect(h.getSnapshot()).toMatchObject({
        status: "purged",
        reason: "session-changed",
        rows: [],
      })
    expect(inspectCore(a.core).rowCount()).toBe(0)
    // Після закриття нічого більше не йде, навіть через плин часу.
    const sent = a.wire.calls.length
    vi.advanceTimersByTime(10 * 60_000)
    await settle()
    expect(a.wire.calls).toHaveLength(sent)
    expect(purges).toEqual([1, 1])
  })

  it("nothing a response brings after dispose() changes the views", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const onStaleClient = vi.fn()
    const a = runtimeOver(fake, { onStaleClient })
    a.runtime.hydrate(snapshot)
    const handle = a.core.view(card(1))
    handle.subscribe(() => {})
    a.wire.foreign.add(task.id)
    a.wire.refuse.add(task.id)
    a.wire.hold = true
    a.runtime.endHydration()
    await settle()
    expect(a.wire.held).toHaveLength(1)
    a.runtime.dispose()
    expect(a.wire.release()).toBe(1)
    await settle()
    expect(onStaleClient).not.toHaveBeenCalled()
    expect(handle.getSnapshot()).toMatchObject({
      status: "purged",
      reason: "disposed",
      rows: [],
    })
  })
})

describe("a stale-client object is closed until reload (spec §10)", () => {
  type Cause = "refused part" | "version answer" | "refused write"

  /** A hydrated runtime over views of TASK and ORG, with the cause armed. */
  async function arm(cause: Cause) {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1), list, lines, orgCard])
    const onStaleClient = vi.fn<(object: string) => void>()
    const a = runtimeOver(fake, { onStaleClient })
    a.runtime.hydrate(snapshot)
    const views = {
      card: a.core.view(card(1)),
      list: a.core.view(list),
      lines: a.core.view(lines),
      org: a.core.view(orgCard),
    }
    Object.values(views).forEach((v) => v.subscribe(() => {}))
    if (cause === "refused part") a.wire.refuse.add(task.id)
    if (cause === "version answer") a.wire.foreign.add(task.id)
    if (cause === "refused write")
      a.wire.runRefusal = { code: "command.stale-client" }
    a.runtime.endHydration()
    await settle()
    if (cause === "refused write") {
      const m = a.core.update(
        TASK,
        key(2),
        { title: "x" },
        { expectedVersion: 1 }
      )
      expect(await m.settled).toMatchObject({
        ok: false,
        error: { code: "command.stale-client" },
      })
      await settle()
    }
    return { a, fake, views, onStaleClient }
  }

  const tasksRead = (wire: Wire) =>
    wire.calls.filter(
      (c) =>
        c.request.type === "read" &&
        c.request.items.some(
          (item) =>
            (item as { query?: { object?: string } }).query?.object === task.id
        )
    ).length

  it.each(["refused part", "version answer", "refused write"] as const)(
    "%s: rows and lines of the object are hidden, its views isStale, the other object shown",
    async (cause) => {
      const { views, onStaleClient } = await arm(cause)
      for (const handle of [views.card, views.list]) {
        const snap = handle.getSnapshot()
        expect(snap.isStale).toBe(true)
        expect(snap.rows.length).toBeGreaterThan(0)
        for (const row of snap.rows) {
          expect(row).toMatchObject({ state: "stale", hidden: true })
          expect(Object.keys((row as { values: object }).values)).toEqual([])
        }
      }
      const section = views.lines.getSnapshot()
      expect(section.isStale).toBe(true)
      expect(section.section?.lines ?? []).toEqual([])
      const other = views.org.getSnapshot()
      expect(other.isStale).toBeUndefined()
      expect(other.rows[0]).toMatchObject({ state: "synced" })
      expect(onStaleClient.mock.calls).toEqual([[TASK]])
    }
  )

  it.each(["refused part", "version answer", "refused write"] as const)(
    "%s: a later version without a divergence opens nothing and no read of the object goes out",
    async (cause) => {
      const { a, views, onStaleClient } = await arm(cause)
      a.wire.refuse.clear()
      a.wire.foreign.clear()
      delete a.wire.runRefusal
      const sent = tasksRead(a.wire)
      a.core.requestVersion()
      await settle()
      views.card.refresh()
      views.list.refresh()
      void a.core.revalidate(TASK, { visibleOnly: false })
      views.card.subscribe(() => {})
      await settle()
      vi.advanceTimersByTime(10 * 60_000)
      await settle()
      expect(tasksRead(a.wire)).toBe(sent)
      for (const handle of [views.card, views.list, views.lines]) {
        expect(handle.getSnapshot().isStale).toBe(true)
        for (const row of handle.getSnapshot().rows)
          expect(row).toMatchObject({ hidden: true })
      }
      expect(onStaleClient).toHaveBeenCalledTimes(1)
      // Другий запис не доходить до транспорту.
      const writes = a.wire.calls.filter((c) => c.request.type === "run").length
      const m = a.core.update(
        TASK,
        key(3),
        { title: "y" },
        { expectedVersion: 1 }
      )
      expect(await m.settled).toMatchObject({ ok: false })
      expect(a.wire.calls.filter((c) => c.request.type === "run")).toHaveLength(
        writes
      )
    }
  )

  it("an answer in flight when the object turned stale writes nothing", async () => {
    const fake = serverWorld()
    const a = runtimeOver(fake)
    a.wire.hold = true
    const handle = a.core.view(list)
    handle.subscribe(() => {})
    await settle()
    expect(handle.getSnapshot().status).toBe("loading")
    a.core.staleClient(TASK)
    expect(a.wire.release()).toBeGreaterThan(0)
    await settle()
    const snap = handle.getSnapshot()
    expect(snap.isStale).toBe(true)
    expect(snap.rows).toEqual([])
    expect(inspectCore(a.core).rowCount()).toBe(0)
  })

  const queriesOf = (wire: Wire, object: string) =>
    wire.calls.filter(
      (c) =>
        c.request.type === "read" &&
        c.request.items.some(
          (item) =>
            (item as { query?: { object?: string } }).query?.object === object
        )
    ).length

  it("the reconciliation after hydration skips a stale-client object: no read, the view stays stale", async () => {
    const fake = serverWorld()
    const snapshot = await takeSnapshot(fake, [card(1)])
    const a = runtimeOver(fake)
    a.runtime.hydrate(snapshot)
    a.core.view(card(1)).subscribe(() => {})
    a.core.staleClient(TASK)
    a.runtime.endHydration()
    await settle()
    expect(queriesOf(a.wire, task.id)).toBe(0)
    const snap = a.core.view(card(1)).getSnapshot()
    expect(snap.isStale).toBe(true)
    expect(snap.status).not.toBe("error")
    expect(snap.error).toBeUndefined()
  })

  it("a read of the object queued in the limiter never reaches the transport after the mark", async () => {
    const fake = serverWorld()
    const a = runtimeOver(fake, { limits: { readParallel: 1 } })
    a.wire.hold = true
    a.core.view(orgCard).subscribe(() => {})
    await settle()
    // Читання TASK — наступним тактом: збирач не зливає його з читанням ORG.
    a.core.view(card(1)).subscribe(() => {})
    await settle()
    // Читання ORG у польоті займає єдиний слот, читання TASK стоїть у черзі.
    expect(a.wire.held).toHaveLength(1)
    expect(queriesOf(a.wire, task.id)).toBe(0)
    a.core.staleClient(TASK)
    a.wire.release()
    await settle()
    expect(queriesOf(a.wire, task.id)).toBe(0)
    expect(a.core.view(orgCard).getSnapshot().status).toBe("ready")
    expect(a.core.view(card(1)).getSnapshot().isStale).toBe(true)
  })

  it("a view that includes a stale object stays ready; the target is unresolved and never asked for", async () => {
    const fake = serverWorld()
    const a = runtimeOver(fake)
    const withOrg: ViewSpec = {
      kind: "window",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "asc" }],
      include: ["org"],
    }
    const handle = a.core.view(withOrg)
    handle.subscribe(() => {})
    await settle()
    const before = handle.getSnapshot()
    expect(before.status).toBe("ready")
    const resolved = before.rows[0] as { refs?: Record<string, unknown> }
    expect(resolved.refs?.org).toMatchObject({ state: "synced" })
    a.core.staleClient(ORG)
    await settle()
    const asked = queriesOf(a.wire, org.id)
    handle.refresh()
    await settle()
    const after = handle.getSnapshot()
    expect(after.status).toBe("ready")
    expect(after.isStale).toBeUndefined()
    expect(after.rows.length).toBeGreaterThan(0)
    for (const row of after.rows) {
      const target = (row as { refs?: Record<string, unknown> }).refs?.org as
        { values?: object } | null | undefined
      expect(Object.keys(target?.values ?? {})).toEqual([])
    }
    expect(queriesOf(a.wire, org.id)).toBe(asked)
  })

  it("the mark is runtime-wide: another object turns stale on its own and the first stays closed", async () => {
    const { a, views, onStaleClient } = await arm("version answer")
    a.wire.foreign.clear()
    a.wire.foreign.add(org.id)
    a.core.requestVersion()
    await settle()
    expect(onStaleClient.mock.calls).toEqual([[TASK], [ORG]])
    expect(views.org.getSnapshot().isStale).toBe(true)
    expect(views.card.getSnapshot().isStale).toBe(true)
  })

  it("nothing is marked, hidden or called after dispose()", async () => {
    const { a, views, onStaleClient } = await arm("version answer")
    onStaleClient.mockClear()
    a.runtime.dispose()
    a.core.staleClient(ORG)
    expect(onStaleClient).not.toHaveBeenCalled()
    expect(views.org.getSnapshot()).toMatchObject({ status: "purged" })
  })
})
