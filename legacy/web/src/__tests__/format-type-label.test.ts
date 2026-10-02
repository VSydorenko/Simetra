import { describe, it, expect } from "vitest"
import type { TFunction } from "i18next"
import type { Attribute } from "@simetra/core"
import { formatTypeLabel } from "../lib/format-type-label"

// Mock t() — повертає ключ як значення для простоти перевірки
const mockT: TFunction = ((key: string) => key) as unknown as TFunction

function makeAttr(overrides: Partial<Attribute>): Attribute {
  return {
    name: "test_field",
    type: "String",
    required: false,
    indexed: false,
    unique: false,
    defaultValue: null,
    ...overrides,
  } as Attribute
}

describe("formatTypeLabel", () => {
  it('примітивний тип → t("fieldType.<Type>")', () => {
    expect(formatTypeLabel(makeAttr({ type: "String" }), mockT)).toBe(
      "fieldType.String"
    )
    expect(formatTypeLabel(makeAttr({ type: "Boolean" }), mockT)).toBe(
      "fieldType.Boolean"
    )
    expect(formatTypeLabel(makeAttr({ type: "Integer" }), mockT)).toBe(
      "fieldType.Integer"
    )
  })

  it('single ref → "fieldType.Ref: refName"', () => {
    const attr = makeAttr({
      type: "Ref",
      ref: { kind: "Catalog", name: "Products" },
    })
    expect(formatTypeLabel(attr, mockT)).toBe("fieldType.Ref: Products")
  })

  it('polymorphic ref → "fieldType.Ref: target1, target2"', () => {
    const attr = makeAttr({
      type: "Ref",
      allowedTypes: [
        { kind: "Catalog", name: "Products" },
        { kind: "Document", name: "SalesOrder" },
      ],
    })
    expect(formatTypeLabel(attr, mockT)).toBe(
      "fieldType.Ref: Products, SalesOrder"
    )
  })

  it('незавершений Ref → "fieldType.Ref"', () => {
    const attr = makeAttr({ type: "Ref" })
    expect(formatTypeLabel(attr, mockT)).toBe("fieldType.Ref")
  })

  it('порожній allowedTypes → "fieldType.Ref"', () => {
    const attr = makeAttr({ type: "Ref", allowedTypes: [] })
    expect(formatTypeLabel(attr, mockT)).toBe("fieldType.Ref")
  })
})
