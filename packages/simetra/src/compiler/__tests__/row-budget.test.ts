import { describe, expect, it } from "vitest"
import { buildRuntimeCatalog, type Diagnostic } from "simetra/compiler"
import {
  RESPONSE_BUDGET_BYTES,
  RIGHTS_DELTA_SECTION,
  jsonBytes,
  type CatalogEntryAttribute,
} from "simetra/model"
import { rowBytesOf, type BudgetColumn } from "../row-budget"
import {
  GAUGE_FILE,
  compileRights,
  gaugeMaxBytesLayer,
  policyDomain,
} from "./fixtures/rights"
import { readReferenceDomain } from "./fixtures/reference-domain"

const attribute = (
  overrides: Partial<CatalogEntryAttribute>
): CatalogEntryAttribute => ({
  name: "c",
  column: "c",
  type: "UUID",
  required: false,
  insert: true,
  update: true,
  ...overrides,
})

// Рядок з однією колонкою `c`: `{` `}`, `"c"`, `:` і `,`.
const ONE_COLUMN = 2 + 3 + 2

/**
 * Межа значення за типом (Рд26, Р7): кожна стала — найдовша форма передачі
 * значення типу в байтах `jsonBytes`, з лапками рядка.
 */
describe("rowBytesOf: value bounds", () => {
  it.each<[string, BudgetColumn, number]>([
    ["UUID", attribute({}), 38],
    ["a single-target Ref", attribute({ type: "Ref" }), 38],
    // Копія носія прав — UUID.
    ["Raw", attribute({ type: "Raw" }), 38],
    [
      "an enumeration: its longest label",
      attribute({
        type: "Ref",
        enumValues: [
          { name: "a", label: "a" },
          { name: "b", label: "long_label" },
        ],
      }),
      12,
    ],
    [
      "an enumeration of short labels: null",
      attribute({ type: "Ref", enumValues: [{ name: "a", label: "a" }] }),
      4,
    ],
    [
      "String(10): 6 bytes a char",
      attribute({ type: "String", maxLength: 10 }),
      62,
    ],
    [
      "Numeric(12, 3)",
      attribute({ type: "Numeric", precision: 12, scale: 3 }),
      17,
    ],
    [
      "Numeric without precision: the Postgres limit",
      attribute({ type: "Numeric" }),
      131_072 + 16_383 + 4,
    ],
    ["SmallInt", attribute({ type: "SmallInt" }), 6],
    ["Integer", attribute({ type: "Integer" }), 11],
    ["BigInt", attribute({ type: "BigInt" }), 22],
    ["Boolean", attribute({ type: "Boolean" }), 5],
    ["Date", attribute({ type: "Date" }), 12],
    ["DateTime", attribute({ type: "DateTime" }), 37],
    ["Text: maxBytes", attribute({ type: "Text", maxBytes: 65_536 }), 65_536],
    [
      "an array: maxBytes",
      attribute({ type: "Integer", array: true, maxBytes: 100 }),
      100,
    ],
    ["maxBytes below null: null", attribute({ type: "Json", maxBytes: 2 }), 4],
    ["the key", { column: "c", system: "key" }, 38],
    ["the version", { column: "c", system: "integerText" }, 19],
  ])("%s", (_, column, value) => {
    expect(rowBytesOf([column])).toBe(ONE_COLUMN + value)
  })

  it("a pair counts both columns: a UUID and the longest target label", () => {
    const pair = attribute({
      type: "Ref",
      pair: {
        typeColumn: "c_type",
        targets: [
          { object: { kind: "Catalog", name: "X" }, label: "x" },
          { object: { kind: "Catalog", name: "Y" }, label: "yy" },
        ],
      },
    })
    expect(rowBytesOf([pair])).toBe(
      ONE_COLUMN + 38 + jsonBytes("c_type") + 2 + jsonBytes("yy")
    )
  })

  it("counts the column name in UTF-8 bytes and a repeated column once", () => {
    const column = attribute({ column: "αβ" })
    expect(rowBytesOf([column, column])).toBe(2 + jsonBytes("αβ") + 2 + 38)
  })

  it("is reached by the worst-case values of String and Numeric", () => {
    // Керівний символ `JSON.stringify` екранує як `\u00XX`; `Numeric(3, 3)`
    // має провідний нуль. Межа рахує кому й за останньою колонкою: `+ 1`.
    expect(
      rowBytesOf([
        attribute({ column: "s", type: "String", maxLength: 3 }),
        attribute({ column: "n", type: "Numeric", precision: 3, scale: 3 }),
      ])
    ).toBe(jsonBytes({ s: "\u0001\u0001\u0001", n: "-0.123" }) + 1)
  })
})

/**
 * Правила бюджету рядка над каталогом рантайму. Межа рахується як `C + m`, де
 * `m` — `maxBytes` одного реквізиту: `C` береться з діагностики за `m` понад
 * бюджет, тож тест ставить модель рівно на межу, не повторюючи формули.
 */
describe("row budget rules", () => {
  const BUDGET = RESPONSE_BUDGET_BYTES
  const compileGauge = (maxBytes: Record<string, number>) =>
    compileRights(policyDomain(gaugeMaxBytesLayer(maxBytes)))
  const budgetCodes = (diagnostics: readonly Diagnostic[]) =>
    diagnostics.filter((d) => d.code.endsWith("-over-budget"))
  const overhead = async (name: string) => {
    const { diagnostics } = await compileGauge({ [name]: BUDGET })
    const [over] = budgetCodes(diagnostics)
    return Number(over!.params!.bytes) - BUDGET
  }

  it.each([
    ["a list row of the header", "body", "", "Gauge"],
    ["a tabular section row", "memo", "/tabularSections/0", "Gauge.lines"],
  ])(
    "%s: no diagnostic at the budget, an error past it",
    async (_, name, pointer, row) => {
      const limit = BUDGET - (await overhead(name))
      const at = await compileGauge({ [name]: limit })
      expect(budgetCodes(at.diagnostics)).toEqual([])
      expect(at.ok).toBe(true)
      const over = await compileGauge({ [name]: limit + 1 })
      expect(over.ok).toBe(false)
      expect(
        budgetCodes(over.diagnostics).map((d) => [
          d.code,
          d.severity,
          d.file,
          d.pointer,
          d.params?.row,
          d.params?.bytes,
        ])
      ).toEqual([
        [
          "attribute.row-over-budget",
          "error",
          GAUGE_FILE,
          pointer,
          row,
          String(BUDGET + 1),
        ],
      ])
    }
  )

  it("lazy attributes past the card budget: a warning, not an error", async () => {
    // `blob` (`Bytes` шапки) — лінивий типово: у рядок списку не входить.
    const { ok, diagnostics } = await compileGauge({ blob: BUDGET })
    expect(ok).toBe(true)
    expect(
      budgetCodes(diagnostics).map((d) => [
        d.code,
        d.severity,
        d.file,
        d.params?.object,
      ])
    ).toEqual([["attribute.lazy-over-budget", "warning", GAUGE_FILE, "Gauge"]])
  })

  it("the reference domain and the standard Roles delta section stay within the budget", async () => {
    const { ok, model, diagnostics } = await compileRights(
      readReferenceDomain()
    )
    expect(ok).toBe(true)
    expect(budgetCodes(diagnostics)).toEqual([])
    // Правило справді дійшло до стандартної ТЧ «Ролей»: інакше тиша нічого б
    // не доводила.
    expect(
      buildRuntimeCatalog(model!).objects.some((o) =>
        o.tabularSections.some((s) => s.name === RIGHTS_DELTA_SECTION)
      )
    ).toBe(true)
  })
})
