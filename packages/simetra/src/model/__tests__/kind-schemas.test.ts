import { describe, it, expect } from "vitest"
import {
  projectSchema,
  catalogSchema,
  documentSchema,
  enumerationSchema,
  informationRegisterSchema,
  accumulationRegisterSchema,
  constantSchema,
  attributeSchema,
  tabularSectionSchema,
  localizedStringSchema,
  metadataRefSchema,
  metadataKindSchema,
  METADATA_KINDS,
  getStandardAttributes,
  getTabularSectionStandardAttributes,
  mappingExpressionSchema,
  postingMovementSchema,
  postingValidationSchema,
  postingSchema,
} from "../schemas"

const ID = "3f2b8a52-6d1e-4c0a-9b7e-5a1c2d3e4f50"

describe("METADATA_KINDS", () => {
  it("lists the 1C kinds plus CustomTable and PgEnum", () => {
    expect(METADATA_KINDS).toEqual([
      "Catalog",
      "Document",
      "Enumeration",
      "InformationRegister",
      "AccumulationRegister",
      "Constant",
      "CustomTable",
      "PgEnum",
    ])
    expect(metadataKindSchema.options).toEqual([...METADATA_KINDS])
  })

  it("metadataRefSchema accepts any registered kind", () => {
    expect(metadataRefSchema.parse({ kind: "PgEnum", name: "Status" })).toEqual(
      { kind: "PgEnum", name: "Status" }
    )
    expect(() => metadataRefSchema.parse({ kind: "Form", name: "X" })).toThrow()
  })
})

describe("attributeSchema", () => {
  it("parses a minimal attribute with defaults", () => {
    expect(attributeSchema.parse({ name: "amount", type: "Integer" })).toEqual({
      name: "amount",
      type: "Integer",
      required: false,
      indexed: false,
      unique: false,
    })
  })

  it("accepts id, physicalName, title and a scalar defaultValue", () => {
    const r = attributeSchema.parse({
      id: ID,
      name: "isActive",
      physicalName: "is_active",
      title: { uk: "Активний" },
      type: "Boolean",
      defaultValue: true,
    })
    expect(r.id).toBe(ID)
    expect(r.defaultValue).toBe(true)
  })

  it("does not check name case or reserved words (later stages)", () => {
    expect(() =>
      attributeSchema.parse({ name: "select", type: "Integer" })
    ).not.toThrow()
  })

  it("reports type rules with a stable code", () => {
    const r = attributeSchema.safeParse({ name: "title", type: "String" })
    expect(r.success).toBe(false)
    expect(
      r.error?.issues.some(
        (i) =>
          (i as { params?: { rule?: string } }).params?.rule ===
          "type.length-required"
      )
    ).toBe(true)
  })

  it("Ref attribute may target any kind", () => {
    expect(() =>
      attributeSchema.parse({
        name: "status",
        type: "Ref",
        ref: { kind: "PgEnum", name: "Status" },
      })
    ).not.toThrow()
  })
})

describe("tabularSectionSchema", () => {
  it("defaults attributes to empty and accepts title", () => {
    expect(
      tabularSectionSchema.parse({ name: "Items", title: { en: "Items" } })
    ).toEqual({
      name: "Items",
      title: { en: "Items" },
      standardAttributeOverrides: {},
      attributes: [],
    })
  })

  it("does not check attribute name uniqueness", () => {
    const a = { name: "qty", type: "Integer" }
    expect(() =>
      tabularSectionSchema.parse({ name: "Items", attributes: [a, a] })
    ).not.toThrow()
  })
})

