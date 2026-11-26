import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { isObjectTable } from "simetra/model"
import { contentColumns } from "../mechanics-units"
import { commandWriteColumns } from "../rights/command-columns"
import { catalog, metaFiles, project, uuid } from "./helpers"

const ORG_FILE = "catalogs/Organization/Organization.meta.json"
const FILE_FILE = "catalogs/Attachment/Attachment.meta.json"
const storage = { maxBytes: 1024, mediaTypes: ["image/png"] }

function files(overrides: Record<string, unknown> = {}) {
  return {
    "project.meta.json": project({
      defaultSchema: "app",
      scopeKinds: [
        {
          id: uuid(80),
          name: "org",
          physicalName: "org_id",
          root: { object: { kind: "Catalog", name: "Organization" } },
          setFunction: { name: "org_set" },
        },
      ],
    }),
    [ORG_FILE]: catalog("Organization", { scope: "org" }),
    [FILE_FILE]: catalog("Attachment", { scope: "none", storage }),
    ...overrides,
  }
}

describe("catalog storage in the compiler", () => {
  it("lays file columns into the table; size and type stay out of command and content columns", async () => {
    const result = await compile(metaFiles(files()))
    const table = result.model?.physical.tables
      .filter(isObjectTable)
      .find((t) => t.name === "attachment")
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(table).toBeDefined()
    const names = table!.columns.map((c) => c.name)
    expect(names).toEqual(
      expect.arrayContaining(["file_name", "file_size", "file_content_type"])
    )
    const { base, update } = commandWriteColumns(table!, {
      attributeCase: "camelCase",
      main: true,
      users: false,
      fixed: undefined,
    })
    for (const list of [base, update].map((l) => l.map((c) => c.name))) {
      expect(list).toContain("file_name")
      expect(list).not.toContain("file_size")
      expect(list).not.toContain("file_content_type")
    }
    const content = contentColumns(table!, "camelCase").map((c) => c.name)
    expect(content).toContain("file_name")
    expect(content).not.toContain("file_size")
    expect(content).not.toContain("file_content_type")
  })

  it("rejects storage on the root of a scope kind", async () => {
    const result = await compile(
      metaFiles(
        files({
          [ORG_FILE]: catalog("Organization", { scope: "org", storage }),
        })
      )
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "storage.incompatible")
        .map((d) => [d.file, d.pointer])
    ).toEqual([[ORG_FILE, "/storage"]])
  })

  it("reports a schema conflict with the setting's pointer", async () => {
    const result = await compile(
      metaFiles(
        files({
          [FILE_FILE]: catalog("Attachment", {
            scope: "none",
            storage,
            hierarchyType: "FoldersAndItems",
          }),
        })
      )
    )
    expect(
      result.diagnostics
        .filter((d) => d.code === "storage.incompatible")
        .map((d) => [d.file, d.pointer])
    ).toEqual([[FILE_FILE, "/hierarchyType"]])
  })
})
