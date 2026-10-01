import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { catalog, document, metaFiles, project } from "./helpers"

const A = "00000000-0000-4000-8000-000000000a01"
const B = "00000000-0000-4000-8000-000000000b02"
const E1 = "00000000-0000-4000-8000-0000000000e1"
const E2 = "00000000-0000-4000-8000-0000000000e2"
const E3 = "00000000-0000-4000-8000-0000000000e3"

async function compiled(entries: Record<string, unknown>) {
  const result = await compile(metaFiles(entries))
  expect(result.diagnostics).toEqual([])
  return result.model!
}

describe("presentation block", () => {
  it("presentation block carries overrides and main presentation", async () => {
    const { presentation } = await compiled({
      "project.meta.json": project(),
      "catalogs/A/A.meta.json": catalog("A", {
        id: A,
        mainPresentation: "Code",
        standardAttributeOverrides: {
          deletionMark: { description: { uk: "Позначка", en: "Mark" } },
        },
      }),
    })
    expect(presentation).toEqual([
      {
        objectId: A,
        mainPresentation: "Code",
        standardAttributes: {
          deletionMark: { description: { uk: "Позначка", en: "Mark" } },
        },
      },
    ])
  })

  it("predefined descriptions keyed by id", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      "catalogs/A/A.meta.json": catalog("A", {
        id: A,
        predefinedItems: [
          { id: E1, name: "first", description: { uk: "Перший" } },
          { id: E2, name: "plain" },
          { id: E3, name: "third", description: { en: "Third" } },
        ],
      }),
    })
    const block = model.presentation.find((p) => p.objectId === A)!
    expect(block.predefined).toEqual([
      { id: E1, description: { uk: "Перший" } },
      { id: E3, description: { en: "Third" } },
    ])
    const ids = model.contracts.predefined
      .find((p) => p.objectId === A)!
      .items.map((i) => i.id)
    for (const { id } of block.predefined!) expect(ids).toContain(id)
  })

  it("object without presentation fields has no block", async () => {
    const { presentation } = await compiled({
      "project.meta.json": project(),
      "documents/D/D.meta.json": document("D", {
        id: "00000000-0000-4000-8000-000000000d01",
      }),
    })
    expect(presentation).toEqual([])
  })

  it("deterministic order", async () => {
    const entries = {
      "project.meta.json": project(),
      "catalogs/B/B.meta.json": catalog("B", { id: B }),
      "catalogs/A/A.meta.json": catalog("A", {
        id: A,
        predefinedItems: [
          { id: E2, name: "x", description: { uk: "Б" } },
          { id: E1, name: "y", description: { uk: "А" } },
        ],
      }),
    }
    const { presentation } = await compiled(entries)
    expect(presentation.map((p) => p.objectId)).toEqual([A, B])
    expect(presentation[0]!.predefined!.map((p) => p.id)).toEqual([E2, E1])
  })
})
