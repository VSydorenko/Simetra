import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  attribute,
  catalog,
  customTable,
  metaFiles,
  organization,
  project,
  scopedProject,
  uuid,
} from "./helpers"

const CONTRACT = "catalogs/Contract/Contract.meta.json"

async function compileWith(entries: Record<string, unknown>) {
  return await compile(
    metaFiles({ "project.meta.json": project(), ...entries })
  )
}

describe("stage 2: identity", () => {
  it("missing id", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", { id: undefined }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.id-missing",
        file: CONTRACT,
        pointer: "/id",
        hint: expect.stringContaining("simetra fix"),
      }),
    ])
    expect(result.ok).toBe(false)
  })

  it("predefined item without id", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        predefinedItems: [{ name: "Main", physicalName: "main" }],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.id-missing",
        pointer: "/predefinedItems/0/id",
      }),
    ])
  })

  it("duplicate predefined name", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        predefinedItems: [
          { id: uuid(5), name: "Main", physicalName: "main" },
          { id: uuid(6), name: "Main", physicalName: "main_2" },
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-duplicate",
        pointer: "/predefinedItems/1/name",
      }),
    ])
  })

  it("predefined id duplicates attribute id", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        attributes: [attribute("note", { id: uuid(5) })],
        predefinedItems: [{ id: uuid(5), name: "Main", physicalName: "main" }],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.id-duplicate",
        pointer: "/predefinedItems/0/id",
      }),
    ])
  })

  it("predefined label may equal the scope kind name", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        [CONTRACT]: catalog("Contract", {
          scope: "org",
          predefinedItems: [{ id: uuid(5), name: "Org", physicalName: "org" }],
        }),
      })
    )
    expect(result.diagnostics).toEqual([])
  })

  it("predefined name is PascalCase regardless of project case", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project({
          naming: { attributeCase: "snake_case" },
        }),
        [CONTRACT]: catalog("Contract", {
          predefinedItems: [
            { id: uuid(5), name: "MainWarehouse", physicalName: "main" },
            { id: uuid(6), name: "spare_warehouse", physicalName: "spare" },
          ],
        }),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "file.schema",
        pointer: "/predefinedItems/1/name",
      }),
    ])
  })

  it("missing id on an element", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        attributes: [attribute("note", { id: undefined })],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.id-missing",
        pointer: "/attributes/0/id",
      }),
    ])
  })

  it("duplicate id across files", async () => {
    const result = await compileWith({
      "catalogs/B/B.meta.json": catalog("B", { id: uuid(1) }),
      "catalogs/A/A.meta.json": catalog("A", { id: uuid(1) }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.id-duplicate",
        file: "catalogs/B/B.meta.json",
        pointer: "/id",
      }),
    ])
  })

  it("duplicate id between an object and an element", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        id: uuid(7),
        attributes: [attribute("note", { id: uuid(7) })],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.id-duplicate",
        pointer: "/attributes/0/id",
      }),
    ])
  })

  it("missing physicalName on attribute", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        attributes: [attribute("note", { physicalName: undefined })],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.physical-name-missing",
        pointer: "/attributes/0/physicalName",
        hint: expect.stringContaining("simetra fix"),
      }),
    ])
  })

  it("duplicate attribute name", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        attributes: [attribute("note"), attribute("note")],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-duplicate",
        pointer: "/attributes/1/name",
      }),
    ])
  })

  it("attribute and tabular section share the object's namespace", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        attributes: [attribute("lines")],
        tabularSections: [attribute("lines", { type: undefined })],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-duplicate",
        pointer: "/tabularSections/0/name",
      }),
    ])
  })

  it("duplicate column name in a custom table", async () => {
    const result = await compileWith({
      "custom-tables/Log/Log.meta.json": customTable("Log", {
        columns: [
          attribute("id", { type: "UUID" }),
          attribute("id", { type: "UUID" }),
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-duplicate",
        pointer: "/columns/1/name",
      }),
    ])
  })

  it("duplicate enumeration value", async () => {
    const value = (name: string, physicalName: string) =>
      attribute(name, { type: undefined, physicalName })
    const result = await compileWith({
      "enumerations/Status/Status.meta.json": {
        id: uuid(50),
        kind: "Enumeration",
        name: "Status",
        physicalName: "status",
        values: [value("Open", "open"), value("Open", "open_2")],
      },
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-duplicate",
        pointer: "/values/1/name",
      }),
    ])
  })

  it("enumeration labels are unique", async () => {
    const value = (name: string, physicalName: string) =>
      attribute(name, { type: undefined, physicalName })
    const result = await compileWith({
      "enumerations/Status/Status.meta.json": {
        id: uuid(50),
        kind: "Enumeration",
        name: "Status",
        physicalName: "status",
        values: [value("Open", "open"), value("Reopened", "open")],
      },
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-duplicate",
        pointer: "/values/1/physicalName",
      }),
    ])
  })

  it("duplicate object name within a kind", async () => {
    const result = await compileWith({
      "catalogs/Contract/Contract.meta.json": catalog("Contract"),
      "catalogs/Other/Other.meta.json": catalog("Contract", {
        kindLabel: "other",
      }),
    })
    expect(result.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ["file.name-mismatch", "catalogs/Other/Other.meta.json"],
      ["identity.name-duplicate", "catalogs/Other/Other.meta.json"],
    ])
  })

  it("attribute case follows project style", async () => {
    const entries = {
      [CONTRACT]: catalog("Contract", {
        attributes: [attribute("unit_price")],
      }),
    }
    const camel = await compile(
      metaFiles({
        "project.meta.json": project({
          naming: { attributeCase: "camelCase" },
        }),
        ...entries,
      })
    )
    expect(camel.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-case",
        pointer: "/attributes/0/name",
      }),
    ])
    const snake = await compile(
      metaFiles({
        "project.meta.json": project({
          naming: { attributeCase: "snake_case" },
        }),
        ...entries,
      })
    )
    expect(snake.diagnostics).toEqual([])
  })

  it("attribute may not reuse a standard logical name", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        attributes: [attribute("deletionMark")],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-reserved",
        pointer: "/attributes/0/name",
      }),
    ])
  })

  it("reserved standard names follow the project style", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project({
          naming: { attributeCase: "snake_case" },
        }),
        [CONTRACT]: catalog("Contract", {
          attributes: [attribute("deletion_mark")],
          tabularSections: [
            {
              ...attribute("lines", { type: undefined }),
              attributes: [attribute("line_number")],
            },
          ],
        }),
      })
    )
    expect(result.diagnostics.map((d) => [d.code, d.pointer])).toEqual([
      ["identity.name-reserved", "/attributes/0/name"],
      ["identity.name-reserved", "/tabularSections/0/attributes/0/name"],
    ])
  })

  it("unresolved reference", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        attributes: [
          attribute("currency", {
            type: "Ref",
            ref: { kind: "Catalog", name: "Missing" },
          }),
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "reference.unresolved",
        pointer: "/attributes/0/ref",
      }),
    ])
  })

  it("reference to an object whose file is broken is not reported twice", async () => {
    const result = await compileWith({
      [CONTRACT]: catalog("Contract", {
        attributes: [
          attribute("currency", {
            type: "Ref",
            ref: { kind: "Catalog", name: "Currency" },
          }),
        ],
      }),
      "catalogs/Currency/Currency.meta.json": "{",
    })
    expect(result.diagnostics.map((d) => d.code)).toEqual(["file.invalid-json"])
  })

  it("references index", async () => {
    const currency = catalog("Currency")
    const contract = catalog("Contract", {
      attributes: [
        attribute("currency", {
          type: "Ref",
          ref: { kind: "Catalog", name: "Currency" },
        }),
      ],
    })
    const result = await compileWith({
      [CONTRACT]: contract,
      "catalogs/Currency/Currency.meta.json": currency,
    })
    expect(result.diagnostics).toEqual([])
    expect(result.model!.references).toEqual([
      {
        from: {
          file: CONTRACT,
          pointer: "/attributes/0/ref",
          objectId: contract.id,
        },
        to: { kind: "Catalog", id: currency.id },
        role: "attribute.ref",
      },
    ])
  })
})

