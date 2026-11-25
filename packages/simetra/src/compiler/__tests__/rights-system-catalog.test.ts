import { describe, expect, it } from "vitest"
import { buildRuntimeCatalog } from "simetra/compiler"
import { KIND_REGISTRY } from "simetra/model"
import { compileRights, withRoles } from "./fixtures/rights"

describe("rights system catalog fact of the runtime catalog", () => {
  it("is the registry rightsSystem: every operation context is administerRights exactly for those objects", async () => {
    const result = await compileRights(withRoles())
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const model = result.model!
    const catalog = buildRuntimeCatalog(model)
    let system = 0
    for (const entry of catalog.objects) {
      const source = model.objects.find((o) => o.id === entry.id)!
      const contexts = Object.values(entry.operations ?? {}).map(
        (op) => op.context
      )
      const byRegistry =
        KIND_REGISTRY[source.kind].rightsSystem?.(source.data) !== undefined
      const byContexts =
        contexts.length > 0 && contexts.every((c) => c === "administerRights")
      // Запобіжник агента читає лише контекст каталогу рантайму; цей збіг
      // не дає йому розійтися з реєстром видів
      expect(byContexts, entry.name).toBe(byRegistry)
      // Жоден об'єкт не змішує контексти: запобіжник судить об'єкт цілим
      expect(
        contexts.some((c) => c === "administerRights") === byContexts,
        entry.name
      ).toBe(true)
      if (byRegistry) system++
    }
    expect(system).toBeGreaterThan(0)
  })
})