describe("catalogSchema", () => {
  it("parses a minimal catalog with defaults", () => {
    const r = catalogSchema.parse({ kind: "Catalog", name: "Product" })
    expect(r.codeLength).toBe(9)
    expect(r.descriptionLength).toBe(150)
    expect(r.attributes).toEqual([])
    expect(r.tabularSections).toEqual([])
    expect(r.id).toBeUndefined()
  })

  it("accepts id, physicalName, schema, title and description", () => {
    const r = catalogSchema.parse({
      $schema: "x",
      id: ID,
      kind: "Catalog",
      name: "Product",
      physicalName: "product",
      schema: "sales",
      title: { uk: "Товар" },
      description: { uk: "Довідник товарів" },
    })
    expect(r.schema).toBe("sales")
    expect(r.title).toEqual({ uk: "Товар" })
  })

  it("catalog accepts codeLength 0 and descriptionLength 0", () => {
    const r = catalogSchema.parse({
      kind: "Catalog",
      name: "Product",
      codeLength: 0,
      descriptionLength: 0,
    })
    expect(r.codeLength).toBe(0)
    expect(r.descriptionLength).toBe(0)
  })

  it("rejects negative lengths and non-PascalCase names", () => {
    expect(() =>
      catalogSchema.parse({ kind: "Catalog", name: "P", codeLength: -1 })
    ).toThrow()
    expect(() =>
      catalogSchema.parse({ kind: "Catalog", name: "product" })
    ).toThrow()
  })

  it("rejects a malformed id", () => {
    expect(() =>
      catalogSchema.parse({ kind: "Catalog", name: "P", id: "nope" })
    ).toThrow()
  })
})

describe("documentSchema", () => {
  it("parses a minimal document with defaults", () => {
    const r = documentSchema.parse({ kind: "Document", name: "SalesOrder" })
    expect(r.numberLength).toBe(11)
    expect(r.registerMovements).toEqual([])
    expect(r.posting).toBeUndefined()
  })
})

describe("enumerationSchema", () => {
  it("enumeration keeps value order", () => {
    const r = enumerationSchema.parse({
      kind: "Enumeration",
      name: "OrderStatus",
      values: [
        { name: "Open" },
        { id: ID, name: "Closed", physicalName: "closed", title: { en: "C" } },
        { name: "Archived" },
      ],
    })
    expect(r.values.map((v) => v.name)).toEqual(["Open", "Closed", "Archived"])
    for (const v of r.values) expect("order" in v).toBe(false)
  })

  it("defaults values to empty", () => {
    expect(
      enumerationSchema.parse({ kind: "Enumeration", name: "E" }).values
    ).toEqual([])
  })
})

describe("constantSchema", () => {
  it("parses a constant with a scalar type", () => {
    const r = constantSchema.parse({
      kind: "Constant",
      name: "MaxItems",
      type: "Integer",
      defaultValue: 10,
    })
    expect(r.defaultValue).toBe(10)
  })

  it("constant accepts Ref value type", () => {
    const r = constantSchema.parse({
      kind: "Constant",
      name: "BaseCurrency",
      type: "Ref",
      ref: { kind: "Catalog", name: "Currency" },
    })
    expect(r.ref).toEqual({ kind: "Catalog", name: "Currency" })
  })

  it("applies value type rules", () => {
    expect(() =>
      constantSchema.parse({ kind: "Constant", name: "C", type: "String" })
    ).toThrow()
  })
})

describe("informationRegisterSchema", () => {
  it("parses a minimal register with defaults", () => {
    const r = informationRegisterSchema.parse({
      kind: "InformationRegister",
      name: "ExchangeRates",
    })
    expect(r.periodicity).toBe("NonPeriodic")
    expect(r.writeMode).toBe("Independent")
    expect(r.dimensions).toEqual([])
    expect(r.resources).toEqual([])
    expect(r.attributes).toEqual([])
  })

  it("does not restrict resource types", () => {
    expect(() =>
      informationRegisterSchema.parse({
        kind: "InformationRegister",
        name: "R",
        resources: [{ name: "note", type: "Text" }],
      })
    ).not.toThrow()
  })
})

