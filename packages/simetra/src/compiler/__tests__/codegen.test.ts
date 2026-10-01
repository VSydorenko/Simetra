import ts from "typescript"
import { describe, expect, it } from "vitest"
import { compile, emitEntityTypes } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  organization,
  project,
  salesDocument,
  scopedProject,
  uuid,
} from "./helpers"

async function emit(entries: Record<string, unknown>): Promise<string> {
  const result = await compile(metaFiles(entries))
  expect(result.diagnostics).toEqual([])
  return emitEntityTypes(result.model!)
}

/** Фрагмент виходу: один інтерфейс разом з його JSDoc. */
function block(code: string, name: string): string {
  const blocks = code.split("\n\n")
  const found = blocks.find((b) => b.includes(`export interface ${name} {`))
  expect(found, `interface ${name}`).toBeDefined()
  return found!.trim()
}

/** Повна перевірка типів емітованого модуля в пам'яті, з реальним lib. */
function diagnosticsOf(code: string): string[] {
  const file = "/virtual/entities.ts"
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    skipLibCheck: true,
    types: [],
  }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile.bind(host)
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === file
      ? ts.createSourceFile(name, code, languageVersion)
      : getSourceFile(name, languageVersion, ...rest)
  const program = ts.createProgram([file], options, host)
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))
}

