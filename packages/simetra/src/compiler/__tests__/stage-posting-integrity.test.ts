import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { Expr } from "simetra/model"
import { inferType, type PostingContext } from "../posting-types"
import { readFiles } from "../stages/files"
import { checkIdentity } from "../stages/identity"
import { checkIntegrity } from "../stages/integrity"
import { buildModel } from "../stages/model"
import {
  SALE_FILE,
  STOCK_FILE,
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  project,
  salesDocument,
} from "./helpers"

type Element = Record<string, unknown>

interface Fixture {
  files: Record<string, unknown>
  sale: Element & {
    attributes: Element[]
    tabularSections: { attributes: Element[] }[]
    registerMovements: Element[]
  }
  stock: Element & {
    dimensions: Element[]
    resources: Element[]
    attributes: Element[]
    recorderTypes: Element[]
  }
}

/**
 * Типова фікстура — документ `Sale` з ТЧ `goods` і регістр залишків `Stock`;
 * `adjust` доповнює її перед компіляцією.
 */
function build(
  movement: Record<string, unknown> = {},
  adjust: (fixture: Fixture) => void = () => {}
) {
  const files = salesDocument(movement)
  const sale = files[SALE_FILE] as Fixture["sale"]
  const stock = files[STOCK_FILE] as Fixture["stock"]
  sale.attributes ??= []
  stock.attributes ??= []
  adjust({ files, sale, stock })
  return compile(metaFiles({ "project.meta.json": project(), ...files }))
}

function codes(result: ReturnType<typeof compile>) {
  return result.diagnostics.map((d) => [d.code, d.file, d.pointer])
}

const ref = (name: string) => ({
  type: "Ref",
  ref: { kind: "Catalog", name },
})

