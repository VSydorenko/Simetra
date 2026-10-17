import { describe, expect, it } from "vitest"
import {
  censusDiagnostics,
  reconcileCensus,
  type CensusClass,
  type EngineCoverage,
} from "../engine/census"

/**
 * Власна мапа покриття тесту: чисті функції не залежать від покриття
 * конкретного двигуна; покриття pg-delta перевіряє тест адаптера в
 * @simetra/designer (`schema-engine/__tests__/census-coverage.test.ts`).
 */
const COVERAGE = {
  table: "compared",
  view: "compared",
  materializedView: "compared",
  sequence: "compared",
  foreignTable: "compared",
  index: "compared",
  "type.enum": "compared",
  "type.composite": "compared",
  "type.range": "compared",
  "type.base": "compared",
  "type.shell": "unmodeled",
  domain: "compared",
  function: "compared",
  procedure: "compared",
  aggregate: "compared",
  "constraint.exclusion": "compared",
  "constraint.trigger": "uncompared",
  trigger: "compared",
  policy: "compared",
  rule: "compared",
  collation: "compared",
  conversion: "compared",
  operator: "compared",
  operatorClass: "compared",
  operatorFamily: "compared",
  cast: "unmodeled",
  textSearchConfiguration: "compared",
  textSearchDictionary: "compared",
  textSearchParser: "compared",
  textSearchTemplate: "compared",
  statistics: "compared",
  transform: "compared",
  publicationRel: "compared",
  publicationSchema: "compared",
  defaultPrivilege: "uncompared",
  extension: "compared",
  language: "unmodeledGlobal",
  accessMethod: "unmodeledGlobal",
  eventTrigger: "compared",
  foreignDataWrapper: "compared",
  server: "compared",
  subscription: "compared",
} as const satisfies EngineCoverage

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
        COVERAGE
      )
    ).toEqual([])
  })

  it("a class the engine extracted fewer of is a mismatch", () => {
    const [found, ...rest] = reconcileCensus(
      [{ class: "policy", count: 3 }],
      new Map<CensusClass, number>([["policy", 2]]),
      COVERAGE
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
        COVERAGE
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
        COVERAGE
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
        COVERAGE,
        []
      ).map((d) => [d.code, d.severity])
    ).toEqual([
      ["engine.unmodeled-class", "error"],
      ["engine.unmodeled-class", "warning"],
      ["engine.unmodeled-class", "warning"],
    ])
  })

  it("a non-default physical property is an error naming it", () => {
    const [found, ...rest] = censusDiagnostics([], new Map(), COVERAGE, [
      { property: "column storage", count: 2 },
    ])
    expect(rest).toEqual([])
    expect(found).toMatchObject({
      code: "engine.unmodeled-property",
      severity: "error",
    })
    expect(found?.message).toMatch(
      /^2 object\(s\) .* non-default column storage/
    )
  })
})
