import { describe, expect, it } from "vitest"
import { addElementInput, promoteInput, renameInput } from "simetra/compiler"
import { metadataKindSchema } from "simetra/model"

const pathOf = (r: {
  success: boolean
  error?: { issues: { path: PropertyKey[] }[] }
}) => r.error?.issues[0]?.path

describe("mutation target schemas", () => {
  it("an unknown kind points at target.kind", () => {
    const bad = { kind: "Nope", name: "X" }
    expect(
      pathOf(renameInput.safeParse({ target: bad, newName: "Y" }))
    ).toEqual(["target", "kind"])
    expect(
      pathOf(
        addElementInput.safeParse({ target: bad, collection: "a", element: {} })
      )
    ).toEqual(["target", "kind"])
  })

  it("Project without element points at target.element", () => {
    const r = renameInput.safeParse({
      target: { kind: "Project" },
      newName: "Y",
    })
    expect(pathOf(r)).toEqual(["target", "element"])
  })

  it("an object kind without name points at target.name", () => {
    const r = renameInput.safeParse({
      target: { kind: "Catalog" },
      newName: "Y",
    })
    expect(pathOf(r)).toEqual(["target", "name"])
  })

  it("metadataKindSchema does not contain Project", () => {
    // Інакше майбутній вид із цим ім'ям мовчки зламав би дискримінатор цілей.
    expect(metadataKindSchema.options as readonly string[]).not.toContain(
      "Project"
    )
  })
})

describe("promoteInput", () => {
  const base = {
    target: { name: "Counterparty" },
    into: { kind: "Catalog", name: "Counterparty" },
    columns: { id: { to: "standard", name: "ref" } },
  }

  it("refuses a foreign field", () => {
    expect(pathOf(promoteInput.safeParse({ ...base, extra: 1 }))).toEqual([])
    expect(
      pathOf(
        promoteInput.safeParse({
          ...base,
          columns: { id: { to: "standard", name: "ref", extra: 1 } },
        })
      )
    ).toEqual(["columns", "id"])
  })

  it("keys columns by logical column names", () => {
    expect(
      promoteInput.safeParse({
        ...base,
        columns: { "not a name": { to: "retire" } },
      }).success
    ).toBe(false)
    expect(
      promoteInput.safeParse({
        ...base,
        columns: { createdAt: { to: "retire" } },
      }).success
    ).toBe(true)
  })

  it("defaults an attribute mapping to the attributes collection", () => {
    const parsed = promoteInput.parse({
      ...base,
      columns: { inn: { to: "attribute", element: { name: "taxId" } } },
    })
    expect(parsed.columns.inn).toEqual({
      to: "attribute",
      collection: "attributes",
      element: { name: "taxId" },
    })
    expect(parsed).toMatchObject({
      tabularSections: [],
      fill: [],
      conversions: {},
      sharedFunctions: [],
      consumerLabels: [],
    })
  })

  it("requires an element name and refuses a physical name", () => {
    const attribute = (element: Record<string, unknown>) =>
      promoteInput.safeParse({
        ...base,
        columns: { inn: { to: "attribute", element } },
      })
    expect(pathOf(attribute({ type: "Text" }))).toEqual([
      "columns",
      "inn",
      "element",
      "name",
    ])
    expect(pathOf(attribute({ name: "taxId", physicalName: "x" }))).toEqual([
      "columns",
      "inn",
      "element",
      "physicalName",
    ])
  })

  it("accepts only the supported conversion classes", () => {
    expect(
      pathOf(
        promoteInput.safeParse({
          ...base,
          conversions: { "Counterparty#uniques/0": "dropped" },
        })
      )
    ).toEqual(["conversions", "Counterparty#uniques/0"])
  })
})
