import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  KIND_REGISTRY,
  kindByDir,
  standardLogicalName,
  type StandardColumnDef,
} from "../kinds/registry"
import {
  METADATA_KINDS,
  accumulationRegisterSchema,
  catalogSchema,
  constantSchema,
  customTableSchema,
  documentSchema,
  informationRegisterSchema,
} from "../schemas"

function column(
  columns: StandardColumnDef[],
  logicalName: string
): StandardColumnDef | undefined {
  return columns.find((c) => c.logicalName === logicalName)
}

function catalogColumns(input: Record<string, unknown> = {}) {
  const obj = catalogSchema.parse({ kind: "Catalog", name: "Item", ...input })
  return KIND_REGISTRY.Catalog.standardColumns(obj)
}

describe("KIND_REGISTRY", () => {
  it("every kind has a registry entry and a unique dir", () => {
    expect(Object.keys(KIND_REGISTRY)).toEqual([...METADATA_KINDS])
    for (const kind of METADATA_KINDS) {
      expect(KIND_REGISTRY[kind].kind).toBe(kind)
    }
    const dirs = METADATA_KINDS.map((kind) => KIND_REGISTRY[kind].dir)
    expect(new Set(dirs).size).toBe(dirs.length)
    expect(kindByDir("custom-tables")?.kind).toBe("CustomTable")
    expect(kindByDir("unknown")).toBeUndefined()
  })

  it("key order starts with the header and covers every schema key", () => {
    for (const kind of METADATA_KINDS) {
      const def = KIND_REGISTRY[kind]
      expect(def.keyOrder.slice(0, 5)).toEqual([
        "$schema",
        "id",
        "kind",
        "name",
        "physicalName",
      ])
      const shape = (def.schema as z.ZodObject).shape
      expect([...def.keyOrder].sort()).toEqual(Object.keys(shape).sort())
    }
  })

  it("materialization and write pattern follow the kind", () => {
    expect(KIND_REGISTRY.Catalog.writePattern).toBe("optimistic")
    expect(KIND_REGISTRY.Document.writePattern).toBe("server")
    expect(KIND_REGISTRY.Enumeration.materializes).toBe("none")
    expect(KIND_REGISTRY.PgEnum.materializes).toBe("enumType")
    expect(KIND_REGISTRY.CustomTable.materializes).toBe("table")
    expect(KIND_REGISTRY.InformationRegister.referenceable).toBe(false)
    expect(KIND_REGISTRY.Document.actions).toEqual([
      "read",
      "create",
      "update",
      "markDeletion",
      "delete",
      "post",
      "unpost",
    ])
  })
})

describe("physical form and child elements", () => {
  it("only accepted kinds declare their physical form as is", () => {
    const declared = METADATA_KINDS.filter((k) => KIND_REGISTRY[k].declared)
    expect(declared).toEqual(["CustomTable", "PgEnum"])
  })

  it("column-producing fields follow the kind, in column order", () => {
    expect(KIND_REGISTRY.Catalog.columnFields).toEqual(["attributes"])
    expect(KIND_REGISTRY.Document.columnFields).toEqual(["attributes"])
    for (const kind of [
      "InformationRegister",
      "AccumulationRegister",
    ] as const) {
      expect(KIND_REGISTRY[kind].columnFields).toEqual([
        "dimensions",
        "resources",
        "attributes",
      ])
    }
    expect(KIND_REGISTRY.CustomTable.columnFields).toEqual(["columns"])
    for (const kind of ["Constant", "Enumeration", "PgEnum"] as const) {
      expect(KIND_REGISTRY[kind].columnFields).toEqual([])
    }
  })

  it("every column-producing field is a field of the kind schema", () => {
    for (const kind of METADATA_KINDS) {
      const def = KIND_REGISTRY[kind]
      const shape = (def.schema as z.ZodObject).shape
      for (const field of def.columnFields) expect(shape).toHaveProperty(field)
    }
  })

  it("only enumeration values are elements with identity", () => {
    const kinds = METADATA_KINDS.filter((k) => KIND_REGISTRY[k].valueElements)
    expect(kinds).toEqual(["Enumeration"])
  })
})

