import { describe, expect, it } from "vitest"
import type { Evidence } from "../sync/evidence"
import { FLIGHT_KINDS, type FlightKind } from "../sync/flight-kinds"
import {
  addRequirement,
  changeVisibility,
  createTargetState,
  derivedInputChanged,
  derivedNeedsRefresh,
  dropRequirementForDefect,
  inFlight,
  isVisible,
  promisedFrom,
  releaseTarget,
  requirementOf,
  settleFlight,
  slotChanged,
  staleComposition,
  startFlight,
  type Requirement,
  type SettleInput,
  type TargetState,
} from "../sync/target-state"
import { SETTLE_OUTCOMES, type SettleOutcome } from "../sync/vocabulary"

const composition = (since: number): Requirement => ({
  kind: "composition-unconfirmed",
  since,
})
const behind = (since: number, barrier = false): Requirement => ({
  kind: "target-behind-header",
  since,
  barrier,
})
const ownerHeader = (since: number, mark = 1): Requirement => ({
  kind: "owner-header",
  since,
  mark,
})

const started = (epoch: number): Evidence => ({
  kind: "session-start",
  epoch,
})

const settle = (over: Partial<SettleInput> = {}): SettleInput => ({
  outcome: "applied",
  flight: "load",
  evidence: started(10),
  own: true,
  startedAt: 100,
  loaded: true,
  ...over,
})

const withReqs = (...reqs: Requirement[]): TargetState =>
  reqs.reduce(addRequirement, createTargetState())

const kinds = (s: TargetState) => s.requirements.map((r) => r.kind)

describe("TargetState: політ осів — вимоги", () => {
  it("лише застосоване читання знімає вимоги; решта наслідків — ні", () => {
    for (const outcome of SETTLE_OUTCOMES) {
      const state = withReqs(composition(5), behind(5), ownerHeader(5))
      const next = settleFlight(
        state,
        settle({
          outcome,
          carriedHeader: true,
          evidence: started(10),
        })
      )
      expect(kinds(next).length, outcome).toBe(outcome === "applied" ? 0 : 3)
    }
  })

  it("склад: завантаження й перечитування знімають, сторінка, ключі, службове — ні", () => {
    const lifted: Record<FlightKind, boolean> = {
      load: true,
      reread: true,
      page: false,
      keys: false,
      service: false,
    }
    for (const flight of FLIGHT_KINDS) {
      const next = settleFlight(withReqs(composition(5)), settle({ flight }))
      expect(
        requirementOf(next, "composition-unconfirmed") === undefined,
        flight
      ).toBe(lifted[flight])
    }
  })

  it("склад: чужий політ вимоги не знімає", () => {
    const next = settleFlight(withReqs(composition(5)), settle({ own: false }))
    expect(kinds(next)).toEqual(["composition-unconfirmed"])
  })

  it("старт рівно since знімає, since − 1 — ні (усі три види)", () => {
    const state = withReqs(composition(7), behind(7), ownerHeader(7))
    const at = settleFlight(
      state,
      settle({ evidence: started(7), carriedHeader: true })
    )
    expect(kinds(at)).toEqual([])
    const before = settleFlight(
      state,
      settle({ evidence: started(6), carriedHeader: true })
    )
    expect(kinds(before).sort()).toEqual([
      "composition-unconfirmed",
      "owner-header",
      "target-behind-header",
    ])
  })

  it("доказ без старту (версія рядка, службовий) вимог виглядів не знімає", () => {
    const rowVersion: Evidence = {
      kind: "row-version",
      versionEpoch: null,
      version: 3,
    }
    for (const evidence of [
      rowVersion,
      { kind: "service-sent", epoch: 50 } as const,
    ])
      expect(
        kinds(settleFlight(withReqs(composition(1)), settle({ evidence })))
      ).toEqual(["composition-unconfirmed"])
  })

  it("шапка: завантаження цілі знімає; перечитування картки — ні", () => {
    const state = withReqs(behind(5))
    expect(kinds(settleFlight(state, settle({ flight: "load" })))).toEqual([])
    expect(kinds(settleFlight(state, settle({ flight: "reread" })))).toEqual([
      "target-behind-header",
    ])
  })

  it("шапка від бар'єра: знімає перечитування, завантаження — ні", () => {
    const state = withReqs(behind(5, true))
    expect(kinds(settleFlight(state, settle({ flight: "reread" })))).toEqual([])
    expect(kinds(settleFlight(state, settle({ flight: "load" })))).toEqual([
      "target-behind-header",
    ])
  })

  it("шапка: чужий політ знімає, лише коли покриває ключ шапки й ціль повна", () => {
    const state = withReqs(behind(5))
    const other = { own: false, flight: "keys" as const }
    expect(
      kinds(
        settleFlight(
          state,
          settle({ ...other, coversHeader: true, complete: true })
        )
      )
    ).toEqual([])
    expect(
      kinds(
        settleFlight(
          state,
          settle({ ...other, coversHeader: true, complete: false })
        )
      )
    ).toEqual(["target-behind-header"])
    expect(
      kinds(
        settleFlight(
          state,
          settle({ ...other, coversHeader: false, complete: true })
        )
      )
    ).toEqual(["target-behind-header"])
    // Перечитування картки — власний політ: (б) на нього не поширюється.
    expect(
      kinds(
        settleFlight(
          state,
          settle({ flight: "reread", coversHeader: true, complete: true })
        )
      )
    ).toEqual(["target-behind-header"])
  })

  it("шапка власника: знімає лише завантаження ТЧ з частиною шапки", () => {
    const state = withReqs(ownerHeader(5))
    expect(kinds(settleFlight(state, settle()))).toEqual(["owner-header"])
    expect(
      kinds(
        settleFlight(state, settle({ flight: "reread", carriedHeader: true }))
      )
    ).toEqual(["owner-header"])
    expect(kinds(settleFlight(state, settle({ carriedHeader: true })))).toEqual(
      []
    )
  })

  it("вимога, що стала після старту польоту, лишається", () => {
    const next = settleFlight(
      withReqs(composition(11)),
      settle({ evidence: started(10) })
    )
    expect(kinds(next)).toEqual(["composition-unconfirmed"])
  })
})

