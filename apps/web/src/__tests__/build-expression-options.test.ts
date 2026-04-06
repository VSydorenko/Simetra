import { describe, it, expect } from "vitest"
import { projectModelSchema, type Document } from "@simetra/core"
import { buildExpressionOptions } from "../lib/build-expression-options"

const identity = (key: string, fallback?: string) => fallback ?? key

function createDocumentWithTS(): Document {
  const model = projectModelSchema.parse({
    project: { name: "Test" },
    documents: [
      {
        kind: "Document",
        name: "GoodsReceipt",
        attributes: [
          {
            name: "warehouse",
            type: "Ref",
            ref: { kind: "Catalog", name: "Warehouses" },
          },
          {
            name: "supplier",
            type: "Ref",
            ref: { kind: "Catalog", name: "Partners" },
          },
        ],
        tabularSections: [
          {
            name: "items",
            attributes: [
              {
                name: "product",
                type: "Ref",
                ref: { kind: "Catalog", name: "Products" },
              },
              { name: "quantity", type: "Numeric", precision: 15, scale: 3 },
              { name: "price", type: "Numeric", precision: 15, scale: 2 },
            ],
          },
        ],
      },
    ],
  })
  return model.documents[0]
}

describe("buildExpressionOptions", () => {
  it('source=document → групи: Документ, Агрегати, Константи', () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(doc, "document", identity)
    const groupNames = groups.map((g) => g.group)

    expect(groupNames).toContain("Документ")
    expect(groupNames).toContain("Агрегати")
    expect(groupNames).toContain("Константи")
  })

  it("source=document → Документ включає standard + custom fields", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(doc, "document", identity)
    const docGroup = groups.find((g) => g.group === "Документ")!

    const values = docGroup.options.map((o) => o.value)
    // Стандартні реквізити документа (без id)
    expect(values).toContain("doc.number")
    expect(values).toContain("doc.date")
    // Користувацькі реквізити
    expect(values).toContain("doc.warehouse")
    expect(values).toContain("doc.supplier")
  })

  it("source=document → Агрегати включає sum і count для ТЧ", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(doc, "document", identity)
    const aggGroup = groups.find((g) => g.group === "Агрегати")!

    const values = aggGroup.options.map((o) => o.value)
    expect(values).toContain("count(items)")
    expect(values).toContain("sum(items.quantity)")
    expect(values).toContain("sum(items.price)")
  })

  it("source=document → Константи включає now() і literal:", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(doc, "document", identity)
    const constGroup = groups.find((g) => g.group === "Константи")!

    const values = constGroup.options.map((o) => o.value)
    expect(values).toContain("now()")
    expect(values).toContain("literal:")
  })

  it("source=tabularSection:items → має групу ТЧ рядок і Документ", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(doc, "tabularSection:items", identity)
    const groupNames = groups.map((g) => g.group)

    // Перша група — рядок ТЧ
    expect(groupNames.some((n) => n.includes("items") || n.includes("ТЧ"))).toBe(true)
    expect(groupNames).toContain("Документ")
  })

  it("source=tabularSection:items → row.* опції для полів ТЧ", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(doc, "tabularSection:items", identity)
    const tsGroup = groups[0] // перша група — рядок ТЧ

    const values = tsGroup.options.map((o) => o.value)
    expect(values).toContain("row.product")
    expect(values).toContain("row.quantity")
    expect(values).toContain("row.price")
    // Стандартний реквізит ТЧ
    expect(values).toContain("row.line_number")
  })

  it("source=tabularSection:items → doc.* для полів документа", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(doc, "tabularSection:items", identity)
    const docGroup = groups.find((g) => g.group === "Документ")!

    const values = docGroup.options.map((o) => o.value)
    expect(values).toContain("doc.warehouse")
    expect(values).toContain("doc.supplier")
    expect(values).toContain("doc.number")
  })

  it("документ без ТЧ → source=document → не має групи Агрегати", () => {
    const model = projectModelSchema.parse({
      project: { name: "Test" },
      documents: [
        {
          kind: "Document",
          name: "Payment",
          attributes: [{ name: "amount", type: "Numeric", precision: 15, scale: 2 }],
          tabularSections: [],
        },
      ],
    })
    const doc = model.documents[0]
    const groups = buildExpressionOptions(doc, "document", identity)
    const aggGroup = groups.find((g) => g.group === "Агрегати")
    expect(aggGroup).toBeUndefined()
  })
})
