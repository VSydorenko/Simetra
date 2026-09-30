import { describe, it, expect } from "vitest"
import {
  metadataIdSchema,
  physicalNameSchema,
  matchesAttributeCase,
  toSnakeCase,
} from "../schemas/identity"

describe("metadataIdSchema", () => {
  it("приймає UUID v4", () => {
    expect(
      metadataIdSchema.safeParse("3f0c2a7e-1b2d-4c3e-9f4a-5b6c7d8e9f01").success
    ).toBe(true)
  })

  it("відхиляє не-v4 і не-uuid", () => {
    expect(
      metadataIdSchema.safeParse("3f0c2a7e-1b2d-1c3e-9f4a-5b6c7d8e9f01").success
    ).toBe(false)
    expect(metadataIdSchema.safeParse("not-a-uuid").success).toBe(false)
  })
})

describe("physicalNameSchema", () => {
  it("відхиляє порожній рядок і 64 байти", () => {
    expect(physicalNameSchema.safeParse("").success).toBe(false)
    expect(physicalNameSchema.safeParse("ї".repeat(32)).success).toBe(false)
  })

  it("приймає 63 байти", () => {
    expect(physicalNameSchema.safeParse("a".repeat(63)).success).toBe(true)
    expect(physicalNameSchema.safeParse("ї".repeat(31) + "a").success).toBe(
      true
    )
  })
})

describe("matchesAttributeCase", () => {
  it("camelCase і snake_case", () => {
    expect(matchesAttributeCase("deletionMark", "camelCase")).toBe(true)
    expect(matchesAttributeCase("deletion_mark", "camelCase")).toBe(false)
    expect(matchesAttributeCase("deletion_mark", "snake_case")).toBe(true)
    expect(matchesAttributeCase("DeletionMark", "snake_case")).toBe(false)
  })
})

describe("toSnakeCase", () => {
  it("SalesOrder → sales_order", () => {
    expect(toSnakeCase("SalesOrder")).toBe("sales_order")
  })
  it("Products → products", () => {
    expect(toSnakeCase("Products")).toBe("products")
  })
  it("CurrencyExchangeRates → currency_exchange_rates", () => {
    expect(toSnakeCase("CurrencyExchangeRates")).toBe("currency_exchange_rates")
  })
  it("однослівне ім'я зберігає lowercase", () => {
    expect(toSnakeCase("Catalog")).toBe("catalog")
  })
  it("вже snake_case залишається без змін", () => {
    expect(toSnakeCase("already_snake")).toBe("already_snake")
  })
  it("ABCEnum → abc_enum (consecutive caps)", () => {
    expect(toSnakeCase("ABCEnum")).toBe("abc_enum")
  })
})
