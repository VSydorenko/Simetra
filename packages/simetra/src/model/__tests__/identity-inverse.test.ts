import { describe, it, expect } from "vitest"
import {
  logicalElementName,
  logicalObjectName,
  matchesAttributeCase,
  objectNameSchema,
  toSnakeCase,
} from "../schemas"

describe("logicalObjectName", () => {
  it("snake to Pascal", () => {
    expect(logicalObjectName("service_accrual")).toBe("ServiceAccrual")
    expect(logicalObjectName("orders")).toBe("Orders")
  })

  it("result satisfies the object name schema", () => {
    expect(
      objectNameSchema.safeParse(logicalObjectName("sales_order_2")).success
    ).toBe(true)
  })

  it("inverts toSnakeCase for ordinary names", () => {
    for (const name of ["SalesOrder", "CurrencyRate", "Item"]) {
      expect(logicalObjectName(toSnakeCase(name))).toBe(name)
    }
  })

  it("drops empty segments without resolving collisions", () => {
    expect(logicalObjectName("a__b")).toBe("AB")
    expect(logicalObjectName("a_b")).toBe("AB")
  })
})

describe("logicalElementName", () => {
  it("snake to camel", () => {
    expect(logicalElementName("order_date", "camelCase")).toBe("orderDate")
    expect(logicalElementName("name", "camelCase")).toBe("name")
    expect(
      matchesAttributeCase(
        logicalElementName("a_b_c", "camelCase"),
        "camelCase"
      )
    ).toBe(true)
  })

  it("snake stays snake", () => {
    expect(logicalElementName("order_date", "snake_case")).toBe("order_date")
  })
})
