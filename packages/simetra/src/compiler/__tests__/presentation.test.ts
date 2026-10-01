import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { catalog, document, metaFiles, project, uuid } from "./helpers"

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
    expect(presentation.objects).toEqual([
      {
        objectId: A,
        mainPresentation: "Code",
        standardAttributes: {
          deletionMark: { description: { uk: "Позначка", en: "Mark" } },
        },
      },
    ])
  })

  it("section overrides appear only for sections that have them", async () => {
    const S1 = uuid(701)
    const S2 = uuid(702)
    const { presentation } = await compiled({
      "project.meta.json": project(),
      "catalogs/A/A.meta.json": catalog("A", {
        id: A,
        tabularSections: [
          {
            id: S1,
            name: "rows",
            physicalName: "rows",
            standardAttributeOverrides: {
              lineNumber: { description: { en: "No." } },
            },
          },
          { id: S2, name: "plain", physicalName: "plain" },
        ],
      }),
    })
    expect(presentation.objects).toEqual([
      {
        objectId: A,
        mainPresentation: "Description",
        standardAttributes: {},
        sections: [
          {
            sectionId: S1,
            standardAttributes: { lineNumber: { description: { en: "No." } } },
          },
        ],
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
    const block = model.presentation.objects.find((p) => p.objectId === A)!
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
    expect(presentation.objects).toEqual([])
  })

  it("deterministic order", async () => {
    // Порядок шляхів (Alpha, Zeta) протилежний порядку id (Zeta менший):
    // без сортування за id блоки йшли б за шляхом.
    const entries = {
      "project.meta.json": project(),
      "catalogs/Alpha/Alpha.meta.json": catalog("Alpha", {
        id: B,
        mainPresentation: "Code",
      }),
      "catalogs/Zeta/Zeta.meta.json": catalog("Zeta", {
        id: A,
        mainPresentation: "Code",
        predefinedItems: [
          { id: E2, name: "x", description: { uk: "Б" } },
          { id: E1, name: "y", description: { uk: "А" } },
        ],
      }),
    }
    const { presentation } = await compiled(entries)
    expect(presentation.objects.map((p) => p.objectId)).toEqual([A, B])
    expect(presentation.objects[0]!.predefined!.map((p) => p.id)).toEqual([
      E2,
      E1,
    ])
  })

  it("carries the project default locale", async () => {
    const uk = await compiled({ "project.meta.json": project() })
    expect(uk.presentation).toEqual({ defaultLocale: "uk", objects: [] })
    const en = await compiled({
      "project.meta.json": project({ defaultLocale: "en" }),
    })
    expect(en.presentation.defaultLocale).toBe("en")
  })

  it("enumeration value titles are keyed by id, untitled values absent", async () => {
    const T = uuid(900)
    const entries = {
      "project.meta.json": project(),
      "enumerations/Status/Status.meta.json": {
        id: T,
        kind: "Enumeration",
        name: "Status",
        physicalName: "status",
        values: [
          {
            id: uuid(901),
            name: "Draft",
            physicalName: "draft",
            title: { uk: "Чернетка", en: "Draft" },
          },
          { id: uuid(902), name: "Plain", physicalName: "plain" },
          {
            id: uuid(903),
            name: "Done",
            physicalName: "done",
            title: { en: "Done" },
          },
        ],
      },
      "enumerations/Bare/Bare.meta.json": {
        id: uuid(910),
        kind: "Enumeration",
        name: "Bare",
        physicalName: "bare",
        values: [{ id: uuid(911), name: "One", physicalName: "one" }],
      },
    }
    const first = await compiled(entries)
    expect(first.presentation.objects).toEqual([
      {
        objectId: T,
        standardAttributes: {},
        values: [
          { id: uuid(901), title: { uk: "Чернетка", en: "Draft" } },
          { id: uuid(903), title: { en: "Done" } },
        ],
      },
    ])
    const second = await compiled(
      Object.fromEntries(Object.entries(entries).reverse())
    )
    expect(second.presentation).toEqual(first.presentation)
    expect(second.hash).toBe(first.hash)
  })
})
