import { describe, expect, it } from "vitest"
import { compile, type CompileResult } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  document,
  metaFiles,
  project,
  uuid,
} from "./helpers"

function codes(result: CompileResult) {
  return result.diagnostics.map((d) => [d.code, d.file, d.pointer])
}

function withoutLabel(data: Record<string, unknown>) {
  const copy = { ...data }
  delete copy.kindLabel
  return copy
}

const uuidKey = {
  primaryKey: { name: "t_pk", columns: ["id"] },
}

describe("stage 2: kind label", () => {
  it("a catalog without kindLabel is an identity error", async () => {
    const bare = withoutLabel(catalog("Contract"))
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Contract/Contract.meta.json": bare,
      })
    )
    expect(codes(result)).toEqual([
      [
        "identity.kind-label-missing",
        "catalogs/Contract/Contract.meta.json",
        "/kindLabel",
      ],
    ])
    expect(result.diagnostics[0]!.hint).toContain("simetra fix")
  })

  it("labels are unique across the project, not the schema", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/A/A.meta.json": catalog("A", { kindLabel: "same" }),
        "documents/B/B.meta.json": document("B", {
          schema: "other",
          kindLabel: "same",
        }),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.kind-label-duplicate",
        file: "documents/B/B.meta.json",
        pointer: "/kindLabel",
        params: expect.objectContaining({
          label: "same",
          firstFile: "catalogs/A/A.meta.json",
        }),
      }),
    ])
  })

  it("a new custom table without a uuid key keeps its label with a warning", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "custom-tables/T/T.meta.json": customTable("T", { kindLabel: "t" }),
      })
    )
    expect(codes(result)).toEqual([
      [
        "identity.kind-label-retained",
        "custom-tables/T/T.meta.json",
        "/kindLabel",
      ],
    ])
    expect(result.diagnostics[0]!.severity).toBe("warning")
    expect(result.ok).toBe(true)
  })

  it("a table that lost its uuid key keeps the label: a warning, not a change", async () => {
    const before = customTable("T", { id: uuid(1), ...uuidKey })
    const after = { ...before }
    delete (after as Record<string, unknown>).primaryKey
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "custom-tables/T/T.meta.json": after,
      }),
      {
        baseline: metaFiles({
          "project.meta.json": project(),
          "custom-tables/T/T.meta.json": before,
        }),
      }
    )
    expect(before.kindLabel).toBe("t")
    expect(codes(result)).toEqual([
      [
        "identity.kind-label-retained",
        "custom-tables/T/T.meta.json",
        "/kindLabel",
      ],
    ])
    expect(result.ok).toBe(true)
  })

  it("a polymorphic reference to a table with a retained label is an error", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "custom-tables/T/T.meta.json": customTable("T", { kindLabel: "t" }),
        "catalogs/Holder/Holder.meta.json": catalog("Holder", {
          attributes: [
            attribute("target", {
              type: "Ref",
              allowedTypes: [
                { kind: "CustomTable", name: "T" },
                { kind: "Catalog", name: "Holder" },
              ],
            }),
          ],
        }),
      })
    )
    expect(result.ok).toBe(false)
    expect(
      result.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => d.code)
    ).toEqual(["reference.custom-table-key"])
  })

  it("removing a retained label is an assigned-once change", async () => {
    const before = customTable("T", { id: uuid(1), kindLabel: "t" })
    const after = withoutLabel(before)
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "custom-tables/T/T.meta.json": after,
      }),
      {
        baseline: metaFiles({
          "project.meta.json": project(),
          "custom-tables/T/T.meta.json": before,
        }),
      }
    )
    expect(codes(result)).toEqual([
      [
        "identity.assigned-once-changed",
        "custom-tables/T/T.meta.json",
        "/kindLabel",
      ],
    ])
  })

  it("a custom table with a single uuid key needs a label", async () => {
    const bare = withoutLabel(customTable("T", uuidKey))
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "custom-tables/T/T.meta.json": bare,
      })
    )
    expect(codes(result)).toEqual([
      [
        "identity.kind-label-missing",
        "custom-tables/T/T.meta.json",
        "/kindLabel",
      ],
    ])
  })

  it("a labelled custom table with a single uuid key compiles", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "custom-tables/T/T.meta.json": customTable("T", uuidKey),
      })
    )
    expect(result.diagnostics).toEqual([])
  })
})
