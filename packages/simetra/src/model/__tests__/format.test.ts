import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  formatMetaFile,
  formatProjectFile,
  isRecordKeyAt,
  PROJECT_KEY_ORDER,
} from "../format"
import { projectSchema } from "../schemas"

const ID = "3f2b8a52-6d1e-4c0a-9b7e-5a1c2d3e4f50"

describe("formatMetaFile", () => {
  it("orders keys by kind key order and is idempotent", () => {
    const shuffled = {
      attributes: [{ type: "Integer", name: "quantity" }],
      title: { en: "Items", uk: "Номенклатура" },
      physicalName: "item",
      codeLength: 5,
      name: "Item",
      kind: "Catalog",
      id: ID,
      $schema: "../../schemas/catalog.json",
    }
    const once = formatMetaFile(shuffled)
    expect(formatMetaFile(JSON.parse(once))).toBe(once)
    expect(Object.keys(JSON.parse(once))).toEqual([
      "$schema",
      "id",
      "kind",
      "name",
      "physicalName",
      "title",
      "codeLength",
      "attributes",
    ])
    // Вкладені об'єкти теж у порядку схеми, а не вхідному.
    expect(Object.keys(JSON.parse(once).attributes[0])).toEqual([
      "name",
      "type",
    ])
  })

  it("unknown keys keep input order after known ones", () => {
    const out = formatMetaFile({
      zeta: 1,
      name: "Item",
      alpha: 2,
      kind: "Catalog",
    })
    expect(Object.keys(JSON.parse(out))).toEqual([
      "kind",
      "name",
      "zeta",
      "alpha",
    ])
  })

  it("keeps input order when the kind is unknown", () => {
    const out = formatMetaFile({ name: "X", kind: "Nope", id: ID })
    expect(Object.keys(JSON.parse(out))).toEqual(["name", "kind", "id"])
  })

  it("2-space indent and trailing newline", () => {
    expect(formatMetaFile({ name: "Item", kind: "Catalog" })).toBe(
      '{\n  "kind": "Catalog",\n  "name": "Item"\n}\n'
    )
  })
})

describe("formatProjectFile", () => {
  it("orders project keys and covers the project schema", () => {
    expect([...PROJECT_KEY_ORDER].sort()).toEqual(
      Object.keys((projectSchema as z.ZodObject).shape).sort()
    )
    const out = formatProjectFile({
      naming: { attributeCase: "snake_case" },
      name: "demo",
      $schema: "./schemas/project.json",
    })
    expect(out).toBe(
      '{\n  "$schema": "./schemas/project.json",\n  "name": "demo",\n  "naming": {\n    "attributeCase": "snake_case"\n  }\n}\n'
    )
  })
})

const keysAt = (text: string, ...path: (string | number)[]): string[] => {
  let node: unknown = JSON.parse(text)
  for (const step of path)
    node = (node as Record<string | number, unknown>)[step]
  return Object.keys(node as object)
}

