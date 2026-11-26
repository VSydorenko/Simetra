import { describe, expect, it } from "vitest"
import type { Evidence } from "../sync/evidence"
import { FLIGHT_KINDS, type FlightKind } from "../sync/flight-kinds"
import {
  addRequirement,
  changeVisibility,
  createTargetState,
  derivedInputChanged,
  derivedNeedsRefresh,
  inFlight,
  isVisible,
  promisedFrom,
  releaseTarget,
  requirementOf,
  settleFlight,
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
  gen: 1,
  epoch: 10,
  startedAt: 100,
  now: 150,
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
          evidence: outcome === "applied" ? started(10) : undefined,
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

  it("шапка від бар'єра: знімає системне перечитування", () => {
    const state = withReqs(behind(5, true))
    expect(kinds(settleFlight(state, settle({ flight: "reread" })))).toEqual([])
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

  it("застосоване завантаження пише доказ і строк; пізніше осіле раніше стартоване не зсуває назад", () => {
    const first = settleFlight(
      createTargetState(),
      settle({
        evidence: started(20),
        headerRevision: 7,
        section: true,
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
        section: true,
        startedAt: 210,
      })
    )
    expect(later).toMatchObject({
      okReadEpoch: 20,
      readStart: 20,
      readRevision: 7,
      sectionRead: 20,
    })
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
      failedAt: 150,
    })
    expect(failed(base, { flight: "page" }).failures).toBe(0)
    expect(failed(base, { flight: "reread", loaded: false }).failures).toBe(1)
    const reset = settleFlight(failed(base, { loaded: true }), settle())
    expect(reset).toMatchObject({ failures: 0, failedAt: undefined })
  })

  it("відкинуте завантаження лишає політ під паузою; відкинуте перечитування звільняє", () => {
    const flying = startFlight(createTargetState(), {
      kind: "load",
      epoch: 10,
      cause: { reason: "mount" },
    })
    const discarded = settleFlight(
      flying,
      settle({
        outcome: "discarded-by-epoch",
        evidence: undefined,
        retryAt: 400,
      })
    )
    expect(discarded.flight).toBe(1)
    expect(discarded.retryAt).toBe(400)
    expect(inFlight(discarded)).toBe(false)
    const retried = settleFlight(discarded, settle())
    expect(retried.flight).toBeUndefined()
    expect(retried.retryAt).toBeUndefined()

    const reread = startFlight(createTargetState(), {
      kind: "reread",
      epoch: 10,
      cause: { reason: "interval" },
    })
    const d2 = settleFlight(
      reread,
      settle({
        flight: "reread",
        outcome: "discarded-by-epoch",
        evidence: undefined,
        retryAt: 300,
      })
    )
    expect(d2.rereadEpochs).toEqual([])
    expect(d2.retryAt).toBe(300)
  })

  it("чужого покоління польоту осідання не знімає", () => {
    const flying = startFlight(createTargetState(), {
      kind: "load",
      epoch: 10,
      cause: { reason: "mount" },
    })
    expect(settleFlight(flying, settle({ gen: 99 })).flight).toBe(1)
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
    const idle = settleFlight(queued, settle({ epoch: 1 }))
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

  it("вимога бар'єра стає суворою, коли ту саму ціль відстала шапка", () => {
    const s = withReqs(behind(5, true), behind(6, false))
    expect(s.requirements).toEqual([behind(6, false)])
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

  it("«у польоті»: пауза відкинутого завантаження — не політ", () => {
    const flying = startFlight(createTargetState(), {
      kind: "load",
      epoch: 1,
      cause: { reason: "mount" },
    })
    expect(inFlight(flying)).toBe(true)
    expect(inFlight({ ...flying, retryAt: 5 })).toBe(false)
  })
})