describe("stage 4: movement constructor semantics", () => {
  it("the default movement is clean", () => {
    expect(build().diagnostics).toEqual([])
  })

  it("integer resource rejects numeric expression", () => {
    const result = build(
      {
        fields: {
          item: "row.item",
          qty: "row.qty",
          count: "row.qty * row.price",
        },
      },
      ({ sale, stock }) => {
        stock.resources.push(attribute("count", { type: "Integer" }))
        sale.tabularSections[0]!.attributes.push(
          attribute("price", { type: "Numeric", precision: 15, scale: 2 })
        )
      }
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.type-mismatch",
        file: SALE_FILE,
        pointer: "/posting/movements/0/fields/count",
        params: expect.objectContaining({ offset: 0 }),
      }),
    ])
  })

  it("integer resource accepts integer arithmetic but not division", () => {
    const adjust = ({ stock }: Fixture) => {
      stock.resources.push(attribute("count", { type: "Integer" }))
    }
    expect(
      build(
        { fields: { item: "row.item", qty: "row.qty", count: "2 * 3 - 1" } },
        adjust
      ).diagnostics
    ).toEqual([])
    expect(
      codes(
        build(
          { fields: { item: "row.item", qty: "row.qty", count: "6 / 2" } },
          adjust
        )
      )
    ).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/count"],
    ])
  })

  it("numeric resource accepts integer", () => {
    const result = build(
      { source: "document", fields: { item: "doc.item", qty: "count(goods)" } },
      ({ sale }) => {
        sale.attributes.push(attribute("item", ref("Item")))
      }
    )
    expect(result.diagnostics).toEqual([])
  })

  it("accumulation resource must be numeric", () => {
    const result = build({ fields: { item: "row.item", qty: "'many'" } })
    expect(codes(result)).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/qty"],
    ])
  })

  it("ref field requires the same target", () => {
    const result = build(
      { fields: { item: "row.warehouse", qty: "row.qty" } },
      ({ files, sale }) => {
        files["catalogs/Warehouse/Warehouse.meta.json"] = catalog("Warehouse")
        sale.tabularSections[0]!.attributes.push(
          attribute("warehouse", ref("Warehouse"))
        )
      }
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.type-mismatch",
        pointer: "/posting/movements/0/fields/item",
        params: expect.objectContaining({ offset: 0 }),
      }),
    ])
  })

  it("polymorphic field accepts a subset of targets", () => {
    const result = build({}, ({ files, stock }) => {
      files["catalogs/Service/Service.meta.json"] = catalog("Service")
      stock.dimensions[0] = attribute("item", {
        physicalName: "item",
        type: "Ref",
        allowedTypes: [
          { kind: "Catalog", name: "Item" },
          { kind: "Catalog", name: "Service" },
        ],
      })
    })
    expect(result.diagnostics).toEqual([])
  })

  it("polymorphic expression does not fit a single-target field", () => {
    const result = build(
      { fields: { item: "row.product", qty: "row.qty" } },
      ({ files, sale }) => {
        files["catalogs/Service/Service.meta.json"] = catalog("Service")
        sale.tabularSections[0]!.attributes.push(
          attribute("product", {
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "Item" },
              { kind: "Catalog", name: "Service" },
            ],
          })
        )
      }
    )
    expect(codes(result)).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/item"],
    ])
  })

  it("document standard ref is a Ref to the document", () => {
    const result = build(
      { fields: { item: "row.item", qty: "row.qty", source: "doc.ref" } },
      ({ stock }) => {
        stock.attributes.push(
          attribute("source", {
            type: "Ref",
            ref: { kind: "Document", name: "Sale" },
          })
        )
      }
    )
    expect(result.diagnostics).toEqual([])
  })

  it("null into a dimension", () => {
    const result = build({ fields: { item: "null", qty: "row.qty" } })
    expect(codes(result)).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/item"],
    ])
  })

  it("null into an accumulation register resource", () => {
    const result = build({ fields: { item: "row.item", qty: "null" } })
    expect(codes(result)).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/qty"],
    ])
  })

  it("null into an optional register attribute is clean", () => {
    const result = build(
      { fields: { item: "row.item", qty: "row.qty", note: "null" } },
      ({ stock }) => {
        stock.attributes.push(attribute("note", { type: "String", length: 50 }))
      }
    )
    expect(result.diagnostics).toEqual([])
  })

  it("null into a required register attribute", () => {
    const result = build(
      { fields: { item: "row.item", qty: "row.qty", note: "null" } },
      ({ stock }) => {
        stock.attributes.push(
          attribute("note", { type: "String", length: 50, required: true })
        )
      }
    )
    expect(codes(result)).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/note"],
    ])
  })

  it("condition must be boolean", () => {
    const result = build({ condition: "row.qty" })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.type-mismatch",
        pointer: "/posting/movements/0/condition",
        params: expect.objectContaining({ offset: 0 }),
      }),
    ])
    expect(
      build({ condition: "row.qty > 0 and not false" }).diagnostics
    ).toEqual([])
  })

  it("period must be a date", () => {
    expect(codes(build({ period: "row.qty" }))).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/period"],
    ])
    expect(build({ period: "doc.date" }).diagnostics).toEqual([])
  })

  it("offset is the start of the offending expression", () => {
    const result = build({ condition: "  (row.qty)" })
    expect(result.diagnostics[0]?.params?.offset).toBe(2)
  })

  it("fields incomplete lists missing", () => {
    const result = build({ fields: { qty: "row.qty" } })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.fields-incomplete",
        file: SALE_FILE,
        pointer: "/posting/movements/0/fields",
        params: expect.objectContaining({ missing: "item" }),
      }),
    ])
  })

  it("accumulation register needs every resource", () => {
    const result = build({}, ({ stock }) => {
      stock.resources.push(
        attribute("amount", { type: "Numeric", precision: 15, scale: 2 })
      )
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.fields-incomplete",
        params: expect.objectContaining({ missing: "amount" }),
      }),
    ])
  })

  it("information register needs dimensions and required resources", () => {
    const pricesFile = "information-registers/Prices/Prices.meta.json"
    const run = (fields: Record<string, string>) =>
      build(
        {
          register: { kind: "InformationRegister", name: "Prices" },
          movementType: undefined,
          fields,
        },
        ({ files, sale }) => {
          sale.registerMovements = [
            { kind: "InformationRegister", name: "Prices" },
          ]
          delete files[STOCK_FILE]
          files[pricesFile] = {
            id: "00000000-0000-4000-8000-000000000901",
            kind: "InformationRegister",
            name: "Prices",
            physicalName: "prices",
            periodicity: "Day",
            writeMode: "RecorderSubordinate",
            recorderTypes: [{ kind: "Document", name: "Sale" }],
            dimensions: [attribute("item", ref("Item"))],
            resources: [
              attribute("price", {
                type: "Numeric",
                precision: 15,
                scale: 2,
                required: true,
              }),
              attribute("note", { type: "String", length: 50 }),
            ],
          }
        }
      )
    expect(run({ item: "row.item", price: "row.amount" }).diagnostics).toEqual(
      []
    )
    expect(
      run({ item: "row.item", price: "row.amount", note: "null" }).diagnostics
    ).toEqual([])
    // Регістр відомостей зберігає значення: тип поля — той самий, не лише число.
    expect(
      codes(run({ item: "row.item", price: "row.amount", note: "row.qty" }))
    ).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/note"],
    ])
    expect(codes(run({ item: "row.item", price: "null" }))).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/price"],
    ])
    expect(run({ item: "row.item" }).diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.fields-incomplete",
        params: expect.objectContaining({ missing: "price" }),
      }),
    ])
    // Вид руху — лише в регістра залишків.
    expect(
      codes(
        build(
          {
            register: { kind: "InformationRegister", name: "Prices" },
            fields: { item: "row.item", price: "row.amount" },
          },
          ({ files, sale }) => {
            sale.registerMovements = [
              { kind: "InformationRegister", name: "Prices" },
            ]
            delete files[STOCK_FILE]
            files[pricesFile] = {
              id: "00000000-0000-4000-8000-000000000902",
              kind: "InformationRegister",
              name: "Prices",
              physicalName: "prices",
              writeMode: "RecorderSubordinate",
              recorderTypes: [{ kind: "Document", name: "Sale" }],
              dimensions: [attribute("item", ref("Item"))],
              resources: [
                attribute("price", {
                  type: "Numeric",
                  precision: 15,
                  scale: 2,
                }),
              ],
            }
          }
        )
      )
    ).toEqual([
      ["posting.movement-type", SALE_FILE, "/posting/movements/0/movementType"],
    ])
  })

  it("movement type required for balance register", () => {
    const result = build({ movementType: undefined })
    expect(codes(result)).toEqual([
      ["posting.movement-type", SALE_FILE, "/posting/movements/0"],
    ])
  })

  it("movement type forbidden for turnover register", () => {
    const result = build({}, ({ stock }) => {
      stock.registerType = "Turnover"
    })
    expect(codes(result)).toEqual([
      ["posting.movement-type", SALE_FILE, "/posting/movements/0/movementType"],
    ])
  })

  it("movement type expression must be text", () => {
    const result = build({ movementType: "row.qty" })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.movement-type",
        pointer: "/posting/movements/0/movementType",
        params: expect.objectContaining({ offset: 0 }),
      }),
    ])
    const text = build({ movementType: "doc.direction" }, ({ sale }) => {
      sale.attributes.push(
        attribute("direction", { type: "String", length: 10 })
      )
    })
    expect(text.diagnostics).toEqual([])
  })

  it("document not among recorders", () => {
    const result = build({}, ({ stock }) => {
      stock.recorderTypes = []
    })
    expect(codes(result)).toEqual([
      ["posting.recorder-not-allowed", SALE_FILE, "/registerMovements/0"],
    ])
  })

  it("register not declared in registerMovements", () => {
    const result = build({}, ({ sale }) => {
      sale.registerMovements = []
    })
    expect(codes(result)).toEqual([
      [
        "posting.register-undeclared",
        SALE_FILE,
        "/posting/movements/0/register",
      ],
    ])
  })

  it("row field with document source", () => {
    const result = build(
      { source: "document", fields: { item: "doc.item", qty: "1 + row.qty" } },
      ({ sale }) => {
        sale.attributes.push(attribute("item", ref("Item")))
      }
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.row-in-document-source",
        pointer: "/posting/movements/0/fields/qty",
        params: expect.objectContaining({ offset: 4 }),
      }),
    ])
  })

  it("aggregate with tabular section source", () => {
    const result = build({
      fields: { item: "row.item", qty: "sum(goods.qty)" },
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.aggregate-in-section-source",
        pointer: "/posting/movements/0/fields/qty",
        params: expect.objectContaining({ offset: 0 }),
      }),
    ])
  })

  it("movement target must be a register", () => {
    const result = build(
      { register: { kind: "Catalog", name: "Item" }, fields: {} },
      ({ sale }) => {
        sale.registerMovements = [{ kind: "Catalog", name: "Item" }]
      }
    )
    // Рух у не-регістр інших перевірок не дає: вони не мали б сенсу.
    expect(codes(result)).toEqual([
      ["posting.register-kind", SALE_FILE, "/posting/movements/0/register"],
      ["posting.register-kind", SALE_FILE, "/registerMovements/0"],
    ])
  })

  it("recorder must be a document", () => {
    const result = build({}, ({ files, stock }) => {
      files["catalogs/Owner/Owner.meta.json"] = catalog("Owner")
      files["custom-tables/Journal/Journal.meta.json"] = customTable(
        "Journal",
        { primaryKey: { columns: ["id"] } }
      )
      files["documents/Invoice/Invoice.meta.json"] = document("Invoice")
      stock.recorderTypes.push(
        { kind: "Catalog", name: "Owner" },
        { kind: "CustomTable", name: "Journal" },
        { kind: "Document", name: "Invoice" }
      )
    })
    expect(codes(result)).toEqual([
      ["register.recorder-kind", STOCK_FILE, "/recorderTypes/1"],
      ["register.recorder-kind", STOCK_FILE, "/recorderTypes/2"],
    ])
  })
})

