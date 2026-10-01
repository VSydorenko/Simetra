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

function compileWith(entries: Record<string, unknown>) {
  return compile(metaFiles({ "project.meta.json": project(), ...entries }))
}

describe("stage 2: identity", () => {
  it("missing id", () => {
    const result = compileWith({
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

  it("predefined item without id", () => {
    const result = compileWith({
      [CONTRACT]: catalog("Contract", { predefinedItems: [{ name: "main" }] }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.id-missing",
        pointer: "/predefinedItems/0/id",
      }),
    ])
  })

  it("duplicate predefined name", () => {
    const result = compileWith({
      [CONTRACT]: catalog("Contract", {
        predefinedItems: [
          { id: uuid(5), name: "main" },
          { id: uuid(6), name: "main" },
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

  it("predefined id duplicates attribute id", () => {
    const result = compileWith({
      [CONTRACT]: catalog("Contract", {
        attributes: [attribute("note", { id: uuid(5) })],
        predefinedItems: [{ id: uuid(5), name: "main" }],
      }),
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.id-duplicate",
        pointer: "/predefinedItems/0/id",
      }),
    ])
  })

  it("predefined item may be named like the scope kind", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": scopedProject(),
        "catalogs/Organization/Organization.meta.json": organization(),
        [CONTRACT]: catalog("Contract", {
          scope: "org",
          predefinedItems: [{ id: uuid(5), name: "org" }],
        }),
      })
    )
    expect(result.diagnostics).toEqual([])
  })

  it("predefined item needs no physicalName", () => {
    const result = compileWith({
      [CONTRACT]: catalog("Contract", {
        predefinedItems: [{ id: uuid(5), name: "main" }],
      }),
    })
    expect(result.diagnostics).toEqual([])
  })

  it("predefined name follows project case", () => {
    const result = compile(
      metaFiles({
        "project.meta.json": project({
          naming: { attributeCase: "snake_case" },
        }),
        [CONTRACT]: catalog("Contract", {
          predefinedItems: [{ id: uuid(5), name: "MainWarehouse" }],
        }),
      })
    )
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-case",
        pointer: "/predefinedItems/0/name",
      }),
    ])
  })

  it("missing id on an element", () => {
    const result = compileWith({
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

  it("duplicate id across files", () => {
    const result = compileWith({
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

  it("duplicate id between an object and an element", () => {
    const result = compileWith({
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

  it("missing physicalName on attribute", () => {
    const result = compileWith({
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

  it("duplicate attribute name", () => {
    const result = compileWith({
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

  it("attribute and tabular section share the object's namespace", () => {
    const result = compileWith({
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

  it("duplicate column name in a custom table", () => {
    const result = compileWith({
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

  it("duplicate enumeration value", () => {
    const value = (name: string) => attribute(name, { type: undefined })
    const result = compileWith({
      "enumerations/Status/Status.meta.json": {
        id: uuid(50),
        kind: "Enumeration",
        name: "Status",
        physicalName: "status",
        values: [value("Open"), value("Open")],
      },
    })
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "identity.name-duplicate",
        pointer: "/values/1/name",
      }),
    ])
  })

  it("duplicate object name within a kind", () => {
    const result = compileWith({
      "catalogs/Contract/Contract.meta.json": catalog("Contract"),
      "catalogs/Other/Other.meta.json": catalog("Contract"),
    })
    expect(result.diagnostics.map((d) => [d.code, d.file])).toEqual([
      ["file.name-mismatch", "catalogs/Other/Other.meta.json"],
      ["identity.name-duplicate", "catalogs/Other/Other.meta.json"],
    ])
  })

  it("attribute case follows project style", () => {
    const entries = {
      [CONTRACT]: catalog("Contract", {
        attributes: [attribute("unit_price")],
      }),
    }
    const camel = compile(
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
    const snake = compile(
      metaFiles({
        "project.meta.json": project({
          naming: { attributeCase: "snake_case" },
        }),
        ...entries,
      })
    )
    expect(snake.diagnostics).toEqual([])
  })

  it("attribute may not reuse a standard logical name", () => {
    const result = compileWith({
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

  it("reserved standard names follow the project style", () => {
    const result = compile(
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

  it("unresolved reference", () => {
    const result = compileWith({
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

  it("reference to an object whose file is broken is not reported twice", () => {
    const result = compileWith({
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

  it("references index", () => {
    const currency = catalog("Currency")
    const contract = catalog("Contract", {
      attributes: [
        attribute("currency", {
          type: "Ref",
          ref: { kind: "Catalog", name: "Currency" },
        }),
      ],
    })
    const result = compileWith({
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