describe("stage 2: enumeration defaults", () => {
  const STATUS = "enumerations/Status/Status.meta.json"
  const RATE = "constants/Rate/Rate.meta.json"
  const status = {
    id: uuid(760),
    kind: "Enumeration",
    name: "Status",
    physicalName: "status",
    values: [
      { id: uuid(761), name: "Open", physicalName: "open" },
      { id: uuid(762), name: "Closed", physicalName: "closed" },
    ],
  }
  const statusRef = {
    type: "Ref",
    ref: { kind: "Enumeration", name: "Status" },
  }

  it("enumeration default is a reference", async () => {
    const result = await compileWith({
      [STATUS]: status,
      [CONTRACT]: catalog("Contract", {
        id: uuid(763),
        attributes: [
          attribute("state", { ...statusRef, defaultValue: "Closed" }),
        ],
      }),
      [RATE]: {
        id: uuid(764),
        kind: "Constant",
        name: "Rate",
        physicalName: "rate",
        ...statusRef,
        defaultValue: "Open",
      },
    })
    expect(result.diagnostics).toEqual([])
    const defaults = result.model!.references.filter((r) =>
      r.role.endsWith(".enumDefault")
    )
    expect(defaults).toEqual([
      {
        from: {
          file: CONTRACT,
          pointer: "/attributes/0/defaultValue",
          objectId: uuid(763),
        },
        to: { kind: "Element", id: uuid(762) },
        role: "attribute.enumDefault",
      },
      {
        from: { file: RATE, pointer: "/defaultValue", objectId: uuid(764) },
        to: { kind: "Element", id: uuid(761) },
        role: "constant.enumDefault",
      },
    ])
  })

  it("unknown enumeration default is still reported", async () => {
    const result = await compileWith({
      [STATUS]: status,
      [CONTRACT]: catalog("Contract", {
        attributes: [
          attribute("state", { ...statusRef, defaultValue: "Archived" }),
        ],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "reference.default-unknown-value",
        file: CONTRACT,
        pointer: "/attributes/0/defaultValue",
        params: expect.objectContaining({ value: "Archived" }),
      }),
    ])
  })
})
