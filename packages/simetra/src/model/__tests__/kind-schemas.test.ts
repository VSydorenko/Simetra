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
  it("predefinedItems accept id, name, description", () => {
    const r = catalogSchema.parse({
      kind: "Catalog",
      name: "Warehouse",
      predefinedItems: [
        { id: ID, name: "Main", description: { uk: "Основний" } },
        { name: "Spare" },
      ],
    })
    expect(r.predefinedItems).toEqual([
      { id: ID, name: "Main", description: { uk: "Основний" } },
      { name: "Spare" },
    ])
  })

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

  it("resources accept ref, unlike accumulation register resources", () => {
    const r = informationRegisterSchema.parse({
      kind: "InformationRegister",
      name: "Prices",
      resources: [
        { name: "currency", type: "Ref", ref: { kind: "Catalog", name: "C" } },
      ],
    })
    expect(r.resources[0]?.ref).toEqual({ kind: "Catalog", name: "C" })
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
      resources: [{ name: "note", type: "Text" }],
    })
    expect(r.success).toBe(false)
    expect(r.error?.issues.map((i) => [i.code, i.path])).toEqual([
      ["invalid_value", ["resources", 0, "type"]],
    ])
  })

  it("resources have no length, ref, allowedTypes, crossScope or indexed", () => {
    for (const extra of [
      { length: 10 },
      { ref: { kind: "Catalog", name: "Item" } },
      { allowedTypes: [{ kind: "Catalog", name: "Item" }] },
      { crossScope: true },
      { indexed: true },
      // Ресурс регістра накопичення завжди NOT NULL: прапорця немає.
      { required: true },
    ]) {
      const r = accumulationRegisterSchema.safeParse({
        kind: "AccumulationRegister",
        name: "Stock",
        resources: [{ name: "qty", type: "Integer", ...extra }],
      })
      expect(r.success).toBe(false)
      expect(
        r.error?.issues.map((i) => [
          i.code,
          i.path,
          (i as { keys?: string[] }).keys,
        ])
      ).toEqual([["unrecognized_keys", ["resources", 0], Object.keys(extra)]])
    }
  })

  it("resources keep the element fields and precision/scale", () => {
    const r = accumulationRegisterSchema.parse({
      kind: "AccumulationRegister",
      name: "Stock",
      resources: [
        {
          id: ID,
          name: "sum",
          physicalName: "sum",
          title: { uk: "Сума" },
          description: { en: "Amount" },
          type: "Numeric",
          precision: 15,
          scale: 2,
        },
      ],
    })
    expect(r.resources[0]).toEqual({
      id: ID,
      name: "sum",
      physicalName: "sum",
      title: { uk: "Сума" },
      description: { en: "Amount" },
      type: "Numeric",
      precision: 15,
      scale: 2,
    })
  })

  it("resource precision is still checked against the type", () => {
    const r = accumulationRegisterSchema.safeParse({
      kind: "AccumulationRegister",
      name: "Stock",
      resources: [{ name: "qty", type: "Integer", precision: 10 }],
    })
    expect(
      r.error?.issues.map(
        (i) => (i as { params?: { rule?: string } }).params?.rule
      )
    ).toEqual(["type.precision-not-allowed"])
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
    expect(
      projectSchema.parse({
        name: "Demo",
        database: { provider: "supabase" },
      })
    ).toEqual({
      name: "Demo",
      defaultLocale: "uk",
      defaultSchema: "public",
      database: { provider: "supabase" },
      naming: { attributeCase: "camelCase" },
      timezone: "UTC",
      scopeKinds: [],
    })
  })

  it("accepts title, locale, schema and snake_case naming", () => {
    const r = projectSchema.parse({
      $schema: "x",
      name: "Demo",
      title: { en: "Demo" },
      defaultLocale: "en",
      defaultSchema: "app",
      database: { provider: "supabase" },
      naming: { attributeCase: "snake_case" },
    })
    expect(r.naming.attributeCase).toBe("snake_case")
  })

  it("rejects an unknown locale or attribute case", () => {
    expect(() =>
      projectSchema.parse({
        name: "D",
        database: { provider: "supabase" },
        defaultLocale: "de",
      })
    ).toThrow()
    expect(() =>
      projectSchema.parse({
        name: "D",
        database: { provider: "supabase" },
        naming: { attributeCase: "kebab" },
      })
    ).toThrow()
  })

  it("project has no generation block", () => {
    for (const key of ["generation", "deployment"]) {
      expect(projectSchema.shape).not.toHaveProperty(key)
    }
    expect(projectSchema.shape).not.toHaveProperty("schemaVersion")
  })

  it("database holds the provider only, never deployment identifiers", () => {
    expect(Object.keys(projectSchema.shape.database.shape)).toEqual([
      "provider",
    ])
    expect(
      projectSchema.safeParse({
        name: "D",
        database: { provider: "supabase", url: "x" },
      }).success
    ).toBe(false)
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

describe("documentSchema — posting movements", () => {
  const movement = {
    register: { kind: "AccumulationRegister", name: "Stock" },
    source: { tabularSection: "goods" },
    movementType: "Receipt",
    fields: { qty: "row.qty", amount: "row.qty * row.price" },
  }
  const parse = (posting: unknown) =>
    documentSchema.safeParse({ kind: "Document", name: "Receipt", posting })

  it("parses a movement with a flat fields map", () => {
    const result = parse({ movements: [movement] })
    expect(result.success).toBe(true)
  })

  it("accepts document source and an expression movementType", () => {
    const result = parse({
      movements: [
        {
          ...movement,
          source: "document",
          movementType: "doc.kind",
          fields: { qty: "1" },
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it("movement with parse error points at the field", () => {
    const result = parse({
      movements: [{ ...movement, fields: { qty: "row.qty +" } }],
    })
    expect(result.success).toBe(false)
    if (result.success) return
    const issue = result.error.issues.find(
      (i) =>
        (i as { params?: { rule?: string } }).params?.rule === "posting.parse"
    )
    expect(issue).toBeDefined()
    expect(issue?.path.slice(-2)).toEqual(["fields", "qty"])
    expect(issue?.path.slice(0, 3)).toEqual(["posting", "movements", 0])
    const params = (issue as { params?: { offset?: unknown } }).params
    expect(typeof params?.offset).toBe("number")
  })

  it("points at condition, period and movementType expressions", () => {
    const result = parse({
      movements: [
        {
          ...movement,
          condition: "row.a =",
          period: "doc.date +",
          movementType: "doc.kind +",
        },
      ],
    })
    expect(result.success).toBe(false)
    if (result.success) return
    const tails = result.error.issues.map((i) => i.path[3])
    expect(tails).toEqual(
      expect.arrayContaining(["condition", "period", "movementType"])
    )
  })

  it("does not parse literal movementType as an expression", () => {
    expect(
      parse({ movements: [{ ...movement, movementType: "Expense" }] }).success
    ).toBe(true)
  })

  it("validations are gone: the key is unknown", () => {
    const result = parse({
      movements: [movement],
      validations: [{ type: "NonNegativeBalance" }],
    })
    expect(result.success).toBe(false)
    expect(
      result.error?.issues.map((i) => [
        i.code,
        i.path,
        (i as { keys?: string[] }).keys,
      ])
    ).toEqual([["unrecognized_keys", ["posting"], ["validations"]]])
  })

  it("document without posting -> posting is undefined", () => {
    const result = documentSchema.parse({ kind: "Document", name: "Receipt" })
    expect(result.posting).toBeUndefined()
  })

  it("empty posting object -> movements is []", () => {
    const result = documentSchema.parse({
      kind: "Document",
      name: "Receipt",
      posting: {},
    })
    expect(result.posting?.movements).toEqual([])
  })

  it("rejects posting: boolean", () => {
    expect(parse(true).success).toBe(false)
  })
})

describe("strict metadata schemas", () => {
  /** Шляхи й ключі issue `unrecognized_keys`. */
  function unknown(result: {
    error?: { issues: { code: string; path: PropertyKey[] }[] }
  }) {
    return (result.error?.issues ?? [])
      .filter((i) => i.code === "unrecognized_keys")
      .map((i) => [i.path.join("/"), (i as { keys?: string[] }).keys])
  }

  it("defaults still apply at every nesting level", () => {
    const r = documentSchema.parse({
      kind: "Document",
      name: "Order",
      posting: {},
      tabularSections: [
        { name: "goods", attributes: [{ name: "q", type: "Integer" }] },
      ],
    })
    expect(r.numberLength).toBe(11)
    expect(r.standardAttributeOverrides).toEqual({})
    expect(r.posting?.movements).toEqual([])
    expect(r.tabularSections[0]?.standardAttributeOverrides).toEqual({})
    expect(r.tabularSections[0]?.attributes[0]).toMatchObject({
      required: false,
      indexed: false,
      unique: false,
    })
    expect(
      projectSchema.parse({ name: "A", database: { provider: "supabase" } })
        .naming
    ).toEqual({
      attributeCase: "camelCase",
    })
  })

  it("$schema is allowed at the top only", () => {
    expect(
      catalogSchema.safeParse({ $schema: "x", kind: "Catalog", name: "C" })
        .success
    ).toBe(true)
    expect(
      projectSchema.safeParse({
        $schema: "x",
        name: "A",
        database: { provider: "supabase" },
      }).success
    ).toBe(true)
    expect(
      unknown(
        catalogSchema.safeParse({
          kind: "Catalog",
          name: "C",
          title: { uk: "Т", $schema: "x" },
        })
      )
    ).toEqual([["title", ["$schema"]]])
  })

  it("records keep arbitrary keys, their values are strict", () => {
    const ok = catalogSchema.safeParse({
      kind: "Catalog",
      name: "C",
      standardAttributeOverrides: {
        anyName: { title: { en: "T" }, description: { en: "D" } },
      },
    })
    expect(ok.success).toBe(true)
    expect(
      unknown(
        catalogSchema.safeParse({
          kind: "Catalog",
          name: "C",
          standardAttributeOverrides: { code: { hint: { en: "H" } } },
        })
      )
    ).toEqual([["standardAttributeOverrides/code", ["hint"]]])
  })

  it("unknown keys are reported at every nesting level", () => {
    expect(
      unknown(
        catalogSchema.safeParse({
          kind: "Catalog",
          name: "C",
          owners: [{ kind: "Catalog", name: "O", id: "x" }],
          predefinedItems: [{ name: "Main", code: "1" }],
        })
      )
    ).toEqual([
      ["owners/0", ["id"]],
      ["predefinedItems/0", ["code"]],
    ])
    expect(
      unknown(
        enumerationSchema.safeParse({
          kind: "Enumeration",
          name: "E",
          values: [{ name: "A", order: 1 }],
        })
      )
    ).toEqual([["values/0", ["order"]]])
    expect(
      unknown(
        accumulationRegisterSchema.safeParse({
          kind: "AccumulationRegister",
          name: "R",
          balanceControl: { resources: [], strict: true },
        })
      )
    ).toEqual([["balanceControl", ["strict"]]])
  })
})
