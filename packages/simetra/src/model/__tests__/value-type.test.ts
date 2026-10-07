import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  LOGICAL_TYPES,
  valueTypeShape,
  refineValueType,
} from "../schemas/value-type"
import { attributeSchema, catalogAttributeSchema } from "../schemas/attribute"
import { constantSchema } from "../schemas/constant"

const schema = z.object(valueTypeShape).superRefine(refineValueType)

function rules(input: unknown): string[] {
  const res = schema.safeParse(input)
  if (res.success) return []
  return res.error.issues.map(
    (i) => (i as { params?: { rule?: string } }).params?.rule ?? "?"
  )
}

const target = { kind: "Catalog", name: "Products" }

describe("value type rules", () => {
  it("String requires length", () => {
    expect(rules({ type: "String" })).toContain("type.length-required")
    expect(rules({ type: "String", length: 50 })).toEqual([])
  })

  it("length only for String", () => {
    expect(rules({ type: "Integer", length: 5 })).toContain(
      "type.length-not-allowed"
    )
  })

  it("Numeric accepts no precision", () => {
    expect(schema.safeParse({ type: "Numeric" }).success).toBe(true)
    expect(rules({ type: "Numeric", precision: 10, scale: 2 })).toEqual([])
  })

  it("scale requires precision", () => {
    expect(rules({ type: "Numeric", scale: 2 })).toContain(
      "type.scale-requires-precision"
    )
  })

  it("precision only for Numeric", () => {
    expect(rules({ type: "Integer", precision: 10 })).toContain(
      "type.precision-not-allowed"
    )
  })

  it("Ref needs exactly one of ref and allowedTypes", () => {
    expect(rules({ type: "Ref" })).toContain("type.ref-target-required")
    expect(
      rules({ type: "Ref", ref: target, allowedTypes: [target] })
    ).toContain("type.ref-exclusive")
    expect(rules({ type: "Ref", ref: target })).toEqual([])
    expect(rules({ type: "Ref", allowedTypes: [target] })).toEqual([])
  })

  it("allowedTypes must not be empty: an empty set yields a pair without CHECK", () => {
    expect(schema.safeParse({ type: "Ref", allowedTypes: [] }).success).toBe(
      false
    )
  })

  it("ref only for Ref", () => {
    expect(rules({ type: "String", length: 5, ref: target })).toContain(
      "type.ref-not-allowed"
    )
    expect(rules({ type: "Integer", allowedTypes: [target] })).toContain(
      "type.ref-not-allowed"
    )
  })

  it("array flag accepted for every logical type", () => {
    for (const type of LOGICAL_TYPES) {
      const input: Record<string, unknown> = { type, array: true }
      if (type === "String") input.length = 10
      if (type === "Ref") input.ref = target
      expect(rules(input), type).toEqual([])
    }
  })

  it("Binary is gone", () => {
    expect(schema.safeParse({ type: "Binary" }).success).toBe(false)
    expect(schema.safeParse({ type: "Bytes" }).success).toBe(true)
  })
})

/** Пара (правило, шлях) кожної власної перевірки — для типового значення. */
function defaultRules(input: Record<string, unknown>): [string, string][] {
  const res = attributeSchema.safeParse({ name: "field", ...input })
  if (res.success) return []
  return res.error.issues.map((i) => [
    (i as { params?: { rule?: string } }).params?.rule ?? "?",
    i.path.join("/"),
  ])
}

const MISMATCH: [string, string][] = [["type.default-mismatch", "defaultValue"]]
const INVALID: [string, string][] = [["type.default-invalid", "defaultValue"]]
const NOT_ALLOWED: [string, string][] = [
  ["type.default-not-allowed", "defaultValue"],
]

