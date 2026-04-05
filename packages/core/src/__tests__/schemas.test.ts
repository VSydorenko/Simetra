import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import {
  projectSchema,
  catalogSchema,
  documentSchema,
  enumerationSchema,
  informationRegisterSchema,
  accumulationRegisterSchema,
  constantSchema,
  customTableSchema,
  attributeSchema,
  localizedStringSchema,
  metadataRefSchema,
  metadataObjectSchema,
  projectModelSchema,
  getStandardAttributes,
  getTabularSectionStandardAttributes,
  isSqlReservedWord,
} from "../schemas"
import { serializeMetadataObject, enrichSchemaUrl, enrichProjectSchemaUrl, buildConstantsSchemaUrl } from "../serialization"

describe("localizedStringSchema", () => {
  it("accepts uk only", () => {
    expect(localizedStringSchema.parse({ uk: "Тест" })).toEqual({ uk: "Тест" })
  })

  it("accepts en only", () => {
    expect(localizedStringSchema.parse({ en: "Test" })).toEqual({ en: "Test" })
  })

  it("rejects empty object", () => {
    expect(() => localizedStringSchema.parse({})).toThrow()
  })
})

describe("projectSchema", () => {
  it("parses minimal project", () => {
    const result = projectSchema.parse({ name: "MyApp" })
    expect(result.name).toBe("MyApp")
    expect(result.schemaVersion).toBe("1.0")
    expect(result.defaultLocale).toBe("uk")
    expect(result.database.target).toBe("postgresql")
  })

  it("parses full project", () => {
    const result = projectSchema.parse({
      schemaVersion: "1.0",
      name: "MyBusinessApp",
      displayName: { uk: "Мій бізнес-додаток", en: "My Business App" },
      defaultLocale: "uk",
      database: {
        target: "postgresql",
        schema: "public",
        namingConvention: "snake_case",
      },
      generation: {
        tablePrefix: "",
        enumStrategy: "pgEnum",
        constantsStrategy: "singleTable",
      },
    })
    expect(result.name).toBe("MyBusinessApp")
  })
})

describe("catalogSchema", () => {
  it("parses minimal catalog", () => {
    const result = catalogSchema.parse({ kind: "Catalog", name: "Products" })
    expect(result.kind).toBe("Catalog")
    expect(result.codeLength).toBe(9)
    expect(result.hierarchyType).toBe("None")
    expect(result.attributes).toEqual([])
  })

  it("parses catalog with attributes and tabular sections", () => {
    const result = catalogSchema.parse({
      kind: "Catalog",
      name: "Products",
      displayName: { uk: "Товари", en: "Products" },
      hierarchyType: "FoldersAndItems",
      attributes: [
        { name: "article", type: "String", length: 50, indexed: true },
      ],
      tabularSections: [
        {
          name: "barcodes",
          displayName: { uk: "Штрихкоди" },
          attributes: [
            { name: "barcode", type: "String", length: 200, required: true },
          ],
        },
      ],
    })
    expect(result.attributes).toHaveLength(1)
    expect(result.tabularSections).toHaveLength(1)
    expect(result.tabularSections[0].standardAttributeOverrides).toEqual({})
    expect(result.tabularSections[0].attributes[0].required).toBe(true)
  })

  it("parses tabular section standard attribute overrides", () => {
    const result = catalogSchema.parse({
      kind: "Catalog",
      name: "Products",
      tabularSections: [
        {
          name: "barcodes",
          standardAttributeOverrides: {
            line_number: {
              description: {
                uk: "Номер рядка у табличній частині",
                en: "Tabular section line number",
              },
            },
          },
          attributes: [],
        },
      ],
    })

    expect(result.tabularSections[0].standardAttributeOverrides).toEqual({
      line_number: {
        description: {
          uk: "Номер рядка у табличній частині",
          en: "Tabular section line number",
        },
      },
    })
  })

  it("rejects invalid name", () => {
    expect(() =>
      catalogSchema.parse({ kind: "Catalog", name: "invalid_name" })
    ).toThrow()
  })
})

