import { describe, expect, it } from "vitest"
import { createGate, isPermit, type Flight } from "../sync/flight"
import {
  FLIGHT_KINDS,
  FLIGHT_KIND_RULES,
  KEYS_FAILURE,
  SITE_OVERRIDES,
  keysDiscarded,
  keysFailureOf,
  type FlightKind,
  type FlightKindRules,
} from "../sync/flight-kinds"
import { EVIDENCE_KINDS, type Evidence } from "../sync/evidence"
import type { ReadReason } from "../sync/vocabulary"

/*
 * Таблиця видів польоту (спека ядра синхронізації §5.5, Р-SK2-4) — дані:
 * кожен вид × кожна колонка названі дослівно, щоб зміну клітинки було видно в
 * цьому файлі, а не лише в таблиці. Поля польоту §5.4 — у кінці.
 */

describe("flight kind table §5.5", () => {
  const EXPECTED: Record<FlightKind, FlightKindRules> = {
    load: {
      reasons: ["mount", "user", "retry", "requirement"],
      confirms: "view-with-composition",
      successMovesDeadline: true,
      failureCounts: "if-loaded",
      liftsBanners: true,
      setsBanners: false,
      discarded: "pause-then-retry",
    },
    page: {
      reasons: ["user", "retry"],
      confirms: "own-page",
      successMovesDeadline: false,
      failureCounts: "never",
      liftsBanners: false,
      setsBanners: false,
      discarded: "pause-then-retry",
    },
    reread: {
      reasons: ["requirement", "interval", "user", "signal"],
      confirms: "view-stable",
      successMovesDeadline: true,
      failureCounts: "always",
      liftsBanners: false,
      setsBanners: true,
      discarded: "pause-then-deadline",
    },
    keys: {
      reasons: ["signal", "requirement", "write-confirm"],
      confirms: "rows",
      successMovesDeadline: false,
      failureCounts: "by-reason",
      liftsBanners: false,
      setsBanners: false,
      discarded: "nothing",
    },
    service: {
      reasons: ["requirement", "interval"],
      confirms: "service",
      successMovesDeadline: true,
      failureCounts: "never",
      liftsBanners: null,
      setsBanners: false,
      discarded: "none",
    },
  }

  it.each(FLIGHT_KINDS)("%s: every column as in §5.5", (kind) => {
    expect(FLIGHT_KIND_RULES[kind]).toEqual(EXPECTED[kind])
  })

  it("has a row for exactly the five kinds", () => {
    expect(Object.keys(FLIGHT_KIND_RULES)).toEqual([...FLIGHT_KINDS])
  })

  it("keys failure follows the reason: signal, requirement budget, write-confirm reply", () => {
    expect(KEYS_FAILURE).toEqual({
      signal: "composition-unconfirmed",
      requirement: "requirement-budget",
      "write-confirm": "reply-to-requester",
    })
  })

  it("keys discard answers the requester only for write-confirm", () => {
    const reasons: ReadonlyArray<"signal" | "requirement" | "write-confirm"> = [
      "signal",
      "requirement",
      "write-confirm",
    ]
    expect(reasons.map(keysDiscarded)).toEqual([
      "nothing",
      "nothing",
      "reply-discarded",
    ])
  })

  it("K2 overrides the failure of the requirement reason like K1; K3 does not", () => {
    expect(Object.keys(SITE_OVERRIDES)).toEqual(["K2"])
    expect(keysFailureOf("K2", "requirement")).toBe("composition-unconfirmed")
    expect(keysFailureOf("K1", "signal")).toBe("composition-unconfirmed")
    expect(keysFailureOf("K3", "requirement")).toBe("requirement-budget")
    expect(keysFailureOf("K4", "write-confirm")).toBe("reply-to-requester")
    expect(SITE_OVERRIDES.K2?.schedulesRetryAfterCommit).toBe(true)
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
    const flight = permit.flight({
      kind: "keys",
      token,
      purgeBarrier: barrier,
      requester,
      deadlineMs: 5000,
    })
    expect(flight.kind).toBe("keys")
    expect(flight.token).toBe(token)
    expect(flight.purgeBarrier).toBe(barrier)
    expect(flight.requester).toBe(requester)
    expect(flight.deadlineMs).toBe(5000)
  })
})
