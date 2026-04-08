import { describe, it, expect } from "vitest"
import { projectModelSchema, type ProjectModel } from "@simetra/core"
import {
  buildTypeEditorTree,
  buildTreeData,
} from "../components/layout/tree/tree-builder"

// --- Хелпери ---

function createEmptyModel(): ProjectModel {
  return projectModelSchema.parse({ project: { name: "Test" } })
}

function createModelWith2Catalogs(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "Test" },
    catalogs: [
      {
        kind: "Catalog",
        name: "Products",
        codeLength: 9,
        codeType: "String",
        descriptionLength: 100,
        hierarchyType: "None",
        attributes: [],
        tabularSections: [],
      },
      {
        kind: "Catalog",
        name: "Partners",
        codeLength: 9,
        codeType: "String",
        descriptionLength: 100,
        hierarchyType: "None",
        attributes: [],
        tabularSections: [],
      },
    ],
    documents: [
      {
        kind: "Document",
        name: "SalesOrder",
        numberLength: 11,
        numberType: "String",
        attributes: [],
        tabularSections: [],
      },
    ],
    enumerations: [
      {
        kind: "Enumeration",
        name: "PriceTypes",
        values: [{ name: "Retail" }, { name: "Wholesale" }],
      },
    ],
  })
}

// --- buildTypeEditorTree ---

describe("buildTypeEditorTree", () => {
  it("повертає всі 9 примітивних типів (без Ref)", () => {
    const model = createEmptyModel()
    const tree = buildTypeEditorTree(model, "")
    const primitives = tree.filter((n) => n.nodeType === "primitiveType")
    expect(primitives).toHaveLength(9)
    const names = primitives.map((n) => n.name)
    expect(names).toEqual([
      "UUID",
      "String",
      "Text",
      "Integer",
      "Numeric",
      "Boolean",
      "Date",
      "DateTime",
      "Binary",
    ])
  })

  it("примітивні типи мають fieldTypeValue і selectable", () => {
    const model = createEmptyModel()
    const tree = buildTypeEditorTree(model, "")
    const primitives = tree.filter((n) => n.nodeType === "primitiveType")
    for (const p of primitives) {
      expect(p.fieldTypeValue).toBe(p.name)
      expect(p.selectable).toBe(true)
    }
  })

  it("reference kinds = тільки Catalog, Document, Enumeration", () => {
    const model = createEmptyModel()
    const tree = buildTypeEditorTree(model, "")
    const groups = tree.filter((n) => n.nodeType === "refKindGroup")
    const kinds = groups.map((g) => g.kind)
    expect(kinds).toEqual(["Catalog", "Document", "Enumeration"])
  })

  it("refKindGroup має selectable: false", () => {
    const model = createEmptyModel()
    const tree = buildTypeEditorTree(model, "")
    const groups = tree.filter((n) => n.nodeType === "refKindGroup")
    for (const g of groups) {
      expect(g.selectable).toBe(false)
    }
  })

  it("обʼєкти з model стають ref targets під відповідним kind group", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTypeEditorTree(model, "")
    const catalogGroup = tree.find(
      (n) => n.nodeType === "refKindGroup" && n.kind === "Catalog"
    )
    expect(catalogGroup).toBeDefined()
    expect(catalogGroup!.children).toHaveLength(2)
    expect(catalogGroup!.children!.map((c) => c.name)).toEqual([
      "Products",
      "Partners",
    ])
  })

  it("ref target має fieldTypeValue: Ref і refTarget з kind та name", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTypeEditorTree(model, "")
    const catalogGroup = tree.find(
      (n) => n.nodeType === "refKindGroup" && n.kind === "Catalog"
    )!
    const target = catalogGroup.children![0]
    expect(target.nodeType).toBe("refTarget")
    expect(target.fieldTypeValue).toBe("Ref")
    expect(target.refTarget).toEqual({ kind: "Catalog", name: "Products" })
    expect(target.selectable).toBe(true)
  })

  it("пошук фільтрує примітивні типи по name", () => {
    const model = createEmptyModel()
    const tree = buildTypeEditorTree(model, "bool")
    const primitives = tree.filter((n) => n.nodeType === "primitiveType")
    expect(primitives).toHaveLength(1)
    expect(primitives[0].name).toBe("Boolean")
  })

  it("пошук фільтрує ref targets по name", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTypeEditorTree(model, "partner")
    const catalogGroup = tree.find(
      (n) => n.nodeType === "refKindGroup" && n.kind === "Catalog"
    )
    expect(catalogGroup).toBeDefined()
    expect(catalogGroup!.children).toHaveLength(1)
    expect(catalogGroup!.children![0].name).toBe("Partners")
  })

  it("при збігу по kind name — показує всі targets під ним", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTypeEditorTree(model, "catalog")
    const catalogGroup = tree.find(
      (n) => n.nodeType === "refKindGroup" && n.kind === "Catalog"
    )
    expect(catalogGroup).toBeDefined()
    // Збіг по kind — показати всі дочірні
    expect(catalogGroup!.children).toHaveLength(2)
  })

  it("пошук ховає kind group, коли немає збігу", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTypeEditorTree(model, "xyz_nonexistent")
    const primitives = tree.filter((n) => n.nodeType === "primitiveType")
    const groups = tree.filter((n) => n.nodeType === "refKindGroup")
    expect(primitives).toHaveLength(0)
    expect(groups).toHaveLength(0)
  })

  it("локалізований пошук примітивів через getLabel", () => {
    const model = createEmptyModel()
    const labels: Record<string, string> = {
      "fieldType.Boolean": "Булево",
      "fieldType.String": "Рядок",
    }
    const getLabel = (key: string) => labels[key] ?? key
    const tree = buildTypeEditorTree(model, "булев", getLabel)
    const primitives = tree.filter((n) => n.nodeType === "primitiveType")
    expect(primitives).toHaveLength(1)
    expect(primitives[0].name).toBe("Boolean")
  })

  it("локалізований пошук по kind label розкриває всі targets", () => {
    const model = createModelWith2Catalogs()
    const labels: Record<string, string> = {
      "metadata.kind.Catalog": "Довідник",
    }
    const getLabel = (key: string) => labels[key] ?? key
    const tree = buildTypeEditorTree(model, "довідн", getLabel)
    const catalogGroup = tree.find(
      (n) => n.nodeType === "refKindGroup" && n.kind === "Catalog"
    )
    expect(catalogGroup).toBeDefined()
    expect(catalogGroup!.children).toHaveLength(2)
  })

  it("без getLabel пошук по локалізованому тексту не знаходить", () => {
    const model = createEmptyModel()
    const tree = buildTypeEditorTree(model, "булев")
    const primitives = tree.filter((n) => n.nodeType === "primitiveType")
    expect(primitives).toHaveLength(0)
  })

  it("порожня модель — kind groups мають порожні children", () => {
    const model = createEmptyModel()
    const tree = buildTypeEditorTree(model, "")
    const groups = tree.filter((n) => n.nodeType === "refKindGroup")
    for (const g of groups) {
      expect(g.children).toHaveLength(0)
    }
  })

  it("allowedKinds обмежує kinds у дереві", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTypeEditorTree(model, "", undefined, {
      allowedKinds: ["AccumulationRegister", "InformationRegister"],
    })
    const groups = tree.filter((n) => n.nodeType === "refKindGroup")
    const kinds = groups.map((g) => g.kind)
    expect(kinds).toEqual(["AccumulationRegister", "InformationRegister"])
    // Не має Catalog, Document, Enumeration
    expect(kinds).not.toContain("Catalog")
    expect(kinds).not.toContain("Document")
  })

  it("includePrimitives=false приховує примітивні типи", () => {
    const model = createEmptyModel()
    const tree = buildTypeEditorTree(model, "", undefined, {
      includePrimitives: false,
    })
    const primitives = tree.filter((n) => n.nodeType === "primitiveType")
    expect(primitives).toHaveLength(0)
  })

  it("allowedKinds + includePrimitives=false — тільки зазначені ref groups", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTypeEditorTree(model, "", undefined, {
      allowedKinds: ["Catalog"],
      includePrimitives: false,
    })
    expect(tree).toHaveLength(1)
    expect(tree[0].kind).toBe("Catalog")
    expect(tree[0].children).toHaveLength(2)
  })
})