describe("default value (spec §5)", () => {
  it("Boolean takes a boolean", () => {
    expect(defaultRules({ type: "Boolean", defaultValue: false })).toEqual([])
    expect(defaultRules({ type: "Boolean", defaultValue: "true" })).toEqual(
      MISMATCH
    )
  })

  it("integer types take an integer within their range", () => {
    expect(defaultRules({ type: "Integer", defaultValue: 3 })).toEqual([])
    expect(defaultRules({ type: "Integer", defaultValue: 1.5 })).toEqual(
      INVALID
    )
    expect(defaultRules({ type: "Integer", defaultValue: "3" })).toEqual(
      MISMATCH
    )
    expect(defaultRules({ type: "Integer", defaultValue: 2 ** 31 })).toEqual(
      INVALID
    )
    expect(defaultRules({ type: "SmallInt", defaultValue: 32767 })).toEqual([])
    expect(defaultRules({ type: "SmallInt", defaultValue: 32768 })).toEqual(
      INVALID
    )
    expect(defaultRules({ type: "BigInt", defaultValue: 2 ** 40 })).toEqual([])
    expect(defaultRules({ type: "BigInt", defaultValue: 2 ** 60 })).toEqual(
      INVALID
    )
  })

  it("Numeric takes a number or a decimal string", () => {
    expect(defaultRules({ type: "Numeric", defaultValue: 0.5 })).toEqual([])
    expect(defaultRules({ type: "Numeric", defaultValue: "-12.50" })).toEqual(
      []
    )
    expect(defaultRules({ type: "Numeric", defaultValue: "1e3" })).toEqual(
      INVALID
    )
    expect(defaultRules({ type: "Numeric", defaultValue: true })).toEqual(
      MISMATCH
    )
  })

  it("string and temporal types take a string", () => {
    for (const type of ["Text", "Date", "DateTime"]) {
      const value = {
        Text: "x",
        Date: "2026-10-01",
        DateTime: "2026-10-01T00:00:00Z",
      }[type]
      expect(defaultRules({ type, defaultValue: value }), type).toEqual([])
      expect(defaultRules({ type, defaultValue: 1 }), type).toEqual(MISMATCH)
    }
    expect(
      defaultRules({ type: "String", length: 3, defaultValue: "UAH" })
    ).toEqual([])
    expect(
      defaultRules({ type: "String", length: 3, defaultValue: false })
    ).toEqual(MISMATCH)
  })

  it("UUID takes a UUID string", () => {
    expect(
      defaultRules({
        type: "UUID",
        defaultValue: "00000000-0000-4000-8000-0000000000AB",
      })
    ).toEqual([])
    expect(defaultRules({ type: "UUID", defaultValue: "not-a-uuid" })).toEqual(
      INVALID
    )
  })

  it("single Ref takes a string: the target is checked by stage 4", () => {
    expect(
      defaultRules({ type: "Ref", ref: target, defaultValue: "Open" })
    ).toEqual([])
    expect(defaultRules({ type: "Ref", ref: target, defaultValue: 1 })).toEqual(
      MISMATCH
    )
  })

  it("array value takes no default", () => {
    expect(
      defaultRules({ type: "Boolean", array: true, defaultValue: false })
    ).toEqual(NOT_ALLOWED)
  })

  it("polymorphic Ref takes no default", () => {
    expect(
      defaultRules({ type: "Ref", allowedTypes: [target], defaultValue: "x" })
    ).toEqual(NOT_ALLOWED)
  })

  it("Bytes takes no default", () => {
    expect(defaultRules({ type: "Bytes", defaultValue: "AA==" })).toEqual(
      NOT_ALLOWED
    )
  })

  it("Json takes no default", () => {
    expect(defaultRules({ type: "Json", defaultValue: "{}" })).toEqual(
      NOT_ALLOWED
    )
  })

  it.each([
    [{ type: "DateTime", defaultValue: { fill: "now" } }, []],
    [{ type: "Date", defaultValue: { fill: "today" } }, []],
    [{ type: "UUID", defaultValue: { fill: "newUuid" } }, []],
    [
      { type: "Date", defaultValue: { fill: "now" } },
      ["type.default-fill-mismatch"],
    ],
    [
      { type: "DateTime", array: true, defaultValue: { fill: "now" } },
      ["type.default-fill-mismatch"],
    ],
    [
      { type: "String", length: 5, array: true, defaultValue: { empty: true } },
      [],
    ],
    [{ type: "Json", defaultValue: { empty: "array" } }, []],
    [
      { type: "Json", defaultValue: { empty: true } },
      ["type.default-empty-mismatch"],
    ],
    [
      { type: "Integer", defaultValue: { empty: "object" } },
      ["type.default-empty-mismatch"],
    ],
    [
      { type: "Integer", array: true, defaultValue: { empty: "array" } },
      ["type.default-empty-mismatch"],
    ],
  ])("default form %j", (input, expected) =>
    expect(defaultRules(input).map(([rule]) => rule)).toEqual(expected)
  )

  it("constant default follows the same rules", () => {
    const issues = (input: Record<string, unknown>) =>
      constantSchema
        .safeParse({ kind: "Constant", name: "C", ...input })
        .error?.issues.map(
          (i) => (i as { params?: { rule?: string } }).params?.rule
        ) ?? []
    expect(issues({ type: "Integer", defaultValue: 3 })).toEqual([])
    expect(issues({ type: "Integer", defaultValue: "3" })).toEqual([
      "type.default-mismatch",
    ])
    expect(issues({ type: "Json", defaultValue: "{}" })).toEqual([
      "type.default-not-allowed",
    ])
  })
})