describe("documentSchema", () => {
  it("parses minimal document", () => {
    const result = documentSchema.parse({
      kind: "Document",
      name: "SalesOrder",
    })
    expect(result.numberLength).toBe(11)
    expect(result.posting).toBe(true)
    expect(result.numberPeriodicity).toBe("Year")
  })

  it("parses document with register movements", () => {
    const result = documentSchema.parse({
      kind: "Document",
      name: "SalesOrder",
      registerMovements: [
        { kind: "AccumulationRegister", name: "InventoryBalance" },
      ],
    })
    expect(result.registerMovements).toHaveLength(1)
  })
})

describe("enumerationSchema", () => {
  it("parses enumeration with values", () => {
    const result = enumerationSchema.parse({
      kind: "Enumeration",
      name: "OrderStatus",
      values: [
        { name: "Draft", displayName: { uk: "Чернетка" }, order: 0 },
        { name: "Posted", displayName: { uk: "Проведений" }, order: 1 },
      ],
    })
    expect(result.values).toHaveLength(2)
  })
})

describe("informationRegisterSchema", () => {
  it("parses periodic register", () => {
    const result = informationRegisterSchema.parse({
      kind: "InformationRegister",
      name: "ExchangeRates",
      periodicity: "Day",
      writeMode: "Independent",
      dimensions: [
        {
          name: "currency",
          type: "Ref",
          ref: { kind: "Catalog", name: "Currencies" },
        },
      ],
      resources: [{ name: "rate", type: "Numeric", precision: 15, scale: 4 }],
    })
    expect(result.periodicity).toBe("Day")
    expect(result.dimensions).toHaveLength(1)
    expect(result.resources).toHaveLength(1)
  })
})

describe("accumulationRegisterSchema", () => {
  it("parses balance register", () => {
    const result = accumulationRegisterSchema.parse({
      kind: "AccumulationRegister",
      name: "InventoryBalance",
      registerType: "Balance",
      recorderTypes: [{ kind: "Document", name: "SalesOrder" }],
      dimensions: [
        {
          name: "product",
          type: "Ref",
          ref: { kind: "Catalog", name: "Products" },
          required: true,
        },
        {
          name: "warehouse",
          type: "Ref",
          ref: { kind: "Catalog", name: "Warehouses" },
          required: true,
        },
      ],
      resources: [
        { name: "quantity", type: "Numeric", precision: 15, scale: 3 },
        { name: "amount", type: "Numeric", precision: 15, scale: 2 },
      ],
    })
    expect(result.registerType).toBe("Balance")
    expect(result.dimensions).toHaveLength(2)
    expect(result.resources).toHaveLength(2)
  })
})

describe("constantSchema", () => {
  it("parses constant", () => {
    const result = constantSchema.parse({
      kind: "Constant",
      name: "OrganizationName",
      displayName: { uk: "Назва організації" },
      valueType: "String",
      defaultValue: "",
    })
    expect(result.valueType).toBe("String")
  })
})

describe("customTableSchema", () => {
  it("parses custom table with defaults", () => {
    const result = customTableSchema.parse({
      kind: "CustomTable",
      name: "AuditLog",
    })
    expect(result.autoAddPrimaryKey).toBe(true)
    expect(result.attributes).toEqual([])
  })

  it("parses custom table without PK", () => {
    const result = customTableSchema.parse({
      kind: "CustomTable",
      name: "TempQueue",
      autoAddPrimaryKey: false,
      attributes: [{ name: "payload", type: "Text" }],
    })
    expect(result.autoAddPrimaryKey).toBe(false)
  })
})

