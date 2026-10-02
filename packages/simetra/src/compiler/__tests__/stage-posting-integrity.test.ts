import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
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
async function build(
  movement: Record<string, unknown> = {},
  adjust: (fixture: Fixture) => void = () => {}
) {
  const files = salesDocument(movement)
  const sale = files[SALE_FILE] as Fixture["sale"]
  const stock = files[STOCK_FILE] as Fixture["stock"]
  sale.attributes ??= []
  stock.attributes ??= []
  adjust({ files, sale, stock })
  return await compile(metaFiles({ "project.meta.json": project(), ...files }))
}

function codes(result: CompileResult) {
  return result.diagnostics.map((d) => [d.code, d.file, d.pointer])
}

const ref = (name: string) => ({
  type: "Ref",
  ref: { kind: "Catalog", name },
})

describe("stage 4: movement constructor semantics", () => {
  it("the default movement is clean", async () => {
    expect((await build()).diagnostics).toEqual([])
  })

  it("integer resource rejects numeric expression", async () => {
    const result = await build(
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

  it("integer resource accepts integer arithmetic but not division", async () => {
    const adjust = ({ stock }: Fixture) => {
      stock.resources.push(attribute("count", { type: "Integer" }))
    }
    expect(
      (
        await build(
          { fields: { item: "row.item", qty: "row.qty", count: "2 * 3 - 1" } },
          adjust
        )
      ).diagnostics
    ).toEqual([])
    expect(
      codes(
        await build(
          { fields: { item: "row.item", qty: "row.qty", count: "6 / 2" } },
          adjust
        )
      )
    ).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/count"],
    ])
  })

  it("numeric resource accepts integer", async () => {
    const result = await build(
      { source: "document", fields: { item: "doc.item", qty: "count(goods)" } },
      ({ sale }) => {
        sale.attributes.push(attribute("item", ref("Item")))
      }
    )
    expect(result.diagnostics).toEqual([])
  })

  it("accumulation resource must be numeric", async () => {
    const result = await build({ fields: { item: "row.item", qty: "'many'" } })
    expect(codes(result)).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/qty"],
    ])
  })

  it("ref field requires the same target", async () => {
    const result = await build(
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

  it("polymorphic field accepts a subset of targets", async () => {
    const result = await build({}, ({ files, stock }) => {
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

  it("polymorphic expression does not fit a single-target field", async () => {
    const result = await build(
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

  it("document standard ref is a Ref to the document", async () => {
    const result = await build(
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

  /** `warehouse` — обов'язковий вимір, `item` (з фікстури) — необов'язковий. */
  const withWarehouse = ({ stock }: Pick<Fixture, "stock">) => {
    stock.dimensions.push(
      attribute("warehouse", { ...ref("Warehouse"), required: true })
    )
  }
  const warehouseFiles = ({ files }: Pick<Fixture, "files">) => {
    files["catalogs/Warehouse/Warehouse.meta.json"] = catalog("Warehouse")
  }
  const withRequired = (fixture: Fixture) => {
    withWarehouse(fixture)
    warehouseFiles(fixture)
  }

  it("null into optional dimension", async () => {
    const result = await build(
      { fields: { warehouse: "null", item: "null", qty: "1" } },
      (f) => {
        withRequired(f)
      }
    )
    expect(codes(result)).toEqual([
      [
        "posting.type-mismatch",
        SALE_FILE,
        "/posting/movements/0/fields/warehouse",
      ],
    ])
    const ok = await build(
      { fields: { warehouse: "doc.warehouse", item: "null", qty: "1" } },
      (f) => {
        withRequired(f)
        f.sale.attributes.push(attribute("warehouse", ref("Warehouse")))
      }
    )
    expect(ok.diagnostics).toEqual([])
  })

  it("optional dimension may be omitted", async () => {
    const fixture = (f: Fixture) => {
      withRequired(f)
      f.sale.attributes.push(attribute("warehouse", ref("Warehouse")))
    }
    expect(
      (
        await build(
          { fields: { warehouse: "doc.warehouse", qty: "1" } },
          fixture
        )
      ).diagnostics
    ).toEqual([])
    expect(
      (await build({ fields: { item: "null", qty: "1" } }, fixture)).diagnostics
    ).toEqual([
      expect.objectContaining({
        code: "posting.fields-incomplete",
        params: expect.objectContaining({ missing: "warehouse" }),
      }),
    ])
  })

  it("null into an accumulation register resource", async () => {
    const result = await build({ fields: { item: "row.item", qty: "null" } })
    expect(codes(result)).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/qty"],
    ])
  })

  it("null into an optional register attribute is clean", async () => {
    const result = await build(
      { fields: { item: "row.item", qty: "row.qty", note: "null" } },
      ({ stock }) => {
        stock.attributes.push(attribute("note", { type: "String", length: 50 }))
      }
    )
    expect(result.diagnostics).toEqual([])
  })

  it("null into a required register attribute", async () => {
    const result = await build(
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

  it("condition must be boolean", async () => {
    const result = await build({ condition: "row.qty" })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.type-mismatch",
        pointer: "/posting/movements/0/condition",
        params: expect.objectContaining({ offset: 0 }),
      }),
    ])
    expect(
      (await build({ condition: "row.qty > 0 and not false" })).diagnostics
    ).toEqual([])
  })

  it("period must be a date", async () => {
    expect(codes(await build({ period: "row.qty" }))).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/period"],
    ])
    expect((await build({ period: "doc.date" })).diagnostics).toEqual([])
  })

  it("offset is the start of the offending expression", async () => {
    const result = await build({ condition: "  (row.qty)" })
    expect(result.diagnostics[0]?.params?.offset).toBe(2)
  })

  it("fields incomplete lists missing", async () => {
    const result = await build({ fields: { qty: "row.qty" } }, ({ stock }) => {
      stock.dimensions[0]!.required = true
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.fields-incomplete",
        file: SALE_FILE,
        pointer: "/posting/movements/0/fields",
        params: expect.objectContaining({ missing: "item" }),
      }),
    ])
  })

  it("accumulation register needs every resource", async () => {
    const result = await build({}, ({ stock }) => {
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

  it("information register needs dimensions and required resources", async () => {
    const pricesFile = "information-registers/Prices/Prices.meta.json"
    const run = async (fields: Record<string, string>) =>
      await build(
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
    expect(
      (await run({ item: "row.item", price: "row.amount" })).diagnostics
    ).toEqual([])
    expect(
      (await run({ item: "row.item", price: "row.amount", note: "null" }))
        .diagnostics
    ).toEqual([])
    // Регістр відомостей зберігає значення: тип поля — той самий, не лише число.
    expect(
      codes(
        await run({ item: "row.item", price: "row.amount", note: "row.qty" })
      )
    ).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/note"],
    ])
    expect(codes(await run({ item: "row.item", price: "null" }))).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/price"],
    ])
    expect((await run({ item: "row.item" })).diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.fields-incomplete",
        params: expect.objectContaining({ missing: "price" }),
      }),
    ])
    // Вид руху — лише в регістра залишків.
    expect(
      codes(
        await build(
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

  it("movement type required for balance register", async () => {
    const result = await build({ movementType: undefined })
    expect(codes(result)).toEqual([
      ["posting.movement-type", SALE_FILE, "/posting/movements/0"],
    ])
  })

  it("movement type forbidden for turnover register", async () => {
    const result = await build({}, ({ stock }) => {
      stock.registerType = "Turnover"
    })
    expect(codes(result)).toEqual([
      ["posting.movement-type", SALE_FILE, "/posting/movements/0/movementType"],
    ])
  })

  it("movement type expression must be text", async () => {
    const result = await build({ movementType: "row.qty" })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.movement-type",
        pointer: "/posting/movements/0/movementType",
        params: expect.objectContaining({ offset: 0 }),
      }),
    ])
    const text = await build({ movementType: "doc.direction" }, ({ sale }) => {
      sale.attributes.push(
        attribute("direction", { type: "String", length: 10 })
      )
    })
    expect(text.diagnostics).toEqual([])
  })

  it("document not among recorders", async () => {
    const result = await build({}, ({ stock }) => {
      stock.recorderTypes = []
    })
    expect(codes(result)).toEqual([
      ["posting.recorder-not-allowed", SALE_FILE, "/registerMovements/0"],
    ])
  })

  it("register not declared in registerMovements", async () => {
    const result = await build({}, ({ sale }) => {
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

  it("row field with document source", async () => {
    const result = await build(
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

  it("aggregate with tabular section source", async () => {
    const result = await build({
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

  it("movement target must be a register", async () => {
    const result = await build(
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

  it("recorder must be a document", async () => {
    const result = await build({}, ({ files, stock }) => {
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
  const intoPrices = async (
    movement: Record<string, unknown>,
    register: Record<string, unknown> = {}
  ) =>
    await build(
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

  it("fields incomplete includes required attributes in declaration order", async () => {
    const result = await build({ fields: {} }, ({ stock }) => {
      stock.dimensions[0]!.required = true
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

  it("information register requires its required attributes", async () => {
    const result = await intoPrices(
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

  it("period is not allowed for a non-periodic information register", async () => {
    const fields = { item: "row.item", price: "row.amount" }
    expect((await intoPrices({ fields })).diagnostics).toEqual([])
    expect(codes(await intoPrices({ fields, period: "doc.date" }))).toEqual([
      ["posting.period-not-allowed", SALE_FILE, "/posting/movements/0/period"],
    ])
    expect(
      (
        await intoPrices(
          { fields, period: "doc.date" },
          { periodicity: "Month" }
        )
      ).diagnostics
    ).toEqual([])
  })

  it("movement type string literal must be Receipt or Expense", async () => {
    const result = await build({ movementType: "'Incoming'" })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "posting.movement-type",
        pointer: "/posting/movements/0/movementType",
        params: expect.objectContaining({ value: "Incoming", offset: 0 }),
      }),
    ])
    expect((await build({ movementType: "'Receipt'" })).diagnostics).toEqual([])
  })

  it("sum takes the attribute type", async () => {
    const run = async (count: string) =>
      await build(
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
    expect((await run("sum(goods.pieces)")).diagnostics).toEqual([])
    expect(codes(await run("sum(goods.qty)"))).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/count"],
    ])
  })

  // Поле того самого типу не рятує: sum() додає числа, а над булевим чи
  // текстом SQL або впаде, або порахує не те.
  it("sum needs a numeric field", async () => {
    const mismatch = async (field: string, text: string) => {
      const result = await build(
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
    expect(await mismatch("flag", "sum(goods.flag)")).toMatchObject({
      expected: "numeric",
      actual: "boolean",
      offset: 0,
    })
    expect(await mismatch("flag", "not sum(goods.flag)")).toMatchObject({
      expected: "numeric",
      actual: "boolean",
      offset: 4,
    })
    expect(await mismatch("title", "sum(goods.title)")).toMatchObject({
      expected: "numeric",
      actual: "text",
      offset: 0,
    })
  })

  it("row DateTime and Date attributes are dates", async () => {
    const adjust = ({ sale }: Fixture) => {
      sale.tabularSections[0]!.attributes.push(
        attribute("shippedAt", { type: "DateTime" }),
        attribute("shippedOn", { type: "Date" })
      )
    }
    expect(
      (await build({ period: "row.shippedAt" }, adjust)).diagnostics
    ).toEqual([])
    expect(
      (await build({ period: "row.shippedOn" }, adjust)).diagnostics
    ).toEqual([])
  })

  it("row.parent is a Ref to the document", async () => {
    const adjust = ({ stock }: Fixture) => {
      stock.attributes.push(
        attribute("source", {
          type: "Ref",
          ref: { kind: "Document", name: "Sale" },
        })
      )
    }
    expect(
      (
        await build(
          {
            fields: { item: "row.item", qty: "row.qty", source: "row.parent" },
          },
          adjust
        )
      ).diagnostics
    ).toEqual([])
    expect(
      codes(
        await build({ fields: { item: "row.parent", qty: "row.qty" } }, adjust)
      )
    ).toEqual([
      ["posting.type-mismatch", SALE_FILE, "/posting/movements/0/fields/item"],
    ])
  })

  // Незалежний регістр пишуть за ключем запису, без реєстратора: рухи
  // документа йому нема куди покласти, а переписати їх за реєстратором нема за чим.
  it("an independent register takes no document movements", async () => {
    const independent = { writeMode: "Independent", recorderTypes: [] }
    const result = await intoPrices(
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

  it("an independent register in registerMovements alone is one error", async () => {
    const declaredOnly = await build({}, ({ files, sale }) => {
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
  const one = async (movement: Record<string, unknown>, pointer: string) => {
    const result = await build(movement, adjust)
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["posting.type-mismatch", pointer],
    ])
    return result.diagnostics[0]!.params
  }
  const qty = "/posting/movements/0/fields/qty"
  const condition = "/posting/movements/0/condition"

  it("arithmetic operand must be numeric", async () => {
    expect(
      await one({ fields: { item: "row.item", qty: "row.item + 1" } }, qty)
    ).toMatchObject({ offset: 0 })
  })

  it("unary minus operand must be numeric", async () => {
    expect(
      await one({ fields: { item: "row.item", qty: "-row.title" } }, qty)
    ).toMatchObject({ offset: 1 })
  })

  it("logical operand must be boolean", async () => {
    expect(
      await one({ condition: "row.qty and doc.posted" }, condition)
    ).toMatchObject({ offset: 0 })
    expect(await one({ condition: "not row.title" }, condition)).toMatchObject({
      offset: 4,
    })
  })

  it("comparison operands must be of the same kind", async () => {
    expect(await one({ condition: "row.qty = 'x'" }, condition)).toMatchObject({
      offset: 10,
    })
    // Посилання без спільних цілей рівними не бувають.
    expect(
      await one({ condition: "row.item = row.warehouse" }, condition)
    ).toMatchObject({ offset: 11 })
  })

  it("ordering is only for numeric, text and date operands", async () => {
    // Зміщення — початок самого порівняння, не операнда.
    expect(
      await one({ condition: "row.item < row.item" }, condition)
    ).toMatchObject({
      offset: 0,
    })
    expect(
      await one({ condition: "doc.posted > true" }, condition)
    ).toMatchObject({
      offset: 0,
    })
    for (const text of [
      "row.item = row.item",
      "row.item != row.item",
      "doc.date < doc.date",
      "row.title >= 'a'",
    ]) {
      expect(
        (await build({ condition: text }, adjust)).diagnostics,
        text
      ).toEqual([])
    }
  })

  it("a polymorphic side compares only with null", async () => {
    // Зміщення — початок поліморфного операнда.
    expect(
      await one({ condition: "row.product = doc.item" }, condition)
    ).toMatchObject({ offset: 0, actual: "polymorphic reference" })
    expect(
      await one({ condition: "doc.item != row.product" }, condition)
    ).toMatchObject({ offset: 12 })
    expect(
      await one({ condition: "row.product = row.product" }, condition)
    ).toMatchObject({ offset: 0 })
    expect(
      await one({ condition: "row.product < null" }, condition)
    ).toMatchObject({
      offset: 0,
    })
  })

  it("ordering with null is a type mismatch", async () => {
    expect(await one({ condition: "row.qty < null" }, condition)).toMatchObject(
      {
        offset: 10,
        actual: "null",
      }
    )
    expect(
      await one({ condition: "null >= row.title" }, condition)
    ).toMatchObject({
      offset: 0,
    })
  })

  it("a failed operand does not cascade to the field", async () => {
    // Вкладена помилка звітує лише операнд, а не результат проти поля.
    await one({ fields: { item: "row.item", qty: "(row.title * 2) > 1" } }, qty)
  })

  it("valid operands are clean", async () => {
    for (const text of [
      "row.qty * 2 > 0",
      "doc.date = doc.date",
      "row.item = null",
      "row.product = null",
      "row.product != null",
      "not doc.posted or row.qty <= 1",
    ]) {
      expect(
        (await build({ condition: text }, adjust)).diagnostics,
        text
      ).toEqual([])
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
    const stage3 = buildModel(
      stage1.objects,
      stage1.project!,
      stage2.references
    )
    const stage4 = checkIntegrity(
      stage1.objects,
      stage2.references,
      stage3,
      "camelCase",
      [],
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
      buildModel(stage1.objects, stage1.project!, stage2.references),
      "camelCase",
      [],
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
    const field: Expr = {
      type: "field",
      base: "row",
      name: "x",
      fieldSpan: at,
      ...at,
    }
    expect(
      inferType(
        { type: "binary", op: "*", left: field, right: num("2"), ...at },
        ctx
      )
    ).toEqual({ kind: "unknown" })
  })

  it("count is integer, comparison is boolean", () => {
    expect(
      inferType(
        { type: "count", section: "goods", sectionSpan: at, ...at },
        ctx
      )
    ).toEqual({
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