describe("accumulationRegisterSchema", () => {
  it("parses a register with numeric resources", () => {
    const r = accumulationRegisterSchema.parse({
      kind: "AccumulationRegister",
      name: "Stock",
      resources: [
        { name: "qty", type: "Integer" },
        { name: "sum", type: "Numeric", precision: 15, scale: 2 },
      ],
    })
    expect(r.registerType).toBe("Balance")
    expect(r.resources).toHaveLength(2)
  })

  it("accumulation register resource must be Integer or Numeric", () => {
    const r = accumulationRegisterSchema.safeParse({
      kind: "AccumulationRegister",
      name: "Stock",
      resources: [{ name: "note", type: "String", length: 10 }],
    })
    expect(r.success).toBe(false)
    const issue = r.error?.issues.find(
      (i) =>
        (i as { params?: { rule?: string } }).params?.rule ===
        "register.resource-type"
    )
    expect(issue).toBeDefined()
    expect(issue?.path).toEqual(["resources", 0, "type"])
  })

  it("allows non-numeric dimensions", () => {
    expect(() =>
      accumulationRegisterSchema.parse({
        kind: "AccumulationRegister",
        name: "Stock",
        dimensions: [{ name: "note", type: "Text" }],
      })
    ).not.toThrow()
  })
})

describe("projectSchema", () => {
  it("project defaults", () => {
    expect(projectSchema.parse({ name: "Demo" })).toEqual({
      name: "Demo",
      defaultLocale: "uk",
      defaultSchema: "public",
      naming: { attributeCase: "camelCase" },
    })
  })

  it("accepts title, locale, schema and snake_case naming", () => {
    const r = projectSchema.parse({
      $schema: "x",
      name: "Demo",
      title: { en: "Demo" },
      defaultLocale: "en",
      defaultSchema: "app",
      naming: { attributeCase: "snake_case" },
    })
    expect(r.naming.attributeCase).toBe("snake_case")
  })

  it("rejects an unknown locale or attribute case", () => {
    expect(() =>
      projectSchema.parse({ name: "D", defaultLocale: "de" })
    ).toThrow()
    expect(() =>
      projectSchema.parse({ name: "D", naming: { attributeCase: "kebab" } })
    ).toThrow()
  })

  it("project has no generation block", () => {
    for (const key of ["generation", "deployment", "database"]) {
      expect(projectSchema.shape).not.toHaveProperty(key)
    }
    expect(projectSchema.shape).not.toHaveProperty("schemaVersion")
  })
})

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

describe("mappingExpressionSchema", () => {
  it.each([
    "doc.warehouse",
    "row.product",
    "row.quantity * row.price",
    "row.a + row.b",
    "row.a - row.b",
    "row.a / row.b",
    "sum(items.amount)",
    "count(items)",
    "literal:42",
    "literal:some text",
    "now()",
  ])("accepts valid expression: %s", (expr) => {
    expect(() => mappingExpressionSchema.parse(expr)).not.toThrow()
  })

  it.each([
    "",
    "invalid",
    "field",
    "doc.",
    "row.",
    "sum()",
    "count()",
    "123",
    "SELECT * FROM users",
  ])("rejects invalid expression: %s", (expr) => {
    expect(() => mappingExpressionSchema.parse(expr)).toThrow()
  })
})