describe("attributeSchema", () => {
  it("rejects non-snake_case name", () => {
    expect(() =>
      attributeSchema.parse({ name: "CamelCase", type: "String" })
    ).toThrow()
  })

  it("accepts valid attribute with all optional fields", () => {
    const result = attributeSchema.parse({
      name: "base_price",
      displayName: { uk: "Базова ціна", en: "Base Price" },
      type: "Numeric",
      precision: 15,
      scale: 2,
      required: true,
      indexed: true,
    })
    expect(result.name).toBe("base_price")
    expect(result.required).toBe(true)
  })

  it("parses Ref attribute with allowedTypes", () => {
    const result = attributeSchema.parse({
      name: "owner",
      type: "Ref",
      allowedTypes: [
        { kind: "Catalog", name: "Products" },
        { kind: "Catalog", name: "Services" },
      ],
      required: true,
    })
    expect(result.allowedTypes).toHaveLength(2)
  })

  it("parses single Ref attribute with MetadataRef", () => {
    const result = attributeSchema.parse({
      name: "contractor",
      type: "Ref",
      ref: { kind: "Catalog", name: "Contractors" },
      required: true,
    })
    expect(result.ref).toEqual({ kind: "Catalog", name: "Contractors" })
  })

  it("accepts Ref without ref and allowedTypes (not yet selected)", () => {
    const result = attributeSchema.parse({
      name: "target",
      type: "Ref",
    })
    expect(result.ref).toBeUndefined()
    expect(result.allowedTypes).toBeUndefined()
  })

  it("rejects attribute with both ref and allowedTypes", () => {
    expect(() =>
      attributeSchema.parse({
        name: "bad_ref",
        type: "Ref",
        ref: { kind: "Catalog", name: "Products" },
        allowedTypes: [{ kind: "Document", name: "SalesOrder" }],
      })
    ).toThrow(/mutually exclusive/)
  })

  it("rejects ref on non-Ref type", () => {
    expect(() =>
      attributeSchema.parse({
        name: "bad_field",
        type: "String",
        ref: { kind: "Catalog", name: "Products" },
      })
    ).toThrow(/only valid when type is Ref/)
  })

  it("rejects allowedTypes on non-Ref type", () => {
    expect(() =>
      attributeSchema.parse({
        name: "bad_field",
        type: "Integer",
        allowedTypes: [{ kind: "Catalog", name: "Products" }],
      })
    ).toThrow(/only valid when type is Ref/)
  })

  it("rejects non-referenceable kind in ref", () => {
    expect(() =>
      attributeSchema.parse({
        name: "bad_kind",
        type: "Ref",
        ref: { kind: "AccumulationRegister", name: "Balance" },
      })
    ).toThrow()
  })

  it("rejects non-referenceable kind in allowedTypes", () => {
    expect(() =>
      attributeSchema.parse({
        name: "bad_kind",
        type: "Ref",
        allowedTypes: [{ kind: "Constant", name: "Settings" }],
      })
    ).toThrow()
  })

  it("rejects stale length when type is not String", () => {
    expect(() =>
      attributeSchema.parse({ name: "flag", type: "Boolean", length: 50 })
    ).toThrow(/length is only valid when type is String/)
  })

  it("rejects stale precision when type is not Numeric", () => {
    expect(() =>
      attributeSchema.parse({
        name: "code",
        type: "String",
        precision: 10,
        length: 50,
      })
    ).toThrow(/precision is only valid when type is Numeric/)
  })

  it("rejects stale scale when type is not Numeric", () => {
    expect(() =>
      attributeSchema.parse({
        name: "code",
        type: "String",
        scale: 2,
        length: 50,
      })
    ).toThrow(/scale is only valid when type is Numeric/)
  })

  it("rejects stale length on Integer", () => {
    expect(() =>
      attributeSchema.parse({ name: "count", type: "Integer", length: 10 })
    ).toThrow(/length is only valid when type is String/)
  })

  it("rejects stale precision on Integer", () => {
    expect(() =>
      attributeSchema.parse({ name: "count", type: "Integer", precision: 10 })
    ).toThrow(/precision is only valid when type is Numeric/)
  })

  it("accepts Numeric with precision and scale", () => {
    const result = attributeSchema.parse({
      name: "amount",
      type: "Numeric",
      precision: 10,
      scale: 2,
    })
    expect(result.precision).toBe(10)
    expect(result.scale).toBe(2)
  })

  it("accepts String with length", () => {
    const result = attributeSchema.parse({
      name: "title",
      type: "String",
      length: 100,
    })
    expect(result.length).toBe(100)
  })

  it("accepts Integer without type-specific params", () => {
    const result = attributeSchema.parse({
      name: "count",
      type: "Integer",
    })
    expect(result.precision).toBeUndefined()
    expect(result.scale).toBeUndefined()
    expect(result.length).toBeUndefined()
  })
})

