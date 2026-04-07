import { describe, it, expect } from "vitest"
import {
  KIND_PREFIX,
  toSnakeCase,
  physicalObjectName,
  physicalTabularName,
} from "../schemas/physical-naming"
import {
  KIND_PREFIX as KIND_PREFIX_BARREL,
  toSnakeCase as toSnakeCase_BARREL,
  physicalObjectName as physicalObjectName_BARREL,
  physicalTabularName as physicalTabularName_BARREL,
} from "../schemas"
import type { MetadataKind } from "../schemas/metadata-kind"
import { metadataKindSchema } from "../schemas/metadata-kind"

// ---------------------------------------------------------------------------
// toSnakeCase
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// KIND_PREFIX
// ---------------------------------------------------------------------------
describe("KIND_PREFIX", () => {
  it("має запис для кожного значення MetadataKind", () => {
    const allKinds = metadataKindSchema.options as MetadataKind[]
    for (const kind of allKinds) {
      expect(KIND_PREFIX[kind]).toBeDefined()
      expect(typeof KIND_PREFIX[kind]).toBe("string")
      expect(KIND_PREFIX[kind].length).toBeGreaterThan(0)
    }
  })

  it("Catalog → cat_", () => expect(KIND_PREFIX["Catalog"]).toBe("cat_"))
  it("Document → doc_", () => expect(KIND_PREFIX["Document"]).toBe("doc_"))
  it("Enumeration → enum_", () => expect(KIND_PREFIX["Enumeration"]).toBe("enum_"))
  it("InformationRegister → ir_", () => expect(KIND_PREFIX["InformationRegister"]).toBe("ir_"))
  it("AccumulationRegister → ar_", () => expect(KIND_PREFIX["AccumulationRegister"]).toBe("ar_"))
  it("Constant → const_", () => expect(KIND_PREFIX["Constant"]).toBe("const_"))
  it("CustomTable → ct_", () => expect(KIND_PREFIX["CustomTable"]).toBe("ct_"))
})

// ---------------------------------------------------------------------------
// physicalObjectName
// ---------------------------------------------------------------------------
describe("physicalObjectName", () => {
  it("Catalog + Products → cat_products", () => {
    expect(physicalObjectName("Catalog", "Products")).toBe("cat_products")
  })

  it("Document + SalesOrder → doc_sales_order", () => {
    expect(physicalObjectName("Document", "SalesOrder")).toBe("doc_sales_order")
  })

  it("Enumeration + Status → enum_status", () => {
    expect(physicalObjectName("Enumeration", "Status")).toBe("enum_status")
  })

  it("InformationRegister + CurrencyExchangeRates → ir_currency_exchange_rates", () => {
    expect(physicalObjectName("InformationRegister", "CurrencyExchangeRates")).toBe(
      "ir_currency_exchange_rates",
    )
  })

  it("AccumulationRegister + Stocks → ar_stocks", () => {
    expect(physicalObjectName("AccumulationRegister", "Stocks")).toBe("ar_stocks")
  })

  it("Constant + Settings → const_settings", () => {
    expect(physicalObjectName("Constant", "Settings")).toBe("const_settings")
  })

  it("CustomTable + EventLog → ct_event_log", () => {
    expect(physicalObjectName("CustomTable", "EventLog")).toBe("ct_event_log")
  })

  it("InformationRegister.X та AccumulationRegister.X дають різні імена", () => {
    const ir = physicalObjectName("InformationRegister", "Prices")
    const ar = physicalObjectName("AccumulationRegister", "Prices")
    expect(ir).toBe("ir_prices")
    expect(ar).toBe("ar_prices")
    expect(ir).not.toBe(ar)
  })
})

// ---------------------------------------------------------------------------
// Smoke test — barrel / package root export chain
// ---------------------------------------------------------------------------
describe("barrel export", () => {
  it("KIND_PREFIX доступний через schemas barrel", () => {
    expect(KIND_PREFIX_BARREL).toBe(KIND_PREFIX)
  })

  it("toSnakeCase доступний через schemas barrel", () => {
    expect(toSnakeCase_BARREL).toBe(toSnakeCase)
  })

  it("physicalObjectName доступний через schemas barrel", () => {
    expect(physicalObjectName_BARREL).toBe(physicalObjectName)
  })

  it("physicalTabularName доступний через schemas barrel", () => {
    expect(physicalTabularName_BARREL).toBe(physicalTabularName)
  })
})

// ---------------------------------------------------------------------------
// physicalTabularName
// ---------------------------------------------------------------------------
describe("physicalTabularName", () => {
  it("Catalog + Products + barcodes → cat_products_barcodes", () => {
    expect(physicalTabularName("Catalog", "Products", "barcodes")).toBe(
      "cat_products_barcodes",
    )
  })

  it("Document + SalesOrder + goods → doc_sales_order_goods", () => {
    expect(physicalTabularName("Document", "SalesOrder", "goods")).toBe(
      "doc_sales_order_goods",
    )
  })

  it("CustomTable + EventLog + details → ct_event_log_details", () => {
    expect(physicalTabularName("CustomTable", "EventLog", "details")).toBe(
      "ct_event_log_details",
    )
  })

  it("Document + SalesOrder + line_items → doc_sales_order_line_items", () => {
    expect(physicalTabularName("Document", "SalesOrder", "line_items")).toBe(
      "doc_sales_order_line_items",
    )
  })
})