describe("TargetState: політ осів — доказ, строк, місце польоту", () => {
  it("відкинуте й збій доказу не пишуть, readRevision не рухають", () => {
    for (const outcome of ["discarded-by-epoch", "failed"] as SettleOutcome[]) {
      const next = settleFlight(
        createTargetState(),
        settle({ outcome, evidence: undefined, headerRevision: 4 })
      )
      expect(next.okReadEpoch).toBeUndefined()
      expect(next.readRevision).toBeUndefined()
      expect(next.refreshedAt).toBeUndefined()
    }
  })

  it("застосоване завантаження пише доказ і строк; пізніше осіле раніше стартоване не зсуває назад доказу шапки", () => {
    const first = settleFlight(
      createTargetState(),
      settle({
        evidence: started(20),
        headerRevision: 7,
        sectionRead: 20,
        startedAt: 200,
      })
    )
    expect(first).toMatchObject({
      okReadEpoch: 20,
      readStart: 20,
      readRevision: 7,
      sectionRead: 20,
      refreshedAt: 200,
    })
    const later = settleFlight(
      first,
      settle({
        evidence: started(15),
        headerRevision: 3,
        sectionRead: 15,
        startedAt: 210,
      })
    )
    // Доказ складу й звіт запису ТЧ — останнього застосованого, як на `main`
    // (рішення архітекторки 26.11, F3, F4): вони можуть піти назад.
    expect(later).toMatchObject({
      okReadEpoch: 15,
      readStart: 20,
      readRevision: 7,
      sectionRead: 15,
    })
  })

  it("звіт запису ТЧ пишеться й за збою застосування; без звіту sectionRead не рухається", () => {
    const failed = settleFlight(
      createTargetState(),
      settle({
        outcome: "failed",
        evidence: undefined,
        applyFailed: true,
        sectionRead: 12,
      })
    )
    expect(failed.sectionRead).toBe(12)
    expect(failed.okReadEpoch).toBeUndefined()
    expect(settleFlight(failed, settle({ flight: "reread" })).sectionRead).toBe(
      12
    )
    expect(
      settleFlight(failed, settle({ flight: "reread", sectionRead: 14 }))
        .sectionRead
    ).toBe(14)
  })

  it("перечитування не пише readRevision", () => {
    const next = settleFlight(
      createTargetState(),
      settle({ flight: "reread", headerRevision: 7 })
    )
    expect(next.readRevision).toBeUndefined()
    expect(next.okReadEpoch).toBe(10)
  })

  it("доказ шапки власника пише лише завантаження з частиною шапки", () => {
    expect(
      settleFlight(createTargetState(), settle()).ownerHeaderRead
    ).toBeUndefined()
    expect(
      settleFlight(createTargetState(), settle({ carriedHeader: true }))
        .ownerHeaderRead
    ).toBe(10)
  })

  it("збій рахує паузу за правилом виду; успіх скидає", () => {
    const base = createTargetState()
    const failed = (s: TargetState, over: Partial<SettleInput>) =>
      settleFlight(
        s,
        settle({ outcome: "failed", evidence: undefined, ...over })
      )
    expect(failed(base, { loaded: false }).failures).toBe(0)
    expect(failed(base, { loaded: true })).toMatchObject({
      failures: 1,
      failedAt: 100,
    })
    expect(failed(base, { flight: "page" }).failures).toBe(0)
    expect(failed(base, { flight: "reread", loaded: false }).failures).toBe(1)
    const reset = settleFlight(failed(base, { loaded: true }), settle())
    expect(reset).toMatchObject({ failures: 0, failedAt: undefined })
  })

  const cause = { reason: "mount" } as const
  const loading = () =>
    startFlight(createTargetState(), { kind: "load", epoch: 10, cause })
  const discardedInput = (over: Partial<SettleInput> = {}) =>
    settle({ outcome: "discarded-by-epoch", evidence: undefined, ...over })

  // Місце польоту (рішення архітекторки 26.11, F1): осідання його не звільняє;
  // моменти `main` — перехід «місце польоту змінилось».
  const attempt = (s: TargetState, epoch: number, over = {}) =>
    startFlight(s, {
      kind: "load",
      epoch,
      cause: { reason: "retry" },
      retry: true,
      ...over,
    })

  it("відкинуте завантаження з паузою тримає політ, повтор і кінець ланцюга знімають", () => {
    const discarded = settleFlight(attempt(loading(), 10), discardedInput())
    expect(discarded).toMatchObject({ flight: 1, retryAt: undefined })
    const paused = slotChanged(discarded, { kind: "paused", retryAt: 400 })
    expect(paused).toMatchObject({ flight: 1, retryAt: 400 })
    expect(inFlight(paused)).toBe(true)
    const woke = slotChanged(paused, { kind: "pause-ended" })
    expect(woke).toMatchObject({ flight: 1, retryAt: undefined })
    const retried = attempt(paused, 20, { headerRevision: 9 })
    expect(retried).toMatchObject({
      gen: 1,
      flight: 1,
      flightEpoch: 20,
      flightRevision: 9,
      flightCause: cause,
      retryAt: undefined,
      trailing: undefined,
      answerPending: true,
    })
    const queued = startFlight(paused, {
      kind: "load",
      epoch: 21,
      cause: { reason: "user" },
    })
    expect(
      startFlight(queued, { kind: "load", epoch: 22, cause, retry: true })
        .trailing
    ).toEqual({ reason: "user" })
    const settled = settleFlight(retried, settle())
    expect(settled).toMatchObject({ flight: 1, answerPending: true })
    const answered = slotChanged(settled, { kind: "answered" })
    expect(answered).toMatchObject({ flight: 1, answerPending: false })
    const end = slotChanged(answered, { kind: "freed" })
    expect(end).toMatchObject({
      flight: undefined,
      flightCause: undefined,
      retryAt: undefined,
      flightEpoch: 20,
    })
    expect(inFlight(end)).toBe(false)
  })

  it("жоден наслідок осідання місця польоту не звільняє й паузи не ставить", () => {
    for (const flight of ["load", "page", "reread", "keys", "service"] as const)
      for (const outcome of SETTLE_OUTCOMES) {
        const paused = slotChanged(attempt(loading(), 10), {
          kind: "paused",
          retryAt: 400,
        })
        const next = settleFlight(
          paused,
          settle({
            flight,
            outcome,
            evidence: outcome === "applied" ? started(10) : undefined,
          })
        )
        expect(next.flight, `${flight} ${outcome}`).toBe(1)
        expect(next.retryAt, `${flight} ${outcome}`).toBe(400)
        expect(next.rereadEpochs, `${flight} ${outcome}`).toEqual([])
      }
  })

  it("кінець ланцюга: черга живої цілі забирається, мертвої — лишається; перевірка — завжди", () => {
    const why = { reason: "retry", site: "R16" } as const
    let s = startFlight(loading(), { kind: "load", epoch: 11, cause })
    s = slotChanged(s, { kind: "recheck", why })
    s = slotChanged(s, { kind: "freed" })
    expect(s).toMatchObject({ flight: undefined, trailing: cause })
    expect(
      slotChanged(s, { kind: "queue-taken", trailing: true })
    ).toMatchObject({ trailing: undefined, recheck: undefined })
    expect(
      slotChanged(s, { kind: "queue-taken", trailing: false })
    ).toMatchObject({ trailing: cause, recheck: undefined })
  })

  it("епоху перечитування знімає прихід відповідей, а не осідання; місце завантаження стоїть", () => {
    let s = loading()
    s = startFlight(s, { kind: "reread", epoch: 10, cause })
    s = startFlight(s, { kind: "reread", epoch: 10, cause })
    s = settleFlight(s, discardedInput({ flight: "reread" }))
    expect(s.rereadEpochs).toEqual([10, 10])
    s = slotChanged(s, { kind: "reread-ended", epoch: 10 })
    expect(s.rereadEpochs).toEqual([10])
    expect(slotChanged(s, { kind: "reread-ended", epoch: 99 })).toBe(s)
    expect(inFlight(slotChanged(s, { kind: "reread-ended", epoch: 10 }))).toBe(
      true
    )
  })

  it("заступлення: покоління зростає, запит стає в чергу, місце стоїть", () => {
    const flying = attempt(loading(), 10)
    const next = startFlight(flying, {
      kind: "load",
      cause: { reason: "mount" },
      supersede: true,
    })
    expect(next).toMatchObject({
      gen: 2,
      flight: 1,
      trailing: { reason: "mount" },
      answerPending: true,
    })
    expect(
      startFlight(next, {
        kind: "load",
        cause: { reason: "user" },
        supersede: true,
      })
    ).toMatchObject({ gen: 3, flight: 1, trailing: { reason: "mount" } })
  })

  it("доказ на старті спроби (рядок 20 main) — лише з proofAtStart і ревізією шапки", () => {
    const base = loading()
    expect(attempt(base, 10, { headerRevision: 4 })).toMatchObject({
      readRevision: undefined,
      readStart: undefined,
    })
    expect(attempt(base, 10, { proofAtStart: true })).toMatchObject({
      readRevision: undefined,
      readStart: undefined,
    })
    expect(
      attempt(base, 10, { headerRevision: 4, proofAtStart: true })
    ).toMatchObject({ readRevision: 4, readStart: 10 })
  })

  it("місце польоту займають без епохи: епоху старту дає перша спроба", () => {
    const first = attempt(loading(), 10)
    const freed = slotChanged(first, { kind: "freed" })
    const next = startFlight(freed, { kind: "load", cause })
    expect(next).toMatchObject({ gen: 2, flight: 2, flightEpoch: 10 })
    expect(attempt(next, 12).flightEpoch).toBe(12)
    expect(() =>
      startFlight(createTargetState(), { kind: "reread", cause })
    ).toThrow("epoch")
  })

  it("перевірка й хвіст: перші лишаються; чекачі розбуджуються разом", () => {
    const one = { reason: "retry", site: "R16" } as const
    const two = { reason: "retry", site: "R18" } as const
    let s = slotChanged(createTargetState(), { kind: "recheck", why: one })
    s = slotChanged(s, { kind: "recheck", why: two })
    expect(s.recheck).toEqual(one)
    const tail = Promise.resolve()
    s = slotChanged(s, { kind: "tail", tail })
    s = slotChanged(s, { kind: "tail", tail: Promise.resolve() })
    expect(s.rereadTail).toBe(tail)
    expect(slotChanged(s, { kind: "tail-ended" }).rereadTail).toBeUndefined()
    const waiter = () => undefined
    s = slotChanged(s, { kind: "waiter", waiter })
    s = slotChanged(s, { kind: "waiter", waiter })
    expect(s.rereadWaiters).toEqual([waiter, waiter])
    expect(slotChanged(s, { kind: "waiters-resolved" }).rereadWaiters).toEqual(
      []
    )
  })

  it("перехід місця польоту ревізії не рухає й вимог не знімає", () => {
    const s = addRequirement(attempt(loading(), 10), composition(1))
    for (const change of [
      { kind: "answered" },
      { kind: "paused", retryAt: 1 },
      { kind: "pause-ended" },
      { kind: "freed" },
      { kind: "queue-taken", trailing: true },
      { kind: "reread-ended", epoch: 1 },
    ] as const) {
      const next = slotChanged(s, change)
      expect(next.revision, change.kind).toBe(s.revision)
      expect(next.requirements, change.kind).toEqual(s.requirements)
    }
  })

  it("чужий політ не чіпає місця польоту, паузи, доказу й строку", () => {
    const base = slotChanged(attempt(loading(), 10), {
      kind: "paused",
      retryAt: 400,
    })
    for (const outcome of SETTLE_OUTCOMES) {
      for (const flight of ["load", "keys", "reread"] as const) {
        const next = settleFlight(
          base,
          settle({ own: false, flight, outcome, sectionRead: 3 })
        )
        expect(next, `${flight} ${outcome}`).toEqual(base)
      }
    }
  })

  it("збій застосування відповіді паузи збоїв не рахує, збій читання — рахує з часом старту", () => {
    const base = createTargetState()
    const failed = (over: Partial<SettleInput>) =>
      settleFlight(
        base,
        settle({
          outcome: "failed",
          evidence: undefined,
          startedAt: 77,
          ...over,
        })
      )
    expect(failed({ applyFailed: true }).failures).toBe(0)
    expect(failed({ applyFailed: true, flight: "reread" }).failures).toBe(0)
    expect(failed({})).toMatchObject({ failures: 1, failedAt: 77 })
  })

  it("дефект самотесту знімає вимогу без доказу; робочий шлях — ні", () => {
    const s = withReqs(composition(5), behind(5))
    const dropped = dropRequirementForDefect(s, "composition-unconfirmed")
    expect(kinds(dropped)).toEqual(["target-behind-header"])
    expect(dropped.revision).toBe(s.revision + 1)
    expect(kinds(settleFlight(s, settle({ evidence: started(4) })))).toEqual([
      "composition-unconfirmed",
      "target-behind-header",
    ])
  })
})

