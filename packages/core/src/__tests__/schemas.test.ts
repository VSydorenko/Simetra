import { describe, it, expect } from "vitest"
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
} from "../schemas"

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
    expect(result.tabularSections[0].attributes[0].required).toBe(true)
  })

  it("rejects invalid name", () => {
    expect(() =>
      catalogSchema.parse({ kind: "Catalog", name: "invalid_name" })
    ).toThrow()
  })
})

describe("documentSchema", () => {
  it("parses minimal document", () => {
    const result = documentSchema.parse({ kind: "Document", name: "SalesOrder" })
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
        { name: "currency", type: "CatalogRef", ref: "Currencies" },
      ],
      resources: [
        { name: "rate", type: "Numeric", precision: 15, scale: 4 },
      ],
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
        { name: "product", type: "CatalogRef", ref: "Products", required: true },
        { name: "warehouse", type: "CatalogRef", ref: "Warehouses", required: true },
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
      attributes: [
        { name: "payload", type: "Text" },
      ],
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

  it("parses AnyRef attribute with allowedTypes", () => {
    const result = attributeSchema.parse({
      name: "owner",
      type: "AnyRef",
      allowedTypes: [
        { kind: "Catalog", name: "Products" },
        { kind: "Catalog", name: "Services" },
      ],
      required: true,
    })
    expect(result.allowedTypes).toHaveLength(2)
  })
})
