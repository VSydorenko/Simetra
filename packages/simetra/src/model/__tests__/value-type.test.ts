import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  LOGICAL_TYPES,
  valueTypeShape,
  refineValueType,
} from "../schemas/value-type"

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
