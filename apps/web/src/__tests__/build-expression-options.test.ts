import { describe, it, expect } from "vitest"
import { projectModelSchema, type Attribute, type Document } from "@simetra/core"
import i18n from "../i18n"
import { buildExpressionOptions } from "../lib/build-expression-options"

const translate = (key: string, options?: Record<string, unknown>) =>
  i18n.t(key, options)

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

function targetField(
  type: Attribute["type"],
  overrides: Partial<Attribute> = {}
): Attribute {
  return {
    name: "target_field",
    type,
    required: false,
    indexed: false,
    unique: false,
    defaultValue: null,
    ...(type === "String" ? { length: 50 } : {}),
    ...(type === "Numeric" ? { precision: 15, scale: 2 } : {}),
    ...overrides,
  }
}

describe("buildExpressionOptions", () => {
  it("source=document + Ref target → показує тільки сумісні doc.* поля", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(
      doc,
      "document",
      targetField("Ref", {
        ref: { kind: "Catalog", name: "Warehouses" },
      }),
      translate
    )
    const groupNames = groups.map((g) => g.group)

    expect(groupNames).toContain("Документ")
    expect(groupNames).not.toContain("Агрегати")
    expect(groupNames).not.toContain("Константи")
  })

  it("source=document + Ref target → Документ включає тільки Ref-поля документа", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(
      doc,
      "document",
      targetField("Ref", {
        ref: { kind: "Catalog", name: "Warehouses" },
      }),
      translate
    )
    const docGroup = groups.find((g) => g.group === "Документ")!

    const values = docGroup.options.map((o) => o.value)
    expect(values).toContain("doc.warehouse")
    expect(values).toContain("doc.supplier")
    expect(values).not.toContain("doc.number")
    expect(values).not.toContain("doc.date")
  })

  it("source=document + Numeric target → Агрегати включає sum і count для ТЧ", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(
      doc,
      "document",
      targetField("Numeric"),
      translate
    )
    const aggGroup = groups.find((g) => g.group === "Агрегати")!

    const values = aggGroup.options.map((o) => o.value)
    expect(values).toContain("count(items)")
    expect(values).toContain("sum(items.quantity)")
    expect(values).toContain("sum(items.price)")
  })

  it("source=document + DateTime target → Константи включає now() і literal:", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(
      doc,
      "document",
      targetField("DateTime"),
      translate
    )
    const constGroup = groups.find((g) => g.group === "Константи")!

    const values = constGroup.options.map((o) => o.value)
    expect(values).toContain("now()")
    expect(values).toContain("literal:")
  })

  it("source=tabularSection:items + Ref target → має групу ТЧ рядок і Документ", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(
      doc,
      "tabularSection:items",
      targetField("Ref", {
        ref: { kind: "Catalog", name: "Products" },
      }),
      translate
    )
    const groupNames = groups.map((g) => g.group)

    expect(groupNames.some((n) => n.includes("items") || n.includes("ТЧ"))).toBe(true)
    expect(groupNames).toContain("Документ")
  })

  it("source=tabularSection:items + Numeric target → row.* опції для числових полів ТЧ", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(
      doc,
      "tabularSection:items",
      targetField("Numeric"),
      translate
    )
    const tsGroup = groups[0] // перша група — рядок ТЧ

    const values = tsGroup.options.map((o) => o.value)
    expect(values).toContain("row.quantity")
    expect(values).toContain("row.price")
    expect(values).toContain("row.line_number")
    expect(values).not.toContain("row.product")
  })

  it("source=tabularSection:items + Ref target → doc.* для Ref-полів документа", () => {
    const doc = createDocumentWithTS()
    const groups = buildExpressionOptions(
      doc,
      "tabularSection:items",
      targetField("Ref", {
        ref: { kind: "Catalog", name: "Products" },
      }),
      translate
    )
    const docGroup = groups.find((g) => g.group === "Документ")!

    const values = docGroup.options.map((o) => o.value)
    expect(values).toContain("doc.warehouse")
    expect(values).toContain("doc.supplier")
    expect(values).not.toContain("doc.number")
  })

  it("документ без ТЧ + Numeric target → source=document не має групи Агрегати", () => {
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
    const groups = buildExpressionOptions(
      doc,
      "document",
      targetField("Numeric"),
      translate
    )
    const aggGroup = groups.find((g) => g.group === "Агрегати")
    expect(aggGroup).toBeUndefined()
  })
})
