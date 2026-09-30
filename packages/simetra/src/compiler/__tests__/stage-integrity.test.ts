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
})
