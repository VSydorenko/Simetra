import { describe, it, expect } from "vitest"
import {
  toSnakeCase,
  tableName,
  tabularTableName,
  qualifiedName,
  quoteIdentifier,
  escapeLiteral,
} from "../naming"

describe("toSnakeCase", () => {
  it("converts PascalCase to snake_case", () => {
    expect(toSnakeCase("Products")).toBe("products")
    expect(toSnakeCase("SalesOrder")).toBe("sales_order")
    expect(toSnakeCase("HTMLParser")).toBe("html_parser")
  })

  it("handles single word", () => {
    expect(toSnakeCase("Items")).toBe("items")
  })

  it("handles already lowercase", () => {
    expect(toSnakeCase("items")).toBe("items")
  })

  it("handles consecutive uppercase", () => {
    expect(toSnakeCase("XMLHTTPRequest")).toBe("xmlhttp_request")
  })

  it("handles mixed with numbers", () => {
    expect(toSnakeCase("Order2024")).toBe("order2024")
    expect(toSnakeCase("V2Api")).toBe("v2_api")
  })
})

describe("tableName", () => {
  it("returns kind-prefixed snake_case without prefix", () => {
    expect(tableName("", "Catalog", "Products")).toBe("cat_products")
    expect(tableName("", "Document", "SalesOrder")).toBe("doc_sales_order")
  })

  it("prepends prefix", () => {
    expect(tableName("app_", "Catalog", "Products")).toBe("app_cat_products")
    expect(tableName("erp_", "Document", "SalesOrder")).toBe(
      "erp_doc_sales_order"
    )
  })
})

describe("tabularTableName", () => {
  it("combines parent and section names with kind prefix", () => {
    expect(tabularTableName("", "Catalog", "Products", "barcodes")).toBe(
      "cat_products_barcodes"
    )
  })

  it("includes prefix", () => {
    expect(tabularTableName("app_", "Catalog", "Products", "barcodes")).toBe(
      "app_cat_products_barcodes"
    )
  })
})

describe("qualifiedName", () => {
  it("returns unqualified for public schema", () => {
    expect(qualifiedName("public", "products")).toBe("products")
  })

  it("qualifies for non-public schema", () => {
    expect(qualifiedName("erp", "products")).toBe("erp.products")
  })
})

describe("quoteIdentifier", () => {
  it("wraps in double quotes", () => {
    expect(quoteIdentifier("products")).toBe('"products"')
  })

  it("escapes embedded double quotes", () => {
    expect(quoteIdentifier('my"table')).toBe('"my""table"')
  })
})

describe("escapeLiteral", () => {
  it("escapes single quotes", () => {
    expect(escapeLiteral("it's")).toBe("it''s")
  })

  it("returns unchanged if no quotes", () => {
    expect(escapeLiteral("hello")).toBe("hello")
  })

  it("escapes multiple quotes", () => {
    expect(escapeLiteral("a'b'c")).toBe("a''b''c")
  })
})
