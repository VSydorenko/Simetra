import { describe, expect, it } from "vitest"
import {
  censusDiagnostics,
  reconcileCensus,
  type CensusClass,
} from "simetra/schema"
import { CENSUS_COVERAGE } from "../pg-delta/census-facts"

/**
 * Покриття класів перепису закріпленим pg-delta (план E2a, рішення 8): що
 * звіряється лічильником, що непорівнюване, а що — тиха втрата двигуна.
 * Чисті функції звірки тестує `simetra` на власній мапі покриття.
 */
describe("pg-delta census coverage", () => {
  it("classifies classes the way the pinned engine sees them", () => {
    expect(CENSUS_COVERAGE).toMatchObject({
      table: "compared",
      view: "compared",
      "type.enum": "compared",
      policy: "compared",
      defaultPrivilege: "uncompared",
      "constraint.trigger": "uncompared",
      cast: "unmodeled",
      "type.shell": "unmodeled",
      language: "unmodeledGlobal",
      accessMethod: "unmodeledGlobal",
    })
  })

  it("reconciles compared classes and skips the rest", () => {
    expect(
      reconcileCensus(
        [
          { class: "table", count: 2 },
          { class: "policy", count: 3 },
          { class: "defaultPrivilege", count: 1 },
          { class: "constraint.trigger", count: 1 },
          { class: "cast", count: 1 },
        ],
        new Map<CensusClass, number>([
          ["table", 2],
          ["policy", 2],
          ["view", 1],
        ]),
        CENSUS_COVERAGE
      ).map((d) => d.message)
    ).toEqual([
      expect.stringContaining("view"),
      expect.stringContaining("policy"),
    ])
  })

  it("an unmodeled class is an error, a global one without a boundary a warning", () => {
    expect(
      censusDiagnostics(
        [
          { class: "type.shell", count: 1 },
          { class: "language", count: 1 },
          { class: "accessMethod", count: 2 },
        ],
        new Map(),
        CENSUS_COVERAGE,
        []
      ).map((d) => [d.code, d.severity])
    ).toEqual([
      ["engine.unmodeled-class", "error"],
      ["engine.unmodeled-class", "warning"],
      ["engine.unmodeled-class", "warning"],
    ])
  })
})