describe("attribute uniqueness", () => {
  const issues = (input: Record<string, unknown>) =>
    (
      attributeSchema.safeParse({ name: "a", ...input }).error?.issues ?? []
    ).map((i) => (i as { params?: { rule?: string } }).params?.rule)

  it("ignoreCase is only for a scalar String or Text", () => {
    expect(issues({ type: "String", length: 5, unique: "ignoreCase" })).toEqual(
      []
    )
    expect(issues({ type: "Text", unique: "ignoreCase" })).toEqual([])
    expect(issues({ type: "Integer", unique: "ignoreCase" })).toEqual([
      "type.unique-ignore-case-type",
    ])
    expect(
      issues({ type: "String", length: 5, array: true, unique: "ignoreCase" })
    ).toEqual(["type.unique-ignore-case-type"])
    expect(issues({ type: "Integer", unique: true })).toEqual([])
  })

  it("uniqueWithin requires unique and exists only on catalog attributes", () => {
    const own = (input: Record<string, unknown>) =>
      (
        catalogAttributeSchema.safeParse({ name: "a", ...input }).error
          ?.issues ?? []
      ).map((i) => (i as { params?: { rule?: string } }).params?.rule)
    expect(
      own({ type: "Integer", unique: true, uniqueWithin: "owner" })
    ).toEqual([])
    expect(own({ type: "Integer", uniqueWithin: "parent" })).toEqual([
      "attribute.unique-within-requires-unique",
    ])
    expect(
      own({ type: "Integer", unique: false, uniqueWithin: "parent" })
    ).toEqual(["attribute.unique-within-requires-unique"])
    expect(
      catalogAttributeSchema.safeParse({
        name: "a",
        type: "Integer",
        unique: true,
        uniqueWithin: "x",
      }).success
    ).toBe(false)
    expect(
      attributeSchema.safeParse({
        name: "a",
        type: "Integer",
        unique: true,
        uniqueWithin: "owner",
      }).success
    ).toBe(false)
  })
})

describe("attribute value checks", () => {
  const issues = (input: Record<string, unknown>) =>
    (
      attributeSchema.safeParse({ name: "a", ...input }).error?.issues ?? []
    ).map((i) => (i as { params?: { rule?: string } }).params?.rule)

  it("accepts bounds on numeric and format on string types", () => {
    expect(
      issues({
        type: "Numeric",
        precision: 10,
        scale: 2,
        nonNegative: true,
        maxValue: "1000.50",
      })
    ).toEqual([])
    expect(issues({ type: "Integer", positive: true, maxValue: 10 })).toEqual(
      []
    )
    expect(
      issues({ type: "BigInt", minValue: "-9223372036854775808" })
    ).toEqual([])
    expect(
      issues({
        type: "String",
        length: 10,
        pattern: "^[A-Z]{2,}\\d*$",
        minLength: 2,
      })
    ).toEqual([])
    expect(issues({ type: "Text", pattern: "(?<=a)b(?=c)" })).toEqual([])
  })

  it("positive and nonNegative are mutually exclusive", () => {
    expect(
      issues({ type: "Integer", positive: true, nonNegative: true })
    ).toEqual(["type.bound-conflict"])
  })

  it("minValue must not exceed maxValue", () => {
    expect(issues({ type: "Integer", minValue: 5, maxValue: 4 })).toEqual([
      "type.bound-order",
    ])
    expect(issues({ type: "Integer", minValue: 5, maxValue: 5 })).toEqual([])
    expect(
      issues({ type: "Numeric", minValue: "0.30", maxValue: 0.3 })
    ).toEqual([])
    expect(
      issues({ type: "Numeric", minValue: "10.01", maxValue: 10 })
    ).toEqual(["type.bound-order"])
  })

  it("a bound outside the type is invalid", () => {
    expect(issues({ type: "SmallInt", maxValue: 40000 })).toEqual([
      "type.bound-invalid",
    ])
    expect(issues({ type: "Integer", maxValue: "5" })).toEqual([
      "type.bound-invalid",
    ])
    expect(issues({ type: "Integer", minValue: 1.5 })).toEqual([
      "type.bound-invalid",
    ])
    expect(
      issues({ type: "Numeric", precision: 5, scale: 2, maxValue: "1000" })
    ).toEqual(["type.bound-invalid"])
    expect(issues({ type: "Numeric", maxValue: "abc" })).toEqual([
      "type.bound-invalid",
    ])
  })

  it("bounds apply only to a scalar numeric type", () => {
    expect(issues({ type: "String", length: 5, minValue: 1 })).toEqual([
      "type.bound-type",
    ])
    expect(issues({ type: "Integer", array: true, positive: true })).toEqual([
      "type.bound-type",
    ])
    expect(issues({ type: "Date", nonNegative: true })).toEqual([
      "type.bound-type",
    ])
  })

  it("pattern and minLength apply only to a scalar String or Text", () => {
    expect(issues({ type: "Integer", pattern: "^1$" })).toEqual([
      "type.format-type",
    ])
    expect(
      issues({ type: "String", length: 5, array: true, minLength: 1 })
    ).toEqual(["type.format-type"])
    expect(issues({ type: "String", length: 5, minLength: 0 })).not.toEqual([])
  })

  it.each([
    ["(", "unbalanced group"],
    ["(?<name>x)", "named group"],
    ["\\p{L}", "unicode property"],
    ["\\P{L}", "negated unicode property"],
    ["\\k<a>", "named backreference"],
    ["\\bword\\b", "word boundary"],
    ["[a-z]+(?<n>x)", "named group after a class"],
  ])("pattern %s is rejected (%s)", (pattern) => {
    expect(issues({ type: "String", length: 5, pattern })).toEqual([
      "type.pattern-invalid",
    ])
  })

  it("an escaped backslash or a class does not trip the divergence scan", () => {
    expect(issues({ type: "Text", pattern: "^\\\\p\\d$" })).toEqual([])
    expect(issues({ type: "Text", pattern: "[(?<a]" })).toEqual([])
  })
})