describe("stage 4: movement constructor, fix round 1", () => {
  const pricesFile = "information-registers/Prices/Prices.meta.json"
  /** Рух у регістр відомостей `Prices` замість `Stock`. */
  const intoPrices = (
    movement: Record<string, unknown>,
    register: Record<string, unknown> = {}
  ) =>
    build(
      {
        register: { kind: "InformationRegister", name: "Prices" },
        movementType: undefined,
        ...movement,
      },
      ({ files, sale }) => {
        sale.registerMovements = [
          { kind: "InformationRegister", name: "Prices" },
        ]
        delete files[STOCK_FILE]
        files[pricesFile] = {
          id: "00000000-0000-4000-8000-000000000903",
          kind: "InformationRegister",
          name: "Prices",
          physicalName: "prices",
          writeMode: "RecorderSubordinate",
          recorderTypes: [{ kind: "Document", name: "Sale" }],
          dimensions: [attribute("item", ref("Item"))],
          resources: [
            attribute("price", { type: "Numeric", precision: 15, scale: 2 }),
          ],
          ...register,
        }
      }
    )

  it("fields incomplete includes required attributes in declaration order", () => {
    const result = build({ fields: {} }, ({ stock }) => {
      stock.attributes.push(
        attribute("note", { type: "String", length: 50, required: true }),
        attribute("memo", { type: "String", length: 50 })
      )
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.fields-incomplete",
        pointer: "/posting/movements/0/fields",
        params: expect.objectContaining({ missing: "item, qty, note" }),
      }),
    ])
  })

  it("information register requires its required attributes", () => {
    const result = intoPrices(
      { fields: { item: "row.item" } },
      { attributes: [attribute("source", { type: "Boolean", required: true })] }
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.fields-incomplete",
        params: expect.objectContaining({ missing: "source" }),
      }),
    ])
  })

  it("period is not allowed for a non-periodic information register", () => {
    const fields = { item: "row.item", price: "row.amount" }
    expect(intoPrices({ fields }).diagnostics).toEqual([])
    expect(codes(intoPrices({ fields, period: "doc.date" }))).toEqual([
      ["posting.period-not-allowed", SALE_FILE, "/posting/movements/0/period"],
    ])
    expect(
      intoPrices({ fields, period: "doc.date" }, { periodicity: "Month" })
        .diagnostics
    ).toEqual([])
  })

  it("movement type string literal must be Receipt or Expense", () => {
    const result = build({ movementType: "'Incoming'" })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.movement-type",
        pointer: "/posting/movements/0/movementType",
        params: expect.objectContaining({ value: "Incoming", offset: 0 }),
      }),
    ])
    expect(build({ movementType: "'Receipt'" }).diagnostics).toEqual([])
  })

  it("sum takes the attribute type", () => {
    const run = (count: string) =>
      build(
        {
          source: "document",
          fields: { item: "doc.item", qty: "sum(goods.qty)", count },
        },
        ({ sale, stock }) => {
          sale.attributes.push(attribute("item", ref("Item")))
          sale.tabularSections[0]!.attributes.push(
            attribute("pieces", { type: "Integer" })
          )
          stock.resources.push(attribute("count", { type: "Integer" }))
        }
      )
    expect(run("sum(goods.pieces)").diagnostics).toEqual([])
    expect(codes(run("sum(goods.qty)"))).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/count"],
    ])
  })

  // Поле того самого типу не рятує: sum() додає числа, а над булевим чи
  // текстом SQL або впаде, або порахує не те.
  it("sum needs a numeric field", () => {
    const mismatch = (field: string, text: string) => {
      const result = build(
        {
          source: "document",
          fields: { item: "doc.item", qty: "1", [field]: text },
        },
        ({ sale, stock }) => {
          sale.attributes.push(attribute("item", ref("Item")))
          sale.tabularSections[0]!.attributes.push(
            attribute("flag", { type: "Boolean" }),
            attribute("title", { type: "String", length: 50 })
          )
          stock.attributes.push(
            attribute("flag", { type: "Boolean" }),
            attribute("title", { type: "String", length: 50 })
          )
        }
      )
      expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
        ["posting.type-mismatch", `/posting/movements/0/fields/${field}`],
      ])
      return result.diagnostics[0]!.params
    }
    expect(mismatch("flag", "sum(goods.flag)")).toMatchObject({
      expected: "numeric",
      actual: "boolean",
      offset: 0,
    })
    expect(mismatch("flag", "not sum(goods.flag)")).toMatchObject({
      expected: "numeric",
      actual: "boolean",
      offset: 4,
    })
    expect(mismatch("title", "sum(goods.title)")).toMatchObject({
      expected: "numeric",
      actual: "text",
      offset: 0,
    })
  })

  it("row DateTime and Date attributes are dates", () => {
    const adjust = ({ sale }: Fixture) => {
      sale.tabularSections[0]!.attributes.push(
        attribute("shippedAt", { type: "DateTime" }),
        attribute("shippedOn", { type: "Date" })
      )
    }
    expect(build({ period: "row.shippedAt" }, adjust).diagnostics).toEqual([])
    expect(build({ period: "row.shippedOn" }, adjust).diagnostics).toEqual([])
  })

  it("row.parent is a Ref to the document", () => {
    const adjust = ({ stock }: Fixture) => {
      stock.attributes.push(
        attribute("source", {
          type: "Ref",
          ref: { kind: "Document", name: "Sale" },
        })
      )
    }
    expect(
      build(
        { fields: { item: "row.item", qty: "row.qty", source: "row.parent" } },
        adjust
      ).diagnostics
    ).toEqual([])
    expect(
      codes(build({ fields: { item: "row.parent", qty: "row.qty" } }, adjust))
    ).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/item"],
    ])
  })

  // Незалежний регістр пишуть за ключем запису, без реєстратора: рухи
  // документа йому нема куди покласти, а переписати їх за реєстратором нема за чим.
  it("an independent register takes no document movements", () => {
    const independent = { writeMode: "Independent", recorderTypes: [] }
    const result = intoPrices(
      { fields: { item: "row.item", price: "row.amount" } },
      independent
    )
    expect(codes(result)).toEqual([
      [
        "posting.register-independent",
        SALE_FILE,
        "/posting/movements/0/register",
      ],
      ["posting.register-independent", SALE_FILE, "/registerMovements/0"],
    ])
    expect(result.diagnostics[0]!.hint).toContain(
      "writeMode: RecorderSubordinate"
    )
  })

  it("an independent register in registerMovements alone is one error", () => {
    const declaredOnly = build({}, ({ files, sale }) => {
      sale.registerMovements.push({
        kind: "InformationRegister",
        name: "Prices",
      })
      files[pricesFile] = {
        id: "00000000-0000-4000-8000-000000000904",
        kind: "InformationRegister",
        name: "Prices",
        physicalName: "prices",
        dimensions: [attribute("item", ref("Item"))],
      }
    })
    // Ні recorder-not-allowed, ні source-missing: причина одна.
    expect(codes(declaredOnly)).toEqual([
      ["posting.register-independent", SALE_FILE, "/registerMovements/1"],
    ])
  })
})