// ============================================================
// Модуль 2: нові тести
// ============================================================

describe("metadataRefSchema", () => {
  it("accepts valid kind", () => {
    const result = metadataRefSchema.parse({
      kind: "Catalog",
      name: "Products",
    })
    expect(result.kind).toBe("Catalog")
  })

  it("rejects invalid kind", () => {
    expect(() =>
      metadataRefSchema.parse({ kind: "InvalidKind", name: "Foo" })
    ).toThrow()
  })

  it("accepts all valid metadata kinds", () => {
    const kinds = [
      "Catalog",
      "Document",
      "Enumeration",
      "InformationRegister",
      "AccumulationRegister",
      "Constant",
      "CustomTable",
    ]
    for (const kind of kinds) {
      expect(() =>
        metadataRefSchema.parse({ kind, name: "Test" })
      ).not.toThrow()
    }
  })
})

describe("SQL reserved words", () => {
  it("isSqlReservedWord detects reserved words", () => {
    expect(isSqlReservedWord("order")).toBe(true)
    expect(isSqlReservedWord("ORDER")).toBe(true)
    expect(isSqlReservedWord("Select")).toBe(true)
    expect(isSqlReservedWord("product")).toBe(false)
    expect(isSqlReservedWord("warehouse")).toBe(false)
  })

  it("rejects reserved word as attribute name", () => {
    expect(() =>
      attributeSchema.parse({ name: "order", type: "String" })
    ).toThrow(/SQL reserved word/)
    expect(() =>
      attributeSchema.parse({ name: "group", type: "Integer" })
    ).toThrow(/SQL reserved word/)
    expect(() =>
      attributeSchema.parse({ name: "user", type: "String" })
    ).toThrow(/SQL reserved word/)
    expect(() =>
      attributeSchema.parse({ name: "table", type: "String" })
    ).toThrow(/SQL reserved word/)
  })

  it("rejects reserved word as object name (case-insensitive)", () => {
    expect(() =>
      catalogSchema.parse({ kind: "Catalog", name: "Select" })
    ).toThrow(/SQL reserved word/)
    expect(() =>
      documentSchema.parse({ kind: "Document", name: "Update" })
    ).toThrow(/SQL reserved word/)
    expect(() =>
      constantSchema.parse({ kind: "Constant", name: "Index" })
    ).toThrow(/SQL reserved word/)
  })
})

describe("attribute name uniqueness", () => {
  it("rejects duplicate attribute names in catalog", () => {
    expect(() =>
      catalogSchema.parse({
        kind: "Catalog",
        name: "Products",
        attributes: [
          { name: "price", type: "Numeric" },
          { name: "price", type: "String" },
        ],
      })
    ).toThrow(/unique/)
  })

  it("rejects duplicate attribute names in tabular section", () => {
    expect(() =>
      catalogSchema.parse({
        kind: "Catalog",
        name: "Products",
        tabularSections: [
          {
            name: "details",
            attributes: [
              { name: "qty", type: "Integer" },
              { name: "qty", type: "Numeric" },
            ],
          },
        ],
      })
    ).toThrow(/unique/)
  })

  it("rejects duplicate tabular section names", () => {
    expect(() =>
      catalogSchema.parse({
        kind: "Catalog",
        name: "Products",
        tabularSections: [
          { name: "details", attributes: [] },
          { name: "details", attributes: [] },
        ],
      })
    ).toThrow(/unique/)
  })

  it("accepts unique attribute names", () => {
    expect(() =>
      catalogSchema.parse({
        kind: "Catalog",
        name: "Products",
        attributes: [
          { name: "price", type: "Numeric" },
          { name: "quantity", type: "Integer" },
        ],
      })
    ).not.toThrow()
  })
})