describe("TargetState: політ стартував", () => {
  const cause = { reason: "mount" } as const

  it("друге завантаження зливається в чергу з причиною першого запиту", () => {
    const one = startFlight(createTargetState(), {
      kind: "load",
      epoch: 1,
      cause,
    })
    const two = startFlight(one, {
      kind: "load",
      epoch: 2,
      cause: { reason: "user" },
    })
    const three = startFlight(two, {
      kind: "load",
      epoch: 3,
      cause: { reason: "retry" },
    })
    expect(three).toMatchObject({ flight: 1, flightEpoch: 1, gen: 1 })
    expect(three.trailing).toEqual({ reason: "user" })
  })

  it("наступне завантаження поза польотом споживає чергу", () => {
    const one = startFlight(createTargetState(), {
      kind: "load",
      epoch: 1,
      cause,
    })
    const queued = startFlight(one, { kind: "load", epoch: 2, cause })
    const idle = slotChanged(settleFlight(queued, settle()), { kind: "freed" })
    const next = startFlight(idle, { kind: "load", epoch: 5, cause })
    expect(next).toMatchObject({
      gen: 2,
      flight: 2,
      flightEpoch: 5,
      trailing: undefined,
    })
  })

  it("системні перечитування летять разом; їхні епохи рахують у польоті й обіцянці", () => {
    let s = startFlight(createTargetState(), {
      kind: "reread",
      epoch: 4,
      cause,
    })
    s = startFlight(s, { kind: "reread", epoch: 6, cause })
    expect(s.rereadEpochs).toEqual([4, 6])
    expect(inFlight(s)).toBe(true)
    expect(promisedFrom(s, 6)).toBe(true)
    expect(promisedFrom(s, 7)).toBe(false)
  })

  it("сторінка стану цілі не міняє", () => {
    const s = createTargetState()
    expect(startFlight(s, { kind: "page", epoch: 1, cause })).toEqual(s)
  })

  it("черга й хвіст перечитування обіцяють будь-яку епоху", () => {
    const flying = startFlight(createTargetState(), {
      kind: "load",
      epoch: 1,
      cause,
    })
    expect(promisedFrom(flying, 1)).toBe(true)
    expect(promisedFrom(flying, 2)).toBe(false)
    expect(
      promisedFrom(startFlight(flying, { kind: "load", epoch: 2, cause }), 99)
    ).toBe(true)
  })
})

