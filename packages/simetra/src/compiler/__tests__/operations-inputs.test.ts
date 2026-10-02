import { describe, expect, it } from "vitest"
import { addElementInput, renameInput } from "simetra/compiler"
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