describe("postingMovementSchema", () => {
  it("parses valid movement with tabularSection source", () => {
    const result = postingMovementSchema.parse({
      register: { kind: "AccumulationRegister", name: "InventoryBalance" },
      movementType: "Receipt",
      source: "tabularSection:items",
      mappings: {
        dimensions: { product: "row.product", warehouse: "doc.warehouse" },
        resources: { quantity: "row.quantity" },
      },
    })
    expect(result.register.name).toBe("InventoryBalance")
    expect(result.movementType).toBe("Receipt")
    expect(result.source).toBe("tabularSection:items")
    expect(result.condition).toBeUndefined()
    expect(result.mappings.dimensions).toEqual({
      product: "row.product",
      warehouse: "doc.warehouse",
    })
    expect(result.mappings.attributes).toEqual({})
  })

  it("parses movement with document source", () => {
    const result = postingMovementSchema.parse({
      register: { kind: "AccumulationRegister", name: "SettlementsBalance" },
      movementType: "Expense",
      source: "document",
      mappings: {
        dimensions: { contractor: "doc.contractor" },
        resources: { amount: "sum(items.amount)" },
      },
    })
    expect(result.source).toBe("document")
  })

  it("parses movement with dynamic movementType", () => {
    const result = postingMovementSchema.parse({
      register: { kind: "AccumulationRegister", name: "InventoryBalance" },
      movementType: "doc.operation_type",
      source: "tabularSection:items",
      mappings: { dimensions: { product: "row.product" } },
    })
    expect(result.movementType).toBe("doc.operation_type")
  })

  it("parses movement with condition", () => {
    const result = postingMovementSchema.parse({
      register: { kind: "AccumulationRegister", name: "Balance" },
      movementType: "Receipt",
      source: "tabularSection:items",
      condition: "doc.is_active",
      mappings: { dimensions: {} },
    })
    expect(result.condition).toBe("doc.is_active")
  })

  it("rejects invalid movementType", () => {
    expect(() =>
      postingMovementSchema.parse({
        register: { kind: "AccumulationRegister", name: "Balance" },
        movementType: "Invalid",
        source: "document",
        mappings: { dimensions: {} },
      })
    ).toThrow()
  })

  it("rejects invalid source format", () => {
    expect(() =>
      postingMovementSchema.parse({
        register: { kind: "AccumulationRegister", name: "Balance" },
        movementType: "Receipt",
        source: "invalid_source",
        mappings: { dimensions: {} },
      })
    ).toThrow()
  })

  it("rejects invalid mapping expression in dimensions", () => {
    expect(() =>
      postingMovementSchema.parse({
        register: { kind: "AccumulationRegister", name: "Balance" },
        movementType: "Receipt",
        source: "document",
        mappings: { dimensions: { product: "INVALID" } },
      })
    ).toThrow()
  })

  it("rejects non-register kind in register ref", () => {
    expect(() =>
      postingMovementSchema.parse({
        register: { kind: "Catalog", name: "Products" },
        movementType: "Receipt",
        source: "document",
        mappings: { dimensions: { product: "doc.product" } },
      })
    ).toThrow()
  })

  it("rejects row.* expressions when source is document", () => {
    expect(() =>
      postingMovementSchema.parse({
        register: { kind: "AccumulationRegister", name: "Balance" },
        movementType: "Receipt",
        source: "document",
        mappings: { dimensions: { product: "row.product" } },
      })
    ).toThrow(/row\.\* expressions are only allowed/)
  })

  it("rejects sum()/count() expressions when source is tabularSection", () => {
    expect(() =>
      postingMovementSchema.parse({
        register: { kind: "AccumulationRegister", name: "Balance" },
        movementType: "Receipt",
        source: "tabularSection:items",
        mappings: { resources: { amount: "sum(items.amount)" } },
      })
    ).toThrow(/aggregations are only allowed/)
  })

  it("allows doc.* expressions with document source", () => {
    expect(() =>
      postingMovementSchema.parse({
        register: { kind: "AccumulationRegister", name: "Balance" },
        movementType: "Receipt",
        source: "document",
        mappings: { dimensions: { contractor: "doc.contractor" } },
      })
    ).not.toThrow()
  })

  it("allows row.* and doc.* with tabularSection source", () => {
    expect(() =>
      postingMovementSchema.parse({
        register: { kind: "AccumulationRegister", name: "Balance" },
        movementType: "Receipt",
        source: "tabularSection:items",
        mappings: {
          dimensions: { product: "row.product", warehouse: "doc.warehouse" },
        },
      })
    ).not.toThrow()
  })
})