describe("AccumulationRegister numeric resources", () => {
  it("rejects String type in resources", () => {
    expect(() =>
      accumulationRegisterSchema.parse({
        kind: "AccumulationRegister",
        name: "TestRegister",
        resources: [{ name: "description", type: "String" }],
      })
    ).toThrow(/Numeric or Integer/)
  })

  it("rejects Boolean type in resources", () => {
    expect(() =>
      accumulationRegisterSchema.parse({
        kind: "AccumulationRegister",
        name: "TestRegister",
        resources: [{ name: "flag", type: "Boolean" }],
      })
    ).toThrow(/Numeric or Integer/)
  })

  it("accepts Numeric resources", () => {
    const result = accumulationRegisterSchema.parse({
      kind: "AccumulationRegister",
      name: "TestRegister",
      resources: [
        { name: "quantity", type: "Numeric", precision: 15, scale: 3 },
      ],
    })
    expect(result.resources).toHaveLength(1)
  })

  it("accepts Integer resources", () => {
    const result = accumulationRegisterSchema.parse({
      kind: "AccumulationRegister",
      name: "TestRegister",
      resources: [{ name: "count", type: "Integer" }],
    })
    expect(result.resources).toHaveLength(1)
  })
})

describe("getStandardAttributes", () => {
  it("returns catalog attributes without hierarchy", () => {
    const attrs = getStandardAttributes("Catalog", { hierarchyType: "None" })
    const names = attrs.map((a) => a.name)
    expect(names).toContain("id")
    expect(names).toContain("code")
    expect(names).toContain("description")
    expect(names).toContain("deletion_mark")
    expect(names).toContain("created_at")
    expect(names).toContain("updated_at")
    expect(names).not.toContain("parent_id")
    expect(names).not.toContain("is_folder")
  })

  it("returns catalog attributes with FoldersAndItems hierarchy", () => {
    const attrs = getStandardAttributes("Catalog", {
      hierarchyType: "FoldersAndItems",
    })
    const names = attrs.map((a) => a.name)
    expect(names).toContain("parent_id")
    expect(names).toContain("is_folder")
  })

  it("returns catalog attributes with owners", () => {
    const attrs = getStandardAttributes("Catalog", {
      owners: [{ kind: "Catalog", name: "Companies" }],
    })
    const names = attrs.map((a) => a.name)
    expect(names).toContain("owner_id")
  })

  it("returns document standard attributes", () => {
    const attrs = getStandardAttributes("Document")
    const names = attrs.map((a) => a.name)
    expect(names).toContain("id")
    expect(names).toContain("number")
    expect(names).toContain("date")
    expect(names).toContain("posted")
    expect(names).toContain("deletion_mark")
    expect(attrs).toHaveLength(7)
  })

  it("returns empty for Enumeration", () => {
    expect(getStandardAttributes("Enumeration")).toEqual([])
  })

  it("returns empty for Constant", () => {
    expect(getStandardAttributes("Constant")).toEqual([])
  })

  it("returns InformationRegister attrs for periodic register", () => {
    const attrs = getStandardAttributes("InformationRegister", {
      periodicity: "Day",
      writeMode: "Independent",
    })
    const names = attrs.map((a) => a.name)
    expect(names).toContain("period")
    expect(names).not.toContain("recorder_id")
  })

  it("returns InformationRegister attrs for recorder-subordinate", () => {
    const attrs = getStandardAttributes("InformationRegister", {
      periodicity: "Day",
      writeMode: "RecorderSubordinate",
    })
    const names = attrs.map((a) => a.name)
    expect(names).toContain("period")
    expect(names).toContain("recorder_id")
    expect(names).toContain("line_number")
    expect(names).toContain("active")
  })

  it("returns AccumulationRegister attrs for Balance", () => {
    const attrs = getStandardAttributes("AccumulationRegister", {
      registerType: "Balance",
    })
    const names = attrs.map((a) => a.name)
    expect(names).toContain("period")
    expect(names).toContain("recorder_id")
    expect(names).toContain("movement_type")
  })

  it("returns AccumulationRegister attrs for Turnover (no movement_type)", () => {
    const attrs = getStandardAttributes("AccumulationRegister", {
      registerType: "Turnover",
    })
    const names = attrs.map((a) => a.name)
    expect(names).toContain("period")
    expect(names).not.toContain("movement_type")
  })

  it("returns CustomTable attrs with PK", () => {
    const attrs = getStandardAttributes("CustomTable", {
      autoAddPrimaryKey: true,
    })
    expect(attrs).toHaveLength(1)
    expect(attrs[0].name).toBe("id")
  })

  it("returns empty CustomTable attrs without PK", () => {
    const attrs = getStandardAttributes("CustomTable", {
      autoAddPrimaryKey: false,
    })
    expect(attrs).toEqual([])
  })

  it("returns tabular section standard attributes", () => {
    const attrs = getTabularSectionStandardAttributes()
    const names = attrs.map((a) => a.name)
    expect(names).toEqual(["id", "line_number"])
  })

  it("parent_id has type UUID without ref", () => {
    const attrs = getStandardAttributes("Catalog", {
      hierarchyType: "FoldersAndItems",
    })
    const parentId = attrs.find((a) => a.name === "parent_id")
    expect(parentId).toBeDefined()
    expect(parentId!.type).toBe("UUID")
    expect(parentId!.ref).toBeUndefined()
  })

  it("owner_id with single owner has type Ref and ref MetadataRef", () => {
    const attrs = getStandardAttributes("Catalog", {
      owners: [{ kind: "Catalog", name: "Companies" }],
    })
    const ownerId = attrs.find((a) => a.name === "owner_id")
    expect(ownerId).toBeDefined()
    expect(ownerId!.type).toBe("Ref")
    expect(ownerId!.ref).toEqual({ kind: "Catalog", name: "Companies" })
    expect(ownerId!.allowedTypes).toBeUndefined()
  })

  it("owner_id with multiple owners has type Ref and allowedTypes", () => {
    const attrs = getStandardAttributes("Catalog", {
      owners: [
        { kind: "Catalog", name: "Companies" },
        { kind: "Catalog", name: "Individuals" },
      ],
    })
    const ownerId = attrs.find((a) => a.name === "owner_id")
    expect(ownerId).toBeDefined()
    expect(ownerId!.type).toBe("Ref")
    expect(ownerId!.ref).toBeUndefined()
    expect(ownerId!.allowedTypes).toEqual([
      { kind: "Catalog", name: "Companies" },
      { kind: "Catalog", name: "Individuals" },
    ])
  })

  it("recorder_id with single recorder has type Ref and ref MetadataRef", () => {
    const attrs = getStandardAttributes("InformationRegister", {
      periodicity: "Day",
      writeMode: "RecorderSubordinate",
      recorderTypes: [{ kind: "Document", name: "SalesOrder" }],
    })
    const recorderId = attrs.find((a) => a.name === "recorder_id")
    expect(recorderId).toBeDefined()
    expect(recorderId!.type).toBe("Ref")
    expect(recorderId!.ref).toEqual({ kind: "Document", name: "SalesOrder" })
    expect(recorderId!.allowedTypes).toBeUndefined()
  })

  it("recorder_id with multiple recorders has type Ref and allowedTypes", () => {
    const attrs = getStandardAttributes("AccumulationRegister", {
      registerType: "Balance",
      recorderTypes: [
        { kind: "Document", name: "SalesOrder" },
        { kind: "Document", name: "PurchaseOrder" },
      ],
    })
    const recorderId = attrs.find((a) => a.name === "recorder_id")
    expect(recorderId).toBeDefined()
    expect(recorderId!.type).toBe("Ref")
    expect(recorderId!.ref).toBeUndefined()
    expect(recorderId!.allowedTypes).toEqual([
      { kind: "Document", name: "SalesOrder" },
      { kind: "Document", name: "PurchaseOrder" },
    ])
  })
})

