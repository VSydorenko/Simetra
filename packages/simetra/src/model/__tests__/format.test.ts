import { describe, it, expect } from "vitest"
import { z } from "zod"
import { formatMetaFile, formatProjectFile, PROJECT_KEY_ORDER } from "../format"
import { projectSchema } from "../schemas"

const ID = "3f2b8a52-6d1e-4c0a-9b7e-5a1c2d3e4f50"

describe("formatMetaFile", () => {
  it("orders keys by kind key order and is idempotent", () => {
    const shuffled = {
      attributes: [{ type: "Integer", name: "quantity" }],
      title: { en: "Items", uk: "Номенклатура" },
      physicalName: "item",
      codeLength: 5,
      name: "Item",
      kind: "Catalog",
      id: ID,
      $schema: "../../schemas/catalog.json",
    }
    const once = formatMetaFile(shuffled)
    expect(formatMetaFile(JSON.parse(once))).toBe(once)
    expect(Object.keys(JSON.parse(once))).toEqual([
      "$schema",
      "id",
      "kind",
      "name",
      "physicalName",
      "title",
      "codeLength",
      "attributes",
    ])
    // Вкладені об'єкти форматер не переставляє: їхній порядок — вхідний.
    expect(Object.keys(JSON.parse(once).attributes[0])).toEqual([
      "type",
      "name",
    ])
  })

  it("unknown keys keep input order after known ones", () => {
    const out = formatMetaFile({
      zeta: 1,
      name: "Item",
      alpha: 2,
      kind: "Catalog",
    })
    expect(Object.keys(JSON.parse(out))).toEqual([
      "kind",
      "name",
      "zeta",
      "alpha",
    ])
  })

  it("keeps input order when the kind is unknown", () => {
    const out = formatMetaFile({ name: "X", kind: "Nope", id: ID })
    expect(Object.keys(JSON.parse(out))).toEqual(["name", "kind", "id"])
  })

  it("2-space indent and trailing newline", () => {
    expect(formatMetaFile({ name: "Item", kind: "Catalog" })).toBe(
      '{\n  "kind": "Catalog",\n  "name": "Item"\n}\n'
    )
  })
})

describe("formatProjectFile", () => {
  it("orders project keys and covers the project schema", () => {
    expect([...PROJECT_KEY_ORDER].sort()).toEqual(
      Object.keys((projectSchema as z.ZodObject).shape).sort()
    )
    const out = formatProjectFile({
      naming: { attributeCase: "snake_case" },
      name: "demo",
      $schema: "./schemas/project.json",
    })
    expect(out).toBe(
      '{\n  "$schema": "./schemas/project.json",\n  "name": "demo",\n  "naming": {\n    "attributeCase": "snake_case"\n  }\n}\n'
    )
  })
})
