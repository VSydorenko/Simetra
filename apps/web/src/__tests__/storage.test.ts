import { describe, it, expect } from "vitest"
import {
  projectModelSchema,
  type ProjectModel,
  toKebabCase,
  serializeToFiles,
} from "@simetra/core"

// --- toKebabCase ---

describe("toKebabCase", () => {
  it("converts simple PascalCase", () => {
    expect(toKebabCase("Products")).toBe("products")
  })

  it("converts multi-word PascalCase", () => {
    expect(toKebabCase("SalesOrder")).toBe("sales-order")
  })

  it("handles consecutive uppercase", () => {
    expect(toKebabCase("HTMLParser")).toBe("html-parser")
  })

  it("handles single word", () => {
    expect(toKebabCase("Item")).toBe("item")
  })

  it("handles already lowercase", () => {
    expect(toKebabCase("item")).toBe("item")
  })
})

// --- serializeToFiles ---

function createMinimalModel(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "TestProject" },
  })
}

function createModelWithObjects(): ProjectModel {
  return projectModelSchema.parse({
    project: { name: "TestProject" },
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
        name: "SalesOrder",
        codeLength: 9,
        codeType: "String",
        descriptionLength: 100,
        hierarchyType: "None",
        attributes: [],
        tabularSections: [],
      },
    ],
    constants: [
      {
        kind: "Constant",
        name: "CompanyName",
        valueType: "String",
      },
      {
        kind: "Constant",
        name: "MaxRetries",
        valueType: "Integer",
      },
    ],
  })
}

describe("serializeToFiles", () => {
  it("creates project.meta.json for empty project", () => {
    const model = createMinimalModel()
    const files = serializeToFiles(model)

    expect(files).toHaveLength(1)
    expect(files[0].path).toBe("project.meta.json")
    expect(files[0].content).toContain('"name": "TestProject"')
    expect(files[0].content.endsWith("\n")).toBe(true)
  })

  it("creates correct file structure for catalogs", () => {
    const model = createModelWithObjects()
    const files = serializeToFiles(model)

    const catalogFiles = files.filter((f) => f.path.startsWith("catalogs/"))
    expect(catalogFiles).toHaveLength(2)

    // Перевірка kebab-case шляхів
    expect(catalogFiles[0].path).toBe("catalogs/products/products.meta.json")
    expect(catalogFiles[1].path).toBe(
      "catalogs/sales-order/sales-order.meta.json"
    )
  })

  it("puts all constants in one file", () => {
    const model = createModelWithObjects()
    const files = serializeToFiles(model)

    const constantFiles = files.filter((f) => f.path.startsWith("constants/"))
    expect(constantFiles).toHaveLength(1)
    expect(constantFiles[0].path).toBe("constants/constants.meta.json")

    const parsed = JSON.parse(constantFiles[0].content)
    // Object wrapper format: { "$schema": "...", "constants": [...] }
    expect(parsed).toHaveProperty("$schema")
    expect(parsed).toHaveProperty("constants")
    expect(Array.isArray(parsed.constants)).toBe(true)
    expect(parsed.constants).toHaveLength(2)
    expect(parsed.constants[0].name).toBe("CompanyName")
    expect(parsed.constants[1].name).toBe("MaxRetries")
  })

  it("serializes with trailing newline", () => {
    const model = createModelWithObjects()
    const files = serializeToFiles(model)

    for (const file of files) {
      expect(file.content.endsWith("\n")).toBe(true)
    }
  })

  it("produces byte-identical output on repeated serialization", () => {
    const model = createModelWithObjects()
    const files1 = serializeToFiles(model)
    const files2 = serializeToFiles(model)

    expect(files1).toEqual(files2)
  })
})

// --- Roundtrip: serialize → parse → serialize ---

describe("roundtrip serialization", () => {
  it("empty project survives roundtrip", () => {
    const model = createMinimalModel()
    const files = serializeToFiles(model)

    // Імітуємо "відкриття": парсимо JSON назад
    const projectJson = JSON.parse(files[0].content)
    const rebuilt = projectModelSchema.parse({ project: projectJson })

    // Серіалізуємо знову
    const files2 = serializeToFiles(rebuilt)
    expect(files2).toEqual(files)
  })

  it("project with objects survives roundtrip", () => {
    const model = createModelWithObjects()
    const files = serializeToFiles(model)

    // Відтворюємо модель із файлів
    const projectJson = JSON.parse(
      files.find((f) => f.path === "project.meta.json")!.content
    )

    const catalogs = files
      .filter((f) => f.path.startsWith("catalogs/"))
      .map((f) => JSON.parse(f.content))

    const constantsFile = files.find(
      (f) => f.path === "constants/constants.meta.json"
    )
    const constantsData = constantsFile
      ? JSON.parse(constantsFile.content)
      : { constants: [] }
    // Object wrapper: extract constants array
    const constants = Array.isArray(constantsData)
      ? constantsData
      : (constantsData.constants ?? [])

    const rebuilt = projectModelSchema.parse({
      project: projectJson,
      catalogs,
      constants,
    })

    const files2 = serializeToFiles(rebuilt)
    expect(files2).toEqual(files)
  })
})

// --- Валідація при відкритті ---

describe("validation on open", () => {
  it("projectModelSchema rejects invalid catalog name", () => {
    const result = projectModelSchema.safeParse({
      project: { name: "Test" },
      catalogs: [{ kind: "Catalog", name: "lowercase" }],
    })
    expect(result.success).toBe(false)
  })

  it("projectModelSchema rejects invalid catalog", () => {
    const result = projectModelSchema.safeParse({
      project: { name: "Test" },
      catalogs: [{ kind: "Catalog", name: "bad name" }],
    })
    expect(result.success).toBe(false)
  })
})

// --- Constants object wrapper ---

describe("constants object wrapper", () => {
  it("constants file has $schema and constants array", () => {
    const model = createModelWithObjects()
    const files = serializeToFiles(model)
    const cf = files.find((f) => f.path === "constants/constants.meta.json")!
    const parsed = JSON.parse(cf.content)
    expect(parsed.$schema).toContain("constants.schema.json")
    expect(Array.isArray(parsed.constants)).toBe(true)
  })

  it("individual objects have $schema URLs", () => {
    const model = createModelWithObjects()
    const files = serializeToFiles(model)
    const catalogFile = files.find((f) => f.path.includes("products"))!
    const parsed = JSON.parse(catalogFile.content)
    expect(parsed.$schema).toContain("catalog.schema.json")
  })

  it("project.meta.json has $schema URL", () => {
    const model = createModelWithObjects()
    const files = serializeToFiles(model)
    const pf = files.find((f) => f.path === "project.meta.json")!
    const parsed = JSON.parse(pf.content)
    expect(parsed.$schema).toContain("project.schema.json")
  })
})