describe("emitEntityTypes", () => {
  it("catalog interface with standard attributes and jsdoc", async () => {
    const code = await emit({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": catalog("Item", {
        title: { uk: "Номенклатура", en: "Item" },
        description: { uk: "Товари й послуги" },
        attributes: [
          attribute("sku", {
            type: "String",
            length: 20,
            required: true,
            title: { uk: "Артикул" },
          }),
          attribute("note", { type: "Text" }),
        ],
      }),
    })
    expect(code.startsWith("export type Json = ")).toBe(true)
    expect(block(code, "Item")).toMatchInlineSnapshot(`
      "/**
       * Item
       *
       * Товари й послуги
       */
      export interface Item {
        /** Reference */
        ref: string
        /** Code */
        code: string | null
        /** Description */
        description: string | null
        /** Deletion mark */
        deletionMark: boolean
        /** Predefined name */
        predefinedName: string | null
        /** Version */
        version: string
        /** Created at */
        createdAt: string
        /** Updated at */
        updatedAt: string
        /** Артикул */
        sku: string
        note: string | null
      }"
    `)
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("numeric and bigint are strings", async () => {
    const code = await emit({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [
          attribute("price", { type: "Numeric", precision: 15, scale: 2 }),
          attribute("big", { type: "BigInt", required: true }),
          attribute("count", { type: "Integer", required: true }),
          attribute("payload", { type: "Json" }),
        ],
      }),
    })
    expect(block(code, "Item")).toMatchInlineSnapshot(`
      "export interface Item {
        /** Reference */
        ref: string
        /** Code */
        code: string | null
        /** Description */
        description: string | null
        /** Deletion mark */
        deletionMark: boolean
        /** Predefined name */
        predefinedName: string | null
        /** Version */
        version: string
        /** Created at */
        createdAt: string
        /** Updated at */
        updatedAt: string
        price: string | null
        big: string
        count: number
        payload: Json | null
      }"
    `)
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("enumeration reference is a union of logical names", async () => {
    const code = await emit({
      "project.meta.json": project(),
      "enumerations/Status/Status.meta.json": {
        id: uuid(1),
        kind: "Enumeration",
        name: "Status",
        physicalName: "status",
        values: [
          { id: uuid(2), name: "Draft", physicalName: "draft" },
          { id: uuid(3), name: "Done", physicalName: "done" },
        ],
      },
      "catalogs/Task/Task.meta.json": catalog("Task", {
        attributes: [
          attribute("status", {
            type: "Ref",
            ref: { kind: "Enumeration", name: "Status" },
            required: true,
          }),
          attribute("history", {
            type: "Ref",
            ref: { kind: "Enumeration", name: "Status" },
            array: true,
          }),
          attribute("related", {
            type: "Ref",
            allowedTypes: [
              { kind: "Catalog", name: "Task" },
              { kind: "Catalog", name: "Item" },
            ],
          }),
        ],
      }),
      "catalogs/Item/Item.meta.json": catalog("Item"),
    })
    expect(code).not.toContain("interface Status")
    expect(block(code, "Task")).toMatchInlineSnapshot(`
      "export interface Task {
        /** Reference */
        ref: string
        /** Code */
        code: string | null
        /** Description */
        description: string | null
        /** Deletion mark */
        deletionMark: boolean
        /** Predefined name */
        predefinedName: string | null
        /** Version */
        version: string
        /** Created at */
        createdAt: string
        /** Updated at */
        updatedAt: string
        status: "Draft" | "Done"
        history: ("Draft" | "Done")[] | null
        related: { type: "Catalog.Task" | "Catalog.Item"; id: string } | null
      }"
    `)
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("tabular section interface and array field", async () => {
    const code = await emit({
      "project.meta.json": project(),
      ...salesDocument(),
    })
    expect(block(code, "Sale")).toMatchInlineSnapshot(`
      "export interface Sale {
        /** Reference */
        ref: string
        /** Number */
        number: string | null
        /** Date */
        date: string
        /** Number period */
        readonly numberPeriod: string
        /** Posted */
        posted: boolean
        /** Deletion mark */
        deletionMark: boolean
        /** Version */
        version: string
        /** Created at */
        createdAt: string
        /** Updated at */
        updatedAt: string
        goods: SaleGoods[]
      }"
    `)
    expect(block(code, "SaleGoods")).toMatchInlineSnapshot(`
      "export interface SaleGoods {
        /** Reference */
        ref: string
        /** Owning object */
        parent: string
        /** Line number */
        lineNumber: number
        item: string | null
        qty: string | null
        amount: string | null
      }"
    `)
    // Регістр: рухи є, похідних таблиць підсумків і оборотів немає.
    expect(block(code, "Stock")).toMatchInlineSnapshot(`
      "export interface Stock {
        /** Period */
        period: string
        /** Recorder */
        recorder: { type: "Document.Sale"; id: string }
        /** Line number */
        lineNumber: number
        /** Active */
        active: boolean
        /** Movement type */
        movementType: string
        item: string | null
        qty: string
      }"
    `)
    expect(code).not.toMatch(/Totals|Turnovers/)
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("required document attribute is nullable and generated column is readonly", async () => {
    const code = await emit({
      "project.meta.json": project(),
      "documents/Invoice/Invoice.meta.json": document("Invoice", {
        numberPeriodicity: "Month",
        attributes: [
          attribute("customer", { type: "String", length: 10, required: true }),
        ],
      }),
    })
    expect(block(code, "Invoice")).toMatchInlineSnapshot(`
      "export interface Invoice {
        /** Reference */
        ref: string
        /** Number */
        number: string | null
        /** Date */
        date: string
        /** Number period */
        readonly numberPeriod: string
        /** Posted */
        posted: boolean
        /** Deletion mark */
        deletionMark: boolean
        /** Version */
        version: string
        /** Created at */
        createdAt: string
        /** Updated at */
        updatedAt: string
        customer: string | null
      }"
    `)
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("section standard overrides feed the section interface jsdoc", async () => {
    const code = await emit({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": catalog("Item", {
        tabularSections: [
          {
            id: uuid(801),
            name: "rows",
            physicalName: "rows",
            standardAttributeOverrides: {
              lineNumber: { description: { en: "Starts at one" } },
            },
          },
        ],
      }),
    })
    expect(block(code, "ItemRows")).toContain(
      "   * Line number\n   *\n   * Starts at one"
    )
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("snake_case project uses snake_case fields", async () => {
    const code = await emit({
      "project.meta.json": project({ naming: { attributeCase: "snake_case" } }),
      "catalogs/Item/Item.meta.json": catalog("Item", {
        attributes: [attribute("unit_price", { type: "Integer" })],
      }),
    })
    expect(block(code, "Item")).toMatchInlineSnapshot(`
      "export interface Item {
        /** Reference */
        ref: string
        /** Code */
        code: string | null
        /** Description */
        description: string | null
        /** Deletion mark */
        deletion_mark: boolean
        /** Predefined name */
        predefined_name: string | null
        /** Version */
        version: string
        /** Created at */
        created_at: string
        /** Updated at */
        updated_at: string
        unit_price: number | null
      }"
    `)
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("scoped object has scope field", async () => {
    const code = await emit({
      "project.meta.json": scopedProject(),
      "catalogs/Organization/Organization.meta.json": organization(),
      "catalogs/Item/Item.meta.json": catalog("Item", { scope: "org" }),
    })
    expect(block(code, "Item")).toMatchInlineSnapshot(`
      "export interface Item {
        /** Reference */
        ref: string
        org: string
        /** Code */
        code: string | null
        /** Description */
        description: string | null
        /** Deletion mark */
        deletionMark: boolean
        /** Predefined name */
        predefinedName: string | null
        /** Version */
        version: string
        /** Created at */
        createdAt: string
        /** Updated at */
        updatedAt: string
      }"
    `)
    // Корінь скоуп-колонки не має: його скоуп — власний ключ.
    expect(block(code, "Organization")).not.toContain("  org:")
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("custom table maps pg enum, raw and nullable columns", async () => {
    const code = await emit({
      "project.meta.json": project(),
      "pg-enums/Mood/Mood.meta.json": {
        id: uuid(1),
        kind: "PgEnum",
        name: "Mood",
        physicalName: "mood",
        values: ["happy", "sad"],
      },
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        scope: "none",
        columns: [
          {
            id: uuid(10),
            name: "id",
            physicalName: "id",
            type: "UUID",
            notNull: true,
          },
          {
            id: uuid(11),
            name: "mood",
            physicalName: "mood",
            type: "PgEnum",
            enum: { kind: "PgEnum", name: "Mood" },
          },
          {
            id: uuid(12),
            name: "blob",
            physicalName: "blob",
            type: "Raw",
            pgType: "tsvector",
          },
        ],
      }),
    })
    expect(block(code, "Log")).toMatchInlineSnapshot(`
      "export interface Log {
        id: string
        mood: "happy" | "sad" | null
        blob: unknown
      }"
    `)
    expect(code).not.toContain("interface Mood")
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("same logical name in two kinds keeps the module valid", async () => {
    const code = await emit({
      "project.meta.json": project(),
      "catalogs/Item/Item.meta.json": catalog("Item"),
      "documents/Item/Item.meta.json": document("Item", {
        physicalName: "item_doc",
      }),
    })
    expect(code).toContain("export interface Item {")
    expect(code).toContain("export interface DocumentItem {")
    expect(diagnosticsOf(code)).toEqual([])
  })

  it("deterministic", async () => {
    const entries = {
      "project.meta.json": project(),
      ...salesDocument(),
    }
    const reversed = Object.fromEntries(Object.entries(entries).reverse())
    expect(await emit(reversed)).toBe(await emit(entries))
  })
})
