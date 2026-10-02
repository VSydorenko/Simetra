import { describe, expect, it } from "vitest"
import {
  censusDiagnostics,
  reconcileCensus,
  type CensusClass,
} from "../engine/census"
import { CENSUS_COVERAGE } from "../engine/pg-delta/census-facts"

/**
 * Звірка лічильників перепису з фактами двигуна (план E2a, рішення 8):
 * пропуск окремих об'єктів покритого класу — помилка, а не тиша.
 */
describe("census reconciliation with engine facts", () => {
  it("equal counts give no diagnostic", () => {
    const facts = new Map<CensusClass, number>([
      ["table", 2],
      ["type.enum", 1],
    ])
    expect(
      reconcileCensus(
        [
          { class: "table", count: 2 },
          { class: "type.enum", count: 1 },
        ],
        facts,
        CENSUS_COVERAGE
      )
    ).toEqual([])
  })

  it("a class the engine extracted fewer of is a mismatch", () => {
    const [found, ...rest] = reconcileCensus(
      [{ class: "policy", count: 3 }],
      new Map<CensusClass, number>([["policy", 2]]),
      CENSUS_COVERAGE
    )
    expect(rest).toEqual([])
    expect(found).toMatchObject({
      code: "engine.census-mismatch",
      severity: "error",
    })
    expect(found?.message).toContain("policy")
    expect(found?.message).toContain("3")
    expect(found?.message).toContain("2")
  })

  it("a class missing on one side counts as zero", () => {
    expect(
      reconcileCensus(
        [],
        new Map<CensusClass, number>([["view", 1]]),
        CENSUS_COVERAGE
      ).map((d) => d.code)
    ).toEqual(["engine.census-mismatch"])
  })

  it("uncompared and unmodeled classes are not reconciled", () => {
    expect(
      reconcileCensus(
        [
          { class: "defaultPrivilege", count: 1 },
          { class: "constraint.trigger", count: 1 },
          { class: "cast", count: 1 },
        ],
        new Map(),
        CENSUS_COVERAGE
      )
    ).toEqual([])
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
        CENSUS_COVERAGE
      ).map((d) => [d.code, d.severity])
    ).toEqual([
      ["engine.unmodeled-class", "error"],
      ["engine.unmodeled-class", "warning"],
      ["engine.unmodeled-class", "warning"],
    ])
  })
})