describe("standard columns", () => {
  it("catalog code and description follow settings", () => {
    const full = catalogColumns({ codeLength: 5, descriptionLength: 40 })
    expect(column(full, "code")).toMatchObject({
      physicalName: "code",
      type: { type: "String", length: 5 },
      indexed: true,
    })
    expect(column(full, "code")).not.toHaveProperty("unique")
    expect(column(full, "description")?.type).toEqual({
      type: "String",
      length: 40,
    })

    const bare = catalogColumns({ codeLength: 0, descriptionLength: 0 })
    expect(column(bare, "code")).toBeUndefined()
    expect(column(bare, "description")).toBeUndefined()

    const numeric = catalogColumns({ codeType: "Number", codeUnique: false })
    expect(column(numeric, "code")?.type).toEqual({ type: "Integer" })
    expect(column(numeric, "code")?.unique).toBeUndefined()
  })

  it("catalog key has no default, document key has gen_random_uuid()", () => {
    const catalogKey = column(catalogColumns(), "ref")
    expect(catalogKey).toMatchObject({
      physicalName: "id",
      type: { type: "UUID" },
      primaryKey: true,
      notNull: true,
    })
    expect(catalogKey?.default).toBeUndefined()

    const doc = documentSchema.parse({ kind: "Document", name: "Invoice" })
    const docColumns = KIND_REGISTRY.Document.standardColumns(doc)
    expect(column(docColumns, "ref")?.default).toBe("gen_random_uuid()")
    expect(column(docColumns, "date")).toMatchObject({
      physicalName: "date",
      type: { type: "DateTime" },
      notNull: true,
      indexed: true,
    })
    expect(column(docColumns, "posted")).toMatchObject({
      notNull: true,
      default: "false",
    })
  })

  it("catalog always has deletion mark and service dates", () => {
    const columns = catalogColumns()
    expect(column(columns, "deletionMark")).toMatchObject({
      physicalName: "deletion_mark",
      notNull: true,
      default: "false",
    })
    expect(column(columns, "createdAt")).toMatchObject({
      physicalName: "created_at",
      type: { type: "DateTime" },
      default: "now()",
    })
    expect(column(columns, "updatedAt")?.physicalName).toBe("updated_at")
    expect(column(columns, "predefinedName")?.physicalName).toBe(
      "predefined_name"
    )
    expect(column(columns, "parent")).toBeUndefined()
  })

  it("catalog and document carry version", () => {
    const doc = KIND_REGISTRY.Document.standardColumns(
      documentSchema.parse({ kind: "Document", name: "Invoice" })
    )
    for (const columns of [catalogColumns(), doc]) {
      expect(column(columns, "version")).toMatchObject({
        physicalName: "version",
        type: { type: "BigInt" },
        notNull: true,
        default: "1",
      })
      const names = columns.map((c) => c.logicalName)
      expect(names.indexOf("version")).toBe(names.indexOf("createdAt") - 1)
    }
    const constant = constantSchema.parse({
      kind: "Constant",
      name: "BaseCurrency",
      type: "String",
      length: 5,
    })
    const registers = [
      KIND_REGISTRY.AccumulationRegister.standardColumns(
        accumulationRegisterSchema.parse({
          kind: "AccumulationRegister",
          name: "Stock",
        })
      ),
      KIND_REGISTRY.InformationRegister.standardColumns(
        informationRegisterSchema.parse({
          kind: "InformationRegister",
          name: "Prices",
        })
      ),
      KIND_REGISTRY.Constant.standardColumns(constant),
      KIND_REGISTRY.Catalog.tabularSectionColumns!(undefined),
    ]
    for (const columns of registers) {
      expect(column(columns, "version")).toBeUndefined()
    }
  })

  it("predefined name is a partial unique", () => {
    expect(column(catalogColumns(), "predefinedName")?.partialUnique).toBe(
      "predefined_name IS NOT NULL"
    )
    const doc = KIND_REGISTRY.Document.standardColumns(
      documentSchema.parse({ kind: "Document", name: "Invoice" })
    )
    expect(column(doc, "predefinedName")).toBeUndefined()
    expect(KIND_REGISTRY.Catalog.namedElementFields).toEqual([
      "predefinedItems",
    ])
    expect(KIND_REGISTRY.Document.namedElementFields).toBeUndefined()
  })

  it("ItemsOnly hierarchy has parent but no is_folder", () => {
    const itemsOnly = catalogColumns({ hierarchyType: "ItemsOnly" })
    expect(column(itemsOnly, "parent")).toMatchObject({
      physicalName: "parent_id",
      ref: "self",
      indexed: true,
    })
    expect(column(itemsOnly, "isFolder")).toBeUndefined()

    const folders = catalogColumns({ hierarchyType: "FoldersAndItems" })
    expect(column(folders, "isFolder")).toMatchObject({
      physicalName: "is_folder",
      notNull: true,
      default: "false",
    })
  })

  it("one owner gives owner_id, many owners give owner_type + owner_id", () => {
    expect(column(catalogColumns(), "owner")).toBeUndefined()

    const one = column(
      catalogColumns({ owners: [{ kind: "Catalog", name: "Company" }] }),
      "owner"
    )
    expect(one).toMatchObject({
      physicalName: "owner_id",
      ref: "owners",
      indexed: true,
    })
    expect(one?.polymorphic).toBeUndefined()

    const many = column(
      catalogColumns({
        owners: [
          { kind: "Catalog", name: "Company" },
          { kind: "Catalog", name: "Person" },
        ],
      }),
      "owner"
    )
    expect(many).toMatchObject({
      physicalName: "owner",
      polymorphic: "whenMany",
      ref: "owners",
      indexed: true,
    })
  })

  it("balance register has movement_type with check, turnover has none", () => {
    const balance = accumulationRegisterSchema.parse({
      kind: "AccumulationRegister",
      name: "Stock",
      registerType: "Balance",
    })
    const columns = KIND_REGISTRY.AccumulationRegister.standardColumns(balance)
    expect(column(columns, "movementType")).toMatchObject({
      physicalName: "movement_type",
      type: { type: "Text" },
      notNull: true,
      check: "movement_type IN ('Receipt', 'Expense')",
    })
    // Період входить в індекси рухів і ключі регістра, окремого індексу немає.
    expect(column(columns, "period")).toMatchObject({ notNull: true })
    expect(column(columns, "period")?.indexed).toBeUndefined()
    expect(column(columns, "recorder")).toMatchObject({
      physicalName: "recorder",
      polymorphic: "always",
      ref: "recorders",
      notNull: true,
    })
    expect(column(columns, "active")?.default).toBe("true")

    const turnover = accumulationRegisterSchema.parse({
      kind: "AccumulationRegister",
      name: "Sales",
      registerType: "Turnover",
    })
    expect(
      column(
        KIND_REGISTRY.AccumulationRegister.standardColumns(turnover),
        "movementType"
      )
    ).toBeUndefined()
  })

  it("register keys are a fact of the kind", () => {
    const parse = (data: Record<string, unknown>) =>
      accumulationRegisterSchema.parse({
        kind: "AccumulationRegister",
        name: "Stock",
        ...data,
      })
    const keys = KIND_REGISTRY.AccumulationRegister.registerKeys!
    expect(keys(parse({}))).toEqual({
      movementsPrimaryKey: "recorder",
      recordKeyUnique: false,
      movementIndexes: true,
      totals: true,
      turnoversMonth: { split: true },
      additiveResources: true,
      virtualTables: ["balance", "balanceAndTurnovers"],
    })
    expect(keys(parse({ registerType: "Turnover" })).totals).toBe(false)
    expect(keys(parse({ registerType: "Turnover" })).turnoversMonth).toEqual({
      split: false,
    })
    expect(keys(parse({ registerType: "Turnover" })).virtualTables).toEqual([
      "turnovers",
    ])

    const info = (writeMode: string) =>
      KIND_REGISTRY.InformationRegister.registerKeys!(
        informationRegisterSchema.parse({
          kind: "InformationRegister",
          name: "Prices",
          writeMode,
        })
      )
    expect(info("Independent")).toEqual({
      movementsPrimaryKey: "none",
      recordKeyUnique: true,
      movementIndexes: false,
      totals: false,
      additiveResources: false,
      virtualTables: [],
    })
    expect(info("RecorderSubordinate")).toEqual({
      movementsPrimaryKey: "recorder",
      recordKeyUnique: true,
      movementIndexes: false,
      totals: false,
      additiveResources: false,
      virtualTables: [],
    })
    expect(KIND_REGISTRY.Catalog.registerKeys).toBeUndefined()
  })

  it("information register recorder columns only when RecorderSubordinate", () => {
    const independent = informationRegisterSchema.parse({
      kind: "InformationRegister",
      name: "Prices",
      periodicity: "Day",
    })
    const independentColumns =
      KIND_REGISTRY.InformationRegister.standardColumns(independent)
    expect(independentColumns.map((c) => c.logicalName)).toEqual(["period"])

    const subordinate = informationRegisterSchema.parse({
      kind: "InformationRegister",
      name: "Prices",
      writeMode: "RecorderSubordinate",
    })
    expect(
      KIND_REGISTRY.InformationRegister.standardColumns(subordinate).map(
        (c) => c.logicalName
      )
    ).toEqual(["recorder", "lineNumber", "active"])
  })

  it("tabular section row has parent_id cascade and line_number", () => {
    const doc = documentSchema.parse({ kind: "Document", name: "Invoice" })
    const docRow = KIND_REGISTRY.Document.tabularSectionColumns?.(doc) ?? []
    expect(column(docRow, "ref")?.default).toBe("gen_random_uuid()")
    expect(column(docRow, "parent")).toMatchObject({
      physicalName: "parent_id",
      ref: "owningObject",
      onDelete: "cascade",
      notNull: true,
      indexed: true,
    })
    expect(column(docRow, "lineNumber")).toMatchObject({
      physicalName: "line_number",
      type: { type: "Integer" },
      notNull: true,
    })

    const catalogRow =
      KIND_REGISTRY.Catalog.tabularSectionColumns?.(
        catalogSchema.parse({ kind: "Catalog", name: "Item" })
      ) ?? []
    expect(column(catalogRow, "ref")?.default).toBeUndefined()
    expect(KIND_REGISTRY.InformationRegister.tabularSectionColumns).toBe(
      undefined
    )
  })

  it("constant has a singleton key and a value of its own type", () => {
    const constant = constantSchema.parse({
      kind: "Constant",
      name: "BaseCurrency",
      type: "Ref",
      ref: { kind: "Catalog", name: "Currency" },
    })
    const columns = KIND_REGISTRY.Constant.standardColumns(constant)
    expect(column(columns, "singleton")).toMatchObject({
      physicalName: "singleton",
      type: { type: "Boolean" },
      primaryKey: true,
      default: "true",
      check: "singleton",
    })
    expect(column(columns, "value")?.type).toEqual({
      type: "Ref",
      ref: { kind: "Catalog", name: "Currency" },
    })
  })

  it("kinds without derived columns give none", () => {
    const table = customTableSchema.parse({
      kind: "CustomTable",
      name: "Log",
      columns: [{ name: "id", type: "UUID" }],
    })
    expect(KIND_REGISTRY.CustomTable.standardColumns(table)).toEqual([])
    expect(
      KIND_REGISTRY.Enumeration.standardColumns({
        kind: "Enumeration",
        name: "Status",
        values: [],
      })
    ).toEqual([])
  })

  it("standard logical names follow project style", () => {
    const columns = catalogColumns({ hierarchyType: "ItemsOnly" })
    const deletionMark = column(columns, "deletionMark")!
    const ref = column(columns, "ref")!
    const parent = column(columns, "parent")!
    expect(standardLogicalName(deletionMark, "snake_case")).toBe(
      "deletion_mark"
    )
    expect(standardLogicalName(deletionMark, "camelCase")).toBe("deletionMark")
    expect(standardLogicalName(ref, "snake_case")).toBe("ref")
    expect(standardLogicalName(parent, "snake_case")).toBe("parent")
  })
})

