import { isDeepStrictEqual } from "node:util"
import { channelTopic, type RightsRow } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import type { SyncState, SyncTarget } from "../core"
import { failurePause } from "../subsets"
import { QUIET_MS, REJOIN_JITTER_MS } from "../receiver"
import { DISCARDS_MAX } from "../session"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import type { CoreLimits, ViewSpec } from "../types"
import {
  ORG,
  S,
  TASK,
  key,
  seed,
  settle,
  setup,
  task,
  watch,
  type CoreHarness,
} from "./core-support"

/*
 * Діагностика `sync()` (план SK-0, задача 3, Р5): проєкція стану свіжості
 * `main` — ціль, вимоги, польоти, черга, доказ, строк, умова. Кожен вид
 * вимоги §5.2, який `main` має, і кожна умова §5.3 — окремий випадок над
 * справжнім ядром і фейковим сервером.
 */

const USER = "00000000-0000-4000-8000-0000000000a1"
const INTERVAL = 60_000

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const keysView = (...ns: number[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys: ns.map(key),
})
const section = (n: number): ViewSpec => ({
  kind: "section",
  object: TASK,
  owner: key(n),
  section: "lines",
})
const viewTarget = (spec: ViewSpec): SyncTarget => ({
  kind: "view",
  object: spec.object,
  spec,
})
const rowTarget = (n: number): SyncTarget => ({
  kind: "row",
  object: TASK,
  key: key(n),
})
const RIGHTS: SyncTarget = { kind: "service", service: "rights" }
const VERSION: SyncTarget = { kind: "service", service: "version" }

const stateOf = (h: CoreHarness, target: SyncTarget): SyncState | undefined =>
  h.inspect.sync().find((s) => isDeepStrictEqual(s.target, target))

const write = (
  h: CoreHarness,
  fn: Parameters<CoreHarness["core"]["commit"]>[0]
) => h.core.commit(fn, h.core.token())

/** Ядро з тиктаючим годинником тестів і завантаженим видимим виглядом. */
async function loaded(
  spec: ViewSpec = keysView(1, 2),
  options: Parameters<typeof setup>[0] = {}
) {
  const h = setup({
    now: () => Date.now(),
    limits: { revalidateIntervalMs: INTERVAL },
    ...options,
  })
  seed(h.fake, 1, 2)
  const handle = h.core.view(spec)
  watch(handle)
  await settle()
  if (h.fake.mode === "manual") {
    h.fake.deliverAll()
    await settle()
  }
  return { ...h, handle, spec }
}