describe("metadataObjectSchema", () => {
  it("parses Catalog via discriminated union", () => {
    const result = metadataObjectSchema.parse({
      kind: "Catalog",
      name: "Products",
    })
    expect(result.kind).toBe("Catalog")
  })

  it("parses Document via discriminated union", () => {
    const result = metadataObjectSchema.parse({
      kind: "Document",
      name: "SalesOrder",
    })
    expect(result.kind).toBe("Document")
  })

  it("parses all 7 types", () => {
    const objects = [
      { kind: "Catalog", name: "Products" },
      { kind: "Document", name: "SalesOrder" },
      { kind: "Enumeration", name: "Status" },
      { kind: "InformationRegister", name: "Rates" },
      { kind: "AccumulationRegister", name: "Balance" },
      { kind: "Constant", name: "AppName", valueType: "String" },
      { kind: "CustomTable", name: "Logs" },
    ]
    for (const obj of objects) {
      expect(() => metadataObjectSchema.parse(obj)).not.toThrow()
    }
  })
})

describe("projectModelSchema", () => {
  it("parses minimal project model", () => {
    const result = projectModelSchema.parse({
      project: { name: "TestApp" },
    })
    expect(result.project.name).toBe("TestApp")
    expect(result.catalogs).toEqual([])
    expect(result.documents).toEqual([])
    expect(result.enumerations).toEqual([])
    expect(result.informationRegisters).toEqual([])
    expect(result.accumulationRegisters).toEqual([])
    expect(result.constants).toEqual([])
    expect(result.customTables).toEqual([])
  })

  it("parses project model with objects", () => {
    const result = projectModelSchema.parse({
      project: { name: "TestApp" },
      catalogs: [{ kind: "Catalog", name: "Products" }],
      documents: [{ kind: "Document", name: "SalesOrder" }],
    })
    expect(result.catalogs).toHaveLength(1)
    expect(result.documents).toHaveLength(1)
  })
})

