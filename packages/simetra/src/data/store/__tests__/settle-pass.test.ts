import { describe, expect, it } from "vitest"
import { coreInternals } from "../core"
import type { Scope } from "../session"
import type { WriteLease } from "../source"
import {
  SWEEPS_AFTER_READ_FAILURE,
  rulesOf,
  settleAfter,
  settlePass,
  type SettleEntry,
  type SettleHooks,
} from "../sync/settle-pass"
import { TASK, setup } from "./core-support"
import { createGate, isPermit, type Flight } from "../sync/flight"
import {
  FLIGHT_KINDS,
  FLIGHT_KIND_RULES,
  type FlightKind,
} from "../sync/flight-kinds"
import { EVIDENCE_KINDS, type Evidence } from "../sync/evidence"
import {
  SETTLE_OUTCOMES,
  type ReadCause,
  type ReadReason,
  type ReadTarget,
  type SettleOutcome,
  type SiteCode,
} from "../sync/vocabulary"

/*
 * Таблиця видів польоту (спека ядра синхронізації §5.5, Р-SK2-4) — дані:
 * кожен вид × кожна колонка названі дослівно, щоб зміну клітинки було видно в
 * цьому файлі, а не лише в таблиці. Поля польоту §5.4 — у кінці.
 */

/*
 * Таблиця видів польоту (§5.5, Р-SK2-4) звірена з записаною поведінкою `main`
 * у `settle-sites-main.test.ts`, а не з її копією. Тут — лише її форма.
 */
describe("flight kind table §5.5", () => {
  it("has a row for exactly the five kinds", () => {
    expect(Object.keys(FLIGHT_KIND_RULES)).toEqual([...FLIGHT_KINDS])
  })
})

describe("Evidence", () => {
  it("lists the kinds the three shapes carry", () => {
    const shapes: readonly Evidence[] = [
      { kind: "session-start", epoch: 1 },
      { kind: "row-version", versionEpoch: null, version: 2 },
      { kind: "service-sent", epoch: 3 },
    ]
    expect(shapes.map((e) => e.kind)).toEqual([...EVIDENCE_KINDS])
  })
})

describe("flight fields §5.4 filled by admit", () => {
  const OPEN = { valid: true } as const
  const admitted = (
    state: Parameters<typeof createGate>[0],
    reason: ReadReason = "user"
  ): Flight => {
    const permit = createGate(state).admit(
      { reason } as never,
      { kind: "keys", object: "task" },
      "R7"
    )
    if (!isPermit(permit)) throw new Error("refused")
    return permit.flight()
  }

  it("takes the epoch and the start time at the moment of the flight", () => {
    let epoch = 4
    let clock = 100
    const state = { token: () => OPEN, epoch: () => epoch, now: () => clock }
    const first = admitted(state)
    epoch = 9
    clock = 250
    const retry = admitted(state)
    expect([first.epoch, first.startedAt]).toEqual([4, 100])
    expect([retry.epoch, retry.startedAt]).toEqual([9, 250])
  })

  it("leaves the fields absent where nothing supplies them", () => {
    const flight = admitted({ token: () => OPEN })
    expect("epoch" in flight).toBe(false)
    expect("startedAt" in flight).toBe(false)
    for (const field of [
      "kind",
      "token",
      "purgeBarrier",
      "loadsAtStart",
      "requester",
      "deadlineMs",
    ]) {
      expect(field in flight).toBe(false)
    }
  })

  it("carries what the path passes: kind, token, barrier, requester, deadline", () => {
    const permit = createGate({ token: () => OPEN }).admit(
      { reason: "write-confirm" },
      { kind: "keys", object: "task" },
      "K4"
    )
    if (!isPermit(permit)) throw new Error("refused")
    const token = { valid: true }
    const barrier = new Map([["task", 1]])
    const requester = () => {}
    const loadsAtStart = { gen: 2, flight: undefined }
    const flight = permit.flight({
      kind: "keys",
      token,
      purgeBarrier: barrier,
      loadsAtStart,
      requester,
      deadlineMs: 5000,
    })
    expect(flight.kind).toBe("keys")
    expect(flight.token).toBe(token)
    expect(flight.purgeBarrier).toBe(barrier)
    expect(flight.loadsAtStart).toBe(loadsAtStart)
    expect(flight.requester).toBe(requester)
    expect(flight.deadlineMs).toBe(5000)
  })
})

/*
 * Прохід осідання (Р-SK2-3) без транспорту: записуючі гачки, фальшива область
 * запису. Кожен наслідок × кожен вид польоту: які гачки викликано, у якому
 * порядку, що повернуто; оренда знімається рівно раз.
 */