describe("references()", () => {
  it("references() finds every MetadataRef", () => {
    const doc = documentSchema.parse({
      kind: "Document",
      name: "Invoice",
      registerMovements: [{ kind: "AccumulationRegister", name: "Stock" }],
      attributes: [
        {
          name: "customer",
          type: "Ref",
          ref: { kind: "Catalog", name: "Customer" },
        },
      ],
      tabularSections: [
        {
          name: "lines",
          attributes: [
            { name: "quantity", type: "Integer" },
            {
              name: "subject",
              type: "Ref",
              allowedTypes: [
                { kind: "Catalog", name: "Product" },
                { kind: "Catalog", name: "Service" },
              ],
            },
          ],
        },
      ],
      posting: {
        movements: [
          {
            register: { kind: "AccumulationRegister", name: "Stock" },
            movementType: "Expense",
            source: "document",
            fields: {},
          },
        ],
      },
    })
    expect(KIND_REGISTRY.Document.references(doc)).toEqual([
      {
        pointer: "/attributes/0/ref",
        ref: { kind: "Catalog", name: "Customer" },
        role: "attribute.ref",
      },
      {
        pointer: "/tabularSections/0/attributes/1/allowedTypes/0",
        ref: { kind: "Catalog", name: "Product" },
        role: "attribute.allowedType",
      },
      {
        pointer: "/tabularSections/0/attributes/1/allowedTypes/1",
        ref: { kind: "Catalog", name: "Service" },
        role: "attribute.allowedType",
      },
      {
        pointer: "/registerMovements/0",
        ref: { kind: "AccumulationRegister", name: "Stock" },
        role: "document.registerMovement",
      },
      {
        pointer: "/posting/movements/0/register",
        ref: { kind: "AccumulationRegister", name: "Stock" },
        role: "posting.register",
      },
    ])
  })

  it("catalog owners, register recorders and fields are references", () => {
    const catalog = catalogSchema.parse({
      kind: "Catalog",
      name: "Contract",
      owners: [{ kind: "Catalog", name: "Company" }],
    })
    expect(KIND_REGISTRY.Catalog.references(catalog)).toEqual([
      {
        pointer: "/owners/0",
        ref: { kind: "Catalog", name: "Company" },
        role: "catalog.owner",
      },
    ])

    const register = informationRegisterSchema.parse({
      kind: "InformationRegister",
      name: "Prices",
      writeMode: "RecorderSubordinate",
      recorderTypes: [{ kind: "Document", name: "PriceSetup" }],
      dimensions: [
        {
          name: "product",
          type: "Ref",
          ref: { kind: "Catalog", name: "Product" },
        },
      ],
    })
    expect(KIND_REGISTRY.InformationRegister.references(register)).toEqual([
      {
        pointer: "/recorderTypes/0",
        ref: { kind: "Document", name: "PriceSetup" },
        role: "register.recorder",
      },
      {
        pointer: "/dimensions/0/ref",
        ref: { kind: "Catalog", name: "Product" },
        role: "attribute.ref",
      },
    ])
  })

  it("constant and custom table references", () => {
    const constant = constantSchema.parse({
      kind: "Constant",
      name: "DefaultPayer",
      type: "Ref",
      allowedTypes: [{ kind: "Catalog", name: "Person" }],
    })
    expect(KIND_REGISTRY.Constant.references(constant)).toEqual([
      {
        pointer: "/allowedTypes/0",
        ref: { kind: "Catalog", name: "Person" },
        role: "constant.allowedType",
      },
    ])

    const table = customTableSchema.parse({
      kind: "CustomTable",
      name: "Membership",
      columns: [
        {
          name: "role",
          type: "PgEnum",
          enum: { kind: "PgEnum", name: "Role" },
        },
        {
          name: "user",
          type: "Ref",
          ref: { kind: "Catalog", name: "User" },
        },
        { name: "groupId", type: "UUID" },
      ],
      foreignKeys: [
        {
          columns: ["groupId"],
          references: {
            object: { kind: "CustomTable", name: "Group" },
            columns: ["id"],
          },
        },
      ],
    })
    expect(KIND_REGISTRY.CustomTable.references(table)).toEqual([
      {
        pointer: "/columns/0/enum",
        ref: { kind: "PgEnum", name: "Role" },
        role: "customTable.pgEnum",
      },
      {
        pointer: "/columns/1/ref",
        ref: { kind: "Catalog", name: "User" },
        role: "attribute.ref",
      },
      {
        pointer: "/foreignKeys/0/references/object",
        ref: { kind: "CustomTable", name: "Group" },
        role: "customTable.foreignKey",
      },
    ])
  })
})

