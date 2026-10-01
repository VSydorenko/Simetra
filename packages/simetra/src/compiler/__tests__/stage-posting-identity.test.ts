import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  SALE_FILE,
  STOCK_FILE,
  metaFiles,
  project,
  salesDocument,
} from "./helpers"

function idsOf(files: Record<string, unknown>) {
  const sale = files[SALE_FILE] as {
    id: string
    tabularSections: { id: string; attributes: { id: string }[] }[]
  }
  const stock = files[STOCK_FILE] as {
    id: string
    dimensions: { id: string }[]
    resources: { id: string }[]
  }
  return { sale, stock }
}

// Ідентифікатори фікстури лічильникові, тож беремо їх із того самого виклику.
async function build(
  movement: Record<string, unknown> = {},
  sale: Record<string, unknown> = {},
  projectOverrides: Record<string, unknown> = {}
) {
  const files = salesDocument(movement, sale)
  const result = await compile(
    metaFiles({ "project.meta.json": project(projectOverrides), ...files })
  )
  return { result, ...idsOf(files) }
}

describe("stage 2: movement constructor references", () => {
  it("resolves movement references", async () => {
    const { result, sale, stock } = await build()
    expect(result.diagnostics).toEqual([])
    const refs = result.model!.references.filter((r) =>
      r.role.startsWith("posting.")
    )
    const goods = sale.tabularSections[0]!
    const pick = (role: string) =>
      refs.filter((r) => r.role === role).map((r) => [r.from.pointer, r.to])
    expect(pick("posting.register")).toEqual([
      [
        "/posting/movements/0/register",
        { kind: "AccumulationRegister", id: stock.id },
      ],
    ])
    expect(pick("posting.registerField")).toEqual([
      [
        "/posting/movements/0/fields/item",
        { kind: "Element", id: stock.dimensions[0]!.id },
      ],
      [
        "/posting/movements/0/fields/qty",
        { kind: "Element", id: stock.resources[0]!.id },
      ],
    ])
    expect(pick("posting.rowField")).toEqual([
      [
        "/posting/movements/0/fields/item",
        { kind: "Element", id: goods.attributes[0]!.id },
      ],
      [
        "/posting/movements/0/fields/qty",
        { kind: "Element", id: goods.attributes[1]!.id },
      ],
    ])
    expect(pick("posting.tabularSection")).toEqual([
      [
        "/posting/movements/0/source/tabularSection",
        { kind: "Element", id: goods.id },
      ],
    ])
  })

  it("standard document field resolves to synthetic id", async () => {
    const { result, sale } = await build({ period: "doc.date" })
    expect(result.diagnostics).toEqual([])
    const found = result.model!.references.find(
      (r) => r.role === "posting.docField"
    )
    expect(found?.to).toEqual({ kind: "Element", id: `${sale.id}#date` })
    expect(found?.span).toEqual({ start: 0, end: 8 })
  })

  it("standard names follow project style", async () => {
    const style = { naming: { attributeCase: "snake_case" } }
    const ok = await build(
      { fields: { item: "row.item", qty: "row.line_number" } },
      {},
      style
    )
    expect(ok.result.diagnostics).toEqual([])
    expect(
      ok.result.model!.references.find(
        (r) =>
          r.role === "posting.rowField" &&
          r.from.pointer === "/posting/movements/0/fields/qty"
      )?.to
    ).toEqual({
      kind: "Element",
      id: `${ok.sale.tabularSections[0]!.id}#lineNumber`,
    })
    const bad = await build({ fields: { qty: "row.lineNumber" } }, {}, style)
    expect(bad.result.diagnostics.map((d) => d.code)).toEqual([
      "posting.field-unknown",
    ])
  })

  it("unknown row field", async () => {
    const { result } = await build({ fields: { qty: "row.qtty" } })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.field-unknown",
        file: SALE_FILE,
        pointer: "/posting/movements/0/fields/qty",
        params: expect.objectContaining({ offset: 0 }),
      }),
    ])
  })

  it("unknown register field key", async () => {
    const { result } = await build({ fields: { quantity: "row.qty" } })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.register-field-unknown",
        pointer: "/posting/movements/0/fields/quantity",
      }),
    ])
  })

  it("unknown tabular section", async () => {
    const { result } = await build({
      source: { tabularSection: "services" },
      fields: { qty: "1" },
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.tabular-section-unknown",
        pointer: "/posting/movements/0/source/tabularSection",
      }),
    ])
  })

  it("resolves aggregates and skips unparsable expressions", async () => {
    const { result } = await build({
      source: "document",
      condition: "sum(goods.amount) > 0",
      fields: { qty: "count(goods)", item: "doc.nope" },
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["posting.field-unknown", "/posting/movements/0/fields/item"],
    ])
    const broken = await build({ period: "doc.", source: "document" })
    expect(broken.result.diagnostics.map((d) => d.code)).toEqual([
      "posting.parse",
    ])
  })

  it("sum and count references carry spans", async () => {
    const { result, sale } = await build({
      source: "document",
      fields: { qty: "sum(goods.qty) + count(goods)" },
    })
    const goods = sale.tabularSections[0]!
    const refs = result.model!.references.filter(
      (r) =>
        r.from.pointer === "/posting/movements/0/fields/qty" &&
        r.role !== "posting.registerField"
    )
    expect(refs.map((r) => [r.role, r.to, r.span])).toEqual([
      [
        "posting.tabularSection",
        { kind: "Element", id: goods.id },
        { start: 0, end: 14 },
      ],
      [
        "posting.rowField",
        { kind: "Element", id: goods.attributes[1]!.id },
        { start: 0, end: 14 },
      ],
      [
        "posting.tabularSection",
        { kind: "Element", id: goods.id },
        { start: 17, end: 29 },
      ],
    ])
  })

  it("condition references are indexed", async () => {
    const { result, sale } = await build({
      condition: "row.qty > 0 and doc.number = 'A'",
    })
    const refs = result.model!.references.filter(
      (r) => r.from.pointer === "/posting/movements/0/condition"
    )
    expect(refs.map((r) => [r.role, r.to, r.span])).toEqual([
      [
        "posting.rowField",
        { kind: "Element", id: sale.tabularSections[0]!.attributes[1]!.id },
        { start: 0, end: 7 },
      ],
      [
        "posting.docField",
        { kind: "Element", id: `${sale.id}#number` },
        { start: 16, end: 26 },
      ],
    ])
  })

  it("movementType expression references are indexed", async () => {
    const { result, sale } = await build({ movementType: "doc.number" })
    const refs = result.model!.references.filter(
      (r) => r.from.pointer === "/posting/movements/0/movementType"
    )
    expect(refs.map((r) => [r.role, r.to, r.span])).toEqual([
      [
        "posting.docField",
        { kind: "Element", id: `${sale.id}#number` },
        { start: 0, end: 10 },
      ],
    ])
  })
})
