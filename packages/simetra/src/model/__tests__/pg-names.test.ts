import { describe, it, expect } from "vitest"
import {
  chooseConstraintName,
  isSqlReservedWord,
  makeObjectName,
  quoteIdent,
} from "../physical"

describe("makeObjectName", () => {
  it("builds a primary key name", () => {
    expect(makeObjectName("orders", undefined, "pkey")).toBe("orders_pkey")
  })

  it("joins the column part", () => {
    expect(makeObjectName("orders", "customer_id", "fkey")).toBe(
      "orders_customer_id_fkey"
    )
  })

  it("shrinks the longer part first, alternating when equal", () => {
    expect(makeObjectName("a".repeat(40), "b".repeat(40), "fkey")).toBe(
      "a".repeat(29) + "_" + "b".repeat(28) + "_fkey"
    )
  })

  it("truncates a lone long name", () => {
    expect(makeObjectName("a".repeat(70), undefined, "pkey")).toBe(
      "a".repeat(58) + "_pkey"
    )
  })

  it("result never exceeds 63 bytes and never splits a UTF-8 character", () => {
    const r = makeObjectName("ї".repeat(40), "c", "key")
    expect(Buffer.byteLength(r)).toBeLessThanOrEqual(63)
    expect(Buffer.from(r).toString()).not.toContain("�")
    expect(r.endsWith("_c_key")).toBe(true)
  })
})

describe("chooseConstraintName", () => {
  it("returns the plain name when free", () => {
    expect(chooseConstraintName("t", "c", "key", new Set())).toBe("t_c_key")
  })

  it("appends a counter to the label on collision", () => {
    expect(chooseConstraintName("t", "c", "key", new Set(["t_c_key"]))).toBe(
      "t_c_key1"
    )
    expect(
      chooseConstraintName("t", "c", "key", new Set(["t_c_key", "t_c_key1"]))
    ).toBe("t_c_key2")
  })

  it("re-truncates with the longer label", () => {
    const base = makeObjectName("a".repeat(70), undefined, "pkey")
    const r = chooseConstraintName(
      "a".repeat(70),
      undefined,
      "pkey",
      new Set([base])
    )
    expect(r).toBe("a".repeat(57) + "_pkey1")
    expect(Buffer.byteLength(r)).toBe(63)
  })
})

describe("quoteIdent", () => {
  it("quotes reserved words", () => {
    expect(quoteIdent("order")).toBe('"order"')
    expect(quoteIdent("user")).toBe('"user"')
  })

  it("quotes col-name and type-func-name keywords too", () => {
    expect(quoteIdent("integer")).toBe('"integer"')
    expect(quoteIdent("left")).toBe('"left"')
  })

  it("leaves unreserved keywords bare", () => {
    expect(quoteIdent("key")).toBe("key")
    expect(quoteIdent("type")).toBe("type")
  })

  it("quotes uppercase and special characters", () => {
    expect(quoteIdent("Orders")).toBe('"Orders"')
    expect(quoteIdent("a b")).toBe('"a b"')
    expect(quoteIdent("1a")).toBe('"1a"')
  })

  it("leaves plain names bare", () => {
    expect(quoteIdent("orders")).toBe("orders")
    expect(quoteIdent("_a$1")).toBe("_a$1")
  })

  it("doubles embedded quotes", () => {
    expect(quoteIdent('a"b')).toBe('"a""b"')
  })
})

describe("isSqlReservedWord", () => {
  it("is every keyword quote_ident quotes, case-insensitive", () => {
    expect(isSqlReservedWord("check")).toBe(true) // RESERVED
    expect(isSqlReservedWord("Join")).toBe(true) // TYPE_FUNC_NAME
    expect(isSqlReservedWord("INT")).toBe(true) // COL_NAME
  })
  it("unreserved keywords and plain names are not reserved", () => {
    expect(isSqlReservedWord("key")).toBe(false)
    expect(isSqlReservedWord("type")).toBe(false)
    expect(isSqlReservedWord("index")).toBe(false)
    expect(isSqlReservedWord("orders")).toBe(false)
  })
})