const KIND_CASES: Record<
  FlightKind,
  { cause: ReadCause; target: ReadTarget; site: SiteCode }
> = {
  load: {
    cause: { reason: "mount" },
    target: { kind: "view", object: "Catalog.Task", id: 1 },
    site: "M1",
  },
  page: {
    cause: { reason: "user" },
    target: { kind: "page", object: "Catalog.Task", id: 1 },
    site: "P1",
  },
  reread: {
    cause: { reason: "interval" },
    target: { kind: "view", object: "Catalog.Task", id: 1 },
    site: "R7",
  },
  keys: {
    cause: { reason: "signal" },
    target: { kind: "keys", object: "Catalog.Task" },
    site: "K1",
  },
  service: {
    cause: { reason: "interval" },
    target: { kind: "service", service: "version" },
    site: "S1",
  },
}

const passGate = createGate({
  token: () => ({ valid: true }),
  epoch: () => 7,
  now: () => 100,
})

class FakeLease implements WriteLease {
  released = 0
  issue() {}
  release() {
    this.released++
  }
}

function flightOf(
  kind: FlightKind,
  extras: {
    lease?: WriteLease
    purgeBarrier?: ReadonlyMap<string, number>
  } = {}
): Flight {
  const { cause, target, site } = KIND_CASES[kind]
  const permit = passGate.admit(cause, target, site)
  if (!isPermit(permit)) throw new Error("refused")
  return permit.flight({ kind, ...extras })
}

interface Rig {
  readonly calls: string[]
  /** `failure` argument of every `settleTarget` call, in order. */
  readonly failures: unknown[]
  readonly hooks: SettleHooks<SettleEntry, string>
  readonly session: { commit: (fn: (scope: Scope) => void) => boolean }
  /** Hook name → a thrown error for the next call. */
  throwIn(name: string): void
  /** Region of a commit refused: the token of the pass is invalid. */
  refuseRegion(): void
}

/** Записуючі гачки: кожен виклик — рядок у журналі, порядок — порядок кроків. */
function rig(
  behave: {
    invalid?: SettleOutcome
    barrier?: boolean
    gate?: "apply" | "discard"
    applyThrows?: boolean
    dropped?: boolean
    refused?: boolean
    lost?: SettleOutcome
    evidence?: Evidence
  } = {}
): Rig {
  const calls: string[] = []
  const failures: unknown[] = []
  const throwing = new Set<string>()
  let regionRefused = false
  const step = <T>(name: string, value?: T): T | undefined => {
    calls.push(name)
    if (throwing.delete(name)) throw new Error(`${name} failed`)
    return value
  }
  const hooks: SettleHooks<SettleEntry, string> = {
    token: { valid: true },
    what: "pass",
    invalid: () => step("invalid", behave.invalid),
    lost: () => {
      calls.push("lost")
      return behave.lost ?? "closed"
    },
    barrier: () => step("barrier", behave.barrier) ?? false,
    refused: () => step("refused", behave.refused) ?? false,
    failureDetail: (error) => {
      calls.push("failureDetail")
      return error instanceof Error ? error.message : "refused"
    },
    beforeGate: () => void step("beforeGate"),
    gate: () => step("gate", behave.gate) ?? "apply",
    discarded: () => void step("discarded"),
    apply: () => {
      calls.push("apply")
      if (behave.applyThrows === true) throw new Error("apply threw")
    },
    applyFailed: () => void step("applyFailed"),
    dropped: () => step("dropped", behave.dropped) ?? false,
    marks: () => void step("marks"),
    evidence: () => behave.evidence,
    settleTarget: (_flight, outcome, evidence, failure) => {
      failures.push(failure?.error)
      return void step(
        `settleTarget:${outcome}${evidence === undefined ? "" : `:${evidence.kind}`}`
      )
    },
    sweep: () => void step("sweep"),
    finish: (_entry, outcome) => void step(`finish:${outcome}`),
    settled: (_entry, outcome, detail) =>
      void step(
        `settled:${outcome}${detail === undefined ? "" : `:${detail}`}`
      ),
  }
  return {
    calls,
    failures,
    hooks,
    session: {
      commit(fn) {
        if (regionRefused) {
          calls.push("commit:refused")
          return false
        }
        calls.push("commit:begin")
        try {
          fn({} as Scope)
        } finally {
          calls.push("commit:end")
        }
        return true
      },
    },
    throwIn: (name) => void throwing.add(name),
    refuseRegion: () => void (regionRefused = true),
  }
}

