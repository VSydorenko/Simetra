import { describe, it, expect } from "vitest"
import { KIND_REGISTRY, effectiveSearch } from "../kinds/registry"
import {
  catalogSchema,
  customTableSchema,
  documentSchema,
  enumerationSchema,
} from "../schemas"

const catalog = (input: Record<string, unknown> = {}) =>
  catalogSchema.parse({ kind: "Catalog", name: "Item", ...input })

describe("search schema", () => {
  it("is optional and accepts fields and mode on search kinds", () => {
    expect(catalog().search).toBeUndefined()
    const search = { fields: ["description"], mode: "startsWith" }
    expect(catalog({ search }).search).toEqual(search)
    expect(
      documentSchema.parse({ kind: "Document", name: "Doc", search }).search
    ).toEqual(search)
    expect(
      customTableSchema.parse({
        kind: "CustomTable",
        name: "T",
        columns: [{ name: "title", type: "Text" }],
        search,
      }).search
    ).toEqual(search)
  })

  it("rejects an unknown mode, an empty field name and extra keys", () => {
    expect(
      catalogSchema.safeParse({
        kind: "Catalog",
        name: "Item",
        search: { mode: "fuzzy" },
      }).success
    ).toBe(false)
    expect(
      catalogSchema.safeParse({
        kind: "Catalog",
        name: "Item",
        search: { fields: [""] },
      }).success
    ).toBe(false)
    expect(
      catalogSchema.safeParse({
        kind: "Catalog",
        name: "Item",
        search: { other: 1 },
      }).success
    ).toBe(false)
  })

  it("is not accepted on a kind without the search fact", () => {
    expect(KIND_REGISTRY.Enumeration.search).toBeUndefined()
    expect(
      enumerationSchema.safeParse({
        kind: "Enumeration",
        name: "E",
        search: {},
      }).success
    ).toBe(false)
  })
})

describe("effectiveSearch", () => {
  it("catalog defaults to the mainPresentation attribute, mode contains", () => {
    expect(effectiveSearch("Catalog", catalog())).toEqual({
      fields: ["description"],
      mode: "contains",
    })
    expect(
      effectiveSearch("Catalog", catalog({ mainPresentation: "Code" }))
    ).toEqual({ fields: ["code"], mode: "contains" })
  })

  it("drops a default field the catalog does not have", () => {
    expect(
      effectiveSearch("Catalog", catalog({ descriptionLength: 0 }))
    ).toBeUndefined()
    expect(
      effectiveSearch(
        "Catalog",
        catalog({ mainPresentation: "Code", codeLength: 0 })
      )
    ).toBeUndefined()
  })

  it("document defaults to the number", () => {
    const doc = documentSchema.parse({ kind: "Document", name: "Doc" })
    expect(effectiveSearch("Document", doc)).toEqual({
      fields: ["number"],
      mode: "contains",
    })
  })

  it("CustomTable has no defaults, only declared fields", () => {
    const table = (search?: unknown) =>
      customTableSchema.parse({
        kind: "CustomTable",
        name: "T",
        columns: [{ name: "title", type: "Text" }],
        ...(search === undefined ? {} : { search }),
      })
    expect(effectiveSearch("CustomTable", table())).toBeUndefined()
    expect(
      effectiveSearch(
        "CustomTable",
        table({ fields: ["title"], mode: "startsWith" })
      )
    ).toEqual({ fields: ["title"], mode: "startsWith" })
  })

  it("declared fields replace the defaults; mode alone keeps them", () => {
    expect(
      effectiveSearch("Catalog", catalog({ search: { fields: ["code"] } }))
    ).toEqual({ fields: ["code"], mode: "contains" })
    expect(
      effectiveSearch("Catalog", catalog({ search: { mode: "startsWith" } }))
    ).toEqual({ fields: ["description"], mode: "startsWith" })
  })

  it("is undefined for a kind without the search fact", () => {
    expect(effectiveSearch("Enumeration", {})).toBeUndefined()
  })
})
