import { describe, expect, it } from "vitest"
import { compile, type Diagnostic } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  project,
} from "./helpers"

function codes(diagnostics: Diagnostic[]): string[] {
  return diagnostics.map((d) => d.code)
}

describe("stage 1: files", () => {
  it("empty map reports project.missing", () => {
    const result = compile(new Map())
    expect(result.ok).toBe(false)
    expect(result.model).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "project.missing",
        severity: "error",
        file: "project.meta.json",
        pointer: "",
      }),
    ])
  })

  it("valid minimal project compiles with ok true and no diagnostics", () => {
    const contract = catalog("Contract")
    const order = document("SalesOrder")
    const table = customTable("AuditLog")
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": contract,
        "catalogs/Contract/Contract.module.ts": "export {}",
        "documents/SalesOrder/SalesOrder.meta.json": order,
        "custom-tables/AuditLog/AuditLog.meta.json": table,
        "custom-tables/AuditLog/AuditLog.sql": "select 1;",
      })
    )
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
    const model = result.model!
    expect(model.project.name).toBe("TestApp")
    // Порядок: METADATA_KINDS, далі ім'я.
    expect(model.objects.map((o) => [o.kind, o.name, o.id])).toEqual([
      ["Catalog", "Contract", contract.id],
      ["Document", "SalesOrder", order.id],
      ["CustomTable", "AuditLog", table.id],
    ])
    expect(model.moduleFiles).toEqual([
      {
        file: "catalogs/Contract/Contract.module.ts",
        ownerObjectId: contract.id,
      },
    ])
    expect(model.sqlFiles).toEqual([
      { file: "custom-tables/AuditLog/AuditLog.sql", ownerObjectId: table.id },
    ])
    expect(model.physical.tables.map((t) => `${t.schema}.${t.name}`)).toEqual([
      "public.audit_log",
      "public.contract",
      "public.sales_order",
    ])
  })

  it("kind mismatch", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": document("Contract"),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.kind-mismatch",
        file: "catalogs/Contract/Contract.meta.json",
        pointer: "/kind",
      }),
    ])
  })

  it("folder and file name must equal logical name", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/contract/contract.meta.json": catalog("Contract"),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.name-mismatch",
        file: "catalogs/contract/contract.meta.json",
        pointer: "/name",
      }),
    ])
  })

  it("unknown path", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract"),
        "catalogs/Contract/notes.txt": "notes",
        "foo.json": "{}",
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.unknown-path",
        file: "catalogs/Contract/notes.txt",
        pointer: "",
      }),
      expect.objectContaining({
        code: "file.unknown-path",
        file: "foo.json",
        pointer: "",
      }),
    ])
  })

  it("orphan sql", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.sql": "select 1;",
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.orphan",
        file: "catalogs/Contract/Contract.sql",
      }),
    ])
  })

  it("shared sql is registered", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "sql/public/scope_sets.sql": "select 1;",
      })
    )
    expect(result.ok).toBe(true)
    expect(result.model!.sqlFiles).toEqual([
      { file: "sql/public/scope_sets.sql", schema: "public" },
    ])
  })

  it("invalid json", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": "{ not json",
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.invalid-json",
        file: "catalogs/Contract/Contract.meta.json",
        pointer: "",
      }),
    ])
  })

  it("schema rule code survives mapping", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          attributes: [attribute("note", { type: "String" })],
        }),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "type.length-required",
        pointer: "/attributes/0/length",
        message: expect.any(String),
      }),
    ])
  })

  it("zod issue without own rule maps to file.schema with zod text", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          codeLength: "nine",
        }),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "file.schema", pointer: "/codeLength" }),
    ])
    expect(result.diagnostics[0]!.message.length).toBeGreaterThan(0)
  })

  it("malformed reference points at the ref field, not the whole file", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": catalog("Contract", {
          attributes: [
            attribute("party", {
              type: "Ref",
              ref: { kind: "Foo", name: "X" },
            }),
          ],
        }),
        "catalogs/Order/Order.meta.json": catalog("Order", {
          attributes: [
            attribute("currency", {
              type: "Ref",
              ref: { kind: "Catalog", name: "currency" },
            }),
          ],
        }),
      })
    )
    expect(result.diagnostics.map((d) => [d.code, d.file, d.pointer])).toEqual([
      [
        "file.schema",
        "catalogs/Contract/Contract.meta.json",
        "/attributes/0/ref/kind",
      ],
      [
        "file.schema",
        "catalogs/Order/Order.meta.json",
        "/attributes/0/ref/name",
      ],
    ])
  })

  it("all diagnostics of stages 1-2 are returned", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": "{",
        "documents/Order/Order.meta.json": catalog("Order"),
      })
    )
    expect(codes(result.diagnostics)).toEqual([
      "file.invalid-json",
      "file.kind-mismatch",
    ])
    expect(result.diagnostics.map((d) => d.file)).toEqual([
      "catalogs/Contract/Contract.meta.json",
      "documents/Order/Order.meta.json",
    ])
  })

  it("output does not depend on map insertion order", () => {
    const entries = {
      "project.meta.json": project(),
      "catalogs/B/B.meta.json": catalog("B", { id: undefined }),
      "catalogs/A/A.meta.json": "{",
      "zzz.txt": "",
      "catalogs/C/C.meta.json": catalog("C"),
    }
    const forward = compile(metaFiles(entries))
    const backward = compile(new Map([...metaFiles(entries)].reverse()))
    expect(backward).toEqual(forward)
  })
})
