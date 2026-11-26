import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  attributeSchema,
  catalogAttributeSchema,
  registerAttributesSchema,
  registerFieldSchema,
} from "../schemas/attribute"
import { constantSchema } from "../schemas/constant"
import { customTableColumnSchema } from "../schemas/custom-table"
import { tabularSectionSchema } from "../schemas/tabular-section"
import { LOGICAL_TYPES, effectiveMaxBytes } from "../schemas"

const rulesOf = (schema: z.ZodType, input: unknown): string[] =>
  (schema.safeParse(input).error?.issues ?? []).map(
    (i) => (i as { params?: { rule?: string } }).params?.rule ?? "?"
  )

const rich = { name: "body", type: "RichText" }

describe("RichText type (Р-B7-1, Р-B7-9, Р-B7-10)", () => {
  it("is a logical type", () => {
    expect(LOGICAL_TYPES).toContain("RichText")
  })

  it("is accepted for a header attribute and a tabular section attribute", () => {
    expect(rulesOf(attributeSchema, rich)).toEqual([])
    expect(rulesOf(catalogAttributeSchema, rich)).toEqual([])
    expect(
      rulesOf(tabularSectionSchema, { name: "lines", attributes: [rich] })
    ).toEqual([])
  })

  it("defaults maxBytes to 1 MiB and allows an explicit maxBytes", () => {
    expect(effectiveMaxBytes({ type: "RichText" })).toBe(1024 * 1024)
    expect(effectiveMaxBytes({ type: "RichText", maxBytes: 10 })).toBe(10)
    expect(rulesOf(attributeSchema, { ...rich, maxBytes: 10 })).toEqual([])
  })

  it.each<[string, Record<string, unknown>, string]>([
    ["array", { array: true }, "type.rich-text-array"],
    ["unique", { unique: true }, "type.rich-text-unique"],
    ["unique ignoreCase", { unique: "ignoreCase" }, "type.rich-text-unique"],
    ["indexed", { indexed: true }, "type.rich-text-indexed"],
    ["defaultValue", { defaultValue: "x" }, "type.default-not-allowed"],
    [
      "defaultValue empty",
      { defaultValue: { empty: "object" } },
      "type.default-empty-mismatch",
    ],
  ])("refuses %s", (_, extra, rule) => {
    expect(rulesOf(attributeSchema, { ...rich, ...extra })).toContain(rule)
  })

  it("refuses uniqueWithin", () => {
    expect(
      rulesOf(catalogAttributeSchema, {
        ...rich,
        uniqueWithin: "owner",
      })
    ).toContain("type.rich-text-unique")
  })

  it("refuses a register field, a constant and a custom table column", () => {
    expect(rulesOf(registerFieldSchema, rich)).toEqual(["type.rich-text-place"])
    expect(
      rulesOf(z.strictObject({ attributes: registerAttributesSchema }), {
        attributes: [rich],
      })
    ).toEqual(["type.rich-text-place"])
    expect(
      rulesOf(constantSchema, { kind: "Constant", name: "C", type: "RichText" })
    ).toEqual(["type.rich-text-place"])
    expect(
      rulesOf(customTableColumnSchema, {
        id: "00000000-0000-4000-8000-000000000001",
        name: "body",
        physicalName: "body",
        type: "RichText",
      })
    ).toEqual(["type.rich-text-place"])
  })
})