describe("formatMetaFile nested levels", () => {
  it("nested keys follow schema order", () => {
    const out = formatMetaFile({
      kind: "Catalog",
      name: "Item",
      attributes: [
        {
          unique: true,
          type: "String",
          title: { en: "Title", uk: "Назва" },
          physicalName: "title",
          name: "title",
          length: 10,
          id: ID,
        },
      ],
      tabularSections: [
        {
          attributes: [{ type: "Integer", name: "qty" }],
          name: "Lines",
          id: ID,
        },
      ],
    })
    expect(keysAt(out, "attributes", 0)).toEqual([
      "id",
      "name",
      "physicalName",
      "title",
      "type",
      "length",
      "unique",
    ])
    expect(keysAt(out, "attributes", 0, "title")).toEqual(["uk", "en"])
    expect(keysAt(out, "tabularSections", 0)).toEqual([
      "id",
      "name",
      "attributes",
    ])
    expect(keysAt(out, "tabularSections", 0, "attributes", 0)).toEqual([
      "name",
      "type",
    ])
  })

  it("custom table column variants", () => {
    const out = formatMetaFile({
      kind: "CustomTable",
      name: "T",
      columns: [
        {
          enum: { name: "Status", kind: "PgEnum" },
          type: "PgEnum",
          notNull: true,
          name: "status",
          id: ID,
        },
        {
          pgType: "tsvector",
          type: "Raw",
          comment: "c",
          name: "doc",
          id: ID,
        },
      ],
    })
    expect(keysAt(out, "columns", 0)).toEqual([
      "id",
      "name",
      "notNull",
      "type",
      "enum",
    ])
    expect(keysAt(out, "columns", 0, "enum")).toEqual(["kind", "name"])
    expect(keysAt(out, "columns", 1)).toEqual([
      "id",
      "name",
      "comment",
      "type",
      "pgType",
    ])
  })

  it("foreign key references internal and external", () => {
    const out = formatMetaFile({
      kind: "CustomTable",
      name: "T",
      columns: [{ type: "Integer", name: "a" }],
      foreignKeys: [
        {
          onDelete: "cascade",
          references: {
            columns: ["id"],
            object: { name: "Item", kind: "Catalog" },
          },
          columns: ["a"],
          name: "fk1",
        },
        {
          references: {
            external: { table: "users", columns: ["id"], schema: "auth" },
          },
          columns: ["a"],
        },
      ],
      indexes: [
        {
          keys: [{ column: "a" }, { expression: "lower(a)" }],
          unique: true,
          name: "ix",
        },
      ],
      rowLevelSecurity: "enabled",
    })
    expect(keysAt(out, "foreignKeys", 0)).toEqual([
      "name",
      "columns",
      "references",
      "onDelete",
    ])
    expect(keysAt(out, "foreignKeys", 0, "references")).toEqual([
      "object",
      "columns",
    ])
    expect(keysAt(out, "foreignKeys", 0, "references", "object")).toEqual([
      "kind",
      "name",
    ])
    expect(keysAt(out, "foreignKeys", 1, "references", "external")).toEqual([
      "schema",
      "table",
      "columns",
    ])
    expect(keysAt(out, "indexes", 0)).toEqual(["name", "unique", "keys"])
  })

  it("fields map keeps input order", () => {
    const out = formatMetaFile({
      kind: "Document",
      name: "Sale",
      posting: {
        movements: [
          {
            fields: { zeta: "a", alpha: "b" },
            source: { tabularSection: "Lines" },
            register: { name: "Stock", kind: "AccumulationRegister" },
          },
        ],
      },
    })
    expect(keysAt(out, "posting", "movements", 0)).toEqual([
      "register",
      "source",
      "fields",
    ])
    expect(keysAt(out, "posting", "movements", 0, "fields")).toEqual([
      "zeta",
      "alpha",
    ])
  })

  it("scope kind keys follow schema order in the project file", () => {
    const out = formatProjectFile({
      scopeKinds: [
        {
          onRootDelete: "cascade",
          setFunction: { name: "set_company", schema: "app" },
          root: { object: { name: "Company", kind: "Catalog" } },
          name: "company",
        },
        {
          setFunction: { name: "f" },
          root: { external: { column: "id", table: "t", schema: "s" } },
          name: "hub",
        },
      ],
      name: "demo",
    })
    expect(keysAt(out, "scopeKinds", 0)).toEqual([
      "name",
      "root",
      "setFunction",
      "onRootDelete",
    ])
    expect(keysAt(out, "scopeKinds", 0, "setFunction")).toEqual([
      "schema",
      "name",
    ])
    expect(keysAt(out, "scopeKinds", 1, "root", "external")).toEqual([
      "schema",
      "table",
      "column",
    ])
  })

  it("unknown nested keys go last in input order", () => {
    const out = formatMetaFile({
      kind: "Catalog",
      name: "Item",
      attributes: [{ zz: 1, type: "Integer", aa: 2, name: "q" }],
    })
    expect(keysAt(out, "attributes", 0)).toEqual(["name", "type", "zz", "aa"])
  })

  it("idempotent on a kitchen-sink file", () => {
    const sink = {
      rowLevelSecurity: "forced",
      indexes: [
        {
          include: ["b"],
          where: "a > 0",
          nullsNotDistinct: true,
          method: "btree",
          keys: [{ column: "a" }],
          unique: true,
          name: "ix",
        },
      ],
      foreignKeys: [
        {
          deferrable: "deferrable",
          onUpdate: "restrict",
          onDelete: "setNull",
          references: {
            columns: ["id"],
            object: { name: "Item", kind: "Catalog" },
          },
          columns: ["a"],
          name: "fk",
        },
      ],
      checks: [{ expression: "a > 0", name: "ck" }],
      uniques: [{ nullsNotDistinct: true, columns: ["a"], name: "uq" }],
      primaryKey: { columns: ["a"], name: "pk" },
      scopeColumn: "a",
      columns: [
        {
          identity: "always",
          default: "0",
          title: { en: "A", uk: "А" },
          notNull: true,
          type: "Integer",
          name: "a",
          id: ID,
        },
        { type: "Integer", name: "b" },
      ],
      comment: "x",
      scope: "company",
      kind: "CustomTable",
      name: "T",
      id: ID,
      description: { en: "d", uk: "о" },
    }
    const once = formatMetaFile(sink)
    expect(formatMetaFile(JSON.parse(once))).toBe(once)
    expect(keysAt(once, "indexes", 0)).toEqual([
      "name",
      "unique",
      "method",
      "keys",
      "include",
      "where",
      "nullsNotDistinct",
    ])
    expect(keysAt(once)).toEqual([
      "id",
      "kind",
      "name",
      "scope",
      "description",
      "comment",
      "columns",
      "primaryKey",
      "uniques",
      "checks",
      "foreignKeys",
      "indexes",
      "scopeColumn",
      "rowLevelSecurity",
    ])
  })

  it("catalog predefined items, owners and overrides are ordered", () => {
    const out = formatMetaFile({
      tabularSections: [{ name: "L", id: ID }],
      predefinedItems: [
        { description: { en: "x", uk: "ікс" }, name: "X", id: ID },
      ],
      standardAttributeOverrides: {
        zeta: { description: { en: "z", uk: "я" } },
        code: { description: { en: "x", uk: "ікс" } },
      },
      owners: [{ name: "Company", kind: "Catalog" }],
      kind: "Catalog",
      name: "Item",
    })
    expect(formatMetaFile(JSON.parse(out))).toBe(out)
    expect(keysAt(out, "predefinedItems", 0)).toEqual([
      "id",
      "name",
      "description",
    ])
    expect(keysAt(out, "predefinedItems", 0, "description")).toEqual([
      "uk",
      "en",
    ])
    expect(keysAt(out, "owners", 0)).toEqual(["kind", "name"])
    expect(keysAt(out, "standardAttributeOverrides")).toEqual(["zeta", "code"])
    expect(
      keysAt(out, "standardAttributeOverrides", "zeta", "description")
    ).toEqual(["uk", "en"])
  })
})

describe("isRecordKeyAt", () => {
  const schema = z.object({
    plain: z.string(),
    list: z.array(z.object({ name: z.string() })),
    source: z.union([z.literal("doc"), z.object({ section: z.string() })]),
    fields: z.record(z.string(), z.string()),
  })
  const data = {
    plain: "fields",
    list: [{ name: "x" }],
    source: { section: "rows" },
    fields: { amount: "amount" },
  }

  it("is true only for a key of a record", () => {
    expect(isRecordKeyAt(schema, data, "/fields/amount")).toBe(true)
    expect(isRecordKeyAt(schema, data, "/plain")).toBe(false)
    expect(isRecordKeyAt(schema, data, "/list/0/name")).toBe(false)
    expect(isRecordKeyAt(schema, data, "/source/section")).toBe(false)
    expect(isRecordKeyAt(schema, data, "/fields")).toBe(false)
    expect(isRecordKeyAt(schema, data, "")).toBe(false)
  })
})