describe("TargetState: вимоги, видимість, ревізія", () => {
  it("вимога того самого виду не знижується; різні ідентифікатори позначки — нова вимога", () => {
    let s = withReqs(composition(5), composition(3))
    expect(requirementOf(s, "composition-unconfirmed")?.since).toBe(5)
    s = withReqs(ownerHeader(5, 1), ownerHeader(8, 1))
    expect(s.requirements).toEqual([ownerHeader(8, 1)])
    s = withReqs(ownerHeader(5, 1), ownerHeader(2, 2))
    expect(s.requirements).toEqual([ownerHeader(2, 2)])
  })

  it("злиття бар'єра й шапки лишає бар'єр: завантаження не знімає, перечитування знімає", () => {
    for (const order of [
      [behind(5, true), behind(6, false)],
      [behind(5, false), behind(6, true)],
    ]) {
      const s = withReqs(...order)
      expect(s.requirements).toEqual([behind(6, true)])
      expect(kinds(settleFlight(s, settle({ flight: "load" })))).toEqual([
        "target-behind-header",
      ])
      expect(kinds(settleFlight(s, settle({ flight: "reread" })))).toEqual([])
    }
  })

  it("ревізію рухає вимога складу, доказ складу й видимість за вимоги; вимоги рядків — ні", () => {
    const s0 = createTargetState()
    expect(addRequirement(s0, behind(1)).revision).toBe(0)
    expect(addRequirement(s0, ownerHeader(1)).revision).toBe(0)
    const s1 = addRequirement(s0, composition(1))
    expect(s1.revision).toBe(1)
    expect(addRequirement(s1, composition(1)).revision).toBe(1)
    expect(changeVisibility(s1, { subscribers: 1 }).revision).toBe(2)
    // видимість без вимоги складу ревізії не рухає
    expect(changeVisibility(s0, { subscribers: 1 }).revision).toBe(0)
    expect(changeVisibility(s0, { visible: false }).revision).toBe(0)
    // знята вимога й новий доказ — вхід похідних
    const lifted = settleFlight(s1, settle({ evidence: started(4) }))
    expect(lifted.revision).toBe(s1.revision + 1)
    expect(settleFlight(s0, settle({ evidence: started(4) })).revision).toBe(1)
    expect(
      settleFlight(s0, settle({ outcome: "failed", evidence: undefined }))
        .revision
    ).toBe(0)
  })

  it("шостий перехід рухає лише ревізію; tab-hidden без вимоги складу — ні", () => {
    const s0 = createTargetState()
    expect(derivedInputChanged(s0, "tab-hidden")).toBe(s0)
    for (const c of ["channel", "registry-flag", "affected"] as const) {
      const next = derivedInputChanged(s0, c)
      expect(next).toEqual({ ...s0, revision: 1 })
    }
    const s1 = addRequirement(s0, composition(1))
    expect(derivedInputChanged(s1, "tab-hidden")).toEqual({
      ...s1,
      revision: s1.revision + 1,
    })
  })

  it("ефективна видимість: явна, інакше є підписники", () => {
    let s = createTargetState()
    expect(isVisible(s)).toBe(false)
    s = changeVisibility(s, { subscribers: 2 })
    expect(isVisible(s)).toBe(true)
    s = changeVisibility(s, { visible: false })
    expect(isVisible(s)).toBe(false)
    s = changeVisibility(s, { visible: undefined })
    expect(isVisible(s)).toBe(true)
    s = changeVisibility(s, { visible: true, subscribers: 0 })
    expect(isVisible(s)).toBe(true)
  })

  it("ціль відпущено: черга й чекачі відпадають, вимоги лишаються", () => {
    const s = startFlight(
      startFlight(withReqs(composition(1), behind(1)), {
        kind: "load",
        epoch: 1,
        cause: { reason: "mount" },
      }),
      {
        kind: "load",
        epoch: 2,
        cause: { reason: "user" },
        waiter: () => undefined,
      }
    )
    const r = releaseTarget(changeVisibility(s, { subscribers: 1 }))
    expect(r).toMatchObject({
      trailing: undefined,
      subscribers: 0,
      rereadWaiters: [],
    })
    expect(kinds(r).sort()).toEqual([
      "composition-unconfirmed",
      "target-behind-header",
    ])
  })
})

