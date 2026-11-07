import { describe, expect, it } from "vitest"
import { standardElementId } from "../../schemas/element-id"
import { LOGICAL_TYPES, type LogicalType } from "../../schemas/value-type"
import type { CatalogEntryAttribute } from "../catalog"
import {
  WireDecodeError,
  WireEncodeError,
  decodeRow,
  encodeRow,
  type LogicalRow,
  type WireRow,
} from "../wire"
import {
  OBJECT_ID,
  SECTION_ID,
  catalogEntry,
  catalogEntryAttribute,
  catalogEntrySection,
} from "./entries"

const ID = "11111111-1111-4111-8111-111111111111"
const LINE_ID = "22222222-2222-4222-8222-222222222222"

// Реквізит `v` у колонці `v_col`: тест бачить лише тип і значення.
const attr = (
  type: CatalogEntryAttribute["type"],
  extra: Partial<CatalogEntryAttribute> = {}
): CatalogEntryAttribute =>
  catalogEntryAttribute({
    name: "v",
    column: "v_col",
    type,
    maxLength: undefined,
    ...extra,
  })

const only = (attribute: CatalogEntryAttribute) =>
  catalogEntry({ attributes: [attribute], tabularSections: [] })

type Case = {
  attribute: CatalogEntryAttribute
  logical: unknown
  wire: WireRow
}

// `Record<LogicalType, …>`: новий логічний тип без кейсу не скомпілюється.
const BY_TYPE: Record<LogicalType, Case> = {
  UUID: { attribute: attr("UUID"), logical: ID, wire: { v_col: ID } },
  String: { attribute: attr("String"), logical: "abc", wire: { v_col: "abc" } },
  Text: { attribute: attr("Text"), logical: "long", wire: { v_col: "long" } },
  Integer: { attribute: attr("Integer"), logical: 42, wire: { v_col: 42 } },
  SmallInt: { attribute: attr("SmallInt"), logical: 7, wire: { v_col: 7 } },
  BigInt: {
    attribute: attr("BigInt"),
    logical: 2n ** 63n - 1n,
    wire: { v_col: "9223372036854775807" },
  },
  Numeric: {
    attribute: attr("Numeric", { precision: 10, scale: 2 }),
    logical: "10.50",
    wire: { v_col: "10.50" },
  },
  Boolean: { attribute: attr("Boolean"), logical: true, wire: { v_col: true } },
  Date: {
    attribute: attr("Date"),
    logical: "2026-11-07",
    wire: { v_col: "2026-11-07" },
  },
  DateTime: {
    attribute: attr("DateTime"),
    logical: "2026-11-07T10:00:00.123456Z",
    wire: { v_col: "2026-11-07T10:00:00.123456Z" },
  },
  Bytes: {
    attribute: attr("Bytes"),
    logical: "\\xdeadbeef",
    wire: { v_col: "\\xdeadbeef" },
  },
  Json: {
    attribute: attr("Json"),
    logical: { a: [1, "x", null] },
    wire: { v_col: { a: [1, "x", null] } },
  },
  Ref: {
    attribute: attr("Ref", {
      ref: { object: OBJECT_ID, constraint: "v_col_fkey" },
    }),
    logical: ID,
    wire: { v_col: ID },
  },
}

const EXTRA: Record<string, Case> = {
  Raw: {
    attribute: attr("Raw", { insert: false, update: false }),
    logical: { copy: [1] },
    wire: { v_col: { copy: [1] } },
  },
  array: {
    attribute: attr("Integer", { array: true }),
    logical: [1, null, 3],
    wire: { v_col: [1, null, 3] },
  },
  enumeration: {
    attribute: attr("Ref", {
      enumValues: [
        { name: "Open", label: "open" },
        { name: "Closed", label: "closed" },
      ],
    }),
    logical: "Open",
    wire: { v_col: "open" },
  },
  pair: {
    attribute: attr("Ref", {
      pair: {
        typeColumn: "v_type",
        targets: [
          { object: { kind: "Catalog", name: "Project" }, label: "project" },
        ],
      },
    }),
    logical: { type: "Catalog.Project", id: ID },
    wire: { v_type: "project", v_col: ID },
  },
  "pair null": {
    attribute: attr("Ref", {
      pair: { typeColumn: "v_type", targets: [] },
    }),
    logical: null,
    wire: { v_type: null, v_col: null },
  },
  null: { attribute: attr("String"), logical: null, wire: { v_col: null } },
}

const CASES: [string, Case][] = [
  ...LOGICAL_TYPES.map((type): [string, Case] => [type, BY_TYPE[type]]),
  ...Object.entries(EXTRA),
]

describe("encodeRow / decodeRow values", () => {
  it.each(CASES)("%s has its wire form and round-trips", (_, c) => {
    const entry = only(c.attribute)
    const wire = encodeRow(entry, { v: c.logical })
    expect(wire).toEqual(c.wire)
    expect(decodeRow(entry, wire)).toEqual({ v: c.logical })
  })

  it.each([
    ["String", attr("String"), 5],
    ["Date infinity", attr("Date"), "infinity"],
    ["DateTime infinity", attr("DateTime"), "infinity"],
    ["Numeric NaN", attr("Numeric"), "NaN"],
    ["UUID", attr("UUID"), "not-a-uuid"],
  ])("rejects an unencodable %s value", (_, attribute, value) => {
    expect(() => encodeRow(only(attribute), { v: value })).toThrow(
      WireEncodeError
    )
  })

  it.each([
    ["BigInt as a number", attr("BigInt"), 5],
    ["BigInt as a decimal", attr("BigInt"), "1.5"],
    ["Integer as a string", attr("Integer"), "5"],
    ["Numeric as a number", attr("Numeric"), 10.5],
    ["DateTime infinity", attr("DateTime"), "infinity"],
    ["array as a scalar", attr("Integer", { array: true }), 1],
  ])("rejects a wire %s with its column", (_, attribute, value) => {
    expect(() => decodeRow(only(attribute), { v_col: value })).toThrow(
      expect.objectContaining({
        name: "WireDecodeError",
        column: "v_col",
      }) as Error
    )
  })

  it("drops an unknown enumeration label and pair target (В9)", () => {
    expect(
      decodeRow(only(EXTRA.enumeration!.attribute), { v_col: "new" })
    ).toEqual({})
    expect(
      decodeRow(only(EXTRA.pair!.attribute), { v_type: "region", v_col: ID })
    ).toEqual({})
  })
})

