import { describe, expect, it } from "vitest"
import { runtimeCatalogSchema } from "../catalog"

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