describe("TargetState: похідні", () => {
  it("staleComposition читає лише вимогу складу й запит каналу", () => {
    const never = () => false
    expect(staleComposition(withReqs(behind(1), ownerHeader(1)), never)).toBe(
      false
    )
    expect(staleComposition(withReqs(composition(1)), never)).toBe(true)
    const asked: number[] = []
    const unproven = (read: number) => (asked.push(read), true)
    expect(staleComposition(createTargetState(), unproven)).toBe(true)
    expect(asked).toEqual([-1])
    const proven = settleFlight(
      createTargetState(),
      settle({ evidence: started(9) })
    )
    asked.length = 0
    staleComposition(proven, unproven)
    expect(asked).toEqual([9])
  })

  it("похідна needsRefresh: вимога складу й невидима ціль чи прихована вкладка", () => {
    const s = withReqs(composition(1))
    expect(derivedNeedsRefresh(s, false)).toBe(true)
    expect(
      derivedNeedsRefresh(changeVisibility(s, { subscribers: 1 }), false)
    ).toBe(false)
    expect(
      derivedNeedsRefresh(changeVisibility(s, { subscribers: 1 }), true)
    ).toBe(true)
    expect(derivedNeedsRefresh(withReqs(behind(1), ownerHeader(1)), true)).toBe(
      false
    )
  })

  it("«у польоті» залежить від місця польоту, не від паузи", () => {
    const flying = startFlight(createTargetState(), {
      kind: "load",
      epoch: 1,
      cause: { reason: "mount" },
    })
    expect(inFlight(flying)).toBe(true)
    expect(inFlight({ ...flying, retryAt: 5 })).toBe(true)
    expect(inFlight(createTargetState())).toBe(false)
  })
})

