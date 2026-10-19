import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { formatMetaFile, formatProjectFile, KIND_REGISTRY } from "simetra/model"
import { readReferenceDomain } from "../../compiler/__tests__/fixtures/reference-domain"

/**
 * Синтетичний референсний домен (спека П2 §10.1) — публічний зразок
 * застосунку й основа паперового тесту та референсного host П4. Тут — його
 * статичні гарантії; розгортання в Postgres — `reference-domain.db.test.ts`.
 */

describe("reference domain", () => {
  it("compiles without diagnostics", async () => {
    const result = await compile(readReferenceDomain())
    // Жодної діагностики, зокрема попереджень: зразок не вчить поганого.
    expect(result.diagnostics).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("files are in canonical form", () => {
    const metaFiles = [...readReferenceDomain()].filter(([path]) =>
      path.endsWith(".meta.json")
    )
    expect(metaFiles.length).toBeGreaterThan(1)
    for (const [path, text] of metaFiles) {
      const data = JSON.parse(text) as Record<string, unknown>
      const canonical =
        path === "project.meta.json"
          ? formatProjectFile(data)
          : formatMetaFile(data)
      expect(text, path).toBe(canonical)
    }
  })

  it("covers every kind", async () => {
    const { model } = await compile(readReferenceDomain())
    const kinds = new Set(model!.objects.map((object) => object.kind))
    // PgEnum свідомо поза доменом: енам-тип Postgres — форма прийнятої схеми,
    // а новий застосунок бере перерахування (спека П2 §4). Ролі й набори прав
    // приходять у приклади з переходом прикладів (план Права-2).
    expect([...kinds].sort()).toEqual(
      Object.values(KIND_REGISTRY)
        .filter((def) => def.kind !== "PgEnum" && !def.rightsDeclaration)
        .map((def) => def.kind)
        .sort()
    )
  })
})