describe("settlePass: one outcome per flight, in the order of the steps", () => {
  it.each(FLIGHT_KINDS)("%s applied: steps 1, 4, 5, 6, 7, 8, 9", (kind) => {
    const r = rig()
    const flight = flightOf(kind)
    const evidence = kind === "service" ? "service-sent" : "session-start"
    const result = settlePass(r.session, [{ flight }], r.hooks)
    expect(result).toEqual([{ outcome: "applied" }])
    expect(r.failures).toEqual([undefined])
    expect(r.calls).toEqual([
      "commit:begin",
      "invalid",
      "beforeGate",
      "gate",
      "apply",
      "dropped",
      "marks",
      `settleTarget:applied:${evidence}`,
      "sweep",
      "finish:applied",
      "commit:end",
      "settled:applied",
    ])
  })

  it.each(FLIGHT_KINDS)(
    "%s discarded by the epoch gate: nothing applied, the kind's discard hook runs",
    (kind) => {
      const r = rig({ gate: "discard" })
      const result = settlePass(
        r.session,
        [{ flight: flightOf(kind) }],
        r.hooks
      )
      expect(result).toEqual([{ outcome: "discarded-by-epoch" }])
      expect(r.calls).toEqual([
        "commit:begin",
        "invalid",
        "beforeGate",
        "gate",
        "discarded",
        "settleTarget:discarded-by-epoch",
        "sweep",
        "finish:discarded-by-epoch",
        "commit:end",
        "settled:discarded-by-epoch",
      ])
    }
  )

  it.each(FLIGHT_KINDS)(
    "%s failed read: the step 3 branch; step 8 only where main sweeps",
    (kind) => {
      const r = rig()
      const flight = flightOf(kind)
      const error = new Error("refused by server")
      const result = settlePass(
        r.session,
        [{ flight, failure: { error } }],
        r.hooks
      )
      expect(result).toEqual([
        { outcome: "failed", detail: "refused by server" },
      ])
      expect(r.failures).toEqual([error])
      expect(r.calls).toEqual([
        "refused",
        "commit:begin",
        "invalid",
        "failureDetail",
        "settleTarget:failed",
        ...(SWEEPS_AFTER_READ_FAILURE[kind] ? ["sweep"] : []),
        "finish:failed",
        "commit:end",
        "settled:failed:refused by server",
      ])
    }
  )

  it("the evidence hook overrides the epoch evidence the pass derives from the flight", () => {
    const evidence: Evidence = {
      kind: "row-version",
      versionEpoch: null,
      version: 3,
    }
    const r = rig({ evidence })
    settlePass(r.session, [{ flight: flightOf("reread") }], r.hooks)
    expect(r.calls).toContain("settleTarget:applied:row-version")
  })

  it("which kinds sweep after a failed read is data, as on main", () => {
    expect(SWEEPS_AFTER_READ_FAILURE).toEqual({
      load: false,
      page: false,
      reread: true,
      keys: false,
      service: false,
    })
  })

  it.each(FLIGHT_KINDS)(
    "%s apply throws: failed, the hook of the defect, the target settles failed",
    (kind) => {
      const r = rig({ applyThrows: true })
      const result = settlePass(
        r.session,
        [{ flight: flightOf(kind) }],
        r.hooks
      )
      expect(result).toEqual([{ outcome: "failed", detail: "apply threw" }])
      expect(r.failures).toEqual([new Error("apply threw")])
      expect(r.calls).toEqual([
        "commit:begin",
        "invalid",
        "beforeGate",
        "gate",
        "apply",
        "failureDetail",
        "applyFailed",
        "settleTarget:failed",
        "sweep",
        "finish:failed",
        "commit:end",
        "settled:failed:apply threw",
      ])
    }
  )

  it.each(["evicted", "after-purge", "closed"] as const)(
    "step 1 says %s: nothing else of the flight runs, the region still sweeps",
    (lost) => {
      const r = rig({ invalid: lost })
      const result = settlePass(
        r.session,
        [{ flight: flightOf("reread") }],
        r.hooks
      )
      expect(result).toEqual([{ outcome: lost }])
      expect(r.calls).toEqual([
        "commit:begin",
        "invalid",
        "sweep",
        "commit:end",
        `settled:${lost}`,
      ])
    }
  )

  it("step 2 judges only a flight that has a purge barrier", () => {
    const withBarrier = rig({ barrier: true })
    const barrier = new Map([["Catalog.Task", 1]])
    expect(
      settlePass(
        withBarrier.session,
        [{ flight: flightOf("reread", { purgeBarrier: barrier }) }],
        withBarrier.hooks
      )
    ).toEqual([{ outcome: "after-purge" }])
    expect(withBarrier.calls).toEqual([
      "commit:begin",
      "invalid",
      "barrier",
      "sweep",
      "commit:end",
      "settled:after-purge",
    ])
    const without = rig({ barrier: true })
    settlePass(without.session, [{ flight: flightOf("load") }], without.hooks)
    expect(without.calls).not.toContain("barrier")
  })

  it("an applied answer a purge dropped is after-purge and skips steps 6 and 7", () => {
    const r = rig({ dropped: true })
    const result = settlePass(
      r.session,
      [{ flight: flightOf("reread") }],
      r.hooks
    )
    expect(result).toEqual([{ outcome: "after-purge" }])
    expect(r.calls).toEqual([
      "commit:begin",
      "invalid",
      "beforeGate",
      "gate",
      "apply",
      "dropped",
      "sweep",
      "finish:after-purge",
      "commit:end",
      "settled:after-purge",
    ])
  })

  it("a refusal of the read limiter is a silent exit: no region, only the settle", () => {
    const r = rig({ refused: true })
    const lease = new FakeLease()
    const result = settlePass(
      r.session,
      [{ flight: flightOf("load", { lease }), failure: { error: "closed" } }],
      r.hooks
    )
    expect(result).toEqual([{ outcome: "closed" }])
    expect(r.calls).toEqual(["refused", "settled:closed"])
    expect(lease.released).toBe(1)
  })

  it("a refused region (token invalid) gives every flight the outcome of lost()", () => {
    const r = rig({ lost: "evicted" })
    r.refuseRegion()
    const result = settlePass(
      r.session,
      [{ flight: flightOf("load") }],
      r.hooks
    )
    expect(result).toEqual([{ outcome: "evicted" }])
    expect(r.calls).toEqual(["commit:refused", "lost", "settled:evicted"])
  })

  it("a refused region without lost() is closed", () => {
    const r = rig()
    r.refuseRegion()
    const { lost, ...hooks } = r.hooks
    void lost
    expect(
      settlePass(r.session, [{ flight: flightOf("keys") }], hooks)
    ).toEqual([{ outcome: "closed" }])
  })

  it("a step without a hook is a step without an action", () => {
    const result = settlePass(rig().session, [{ flight: flightOf("keys") }], {
      token: { valid: true },
      what: "bare",
    })
    expect(result).toEqual([{ outcome: "applied" }])
  })

  it("covers the closed list of outcomes", () => {
    const seen = new Set<SettleOutcome>()
    for (const behave of [
      {},
      { gate: "discard" as const },
      { applyThrows: true },
      { invalid: "evicted" as const },
      { barrier: true },
      { refused: true },
    ]) {
      const r = rig(behave)
      const flight = flightOf("reread", {
        purgeBarrier: new Map([["Catalog.Task", 1]]),
      })
      const [result] = settlePass(
        r.session,
        [
          behave.refused === true
            ? { flight, failure: { error: "closed" } }
            : { flight },
        ],
        r.hooks
      )
      seen.add(result!.outcome)
    }
    expect([...seen].sort()).toEqual([...SETTLE_OUTCOMES].sort())
  })
})