describe("stage 4: operand types", () => {
  const adjust = ({ files, sale }: Fixture) => {
    files["catalogs/Service/Service.meta.json"] = catalog("Service")
    files["catalogs/Warehouse/Warehouse.meta.json"] = catalog("Warehouse")
    sale.attributes.push(attribute("item", ref("Item")))
    sale.tabularSections[0]!.attributes.push(
      attribute("title", { type: "String", length: 50 }),
      attribute("warehouse", ref("Warehouse")),
      attribute("product", {
        type: "Ref",
        allowedTypes: [
          { kind: "Catalog", name: "Item" },
          { kind: "Catalog", name: "Service" },
        ],
      })
    )
  }
  const one = (movement: Record<string, unknown>, pointer: string) => {
    const result = build(movement, adjust)
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["posting.type-mismatch", pointer],
    ])
    return result.diagnostics[0]!.params
  }
  const qty = "/posting/movements/0/fields/qty"
  const condition = "/posting/movements/0/condition"

  it("arithmetic operand must be numeric", () => {
    expect(
      one({ fields: { item: "row.item", qty: "row.item + 1" } }, qty)
    ).toMatchObject({ offset: 0 })
  })

  it("unary minus operand must be numeric", () => {
    expect(
      one({ fields: { item: "row.item", qty: "-row.title" } }, qty)
    ).toMatchObject({ offset: 1 })
  })

  it("logical operand must be boolean", () => {
    expect(
      one({ condition: "row.qty and doc.posted" }, condition)
    ).toMatchObject({ offset: 0 })
    expect(one({ condition: "not row.title" }, condition)).toMatchObject({
      offset: 4,
    })
  })

  it("comparison operands must be of the same kind", () => {
    expect(one({ condition: "row.qty = 'x'" }, condition)).toMatchObject({
      offset: 10,
    })
    // Посилання без спільних цілей рівними не бувають.
    expect(
      one({ condition: "row.item = row.warehouse" }, condition)
    ).toMatchObject({ offset: 11 })
  })

  it("ordering is only for numeric, text and date operands", () => {
    // Зміщення — початок самого порівняння, не операнда.
    expect(one({ condition: "row.item < row.item" }, condition)).toMatchObject({
      offset: 0,
    })
    expect(one({ condition: "doc.posted > true" }, condition)).toMatchObject({
      offset: 0,
    })
    for (const text of [
      "row.item = row.item",
      "row.item != row.item",
      "doc.date < doc.date",
      "row.title >= 'a'",
    ]) {
      expect(build({ condition: text }, adjust).diagnostics, text).toEqual([])
    }
  })

  it("a polymorphic side compares only with null", () => {
    // Зміщення — початок поліморфного операнда.
    expect(
      one({ condition: "row.product = doc.item" }, condition)
    ).toMatchObject({ offset: 0, actual: "polymorphic reference" })
    expect(
      one({ condition: "doc.item != row.product" }, condition)
    ).toMatchObject({ offset: 12 })
    expect(
      one({ condition: "row.product = row.product" }, condition)
    ).toMatchObject({ offset: 0 })
    expect(one({ condition: "row.product < null" }, condition)).toMatchObject({
      offset: 0,
    })
  })

  it("ordering with null is a type mismatch", () => {
    expect(one({ condition: "row.qty < null" }, condition)).toMatchObject({
      offset: 10,
      actual: "null",
    })
    expect(one({ condition: "null >= row.title" }, condition)).toMatchObject({
      offset: 0,
    })
  })

  it("a failed operand does not cascade to the field", () => {
    // Вкладена помилка звітує лише операнд, а не результат проти поля.
    one({ fields: { item: "row.item", qty: "(row.title * 2) > 1" } }, qty)
  })

  it("valid operands are clean", () => {
    for (const text of [
      "row.qty * 2 > 0",
      "doc.date = doc.date",
      "row.item = null",
      "row.product = null",
      "row.product != null",
      "not doc.posted or row.qty <= 1",
    ]) {
      expect(build({ condition: text }, adjust).diagnostics, text).toEqual([])
    }
  })
})

