import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  LOGICAL_TYPES,
  valueTypeShape,
  refineValueType,
} from "../schemas/value-type"
import { attributeSchema } from "../schemas/attribute"
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
      MISMATCH
    )
    expect(defaultRules({ type: "Integer", defaultValue: "3" })).toEqual(
      MISMATCH
    )
    expect(defaultRules({ type: "Integer", defaultValue: 2 ** 31 })).toEqual(
      MISMATCH
    )
    expect(defaultRules({ type: "SmallInt", defaultValue: 32767 })).toEqual([])
    expect(defaultRules({ type: "SmallInt", defaultValue: 32768 })).toEqual(
      MISMATCH
    )
    expect(defaultRules({ type: "BigInt", defaultValue: 2 ** 40 })).toEqual([])
    expect(defaultRules({ type: "BigInt", defaultValue: 2 ** 60 })).toEqual(
      MISMATCH
    )
  })

  it("Numeric takes a number or a decimal string", () => {
    expect(defaultRules({ type: "Numeric", defaultValue: 0.5 })).toEqual([])
    expect(defaultRules({ type: "Numeric", defaultValue: "-12.50" })).toEqual(
      []
    )
    expect(defaultRules({ type: "Numeric", defaultValue: "1e3" })).toEqual(
      MISMATCH
    )
    expect(defaultRules({ type: "Numeric", defaultValue: true })).toEqual(
      MISMATCH
    )
  })

  it("string and temporal types take a string", () => {
    for (const type of ["Text", "Date", "DateTime"]) {
      expect(defaultRules({ type, defaultValue: "x" }), type).toEqual([])
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
      MISMATCH
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
