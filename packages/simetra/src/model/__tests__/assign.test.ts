import { describe, expect, it } from "vitest"
import { assignPhysicalName } from "simetra/model"

const none = new Set<string>()

describe("assignPhysicalName", () => {
  it("object", () => {
    expect(assignPhysicalName("ServiceAccrual", { role: "object" }, none)).toBe(
      "service_accrual"
    )
  })

  it("single ref", () => {
    expect(
      assignPhysicalName(
        "counterparty",
        { role: "field", reference: "single" },
        none
      )
    ).toBe("counterparty_id")
  })

  it("enumeration ref", () => {
    expect(
      assignPhysicalName(
        "accrualKind",
        { role: "field", reference: "enumeration" },
        none
      )
    ).toBe("accrual_kind")
  })

  it("polymorphic ref", () => {
    // Пару `_type`/`_id` дає компілятор, тож ім'я — лише основа.
    expect(
      assignPhysicalName(
        "subject",
        { role: "field", reference: "polymorphic" },
        none
      )
    ).toBe("subject")
  })

  it("plain field", () => {
    expect(assignPhysicalName("startDate", { role: "field" }, none)).toBe(
      "start_date"
    )
  })

  it("tabular section", () => {
    expect(
      assignPhysicalName(
        "services",
        { role: "tabularSection", ownerPhysicalName: "service_accrual" },
        none
      )
    ).toBe("service_accrual_services")
  })

  it("scope kind", () => {
    expect(assignPhysicalName("org", { role: "scopeKind" }, none)).toBe(
      "org_id"
    )
  })

  it("label", () => {
    expect(assignPhysicalName("Uah", { role: "label" }, none)).toBe("uah")
  })

  it("column", () => {
    expect(assignPhysicalName("pageSize", { role: "column" }, none)).toBe(
      "page_size"
    )
  })

  it("reserved word", () => {
    expect(assignPhysicalName("order", { role: "field" }, none)).toBe("order_")
  })

  it("an unreserved keyword takes no suffix", () => {
    expect(assignPhysicalName("key", { role: "field" }, none)).toBe("key")
    expect(assignPhysicalName("type", { role: "field" }, none)).toBe("type")
  })

  it("a label is a data literal, not an identifier", () => {
    expect(assignPhysicalName("Order", { role: "label" }, none)).toBe("order")
    expect(
      assignPhysicalName("Order", { role: "label" }, new Set(["order"]))
    ).toBe("order_")
  })

  it("taken", () => {
    expect(
      assignPhysicalName("amount", { role: "field" }, new Set(["amount"]))
    ).toBe("amount_")
    expect(
      assignPhysicalName(
        "amount",
        { role: "field" },
        new Set(["amount", "amount_"])
      )
    ).toBe("amount__")
  })
})