describe("stage 4: robustness", () => {
  it("names that stage 2 could not resolve produce no stage 4 noise", () => {
    const files = salesDocument({
      condition: "row.qtty > 0",
      fields: { item: "row.item", qty: "row.qty", nope: "row.qty" },
    })
    const stage1 = readFiles(
      metaFiles({ "project.meta.json": project(), ...files })
    )
    const stage2 = checkIdentity(
      stage1.objects,
      stage1.brokenNames,
      stage1.project
    )
    expect(stage2.diagnostics.map((d) => d.code)).toEqual([
      "posting.field-unknown",
      "posting.register-field-unknown",
    ])
    const stage3 = buildModel(stage1.objects, stage1.project!)
    const stage4 = checkIntegrity(
      stage1.objects,
      stage2.references,
      stage3,
      "camelCase",
      []
    )
    expect(stage4).toEqual([])
  })

  it("expression that failed T0 parsing is skipped", () => {
    const files = salesDocument()
    const stage1 = readFiles(
      metaFiles({ "project.meta.json": project(), ...files })
    )
    const stage2 = checkIdentity(
      stage1.objects,
      stage1.brokenNames,
      stage1.project
    )
    // Об'єкт уже розібрано: зламаний вираз підставляємо в дані напряму, як
    // лишила б його стадія 1 без гарантій T0.
    const sale = stage1.objects.find((o) => o.file === SALE_FILE)!
    const movement = (
      sale.data as {
        posting: { movements: { fields: Record<string, string> }[] }
      }
    ).posting.movements[0]!
    movement.fields.qty = "row.qty +"
    const stage4 = checkIntegrity(
      stage1.objects,
      stage2.references,
      buildModel(stage1.objects, stage1.project!),
      "camelCase",
      []
    )
    expect(stage4).toEqual([])
  })
})

