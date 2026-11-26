import { isDeepStrictEqual } from "node:util"
import { channelTopic, type RightsRow } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SCOPE_KIND_ID } from "../../../model/runtime/__tests__/entries"
import type { SyncState, SyncTarget } from "../core"
import { failurePause } from "../subsets"
import { QUIET_MS, REJOIN_JITTER_MS } from "../receiver"
import { DISCARD_PAUSE_MS, DISCARDS_MAX } from "../session"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import type { ReadEvent } from "../source"
import type { CoreLimits, ViewSpec } from "../types"
import {
  ORG,
  S,
  TASK,
  key,
  keysOf,
  seed,
  settle,
  setup,
  task,
  watch,
  type CoreHarness,
} from "./core-support"

/*
 * Діагностика `sync()` (план SK-0, задача 3, Р-SK0-5): проєкція стану свіжості
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
/** Ціль без непрозорого ідентифікатора: його перевіряють окремі тести. */
type Probe = SyncTarget extends infer T
  ? T extends { readonly id: number }
    ? Omit<T, "id">
    : T
  : never
const viewTarget = (spec: ViewSpec): Probe => ({
  kind: "view",
  object: spec.object,
  spec,
})
const rowTarget = (n: number): Probe => ({
  kind: "row",
  object: TASK,
  key: key(n),
})
const RIGHTS: Probe = { kind: "service", service: "rights" }
const VERSION: Probe = { kind: "service", service: "version" }

const stateOf = (h: CoreHarness, target: Probe): SyncState | undefined =>
  h.inspect.sync().find((s) => {
    const { id, ...rest } = s.target as SyncTarget & { id?: number }
    void id
    return isDeepStrictEqual(rest, target)
  })

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

/** Вигляд пережив перемикання епохи версій A → B: рядки й строк об'єкта. */
async function switched() {
  const h = await loaded(keysView(1, 2), { mode: "manual" })
  for (const epoch of ["a", "b"]) {
    h.fake.epoch = epoch.repeat(64)
    h.handle.refresh()
    await settle()
    h.fake.deliverAll()
    await settle()
  }
  expect(h.inspect.scheduledDue().get(TASK)).toEqual(expect.any(Number))
  return h
}

/**
 * Строк, який показує `sync()`, — обіцянка: модельний годинник доходить до
 * нього, і запит для цієї цілі йде (подія `watchReads`; для рядка — ще й
 * запит фейкового сервера з його ключем). Звірка з `scheduledDue()` нічого
 * не довела б: проєкція сама його читає.
 */
