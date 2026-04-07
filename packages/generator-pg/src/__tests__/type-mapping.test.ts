import { describe, it, expect } from "vitest"
import { mapFieldType, attributeToColumn } from "../type-mapping"

describe("mapFieldType", () => {
  it("maps UUID", () => {
    expect(mapFieldType({ type: "UUID" })).toBe("uuid")
  })

  it("maps String with default length", () => {
    expect(mapFieldType({ type: "String" })).toBe("varchar(255)")
  })

  it("maps String with custom length", () => {
    expect(mapFieldType({ type: "String", length: 50 })).toBe("varchar(50)")
  })

  it("maps Text", () => {
    expect(mapFieldType({ type: "Text" })).toBe("text")
  })

  it("maps Integer", () => {
    expect(mapFieldType({ type: "Integer" })).toBe("integer")
  })

  it("maps Numeric with defaults", () => {
    expect(mapFieldType({ type: "Numeric" })).toBe("numeric(15, 2)")
  })

  it("maps Numeric with custom precision/scale", () => {
    expect(mapFieldType({ type: "Numeric", precision: 10, scale: 4 })).toBe(
      "numeric(10, 4)"
    )
  })

  it("maps Numeric with scale 0", () => {
    expect(mapFieldType({ type: "Numeric", precision: 8, scale: 0 })).toBe(
      "numeric(8, 0)"
    )
  })

  it("maps Boolean", () => {
    expect(mapFieldType({ type: "Boolean" })).toBe("boolean")
  })

  it("maps Date", () => {
    expect(mapFieldType({ type: "Date" })).toBe("date")
  })

  it("maps DateTime", () => {
    expect(mapFieldType({ type: "DateTime" })).toBe("timestamptz")
  })

  it("maps Binary", () => {
    expect(mapFieldType({ type: "Binary" })).toBe("bytea")
  })

  it("falls back to text for unknown type", () => {
    expect(mapFieldType({ type: "Unknown" })).toBe("text")
  })
})

describe("attributeToColumn", () => {
  const noopResolve = () => "target_table"
  const noopEnumResolve = () => undefined

  it("single Ref + required: true → NOT NULL", () => {
    const col = attributeToColumn(
      {
        name: "customer",
        type: "Ref",
        ref: { kind: "Catalog", name: "Customers" },
        required: true,
        indexed: false,
        unique: false,
        defaultValue: null,
      },
      noopResolve,
      noopEnumResolve,
    )
    expect(col.sqlType).toBe("uuid")
    expect(col.constraints).toContain("NOT NULL")
    expect(col.constraints).toContain("REFERENCES target_table(id)")
  })

  it("single Ref + unique: true → UNIQUE", () => {
    const col = attributeToColumn(
      {
        name: "serial_no",
        type: "Ref",
        ref: { kind: "Catalog", name: "Serials" },
        required: false,
        indexed: false,
        unique: true,
        defaultValue: null,
      },
      noopResolve,
      noopEnumResolve,
    )
    expect(col.sqlType).toBe("uuid")
    expect(col.constraints).toContain("UNIQUE")
    expect(col.constraints).not.toContain("NOT NULL")
  })

  it("single enum Ref + required: true → NOT NULL", () => {
    const col = attributeToColumn(
      {
        name: "status",
        type: "Ref",
        ref: { kind: "Enumeration", name: "Status" },
        required: true,
        indexed: false,
        unique: false,
        defaultValue: null,
      },
      noopResolve,
      () => "public.status",
    )
    expect(col.sqlType).toBe("public.status")
    expect(col.constraints).toContain("NOT NULL")
  })

  it("single Ref without required/unique → no constraints besides FK", () => {
    const col = attributeToColumn(
      {
        name: "warehouse",
        type: "Ref",
        ref: { kind: "Catalog", name: "Warehouses" },
        required: false,
        indexed: false,
        unique: false,
        defaultValue: null,
      },
      noopResolve,
      noopEnumResolve,
    )
    expect(col.sqlType).toBe("uuid")
    expect(col.constraints).toEqual(["REFERENCES target_table(id)"])
  })
})
