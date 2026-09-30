import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  project,
  uuid,
} from "./helpers"

function compileWith(entries: Record<string, unknown>) {
  return compile(metaFiles({ "project.meta.json": project(), ...entries }))
}

const NOTE = "catalogs/Note/Note.meta.json"

function register(name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(700 + name.length),
    kind: "InformationRegister",
    name,
    physicalName: name.toLowerCase(),
    ...overrides,
  }
}

function refTo(kind: string, name: string) {
  return { type: "Ref", ref: { kind, name } }
}

describe("stage 4: integrity", () => {
  it("reference to a register is not referenceable", () => {
    const result = compileWith({
      "information-registers/Prices/Prices.meta.json": register("Prices"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("price", refTo("InformationRegister", "Prices")),
        ],
      }),
    })
    expect(result.ok).toBe(false)
    expect(result.model).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "reference.not-referenceable",
        severity: "error",
        file: NOTE,
        pointer: "/attributes/0/ref",
      }),
    ])
  })

  it("reference to a constant or pg enum is not referenceable", () => {
    const result = compileWith({
      "constants/Rate/Rate.meta.json": {
        id: uuid(710),
        kind: "Constant",
        name: "Rate",
        physicalName: "rate",
        type: "Integer",
      },
      "pg-enums/Mood/Mood.meta.json": {
        id: uuid(711),
        kind: "PgEnum",
        name: "Mood",
        physicalName: "mood",
        values: ["ok"],
      },
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subject", {
            type: "Ref",
            allowedTypes: [
              { kind: "Constant", name: "Rate" },
              { kind: "PgEnum", name: "Mood" },
            ],
          }),
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["reference.not-referenceable", "/attributes/0/allowedTypes/0"],
      ["reference.not-referenceable", "/attributes/0/allowedTypes/1"],
    ])
  })

  it("pg enum column of a custom table is allowed", () => {
    const result = compileWith({
      "pg-enums/Mood/Mood.meta.json": {
        id: uuid(711),
        kind: "PgEnum",
        name: "Mood",
        physicalName: "mood",
        values: ["ok"],
      },
      "custom-tables/Diary/Diary.meta.json": customTable("Diary", {
        columns: [
          {
            id: uuid(712),
            name: "mood",
            physicalName: "mood",
            type: "PgEnum",
            enum: { kind: "PgEnum", name: "Mood" },
          },
        ],
      }),
    })
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("reference to a custom table without a single uuid primary key", () => {
    const result = compileWith({
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        columns: [
          { id: uuid(720), name: "id", physicalName: "id", type: "BigInt" },
        ],
        primaryKey: { columns: ["id"] },
      }),
      "custom-tables/Raw/Raw.meta.json": customTable("Raw"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("log", refTo("CustomTable", "Log")),
          attribute("raw", refTo("CustomTable", "Raw")),
        ],
      }),
    })
    expect(
      result.diagnostics.map((d) => [d.code, d.severity, d.file, d.pointer])
    ).toEqual([
      ["reference.custom-table-key", "error", NOTE, "/attributes/0/ref"],
      ["reference.custom-table-key", "error", NOTE, "/attributes/1/ref"],
    ])
  })

  it("catalog owner must materialize a table with a uuid key", () => {
    const result = compileWith({
      "enumerations/Status/Status.meta.json": {
        id: uuid(730),
        kind: "Enumeration",
        name: "Status",
        physicalName: "status",
        values: [{ id: uuid(731), name: "Open", physicalName: "open" }],
      },
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        columns: [
          { id: uuid(732), name: "id", physicalName: "id", type: "BigInt" },
        ],
        primaryKey: { columns: ["id"] },
      }),
      "catalogs/Owner/Owner.meta.json": catalog("Owner"),
      [NOTE]: catalog("Note", {
        owners: [
          { kind: "Enumeration", name: "Status" },
          { kind: "CustomTable", name: "Log" },
          { kind: "Catalog", name: "Owner" },
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.file, d.pointer])).toEqual([
      ["reference.not-referenceable", NOTE, "/owners/0"],
      ["reference.custom-table-key", NOTE, "/owners/1"],
    ])
  })

  it("two tables with the same physicalName in one schema", () => {
    const result = compileWith({
      "catalogs/A/A.meta.json": catalog("A", { physicalName: "shared" }),
      "documents/B/B.meta.json": document("B", { physicalName: "shared" }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.table-duplicate",
        severity: "error",
        file: "documents/B/B.meta.json",
        pointer: "/physicalName",
      }),
    ])
  })

  it("same physicalName in different schemas is fine", () => {
    const result = compileWith({
      "catalogs/A/A.meta.json": catalog("A", { physicalName: "shared" }),
      "documents/B/B.meta.json": document("B", {
        physicalName: "shared",
        schema: "sales",
      }),
    })
    expect(result.diagnostics).toEqual([])
  })

  it("tabular section and enum type share the table namespace", () => {
    const result = compileWith({
      "catalogs/A/A.meta.json": catalog("A", {
        tabularSections: [
          {
            id: uuid(730),
            name: "lines",
            physicalName: "mood",
            attributes: [],
          },
        ],
      }),
      "pg-enums/Mood/Mood.meta.json": {
        id: uuid(731),
        kind: "PgEnum",
        name: "Mood",
        physicalName: "mood",
        values: ["ok"],
      },
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.table-duplicate",
        file: "pg-enums/Mood/Mood.meta.json",
        pointer: "/physicalName",
      }),
    ])
  })

  it("attribute column collides with a standard column", () => {
    const result = compileWith({
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("label", { physicalName: "code" }),
          attribute("other", { physicalName: "note_x" }),
          attribute("again", { physicalName: "note_x" }),
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["physical.column-duplicate", "/attributes/0/physicalName"],
      ["physical.column-duplicate", "/attributes/2/physicalName"],
    ])
  })

  it("polymorphic pair collides with a plain column", () => {
    const result = compileWith({
      "catalogs/A/A.meta.json": catalog("A"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subjectType", { physicalName: "subject_type" }),
          attribute("subject", {
            type: "Ref",
            allowedTypes: [{ kind: "Catalog", name: "A" }],
          }),
        ],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["physical.column-duplicate", "/attributes/1/physicalName"],
    ])
  })

  it("two polymorphic targets with the same physicalName in different schemas", () => {
    const result = compileWith({
      "catalogs/A/A.meta.json": catalog("A", { physicalName: "party" }),
      "catalogs/B/B.meta.json": catalog("B", {
        physicalName: "party",
        schema: "crm",
      }),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subject", {
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "A" },
              { kind: "Catalog", name: "B" },
            ],
          }),
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.discriminator-duplicate",
        severity: "error",
        file: NOTE,
        pointer: "/attributes/0/allowedTypes/1",
      }),
    ])
  })

  it("register recorders with the same physicalName", () => {
    const result = compileWith({
      "documents/A/A.meta.json": document("A", { physicalName: "doc" }),
      "documents/B/B.meta.json": document("B", {
        physicalName: "doc",
        schema: "other",
      }),
      "information-registers/Log/Log.meta.json": register("Log", {
        writeMode: "RecorderSubordinate",
        recorderTypes: [
          { kind: "Document", name: "A" },
          { kind: "Document", name: "B" },
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.discriminator-duplicate",
        file: "information-registers/Log/Log.meta.json",
        pointer: "/recorderTypes/1",
      }),
    ])
  })

  it("reserved word is a warning", () => {
    const result = compileWith({
      "catalogs/Order/Order.meta.json": catalog("Order", {
        attributes: [attribute("check", { physicalName: "check" })],
      }),
    })
    expect(result.ok).toBe(true)
    expect(result.model).toBeDefined()
    expect(
      result.diagnostics.map((d) => [d.code, d.severity, d.pointer])
    ).toEqual([
      ["physical.reserved-word", "warning", "/attributes/0/physicalName"],
      ["physical.reserved-word", "warning", "/physicalName"],
    ])
  })

  it("derived name longer than 63 bytes", () => {
    const base = "s".repeat(60)
    const result = compileWith({
      "catalogs/A/A.meta.json": catalog("A"),
      [NOTE]: catalog("Note", {
        attributes: [
          attribute("subject", {
            physicalName: base,
            type: "Ref",
            allowedTypes: [{ kind: "Catalog", name: "A" }],
          }),
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "physical.name-too-long",
        severity: "error",
        file: NOTE,
        pointer: "/attributes/0/physicalName",
        params: { name: `${base}_type` },
      }),
    ])
  })

  it("explicit constraint name longer than 63 bytes", () => {
    const result = compileWith({
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        uniques: [{ name: "u".repeat(64), columns: ["id"] }],
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["physical.name-too-long", "/uniques/0/name"],
    ])
  })

  describe("custom table constraints", () => {
    const LOG = "custom-tables/Log/Log.meta.json"
    const columns = [
      { id: uuid(740), name: "id", physicalName: "id", type: "UUID" },
      { id: uuid(741), name: "email", physicalName: "email", type: "Text" },
    ]
    const log = (overrides: Record<string, unknown>) =>
      compileWith({ [LOG]: customTable("Log", { columns, ...overrides }) })
    const codes = (result: ReturnType<typeof compileWith>) =>
      result.diagnostics.map((d) => [d.code, d.severity, d.file, d.pointer])

    it("unnamed index with an expression key needs a name", () => {
      const result = log({
        indexes: [
          { name: "log_lower_idx", keys: [{ expression: "lower(email)" }] },
          { keys: [{ column: "email" }] },
          { keys: [{ column: "id" }, { expression: "lower(email)" }] },
        ],
      })
      expect(codes(result)).toEqual([
        ["physical.constraint-name-required", "error", LOG, "/indexes/2"],
      ])
      expect(result.diagnostics[0]!.hint).toContain("explicit name")
    })

    it("unnamed check needs a name", () => {
      const result = log({
        checks: [
          { name: "log_email_len", expression: "length(email) > 0" },
          { expression: "length(email) > 0" },
        ],
      })
      expect(codes(result)).toEqual([
        ["physical.constraint-name-required", "error", LOG, "/checks/1"],
      ])
    })

    it("fk to a pg enum is not referenceable, not a table", () => {
      const result = compileWith({
        "pg-enums/Mood/Mood.meta.json": {
          id: uuid(742),
          kind: "PgEnum",
          name: "Mood",
          physicalName: "mood",
          values: ["ok"],
        },
        [LOG]: customTable("Log", {
          columns,
          foreignKeys: [
            {
              columns: ["email"],
              references: {
                object: { kind: "PgEnum", name: "Mood" },
                columns: ["ok"],
              },
            },
          ],
        }),
      })
      expect(codes(result)).toEqual([
        [
          "reference.not-referenceable",
          "error",
          LOG,
          "/foreignKeys/0/references/object",
        ],
      ])
    })

    it("unknown column in primary key, unique, fk and index", () => {
      const result = log({
        primaryKey: { columns: ["uuid"] },
        uniques: [{ columns: ["id", "mail"] }],
        foreignKeys: [
          {
            columns: ["owner"],
            references: {
              external: { schema: "auth", table: "users", columns: ["id"] },
            },
          },
        ],
        indexes: [
          { keys: [{ column: "id" }, { column: "nope" }], include: ["gone"] },
        ],
      })
      expect(codes(result)).toEqual([
        [
          "customTable.column-unknown",
          "error",
          LOG,
          "/foreignKeys/0/columns/0",
        ],
        ["customTable.column-unknown", "error", LOG, "/indexes/0/include/0"],
        ["customTable.column-unknown", "error", LOG, "/indexes/0/keys/1"],
        ["customTable.column-unknown", "error", LOG, "/primaryKey/columns/0"],
        ["customTable.column-unknown", "error", LOG, "/uniques/0/columns/1"],
      ])
    })

    it("fk target columns resolve as logical names of the target", () => {
      const result = compileWith({
        "catalogs/Currency/Currency.meta.json": catalog("Currency", {
          attributes: [attribute("isoCode", { physicalName: "iso_code" })],
        }),
        "custom-tables/Other/Other.meta.json": customTable("Other"),
        [LOG]: customTable("Log", {
          columns,
          foreignKeys: [
            {
              columns: ["id"],
              references: {
                object: { kind: "Catalog", name: "Currency" },
                columns: ["ref"],
              },
            },
            {
              columns: ["email"],
              references: {
                object: { kind: "Catalog", name: "Currency" },
                columns: ["isoCode"],
              },
            },
            {
              columns: ["id"],
              references: {
                object: { kind: "Catalog", name: "Currency" },
                columns: ["id"],
              },
            },
            {
              columns: ["id"],
              references: {
                object: { kind: "CustomTable", name: "Other" },
                columns: ["missing"],
              },
            },
          ],
        }),
      })
      expect(codes(result)).toEqual([
        [
          "customTable.column-unknown",
          "error",
          LOG,
          "/foreignKeys/2/references/columns/0",
        ],
        [
          "customTable.column-unknown",
          "error",
          LOG,
          "/foreignKeys/3/references/columns/0",
        ],
      ])
    })

    it("fk column count must match the referenced columns", () => {
      const result = compileWith({
        "custom-tables/Other/Other.meta.json": customTable("Other"),
        [LOG]: customTable("Log", {
          columns,
          foreignKeys: [
            {
              columns: ["id", "email"],
              references: {
                object: { kind: "CustomTable", name: "Other" },
                columns: ["id"],
              },
            },
            {
              columns: ["id"],
              references: {
                external: {
                  schema: "auth",
                  table: "users",
                  columns: ["id", "aud"],
                },
              },
            },
          ],
        }),
      })
      expect(codes(result)).toEqual([
        ["customTable.foreign-key-arity", "error", LOG, "/foreignKeys/0"],
        ["customTable.foreign-key-arity", "error", LOG, "/foreignKeys/1"],
      ])
    })
  })
})