describe("canonical serialization", () => {
  const currentDir = dirname(fileURLToPath(import.meta.url))
  const fixturesDir = join(currentDir, "fixtures")

  function loadFixture(name: string): string {
    return readFileSync(join(fixturesDir, name), "utf-8")
  }

  it("roundtrip: catalog parse → serialize → match fixture", () => {
    const json = loadFixture("catalog.json")
    const parsed = catalogSchema.parse(JSON.parse(json))
    const serialized = serializeMetadataObject(parsed)
    expect(serialized).toBe(json)
  })

  it("roundtrip: document parse → serialize → match fixture", () => {
    const json = loadFixture("document.json")
    const parsed = documentSchema.parse(JSON.parse(json))
    const serialized = serializeMetadataObject(parsed)
    expect(serialized).toBe(json)
  })

  it("roundtrip: enumeration parse → serialize → match fixture", () => {
    const json = loadFixture("enumeration.json")
    const parsed = enumerationSchema.parse(JSON.parse(json))
    const serialized = serializeMetadataObject(parsed)
    expect(serialized).toBe(json)
  })

  it("roundtrip: information-register parse → serialize → match fixture", () => {
    const json = loadFixture("information-register.json")
    const parsed = informationRegisterSchema.parse(JSON.parse(json))
    const serialized = serializeMetadataObject(parsed)
    expect(serialized).toBe(json)
  })

  it("roundtrip: accumulation-register parse → serialize → match fixture", () => {
    const json = loadFixture("accumulation-register.json")
    const parsed = accumulationRegisterSchema.parse(JSON.parse(json))
    const serialized = serializeMetadataObject(parsed)
    expect(serialized).toBe(json)
  })

  it("roundtrip: constant parse → serialize → match fixture", () => {
    const json = loadFixture("constant.json")
    const parsed = constantSchema.parse(JSON.parse(json))
    const serialized = serializeMetadataObject(parsed)
    expect(serialized).toBe(json)
  })

  it("roundtrip: custom-table parse → serialize → match fixture", () => {
    const json = loadFixture("custom-table.json")
    const parsed = customTableSchema.parse(JSON.parse(json))
    const serialized = serializeMetadataObject(parsed)
    expect(serialized).toBe(json)
  })

  it("idempotent: serialize twice gives same result", () => {
    const json = loadFixture("catalog.json")
    const parsed = catalogSchema.parse(JSON.parse(json))
    const first = serializeMetadataObject(parsed)
    const reparsed = catalogSchema.parse(JSON.parse(first))
    const second = serializeMetadataObject(reparsed)
    expect(first).toBe(second)
  })

  it("serializes tabular section overrides before attributes", () => {
    const serialized = serializeMetadataObject(
      catalogSchema.parse({
        kind: "Catalog",
        name: "Products",
        tabularSections: [
          {
            name: "barcodes",
            displayName: { uk: "Штрихкоди" },
            standardAttributeOverrides: {
              line_number: {
                description: {
                  uk: "Номер рядка у табличній частині",
                },
              },
            },
            attributes: [{ name: "barcode", type: "String", length: 200 }],
          },
        ],
      })
    )

    const tabularSectionsChunk = serialized.split('"tabularSections": [\n')[1]

    expect(tabularSectionsChunk.indexOf('"displayName"')).toBeLessThan(
      tabularSectionsChunk.indexOf('"standardAttributeOverrides"')
    )
    expect(
      tabularSectionsChunk.indexOf('"standardAttributeOverrides"')
    ).toBeLessThan(tabularSectionsChunk.indexOf('"attributes"'))
  })
})