describe("postingValidationSchema", () => {
  it("parses valid validation", () => {
    const result = postingValidationSchema.parse({
      type: "NonNegativeBalance",
      register: { kind: "AccumulationRegister", name: "InventoryBalance" },
      dimensions: ["product", "warehouse"],
      resource: "quantity",
      message: { uk: "Недостатньо товару", en: "Not enough product" },
    })
    expect(result.type).toBe("NonNegativeBalance")
    expect(result.dimensions).toEqual(["product", "warehouse"])
    expect(result.applyTo).toBe("Expense")
  })

  it("accepts explicit applyTo", () => {
    const result = postingValidationSchema.parse({
      type: "NonNegativeBalance",
      register: { kind: "AccumulationRegister", name: "Balance" },
      dimensions: ["product"],
      resource: "quantity",
      message: { uk: "Помилка" },
      applyTo: "Both",
    })
    expect(result.applyTo).toBe("Both")
  })

  it("rejects unknown validation type", () => {
    expect(() =>
      postingValidationSchema.parse({
        type: "CustomCheck",
        register: { kind: "AccumulationRegister", name: "Balance" },
        dimensions: ["product"],
        resource: "quantity",
        message: { uk: "Помилка" },
      })
    ).toThrow()
  })

  it("rejects non-register kind in validation register", () => {
    expect(() =>
      postingValidationSchema.parse({
        type: "NonNegativeBalance",
        register: { kind: "Document", name: "SalesOrder" },
        dimensions: ["product"],
        resource: "quantity",
        message: { uk: "Помилка" },
      })
    ).toThrow()
  })
})

describe("postingSchema", () => {
  it("parses full posting with movements and validations", () => {
    const result = postingSchema.parse({
      movements: [
        {
          register: { kind: "AccumulationRegister", name: "InventoryBalance" },
          movementType: "Receipt",
          source: "tabularSection:items",
          mappings: {
            dimensions: { product: "row.product", warehouse: "doc.warehouse" },
            resources: {
              quantity: "row.quantity",
              amount: "row.quantity * row.price",
            },
            attributes: { responsible: "doc.responsible" },
          },
        },
      ],
      validations: [
        {
          type: "NonNegativeBalance",
          register: { kind: "AccumulationRegister", name: "InventoryBalance" },
          dimensions: ["product", "warehouse"],
          resource: "quantity",
          message: { uk: "Недостатньо товару" },
        },
      ],
    })
    expect(result.movements).toHaveLength(1)
    expect(result.validations).toHaveLength(1)
  })

  it("parses empty posting object", () => {
    const result = postingSchema.parse({})
    expect(result.movements).toEqual([])
    expect(result.validations).toEqual([])
  })

  it("defaults movements and validations to empty arrays", () => {
    const result = postingSchema.parse({ movements: [] })
    expect(result.validations).toEqual([])
  })
})

describe("documentSchema — posting field", () => {
  it("document without posting -> posting is undefined", () => {
    const result = documentSchema.parse({
      kind: "Document",
      name: "SalesOrder",
    })
    expect(result.posting).toBeUndefined()
  })

  it("document with posting object", () => {
    const result = documentSchema.parse({
      kind: "Document",
      name: "GoodsReceipt",
      posting: {
        movements: [
          {
            register: {
              kind: "AccumulationRegister",
              name: "InventoryBalance",
            },
            movementType: "Receipt",
            source: "tabularSection:items",
            mappings: {
              dimensions: { product: "row.product" },
              resources: { quantity: "row.quantity" },
            },
          },
        ],
        validations: [],
      },
    })
    expect(typeof result.posting).toBe("object")
    const posting = result.posting as {
      movements: unknown[]
      validations: unknown[]
    }
    expect(posting.movements).toHaveLength(1)
    expect(posting.validations).toEqual([])
  })

  it("document with empty posting object", () => {
    const result = documentSchema.parse({
      kind: "Document",
      name: "SalesOrder",
      posting: {},
    })
    expect(typeof result.posting).toBe("object")
    const posting = result.posting as {
      movements: unknown[]
      validations: unknown[]
    }
    expect(posting.movements).toEqual([])
    expect(posting.validations).toEqual([])
  })

  it("rejects posting: true (boolean no longer allowed)", () => {
    expect(() =>
      documentSchema.parse({
        kind: "Document",
        name: "SalesOrder",
        posting: true,
      })
    ).toThrow()
  })

  it("rejects posting: false (boolean no longer allowed)", () => {
    expect(() =>
      documentSchema.parse({
        kind: "Document",
        name: "SalesOrder",
        posting: false,
      })
    ).toThrow()
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