describe("TargetState: дрібні гарантії переходів", () => {
  const cause = { reason: "mount" } as const
  const why = { reason: "retry", site: "R18" } as const

  it("ціль відпущено чистить хвіст, перевірку, паузу, чекачів", () => {
    let s = startFlight(createTargetState(), {
      kind: "load",
      epoch: 1,
      cause,
      recheck: why,
      tail: Promise.resolve(),
      waiter: () => undefined,
    })
    s = { ...s, retryAt: 5 }
    const r = releaseTarget(s)
    expect(r).toMatchObject({
      rereadTail: undefined,
      recheck: undefined,
      retryAt: undefined,
      rereadWaiters: [],
    })
  })

  it("старт завантаження знімає паузу", () => {
    const s = { ...createTargetState(), retryAt: 5 }
    expect(
      startFlight(s, { kind: "load", epoch: 1, cause }).retryAt
    ).toBeUndefined()
  })

  it("перечитування споживає перевірку, перша відкладена зберігається", () => {
    let s = startFlight(createTargetState(), {
      kind: "load",
      epoch: 1,
      cause,
      recheck: why,
    })
    s = startFlight(s, {
      kind: "load",
      epoch: 2,
      cause,
      recheck: { reason: "retry", site: "R16" },
    })
    expect(s.recheck).toEqual(why)
    expect(
      startFlight(s, { kind: "reread", epoch: 3, cause }).recheck
    ).toBeUndefined()
    expect(
      startFlight(s, { kind: "reread", epoch: 3, cause, recheck: why }).recheck
    ).toEqual(why)
  })

  it("ownerHeaderRead і sectionRead йдуть уперед; sectionRead лише для ТЧ", () => {
    let s = settleFlight(
      createTargetState(),
      settle({ evidence: started(20), carriedHeader: true, headerRevision: 1 })
    )
    s = settleFlight(
      s,
      settle({ evidence: started(15), carriedHeader: true, headerRevision: 1 })
    )
    expect(s.ownerHeaderRead).toBe(20)
    expect(s.sectionRead).toBeUndefined()
  })
})
