import { describe, it, expect } from "vitest"
import { pgEnumTypeName, pgTypeOf } from "../physical"
import type { ValueType } from "../schemas"

describe("pgTypeOf", () => {
  const cases: [ValueType, string][] = [
    [{ type: "UUID" }, "uuid"],
    [{ type: "String", length: 100 }, "character varying(100)"],
    [{ type: "Text" }, "text"],
    [{ type: "SmallInt" }, "smallint"],
    [{ type: "Integer" }, "integer"],
    [{ type: "BigInt" }, "bigint"],
    [{ type: "Numeric" }, "numeric"],
    [{ type: "Numeric", precision: 12, scale: 2 }, "numeric(12,2)"],
    [{ type: "Numeric", precision: 10 }, "numeric(10,0)"],
    [{ type: "Boolean" }, "boolean"],
    [{ type: "Date" }, "date"],
    [{ type: "DateTime" }, "timestamp with time zone"],
    [{ type: "Bytes" }, "bytea"],
    [{ type: "Json" }, "jsonb"],
    [{ type: "Ref" }, "uuid"],
    [{ type: "String", length: 100, array: true }, "character varying(100)[]"],
    [{ type: "Integer", array: true }, "integer[]"],
  ]

  it.each(cases)("maps %j to %s", (value, expected) => {
    expect(pgTypeOf(value)).toBe(expected)
  })

  it("maps Ref to Enumeration as text", () => {
    expect(pgTypeOf({ type: "Ref" }, "Enumeration")).toBe("text")
    expect(pgTypeOf({ type: "Ref" }, "Catalog")).toBe("uuid")
  })
})

describe("pgEnumTypeName", () => {
  it("leaves plain identifiers unquoted", () => {
    expect(pgEnumTypeName("public", "order_status")).toBe("public.order_status")
  })

  it("quotes parts like quote_ident", () => {
    expect(pgEnumTypeName("Sales", "Status")).toBe('"Sales"."Status"')
  })
})