const rightsRow: RightsRow = {
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

/** Ядро з приймачем сигналів над фейковим каналом і завантаженим виглядом. */
async function withSignals(
  spec: ViewSpec = keysView(1),
  limits: Partial<CoreLimits> = {}
) {
  const transport = createFakeSignalTransport()
  const h = setup({
    now: () => Date.now(),
    rightsSnapshot: true,
    signals: transport,
    limits: { revalidateIntervalMs: INTERVAL, ...limits },
  })
  h.fake.rightsSnapshot = {
    userId: USER,
    scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
    rights: [rightsRow],
    members: [],
    dimensionValues: [],
  }
  h.fake.rightsVersion = "1".repeat(64)
  seed(h.fake, 1, 2)
  watch(h.core.view(spec))
  await settle()
  expect(transport.subscribed().has(channel)).toBe(true)
  return { ...h, transport, spec }
}

describe("sync(): a requirement of each kind main holds, with its promise or condition", () => {
  it("composition-unconfirmed: the epoch, no promise until a re-read; the re-read promises it and its applied start is the proof", async () => {
    const h = await loaded(keysView(1, 2), { mode: "manual" })
    const proof = stateOf(h, viewTarget(h.spec))!.proof
    expect(proof).toEqual(expect.any(Number))
    const since = h.core.readEpoch()
    write(h, (w) => w.markViews(TASK, { unconfirmedSince: since }))
    // Видимий вигляд читає механізм, що поставив вимогу: самої вимоги мало.
    expect(stateOf(h, viewTarget(h.spec))).toEqual({
      target: viewTarget(h.spec),
      requirements: [{ kind: "composition-unconfirmed", epoch: since }],
      flights: [],
      queued: [],
      proof,
      due: expect.any(Number),
    })
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const flying = stateOf(h, viewTarget(h.spec))!
    expect(flying).toMatchObject({
      requirements: [{ kind: "composition-unconfirmed", epoch: since }],
      flights: [{ kind: "reread", epoch: since }],
      deferral: "promised",
    })
    h.fake.deliverAll()
    await settle()
    expect(stateOf(h, viewTarget(h.spec))).toMatchObject({
      requirements: [],
      flights: [],
      proof: since,
    })
  })

  it("channel-rejoin: every view of the object until the wave fires, due at the wave", async () => {
    const h = await withSignals()
    const at = Date.now()
    h.transport.join(channel, false)
    expect(stateOf(h, viewTarget(h.spec))).toMatchObject({
      requirements: [{ kind: "channel-rejoin" }],
      due: at + REJOIN_JITTER_MS / 2,
    })
  })

  it("hydration-trust: the views of a snapshot over rows not read since the hydration, read by endHydration", async () => {
    const from = await loaded(keysView(1, 2))
    const snapshot = from.core.dehydrate()
    const h = setup({ mode: "manual" })
    seed(h.fake, 1, 2)
    h.core.hydrate(snapshot)
    const epoch = h.core.readEpoch()
    expect(stateOf(h, viewTarget(from.spec))).toMatchObject({
      requirements: [{ kind: "hydration-trust", epoch }],
      flights: [],
    })
    watch(h.core.view(from.spec))
    h.core.endHydration()
    await settle()
    expect(stateOf(h, viewTarget(from.spec))).toMatchObject({
      requirements: [{ kind: "hydration-trust", epoch }],
      flights: [{ kind: "reread", epoch }],
      deferral: "promised",
    })
    h.fake.deliverAll()
    await settle()
    expect(stateOf(h, viewTarget(from.spec))!.requirements).toEqual([])
  })

  it("access-narrowed: a view answered by another request before the first rights snapshot, re-read once it applies", async () => {
    const h = setup({ rightsSnapshot: true })
    h.fake.holdRights = true
    seed(h.fake, 1, 2)
    h.fake.insert(ORG, { ref: S })
    // Перше читання несе частину `rights`, друге — вже без неї.
    watch(h.core.view(keysView(1)))
    await settle()
    const org: ViewSpec = { kind: "keys", object: ORG, keys: [S] }
    watch(h.core.view(org))
    await settle()
    expect(stateOf(h, viewTarget(org))).toMatchObject({
      requirements: [{ kind: "access-narrowed" }],
    })
    expect(stateOf(h, RIGHTS)).toMatchObject({
      requirements: [{ kind: "rights-unconfirmed" }],
      flights: [{ kind: "service", epoch: expect.any(Number) }],
      deferral: "promised",
    })
    h.fake.releaseRights()
    await settle()
    expect(stateOf(h, viewTarget(org))!.requirements).toEqual([])
  })

  it("target-behind-header, value-hidden and row-unfinished: a hide of the owner of a held section", async () => {
    const h = await loaded(keysView(1), { mode: "manual" })
    h.fake.setLines(TASK, key(1), "lines", [
      { ref: key(901), qty: 1, lineNumber: 1 },
    ])
    watch(h.core.view(section(1)))
    await settle()
    h.fake.deliverAll()
    await settle()
    expect(stateOf(h, viewTarget(section(1)))!.requirements).toEqual([])
    write(h, (w) => w.hide(TASK, [key(1)]))
    // Між `commit` і перевіркою в мікрозадачі вимога стоїть без польоту;
    // перевірка читає ТЧ, і старт завантаження рухає входи предиката.
    expect(stateOf(h, viewTarget(section(1)))).toMatchObject({
      requirements: [{ kind: "target-behind-header" }],
      flights: [],
    })
    await settle()
    const hidden = stateOf(h, rowTarget(1))!
    expect(hidden.requirements).toEqual([
      { kind: "value-hidden", epoch: expect.any(Number) },
      { kind: "row-unfinished" },
    ])
    expect(hidden.flights).toEqual([{ kind: "keys" }])
    expect(stateOf(h, viewTarget(section(1)))).toMatchObject({
      flights: [{ kind: "load", epoch: expect.any(Number) }],
    })
    for (let round = 0; round < 3; round++) {
      h.fake.deliverAll()
      await settle()
    }
    expect(stateOf(h, rowTarget(1))).toBeUndefined()
    expect(stateOf(h, viewTarget(section(1)))!.requirements).toEqual([])
  })

  it("min-version: the epoch, the version and the budget of the receiver's re-read, due at its pause", async () => {
    const h = await withSignals()
    const served = h.fake.edit(TASK, key(1), { title: "v" })
    h.transport.emit(channel, {
      id: "1",
      object: task.id,
      op: "update",
      keys: { id: key(1) },
      row_ver: served + 1,
    })
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    expect(stateOf(h, rowTarget(1))).toEqual({
      target: rowTarget(1),
      requirements: [
        {
          kind: "min-version",
          epoch: expect.any(Number),
          version: served + 1,
          attempt: 1,
        },
      ],
      flights: [],
      queued: [],
      due: Date.now() + 500,
    })
  })

  it("min-version of an own write without confirmation: no re-read holds it (the gap of §5.14 row 12)", async () => {
    const h = await loaded()
    write(h, (w) => w.markStale(TASK, [key(1)], 99))
    // Позначка бере нову епоху сесії.
    const epoch = h.core.readEpoch()
    expect(stateOf(h, rowTarget(1))).toEqual({
      target: rowTarget(1),
      requirements: [{ kind: "min-version", epoch, version: 99 }],
      flights: [],
      queued: [],
    })
  })

  it("version-epoch-switched: the rows of the switch, due at the object's spread re-read", async () => {
    const h = await loaded(keysView(1, 2), { mode: "manual" })
    h.fake.epoch = "a".repeat(64)
    h.handle.refresh()
    await settle()
    h.fake.deliverAll()
    await settle()
    h.fake.epoch = "b".repeat(64)
    h.handle.refresh()
    await settle()
    h.fake.deliverAll()
    await settle()
    const due = h.inspect.scheduledDue().get(TASK)
    expect(due).toEqual(expect.any(Number))
    expect(stateOf(h, rowTarget(2))).toEqual({
      target: rowTarget(2),
      requirements: [{ kind: "version-epoch-switched" }],
      flights: [],
      queued: [],
      due,
    })
  })

  it("rights-unconfirmed: no snapshot yet and nothing reads it; a request promises it; its accepted send epoch is the proof", async () => {
    const h = setup({ rightsSnapshot: true })
    h.fake.holdRights = true
    expect(stateOf(h, RIGHTS)).toEqual({
      target: RIGHTS,
      requirements: [{ kind: "rights-unconfirmed" }],
      flights: [],
      queued: [],
    })
    h.core.requestRights()
    await settle()
    const flight = stateOf(h, RIGHTS)!.flights[0]!
    expect(flight).toEqual({ kind: "service", epoch: expect.any(Number) })
    h.core.requestRights()
    expect(stateOf(h, RIGHTS)).toMatchObject({
      queued: [
        {
          kind: "service",
          cause: { reason: "requirement", requirement: "rights-unconfirmed" },
        },
      ],
      deferral: "promised",
    })
    h.fake.releaseRights()
    await settle()
    expect(stateOf(h, RIGHTS)).toMatchObject({ proof: flight.epoch })
  })

  it("version-unconfirmed: a call while the version request flies queues one more", async () => {
    // Версія йде в одному запиті з частиною `rights`, яку фейк тримає.
    const h = setup({ rightsSnapshot: true })
    h.fake.holdRights = true
    expect(stateOf(h, VERSION)).toEqual({
      target: VERSION,
      requirements: [],
      flights: [],
      queued: [],
    })
    h.core.requestVersion()
    h.core.requestRights()
    await settle()
    h.core.requestVersion()
    expect(stateOf(h, VERSION)).toEqual({
      target: VERSION,
      requirements: [{ kind: "version-unconfirmed" }],
      flights: [{ kind: "service" }],
      queued: [{ kind: "service" }],
      deferral: "promised",
    })
  })
})

describe("sync(): each condition of §5.3 main holds", () => {
  const unconfirmed = (h: CoreHarness) =>
    write(h, (w) => w.markViews(TASK, { unconfirmedSince: h.core.readEpoch() }))

  it("tab-hidden: the requirement of a view on a hidden tab", async () => {
    const h = await loaded()
    h.core.suspend()
    unconfirmed(h)
    expect(stateOf(h, viewTarget(h.spec))!.deferral).toBe("tab-hidden")
  })

  it("target-invisible: the requirement of an invisible view", async () => {
    const h = await loaded()
    h.core.setVisible(h.spec, false)
    unconfirmed(h)
    expect(stateOf(h, viewTarget(h.spec))!.deferral).toBe("target-invisible")
  })

  // `promised` — лише політ зі стартом не раніше вимоги і не сторінка: старше
  // читання вимоги не знімає, а сторінка підтверджує лише себе (§5.5).
  it("promised: not by a re-read that started before the requirement", async () => {
    const h = await loaded(keysView(1, 2), { mode: "manual" })
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const started = h.core.readEpoch()
    write(h, (w) => w.markViews(TASK, { unconfirmedSince: started + 1 }))
    const state = stateOf(h, viewTarget(h.spec))!
    expect(state.flights).toEqual([{ kind: "reread", epoch: started }])
    expect(state.deferral).toBeUndefined()
  })

  it("promised: not by a page in flight", async () => {
    const win: ViewSpec = {
      kind: "window",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "asc" }],
    }
    // Вимога без епохи (хвиля приєднання): її не обіцяє й будь-яка сторінка.
    const h = await withSignals(win, { windowPage: 1 })
    h.fake.mode = "manual"
    h.core.view(win).loadAfter()
    await settle()
    h.transport.join(channel, false)
    const state = stateOf(h, viewTarget(win))!
    expect(state.requirements).toEqual([{ kind: "channel-rejoin" }])
    expect(state.flights).toEqual([{ kind: "page" }])
    expect(state.deferral).toBeUndefined()
  })

  it("paused: the requirement of a view in its failure pause, due at the end of the pause", async () => {
    const h = await loaded(keysView(1, 2), { mode: "manual" })
    const failedAt = Date.now()
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    h.fake.take().fail("command.unavailable")
    await settle()
    unconfirmed(h)
    expect(stateOf(h, viewTarget(h.spec))).toMatchObject({
      deferral: "paused",
      due: failedAt + failurePause(1, INTERVAL),
    })
  })

  it("stale-object: a view of an object marked stale-client is refused", async () => {
    const h = await loaded()
    h.core.staleClient(TASK)
    expect(stateOf(h, viewTarget(h.spec))!.refusal).toBe("stale-object")
  })

  it("discard-bound: a view of a session out of the discard limit is refused", async () => {
    const h = await loaded(keysView(1, 2), { mode: "manual" })
    const deliver = async () => {
      await settle()
      h.fake.deliverAll()
      await settle()
    }
    // Епохи A → B, далі відповіді лише покинутої A: кожну відкинуто.
    for (const epoch of ["a", "b"]) {
      h.fake.epoch = epoch.repeat(64)
      h.handle.refresh()
      await deliver()
    }
    h.fake.epoch = "a".repeat(64)
    h.handle.refresh()
    for (let i = 0; i < DISCARDS_MAX; i++) {
      await deliver()
      vi.advanceTimersByTime(60_000)
    }
    await settle()
    expect(h.inspect.versionEpochs().unavailable).toBe(true)
    expect(stateOf(h, viewTarget(h.spec))!.refusal).toBe("discard-bound")
  })

  it("closed: the service targets of a closed core are refused", async () => {
    const h = await loaded()
    h.core.close("disposed")
    expect(stateOf(h, VERSION)!.refusal).toBe("closed")
    expect(stateOf(h, viewTarget(h.spec))).toBeUndefined()
  })
})