describe("settlePass: one region over several flights", () => {
  it("settles a batch in one commit: per-flight steps, one sweep, one settle each", () => {
    const r = rig()
    const lease = new FakeLease()
    const entries: SettleEntry[] = [
      { flight: flightOf("reread", { lease }) },
      {
        flight: flightOf("reread", { lease }),
        failure: { error: new Error("boom") },
      },
    ]
    const result = settlePass(r.session, entries, r.hooks)
    expect(result.map((x) => x.outcome)).toEqual(["applied", "failed"])
    expect(r.calls.filter((c) => c === "commit:begin")).toHaveLength(1)
    expect(r.calls.filter((c) => c === "sweep")).toHaveLength(1)
    expect(r.calls.slice(-2)).toEqual([
      "settled:applied",
      "settled:failed:boom",
    ])
    expect(lease.released).toBe(1)
  })
})

describe("settlePass: the write lease is released exactly once", () => {
  const hookNames = [
    "invalid",
    "gate",
    "marks",
    "settleTarget:applied:session-start",
    "sweep",
    "finish:applied",
    "settled:applied",
  ]
  it("releases once on the normal path", () => {
    const r = rig()
    const lease = new FakeLease()
    settlePass(r.session, [{ flight: flightOf("load", { lease }) }], r.hooks)
    expect(lease.released).toBe(1)
  })

  it.each(hookNames)("releases once when the hook %s throws", (name) => {
    const r = rig()
    r.throwIn(name)
    const lease = new FakeLease()
    expect(() =>
      settlePass(r.session, [{ flight: flightOf("load", { lease }) }], r.hooks)
    ).toThrow(`${name} failed`)
    expect(lease.released).toBe(1)
  })

  it("releases once when the region does not run", () => {
    const r = rig()
    r.refuseRegion()
    const lease = new FakeLease()
    settlePass(r.session, [{ flight: flightOf("load", { lease }) }], r.hooks)
    expect(lease.released).toBe(1)
  })

  it("releases after the settle hook: the attempt event is seen with the lease held", () => {
    const order: string[] = []
    const lease: WriteLease = {
      issue() {},
      release: () => void order.push("release"),
    }
    settlePass(rig().session, [{ flight: flightOf("load", { lease }) }], {
      token: { valid: true },
      what: "pass",
      settled: () => void order.push("settled"),
    })
    expect(order).toEqual(["settled", "release"])
  })
})

