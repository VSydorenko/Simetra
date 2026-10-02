import { describe, expect, it } from "vitest"
import { KIND_REGISTRY, namedCollections, projectSchema } from "simetra/model"

describe("namedCollections", () => {
  it("agrees with the kind registry", () => {
    // Схема й реєстр описують ті самі колекції двома шляхами: розбіжність
    // означала б, що операції й `fix` бачать різні іменовані елементи.
    for (const def of Object.values(KIND_REGISTRY)) {
      const expected = [
        ...def.columnFields,
        ...(def.tabularSectionColumns === undefined ? [] : ["tabularSections"]),
        ...(def.valueElements ? ["values"] : []),
        ...(def.namedElementFields ?? []),
      ].sort()
      expect([...namedCollections(def.schema).keys()].sort(), def.kind).toEqual(
        expected
      )
    }
  })

  it("finds nested and project collections", () => {
    const sections = namedCollections(KIND_REGISTRY.Document.schema).get(
      "tabularSections"
    )!
    expect([...namedCollections(sections).keys()]).toEqual(["attributes"])
    expect([...namedCollections(projectSchema).keys()]).toEqual(["scopeKinds"])
  })
})