// ============================================================
// constantSchema — valueType restriction
// ============================================================

describe("constantSchema — valueType restriction", () => {
  it("rejects Ref as valueType", () => {
    const result = constantSchema.safeParse({
      kind: "Constant",
      name: "BadConst",
      valueType: "Ref",
    })
    expect(result.success).toBe(false)
  })

  it("accepts String as valueType", () => {
    const result = constantSchema.safeParse({
      kind: "Constant",
      name: "GoodConst",
      valueType: "String",
    })
    expect(result.success).toBe(true)
  })

  it("accepts all non-Ref types", () => {
    const validTypes = [
      "UUID",
      "String",
      "Text",
      "Integer",
      "Numeric",
      "Boolean",
      "Date",
      "DateTime",
      "Binary",
    ]
    for (const t of validTypes) {
      const result = constantSchema.safeParse({
        kind: "Constant",
        name: "TestConst",
        valueType: t,
      })
      expect(result.success).toBe(true)
    }
  })
})

// ============================================================
// $schema enrichment
// ============================================================

describe("$schema enrichment", () => {
  it("enrichSchemaUrl adds correct URL for Catalog", () => {
    const obj = catalogSchema.parse({
      kind: "Catalog",
      name: "Test",
      codeLength: 9,
      codeType: "String",
      descriptionLength: 100,
      hierarchyType: "None",
      attributes: [],
      tabularSections: [],
    })
    const enriched = enrichSchemaUrl(obj, "1.0")
    expect(enriched.$schema).toBe(
      "https://simetra.dev/schemas/v1.0/catalog.schema.json",
    )
  })

  it("enrichProjectSchemaUrl adds correct URL", () => {
    const project = projectSchema.parse({ name: "Test" })
    const enriched = enrichProjectSchemaUrl(project, "1.0")
    expect(enriched.$schema).toBe(
      "https://simetra.dev/schemas/v1.0/project.schema.json",
    )
  })

  it("buildConstantsSchemaUrl returns correct URL", () => {
    expect(buildConstantsSchemaUrl("1.0")).toBe(
      "https://simetra.dev/schemas/v1.0/constants.schema.json",
    )
  })

  it("enrichSchemaUrl overwrites existing $schema", () => {
    const obj = catalogSchema.parse({
      kind: "Catalog",
      name: "Test",
      codeLength: 9,
      codeType: "String",
      descriptionLength: 100,
      hierarchyType: "None",
      attributes: [],
      tabularSections: [],
    })
    const first = enrichSchemaUrl(obj, "1.0")
    const second = enrichSchemaUrl(first, "2.0")
    expect(second.$schema).toBe(
      "https://simetra.dev/schemas/v2.0/catalog.schema.json",
    )
  })
})