describe("DateTime normalisation", () => {
  // Один момент UTC 10:00 у трьох зсувах; дріб — 0, 3 і 6 знаків.
  const offsets: [string, string][] = [
    ["+00:00", "2026-11-07T10:00:00"],
    ["+05:30", "2026-11-07T15:30:00"],
    ["-08:00", "2026-11-07T02:00:00"],
  ]
  const fractions: [string, string][] = [
    ["", ".000000"],
    [".123", ".123000"],
    [".123456", ".123456"],
  ]
  const entry = only(attr("DateTime"))

  it.each(
    offsets.flatMap(([offset, local]) =>
      fractions.map(([fraction, normal]) => [
        `${local}${fraction}${offset}`,
        `2026-11-07T10:00:00${normal}Z`,
      ])
    )
  )("%s → %s", (raw, normal) => {
    expect(decodeRow(entry, { v_col: raw })).toEqual({ v: normal })
  })

  it.each([
    // Текстова форма Postgres: пробіл і зсув годинами.
    ["2026-11-07 15:00:00.5+05", "2026-11-07T10:00:00.500000Z"],
    ["2026-11-07T23:30:00-08:00", "2026-11-08T07:30:00.000000Z"],
  ])("%s → %s", (raw, normal) => {
    expect(decodeRow(entry, { v_col: raw })).toEqual({ v: normal })
  })

  it("rejects seven fraction digits", () => {
    expect(() =>
      decodeRow(entry, { v_col: "2026-11-07T10:00:00.1234567Z" })
    ).toThrow(WireDecodeError)
  })
})

describe("encodeRow / decodeRow rows", () => {
  const entry = catalogEntry()

  it("writes the key and the version as integer text", () => {
    const wire = encodeRow(entry, { ref: ID, version: 7 })
    expect(wire).toEqual({ id: ID, version: "7" })
    expect(decodeRow(entry, wire)).toEqual({ ref: ID, version: 7 })
  })

  it.each([
    ["a number", 7],
    ["a decimal", "7.5"],
    ["beyond a safe integer", "9007199254740993"],
    ["null", null],
  ])("rejects a version that is %s", (_, version) => {
    expect(() => decodeRow(entry, { version })).toThrow(
      expect.objectContaining({ column: "version" }) as Error
    )
  })

  it("ignores an unknown key and leaves a missing key missing", () => {
    const row = decodeRow(entry, { title: "a", added_later: 1 })
    expect(row).toEqual({ title: "a" })
    expect(row).not.toHaveProperty("status")
    expect(encodeRow(entry, { title: "a", unknown: 1 })).toEqual({
      title: "a",
    })
  })

  it("maps a card row with two sections by section id", () => {
    const roles = catalogEntrySection({
      id: standardElementId(OBJECT_ID, { logicalName: "roles" }),
      name: "roles",
      table: { schema: "public", name: "task_roles" },
      attributes: [
        catalogEntryAttribute({
          name: "role",
          column: "role_id",
          type: "UUID",
        }),
      ],
    })
    const card = catalogEntry({
      tabularSections: [catalogEntrySection(), roles],
    })
    const line = (n: number) => ({
      ref: LINE_ID,
      parent: ID,
      lineNumber: n,
    })
    const logical: LogicalRow = {
      ref: ID,
      version: 3,
      tabularSections: {
        lines: [{ ...line(1), qty: 2, comment: "x" }],
        roles: [{ ...line(2), role: ID }],
      },
    }
    const physical = (n: number) => ({
      id: LINE_ID,
      parent_id: ID,
      line_number: String(n),
    })
    const wire = encodeRow(card, logical)
    expect(wire).toEqual({
      id: ID,
      version: "3",
      tabularSections: {
        [SECTION_ID]: [{ ...physical(1), qty: 2, comment: "x" }],
        [`${OBJECT_ID}#roles`]: [{ ...physical(2), role_id: ID }],
      },
    })
    expect(decodeRow(card, wire)).toEqual(logical)
  })

  it("rejects a line number that is not integer text", () => {
    expect(() =>
      decodeRow(entry, {
        tabularSections: { [SECTION_ID]: [{ line_number: 1 }] },
      })
    ).toThrow(expect.objectContaining({ column: "line_number" }) as Error)
  })

  it("never lets __proto__ or constructor alter the prototype or add a field", () => {
    const raw = JSON.parse(
      '{"__proto__":{"title":"x"},"constructor":"y","tabularSections":{"__proto__":[{"qty":1}],"constructor":[]}}'
    ) as WireRow
    const decoded = decodeRow(entry, raw)
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype)
    expect(decoded).toEqual({ tabularSections: {} })
    expect(Object.getPrototypeOf(decoded.tabularSections)).toBe(
      Object.prototype
    )

    const logical = JSON.parse(
      '{"__proto__":{"title":"x"},"constructor":"y"}'
    ) as LogicalRow
    const encoded = encodeRow(entry, logical)
    expect(Object.getPrototypeOf(encoded)).toBe(Object.prototype)
    expect(Object.keys(encoded)).toEqual([])
  })
})
