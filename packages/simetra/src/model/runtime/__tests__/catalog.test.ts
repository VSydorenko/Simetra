import { describe, expect, it } from "vitest"
import { runtimeCatalogSchema, runtimeSectionSchema } from "../catalog"

describe("runtimeCatalogSchema", () => {
  it("accepts an object without the operations field", () => {
    // Об'єкт без команд (лише читання) не мусить нести порожній запис.
    const parsed = runtimeCatalogSchema.parse({
      format: 1,
      snapshotHash: "hash-1",
      provider: "supabase",
      objects: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          name: "Report",
          kind: "Catalog",
          kindLabel: "report",
          table: { schema: "public", name: "report" },
          key: "id",
          keyName: "ref",
          versionColumn: "version",
          versionName: "version",
          attributes: [],
          tabularSections: [],
          constraints: [],
        },
      ],
    })
    expect(parsed.objects[0]!.operations).toBeUndefined()
  })
})

describe("runtimeSectionSchema", () => {
  const parentKey = {
    name: "lines_org_id_parent_id_fkey",
    kind: "foreignKey",
    columns: ["org_id", "parent_id"],
    references: ["org_id", "id"],
  }
  const section = {
    name: "lines",
    table: { schema: "public", name: "report_lines" },
    key: "id",
    keyName: "ref",
    parent: "parent_id",
    parentName: "parent",
    lineNumber: "line_number",
    lineNumberName: "lineNumber",
    parentConstraint: parentKey.name,
    attributes: [],
    constraints: [parentKey],
  }

  // Будівник корелює ТЧ з власником за всіма колонками FK власника: без
  // `references` чи з чужим іменем кореляції не з чого побудувати.
  it.each([
    ["a parent foreign key with its references", true, section],
    ["no parentConstraint", false, { ...section, parentConstraint: undefined }],
    [
      "a parentConstraint naming no constraint",
      false,
      { ...section, parentConstraint: "missing_fkey" },
    ],
    [
      "a parentConstraint naming a unique",
      false,
      {
        ...section,
        constraints: [{ ...parentKey, kind: "unique", references: undefined }],
      },
    ],
    [
      "a parent foreign key without references",
      false,
      { ...section, constraints: [{ ...parentKey, references: undefined }] },
    ],
    [
      "references on a non-foreign-key constraint",
      false,
      {
        ...section,
        constraints: [
          parentKey,
          {
            name: "lines_pkey",
            kind: "primaryKey",
            columns: ["id"],
            references: ["id"],
          },
        ],
      },
    ],
    [
      "references not matching the columns",
      false,
      { ...section, constraints: [{ ...parentKey, references: ["id"] }] },
    ],
  ])("parses %s as %s", (_, ok, input) => {
    expect(runtimeSectionSchema.safeParse(input).success).toBe(ok)
  })
})