describe("settleAfter: the dependency of settlements (Р-SK2-8)", () => {
  it("is synchronous when no flight waits for another", () => {
    const r = rig()
    const result = settleAfter(
      r.session,
      [{ flight: flightOf("keys") }],
      r.hooks
    )
    expect(Array.isArray(result)).toBe(true)
  })

  it("waits for the flight it settles after, before step 1", async () => {
    const r = rig()
    let settleSections!: () => void
    const sections = new Promise<void>((resolve) => {
      settleSections = resolve
    })
    const result = settleAfter(
      r.session,
      [{ flight: flightOf("keys"), after: sections }],
      r.hooks
    )
    expect(result).toBeInstanceOf(Promise)
    await Promise.resolve()
    expect(r.calls).toEqual([])
    settleSections()
    expect(await result).toEqual([{ outcome: "applied" }])
    expect(r.calls.slice(0, 2)).toEqual(["commit:begin", "invalid"])
  })
})

describe("rulesOf: the table cell of a flight", () => {
  it("is the row of the kind", () => {
    expect(rulesOf(flightOf("page")).confirms).toBe("own-page")
    expect(rulesOf(flightOf("page")).discardedAnswer).toBe("pause-then-retry")
  })

  it("resolves a keys flight by its reason and its row code", () => {
    const keys = (reason: ReadReason, site: SiteCode) => {
      const permit = passGate.admit(
        reason === "requirement"
          ? { reason, requirement: "row-unfinished" }
          : ({ reason } as ReadCause),
        { kind: "keys", object: "Catalog.Task" },
        site
      )
      if (!isPermit(permit)) throw new Error("refused")
      return rulesOf(permit.flight({ kind: "keys" }))
    }
    expect(keys("signal", "K1")).toMatchObject({
      keysFailure: "composition-unconfirmed",
      discardedAnswer: "nothing",
    })
    expect(keys("requirement", "K3")).toMatchObject({
      keysFailure: "requirement-budget",
    })
    // K2 — перевизначення коду: збій як K1, а не як хвіст K3.
    expect(keys("requirement", "K2")).toMatchObject({
      keysFailure: "composition-unconfirmed",
    })
    expect(keys("write-confirm", "K4")).toMatchObject({
      keysFailure: "reply-to-requester",
      discardedAnswer: "reply-discarded",
    })
  })

  it("refuses a flight without a kind", () => {
    const permit = passGate.admit(
      { reason: "mount" },
      KIND_CASES.load.target,
      "M1"
    )
    if (!isPermit(permit)) throw new Error("refused")
    expect(() => rulesOf(permit.flight())).toThrow("kind")
  })
})

describe("createCore feeds the gate the epoch and the clock", () => {
  it("a flight admitted by the core carries its start epoch and clock reading", () => {
    let clock = 500
    const h = setup({ now: () => clock })
    const { source } = coreInternals(h.core)
    const permit = source.admit(
      { reason: "user" },
      { kind: "view", object: TASK, id: 1 },
      "M5"
    )
    if (!isPermit(permit)) throw new Error("refused")
    const flight = permit.flight()
    expect(typeof flight.epoch).toBe("number")
    expect(flight.startedAt).toBe(500)
    clock = 900
    const next = source.admit(
      { reason: "user" },
      { kind: "view", object: TASK, id: 1 },
      "M5"
    )
    if (!isPermit(next)) throw new Error("refused")
    expect(next.flight().startedAt).toBe(900)
  })
})
