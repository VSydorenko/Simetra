import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  catalog,
  metaFiles,
  organization,
  project,
  scopedProject,
  uuid,
} from "./helpers"

const WAREHOUSE = "catalogs/Warehouse/Warehouse.meta.json"
const WAREHOUSE_ID = uuid(901)

function warehouse(
  items: Record<string, unknown>[],
  overrides: Record<string, unknown> = {}
) {
  return catalog("Warehouse", {
    id: WAREHOUSE_ID,
    predefinedItems: items,
    ...overrides,
  })
}

async function compileWith(entries: Record<string, unknown>) {
  return await compile(
    metaFiles({ "project.meta.json": project(), ...entries })
  )
}

describe("predefined catalog items", () => {
  it("predefined item needs a label", async () => {
    const result = await compileWith({
      [WAREHOUSE]: warehouse([{ id: uuid(911), name: "Main" }]),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.physical-name-missing",
        file: WAREHOUSE,
        pointer: "/predefinedItems/0/physicalName",
        hint: expect.stringContaining("simetra fix"),
      }),
    ])
    expect(result.ok).toBe(false)
  })

  it("labels are unique within a catalog", async () => {
    const result = await compileWith({
      [WAREHOUSE]: warehouse([
        { id: uuid(911), name: "Main", physicalName: "main" },
        { id: uuid(912), name: "Spare", physicalName: "main" },
      ]),
      // Та сама мітка в іншому довіднику — не конфлікт: індекс і засів — на
      // таблицю довідника.
      "catalogs/Store/Store.meta.json": catalog("Store", {
        predefinedItems: [
          { id: uuid(913), name: "Main", physicalName: "main" },
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-duplicate",
        file: WAREHOUSE,
        pointer: "/predefinedItems/1/physicalName",
      }),
    ])
  })

  it("contract carries labels, scope column and lookup function", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        [WAREHOUSE]: warehouse(
          [
            { id: uuid(912), name: "Spare", physicalName: "spare" },
            { id: uuid(911), name: "Main", physicalName: "main" },
          ],
          { scope: "org" }
        ),
        "catalogs/Store/Store.meta.json": catalog("Store", {
          id: uuid(902),
          scope: "none",
          predefinedItems: [
            { id: uuid(913), name: "Central", physicalName: "central" },
          ],
        }),
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(result.model!.contracts.predefined).toEqual([
      {
        objectId: WAREHOUSE_ID,
        column: "predefined_name",
        scopeColumn: "org_id",
        lookupFunction: { schema: "public", name: "warehouse_predefined" },
        items: [
          { id: uuid(912), name: "Spare", label: "spare" },
          { id: uuid(911), name: "Main", label: "main" },
        ],
      },
      {
        objectId: uuid(902),
        column: "predefined_name",
        lookupFunction: { schema: "public", name: "store_predefined" },
        items: [{ id: uuid(913), name: "Central", label: "central" }],
      },
    ])
  })

  it("renaming a predefined item keeps its label and the physical snapshot", async () => {
    const before = await compileWith({
      [WAREHOUSE]: warehouse([
        { id: uuid(911), name: "Main", physicalName: "main" },
      ]),
    })
    const after = await compileWith({
      [WAREHOUSE]: warehouse([
        { id: uuid(911), name: "Primary", physicalName: "main" },
      ]),
    })
    expect(after.diagnostics).toEqual([])
    expect(after.model!.physical).toEqual(before.model!.physical)
    expect(after.model!.contracts.predefined[0]!.items).toEqual([
      { id: uuid(911), name: "Primary", label: "main" },
    ])
  })

  it("scoped catalog index starts with the scope carrier", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        [WAREHOUSE]: warehouse(
          [{ id: uuid(911), name: "Main", physicalName: "main" }],
          { scope: "org" }
        ),
      })
    )
    expect(result.diagnostics).toEqual([])
    const table = result.model!.physical.tables.find(
      (t) => t.name === "warehouse"
    )!
    const index = table.indexes.find((i) => i.where !== undefined)!
    expect(index).toMatchObject({
      unique: true,
      keys: [{ column: "org_id" }, { column: "predefined_name" }],
      where: "predefined_name IS NOT NULL",
    })
  })

  it("contract key columns equal the partial unique index key", async () => {
    // Засів П3 бере арбітр конфлікту з контракту: він має збігатися з індексом
    // і в скоупленому, і в глобальному довіднику.
    const result = await compile(
      metaFiles({
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        [WAREHOUSE]: warehouse(
          [{ id: uuid(911), name: "Main", physicalName: "main" }],
          { scope: "org" }
        ),
        "catalogs/Store/Store.meta.json": catalog("Store", {
          scope: "none",
          predefinedItems: [
            { id: uuid(913), name: "Central", physicalName: "central" },
          ],
        }),
      })
    )
    expect(result.diagnostics).toEqual([])
    const model = result.model!
    const keyOf = (name: string) =>
      model.physical.tables
        .find((t) => t.name === name)!
        .indexes.find((i) => i.where !== undefined)!
        .keys.map((key) => ("column" in key ? key.column : key.expression))
    const contractKeyOf = (name: string) => {
      const table = model.physical.tables.find((t) => t.name === name)!
      const contract = model.contracts.predefined.find(
        (c) => c.objectId === table.origin.objectId
      )!
      return [
        ...(contract.scopeColumn === undefined ? [] : [contract.scopeColumn]),
        contract.column,
      ]
    }
    expect(contractKeyOf("warehouse")).toEqual(keyOf("warehouse"))
    expect(keyOf("warehouse")).toEqual(["org_id", "predefined_name"])
    expect(contractKeyOf("store")).toEqual(keyOf("store"))
    expect(keyOf("store")).toEqual(["predefined_name"])
  })

  it("lookup function name collides with a table → physical.function-duplicate", async () => {
    const result = await compileWith({
      [WAREHOUSE]: warehouse([
        { id: uuid(911), name: "Main", physicalName: "main" },
      ]),
      "catalogs/WarehousePredefined/WarehousePredefined.meta.json": catalog(
        "WarehousePredefined"
      ),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.function-duplicate",
        file: WAREHOUSE,
        params: expect.objectContaining({
          name: "warehouse_predefined",
          other: "a table",
        }),
      }),
    ])
  })
})