async function expectReadByDue(h: CoreHarness, target: Probe) {
  const due = stateOf(h, target)?.due
  expect(due, "sync() shows a due").toEqual(expect.any(Number))
  const events: { event: ReadEvent; at: number }[] = []
  const off = h.inspect.watchReads((event) =>
    events.push({ event, at: Date.now() })
  )
  const from = h.fake.log.length
  await vi.advanceTimersByTimeAsync(Math.max(0, due! - Date.now()))
  await settle()
  off()
  const hits = events.filter(({ event: e }) =>
    target.kind === "service"
      ? e.target.kind === "service" && e.target.service === target.service
      : e.target.kind !== "service" && e.target.object === target.object
  )
  expect(hits.length, "a read of the target by its due").toBeGreaterThan(0)
  if (target.kind === "row")
    expect(
      h.fake.log
        .slice(from)
        .some((l) =>
          keysOf(l.query).some(
            (k) => String(k).toLowerCase() === target.key.toLowerCase()
          )
        ),
      "a request of the row's key by its due"
    ).toBe(true)
  return { due: due!, firstReadAt: hits[0]!.at }
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
      target: { ...viewTarget(h.spec), id: expect.any(Number) },
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
    // До `endHydration` вимогу не читає ніхто: умова `hydrating`, без обіцянки.
    expect(stateOf(h, viewTarget(from.spec))).toEqual({
      target: { ...viewTarget(from.spec), id: expect.any(Number) },
      requirements: [{ kind: "hydration-trust", epoch }],
      flights: [],
      queued: [],
      deferral: "hydrating",
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

  // Власного повтору запис не має (§5.14, рядок 12): рядок читає лише такт
  // вигляду-власника.
  it("min-version of an own write without confirmation: due at the interval of its holder view", async () => {
    const h = await loaded()
    write(h, (w) => w.markStale(TASK, [key(1)], 99))
    // Позначка бере нову епоху сесії.
    const epoch = h.core.readEpoch()
    expect(stateOf(h, rowTarget(1))).toEqual({
      target: rowTarget(1),
      requirements: [{ kind: "min-version", epoch, version: 99 }],
      flights: [],
      queued: [],
      due: stateOf(h, viewTarget(h.spec))!.due,
    })
  })

  it("version-epoch-switched: the rows of the switch, due at the object's spread re-read", async () => {
    const h = await switched()
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

describe("sync(): every due it shows is read by then", () => {
  it("the interval of a visible view", async () => {
    const h = await loaded()
    await expectReadByDue(h, viewTarget(h.spec))
  })

  it("the rejoin wave", async () => {
    const h = await withSignals()
    h.transport.join(channel, false)
    await expectReadByDue(h, viewTarget(h.spec))
  })

  it("the failure pause of a view", async () => {
    const h = await loaded(keysView(1, 2), { mode: "manual" })
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    h.fake.take().fail("command.unavailable")
    await settle()
    await expectReadByDue(h, viewTarget(h.spec))
  })

  it("the min-version re-read of the receiver", async () => {
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
    await expectReadByDue(h, rowTarget(1))
  })

  it("the key of the receiver that waits behind the read in flight is queued in sync()", async () => {
    const h = await withSignals(keysView(1, 2))
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
    expect(stateOf(h, rowTarget(1))!.due).toBe(Date.now() + 500)
    // Читання іншого ключа лишається в польоті: приймач single-flight.
    h.fake.hold = () => true
    h.transport.emit(channel, {
      id: "2",
      object: task.id,
      op: "update",
      keys: { id: key(2) },
      row_ver: h.fake.edit(TASK, key(2), { title: "w" }),
    })
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    expect(h.fake.pending.length).toBeGreaterThan(0)
    // Пауза повтору минула: ключ чекає польоту в черзі партій.
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(stateOf(h, rowTarget(1))).toMatchObject({
      queued: [{ kind: "keys", cause: { reason: "signal" } }],
    })
    // Політ осів — ключ іде читанням, черги в рядка більше нема.
    h.fake.hold = undefined
    h.fake.deliverAll()
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    h.fake.deliverAll()
    await settle()
    expect(stateOf(h, rowTarget(1))?.queued ?? []).toEqual([])
  })

  it("the min-version of an own write: the interval of its holder view", async () => {
    const h = await loaded()
    write(h, (w) => w.markStale(TASK, [key(1)], 99))
    await expectReadByDue(h, rowTarget(1))
  })

  it("a row of the epoch switch", async () => {
    const h = await switched()
    await expectReadByDue(h, rowTarget(2))
  })

  // Строк об'єкта, поставлений раніше з іншою причиною, читає й рядки
  // перемикання: причина черги — лише походження, а не вхід рішення.
  it("a row of the epoch switch whose object timer a reread request queued first", async () => {
    const h = await loaded(keysView(1, 2), { mode: "manual" })
    h.fake.epoch = "a".repeat(64)
    h.handle.refresh()
    await settle()
    h.fake.deliverAll()
    await settle()
    h.core.freshness.requestReread([TASK], { jitterMs: 10_000 })
    h.fake.epoch = "b".repeat(64)
    h.handle.refresh()
    await settle()
    h.fake.deliverAll()
    await settle()
    expect(stateOf(h, rowTarget(2))!.requirements).toEqual([
      { kind: "version-epoch-switched" },
    ])
    // Строк — саме той таймер, що читає рядок першим, а не пізніший такт.
    const { due, firstReadAt } = await expectReadByDue(h, rowTarget(2))
    expect(firstReadAt).toBe(due)
  })

  it("the interval of the rights snapshot", async () => {
    const h = setup({
      now: () => Date.now(),
      rightsSnapshot: true,
      limits: { revalidateIntervalMs: INTERVAL },
    })
    seed(h.fake, 1, 2)
    watch(h.core.view(keysView(1, 2)))
    await settle()
    await expectReadByDue(h, RIGHTS)
  })

  // Строк знімка прав, як і строки решти таймерів, на прихованій вкладці
  // не показують: планувальник не спрацює, отже строку немає.
  it("tab-hidden: no due of the rights snapshot on a hidden tab", async () => {
    const h = setup({
      now: () => Date.now(),
      rightsSnapshot: true,
      limits: { revalidateIntervalMs: INTERVAL },
    })
    seed(h.fake, 1, 2)
    watch(h.core.view(keysView(1, 2)))
    await settle()
    expect(stateOf(h, RIGHTS)!.due).toBeDefined()
    h.core.suspend()
    expect(stateOf(h, RIGHTS)!.due).toBeUndefined()
  })
})

describe("sync(): the pause before the retry of a discarded load", () => {
  it("shows the end of the pause as `due` with the cause `retry` although a timer of its object is earlier, and the read starts by it", async () => {
    // Джитер перемикання епохи 60 мс: таймер об'єкта настає зараз, раніше за паузу.
    vi.spyOn(Math, "random").mockReturnValue(0.001)
    const h = await switched()
    const events: { at: number; site: string; reason: string }[] = []
    h.inspect.watchReads((e) =>
      events.push({ at: Date.now(), site: e.site, reason: e.reason })
    )
    // Завантажений вигляд перечитується завантаженням, відповідь покинутої
    // епохи відкидається, і він іде в паузу; таймер його об'єкта вже стоїть.
    h.handle.refresh()
    await settle()
    h.fake.epoch = "a".repeat(64)
    h.fake.deliverAll()
    await settle()
    const objectDue = h.inspect.scheduledDue().get(TASK)!
    const state = stateOf(h, viewTarget(h.spec))!
    const pause =
      DISCARD_PAUSE_MS *
      2 ** Math.max(0, h.inspect.versionEpochs().discards - 1)
    expect(state.flights).toEqual([])
    expect(objectDue).toBeLessThan(Date.now() + pause)
    expect(state.due).toBe(Date.now() + pause)
    expect(state.dueCause).toBe("retry")
    // Рядок, який тримає цей вигляд, дістає той самий строк: таймери об'єкта
    // вигляд у польоті не читають.
    write(h, (w) => w.markStale(TASK, [key(1)], 99))
    expect(stateOf(h, rowTarget(1))!.due).toBe(state.due)
    const due = state.due!
    // Повтор стартує не пізніше кінця паузи.
    events.length = 0
    vi.advanceTimersByTime(pause)
    await settle()
    const retry = events.filter((e) => e.site === "M8")
    expect(retry.length).toBeGreaterThan(0)
    expect(retry.every((e) => e.at <= due)).toBe(true)
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

  // Вимога без епохи: політ, що вже летить, міг стартувати раніше за неї.
  // Політ обіцяє лише вимогу, від якої стартував: пізніша хвиля приєднання
  // ним не обіцяна, хоч вимогу складу він виконає.
  it("promised: per requirement — a re-read promising the composition does not promise a later rejoin", async () => {
    const h = await withSignals()
    h.fake.mode = "manual"
    write(h, (w) => w.markViews(TASK, { unconfirmedSince: h.core.readEpoch() }))
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    expect(stateOf(h, viewTarget(h.spec))!.deferral).toBe("promised")
    h.transport.join(channel, false)
    const state = stateOf(h, viewTarget(h.spec))!
    expect(state.requirements.map((r) => r.kind)).toEqual([
      "composition-unconfirmed",
      "channel-rejoin",
    ])
    expect(state.deferral).not.toBe("promised")
  })

  it("promised: not by a re-read in flight for a requirement without an epoch", async () => {
    const h = await withSignals()
    h.fake.mode = "manual"
    void h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    h.transport.join(channel, false)
    const state = stateOf(h, viewTarget(h.spec))!
    expect(state.requirements).toEqual([{ kind: "channel-rejoin" }])
    expect(state.flights).toEqual([
      { kind: "reread", epoch: expect.any(Number) },
    ])
    expect(state.deferral).toBeUndefined()
  })

  // Планувальник на прихованій вкладці не спрацьовує: його строки нічого не
  // читають, а вимога, яку читає лише він, відкладена вкладкою.
  it("tab-hidden: no due of a scheduler timer on a hidden tab", async () => {
    const h = await loaded()
    expect(stateOf(h, viewTarget(h.spec))!.due).toBe(Date.now() + INTERVAL)
    h.core.suspend()
    expect(stateOf(h, viewTarget(h.spec))!.due).toBeUndefined()
  })

  // Хвиля читає лише видимі вигляди: невидимому вона лише ставить вимогу.
  it("target-invisible: the rejoin wave of an invisible view, without a due", async () => {
    const h = await withSignals()
    h.core.setVisible(h.spec, false)
    h.transport.join(channel, false)
    const state = stateOf(h, viewTarget(h.spec))!
    expect(state.requirements).toEqual([{ kind: "channel-rejoin" }])
    expect(state.deferral).toBe("target-invisible")
    expect(state.due).toBeUndefined()
  })

  it("tab-hidden: the rejoin wave waits for the tab, without a due", async () => {
    const h = await withSignals()
    h.core.suspend()
    h.transport.join(channel, false)
    const state = stateOf(h, viewTarget(h.spec))!
    expect(state.requirements).toEqual([{ kind: "channel-rejoin" }])
    expect(state.deferral).toBe("tab-hidden")
    expect(state.due).toBeUndefined()
  })

  it("tab-hidden: a row of the epoch switch on a hidden tab, without a due", async () => {
    const h = await switched()
    h.core.suspend()
    expect(stateOf(h, rowTarget(2))).toMatchObject({
      requirements: [{ kind: "version-epoch-switched" }],
      deferral: "tab-hidden",
    })
    expect(stateOf(h, rowTarget(2))!.due).toBeUndefined()
  })

  // Строк перемикання читає лише видимі вигляди об'єкта (`visibleOnly`).
  it("no due for a row of the epoch switch no visible view holds", async () => {
    const h = await switched()
    h.core.setVisible(h.spec, false)
    expect(h.inspect.scheduledDue().get(TASK)).toEqual(expect.any(Number))
    expect(stateOf(h, rowTarget(2))).toEqual({
      target: rowTarget(2),
      requirements: [{ kind: "version-epoch-switched" }],
      flights: [],
      queued: [],
    })
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

  // Таймери несумісного об'єкта не читають (§10): строку немає ні в вигляду,
  // ні в рядка, ні в повтору мінімальної версії.
  it("stale-object: a view of an object marked stale-client is refused, without a due", async () => {
    const h = await loaded()
    write(h, (w) => w.markStale(TASK, [key(1)], 99))
    expect(stateOf(h, viewTarget(h.spec))!.due).toEqual(expect.any(Number))
    expect(stateOf(h, rowTarget(1))!.due).toEqual(expect.any(Number))
    h.core.staleClient(TASK)
    expect(stateOf(h, viewTarget(h.spec))).toMatchObject({
      refusal: "stale-object",
    })
    expect(stateOf(h, viewTarget(h.spec))!.due).toBeUndefined()
    expect(stateOf(h, rowTarget(1))!.due).toBeUndefined()
  })

  it("stale-object: no due of the receiver's min-version re-read", async () => {
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
    expect(stateOf(h, rowTarget(1))!.due).toEqual(expect.any(Number))
    h.core.staleClient(TASK)
    expect(stateOf(h, rowTarget(1))!.due).toBeUndefined()
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
    // Після межі відкинутих планувальник нічого не читає (§6.2).
    expect(stateOf(h, viewTarget(h.spec))!.due).toBeUndefined()
  })

  it("closed: the service targets of a closed core are refused", async () => {
    const h = await loaded()
    h.core.close("disposed")
    expect(stateOf(h, VERSION)!.refusal).toBe("closed")
    expect(stateOf(h, viewTarget(h.spec))).toBeUndefined()
  })
})

describe("sync(): the opaque id of a view target", () => {
  const idOf = (h: CoreHarness, spec: ViewSpec) => {
    const target = stateOf(h, viewTarget(spec))!.target
    if (target.kind !== "view") throw new Error("not a view")
    return target.id
  }

  it("is the id of the events of the view's reads, stable across them, distinct for two views", async () => {
    const h = setup({
      now: () => Date.now(),
      limits: { revalidateIntervalMs: INTERVAL },
    })
    seed(h.fake, 1, 2)
    const events: ReadEvent[] = []
    h.inspect.watchReads((event) => events.push(event))
    const a = keysView(1)
    const b = keysView(2)
    watch(h.core.view(a))
    watch(h.core.view(b))
    await settle()
    // Своє читання кожного виду й системне перечитування: той самий id.
    await h.core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const ids = (kind: string) =>
      new Set(
        events.flatMap((e) =>
          e.target.kind === kind && "id" in e.target ? [e.target.id] : []
        )
      )
    expect(idOf(h, a)).not.toBe(idOf(h, b))
    expect(ids("view")).toEqual(new Set([idOf(h, a), idOf(h, b)]))
    const byId = events.filter(
      (e) => e.target.kind === "view" && e.target.id === idOf(h, a)
    )
    expect(new Set(byId.map((e) => e.reason)).size).toBeGreaterThan(1)
  })

  it("is the id of its view in the events of the pages of a window", async () => {
    const win: ViewSpec = {
      kind: "window",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "asc" }],
    }
    const h = await withSignals(win, { windowPage: 1 })
    const events: ReadEvent[] = []
    h.inspect.watchReads((event) => events.push(event))
    h.core.view(win).loadAfter()
    await settle()
    const pages = events.filter((e) => e.target.kind === "page")
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages)
      expect("id" in page.target && page.target.id).toBe(idOf(h, win))
  })
})

describe("sync(): the cause of a load flight", () => {
  it("is the origin of the call that started it; the queued load keeps its own cause and becomes the flight's", async () => {
    const h = setup({ now: () => Date.now(), mode: "manual" })
    seed(h.fake, 1, 2)
    const spec = keysView(1, 2)
    const handle = h.core.view(spec)
    watch(handle)
    await settle()
    const load = () =>
      stateOf(h, viewTarget(spec))!.flights.find((f) => f.kind === "load")
    expect(load()).toMatchObject({ cause: { reason: "mount" } })
    // Явне оновлення під час польоту стає в чергу під своєю причиною.
    handle.refresh()
    await settle()
    expect(stateOf(h, viewTarget(spec))!.queued).toMatchObject([
      { kind: "load", cause: { reason: "user" } },
    ])
    expect(load()).toMatchObject({ cause: { reason: "mount" } })
    h.fake.deliverAll()
    await settle()
    // Політ із черги — причини виклику, що її поставив.
    expect(load()).toMatchObject({ cause: { reason: "user" } })
    h.fake.deliverAll()
    await settle()
    expect(load()).toBeUndefined()
  })
})