describe("expression types", () => {
  const at = { start: 0, end: 1 }
  const num = (value: string): Expr => ({ type: "number", value, ...at })
  const ctx: PostingContext = { typeOf: () => ({ kind: "unknown" }) }

  it("number literal integer by the absence of a decimal point", () => {
    expect(inferType(num("3"), ctx)).toEqual({ kind: "numeric", integer: true })
    expect(inferType(num("3.5"), ctx)).toEqual({
      kind: "numeric",
      integer: false,
    })
  })

  it("arithmetic keeps integer only without division", () => {
    const bin = (op: "+" | "/", left: Expr, right: Expr): Expr => ({
      type: "binary",
      op,
      left,
      right,
      ...at,
    })
    expect(inferType(bin("+", num("1"), num("2")), ctx)).toEqual({
      kind: "numeric",
      integer: true,
    })
    expect(inferType(bin("/", num("4"), num("2")), ctx)).toEqual({
      kind: "numeric",
      integer: false,
    })
  })

  it("unknown operand keeps the result unknown", () => {
    const field: Expr = { type: "field", base: "row", name: "x", ...at }
    expect(
      inferType(
        { type: "binary", op: "*", left: field, right: num("2"), ...at },
        ctx
      )
    ).toEqual({ kind: "unknown" })
  })

  it("count is integer, comparison is boolean", () => {
    expect(inferType({ type: "count", section: "goods", ...at }, ctx)).toEqual({
      kind: "numeric",
      integer: true,
    })
    expect(
      inferType(
        { type: "binary", op: "<", left: num("1"), right: num("2"), ...at },
        ctx
      )
    ).toEqual({ kind: "boolean" })
  })
})