describe("numbering spec", () => {
  it("numbering spec of document and catalog", () => {
    const doc = documentSchema.parse({
      kind: "Document",
      name: "Invoice",
      numberPeriodicity: "Quarter",
      numberLength: 8,
    })
    expect(KIND_REGISTRY.Document.numbering?.(doc)).toEqual({
      column: "number",
      periodColumn: "numberPeriod",
      type: "String",
      length: 8,
      autonumber: true,
      periodicity: "Quarter",
      unique: true,
    })
    const columns = KIND_REGISTRY.Document.standardColumns(doc)
    const index = columns.findIndex((c) => c.logicalName === "date")
    expect(columns[index + 1]).toEqual({
      logicalName: "numberPeriod",
      physicalName: "number_period",
      type: { type: "Date" },
      notNull: true,
      generated: { truncate: { column: "date", unit: "quarter" } },
      title: { uk: "Період номера", en: "Number period" },
    })
    expect(column(columns, "number")?.indexed).toBeUndefined()

    const none = documentSchema.parse({
      kind: "Document",
      name: "Invoice",
      numberPeriodicity: "None",
    })
    expect(KIND_REGISTRY.Document.numbering?.(none)).toMatchObject({
      periodicity: "None",
      unique: true,
    })
    expect(
      column(KIND_REGISTRY.Document.standardColumns(none), "numberPeriod")
    ).toBeUndefined()

    const cat = catalogSchema.parse({
      kind: "Catalog",
      name: "Item",
      codeUnique: false,
      codeType: "Number",
    })
    expect(KIND_REGISTRY.Catalog.numbering?.(cat)).toEqual({
      column: "code",
      type: "Number",
      length: 9,
      autonumber: true,
      periodicity: "None",
      unique: false,
    })
    expect(column(catalogColumns({ codeUnique: true }), "code")?.unique).toBe(
      undefined
    )
  })

  it("catalog without code has no numbering", () => {
    const cat = catalogSchema.parse({
      kind: "Catalog",
      name: "Item",
      codeLength: 0,
    })
    expect(KIND_REGISTRY.Catalog.numbering?.(cat)).toBeUndefined()
  })
})