// --- buildTreeData (sidebar) regression ---

describe("buildTreeData sidebar regression", () => {
  it("повертає масив kind секцій з правильною структурою", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTreeData(model, "")

    expect(tree).toHaveLength(7)
    expect(tree[0].nodeType).toBe("kind")
    expect(tree[0].kind).toBe("Catalog")
    expect(tree[0].children).toHaveLength(2)
  })

  it("object nodes мають nodeType: object", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTreeData(model, "")
    const catalogSection = tree.find((n) => n.kind === "Catalog")!
    for (const obj of catalogSection.children!) {
      expect(obj.nodeType).toBe("object")
    }
  })

  it("пошук фільтрує обʼєкти по імені", () => {
    const model = createModelWith2Catalogs()
    const tree = buildTreeData(model, "Products")
    const catalogSection = tree.find((n) => n.kind === "Catalog")!
    expect(catalogSection.children).toHaveLength(1)
    expect(catalogSection.children![0].name).toBe("Products")
  })

  it("field nodes мають fieldType і fieldTypeDisplay", () => {
    const model = projectModelSchema.parse({
      project: { name: "Test" },
      catalogs: [
        {
          kind: "Catalog",
          name: "Products",
          codeLength: 9,
          codeType: "String",
          descriptionLength: 100,
          hierarchyType: "None",
          attributes: [
            { name: "price", type: "Numeric", precision: 10, scale: 2 },
            {
              name: "category",
              type: "Ref",
              ref: { kind: "Catalog", name: "Products" },
            },
          ],
          tabularSections: [],
        },
      ],
    })
    const tree = buildTreeData(model, "")
    const catalogSection = tree.find((n) => n.kind === "Catalog")!
    const obj = catalogSection.children![0]
    const attrGroup = obj.children?.find((g) => g.groupKey === "attributes")
    expect(attrGroup).toBeDefined()
    expect(attrGroup!.children).toHaveLength(2)

    const priceField = attrGroup!.children![0]
    expect(priceField.fieldType).toBe("Numeric")
    expect(priceField.fieldTypeDisplay).toBe("Numeric")

    const catField = attrGroup!.children![1]
    expect(catField.fieldType).toBe("Ref")
    expect(catField.fieldTypeDisplay).toBe("CatalogRef.Products")
  })
})
