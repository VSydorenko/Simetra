import { describe, expect, it } from "vitest"
import type { CatalogEntryAttribute } from "../catalog"
import { jsonBytes } from "../limits"
import { encodeAttributes, type EncodeAttributesOptions } from "../values"
import { catalogEntryAttribute } from "./entries"

// Кодувальник читає лише спільну частину запису: реквізити — з будівника T0.
const attr = (
  name: string,
  type: CatalogEntryAttribute["type"],
  extra: Partial<CatalogEntryAttribute> = {}
): CatalogEntryAttribute =>
  catalogEntryAttribute({
    name,
    column: `${name}_col`,
    type,
    required: false,
    maxLength: undefined,
    insert: true,
    update: true,
    ...extra,
  })

const OTHER = "22222222-2222-4222-8222-222222222222"

const attributes: CatalogEntryAttribute[] = [
  attr("user", "UUID"),
  attr("code", "String", { maxLength: 3 }),
  attr("amount", "Numeric", { precision: 10, scale: 2 }),
  attr("subject", "Ref", {
    pair: {
      typeColumn: "subject_type",
      targets: [
        { object: { kind: "Catalog", name: "Project" }, label: "project" },
      ],
    },
  }),
  attr("tags", "Integer", { array: true }),
  attr("frozen", "String", { update: false }),
  attr("computed", "Integer", { insert: false, update: false }),
]

/**
 * Три споживачі одного обходу (Р-A6-13): шапка `values` (грант вставки чи
 * оновлення), рядок ТЧ (ключ рядка пише викликач, шляхи з префіксом) і
 * `creatorMember` (примушені ключі, префікс): шляхи й порядок помилок у
 * всіх трьох однакові.
 */
const HEADER: EncodeAttributesOptions = {
  allowed: (a) => a.update,
  path: "values",
  prefix: "",
}
const ROW: EncodeAttributesOptions = {
  allowed: (a) => a.insert,
  path: "lines.0",
  prefix: "lines.0.",
  rowKey: "ref",
}
const MEMBER: EncodeAttributesOptions = {
  allowed: (a) => a.insert,
  forced: ["user"],
  path: "creatorMember",
  prefix: "creatorMember.",
}

const revoked = () => {
  const proxy = Proxy.revocable({}, {})
  proxy.revoke()
  return proxy.proxy
}
const throwing = (key: string) =>
  Object.defineProperty({}, key, {
    enumerable: true,
    get() {
      throw new Error("getter")
    },
  })

describe("encodeAttributes", () => {
  it.each<[string, EncodeAttributesOptions, unknown, string]>([
    ["member: a forced key", MEMBER, { user: OTHER }, "creatorMember.user"],
    [
      "member: a key outside insert",
      MEMBER,
      { computed: 1 },
      "creatorMember.computed",
    ],
    ["member: an unknown key", MEMBER, { nope: 1 }, "creatorMember.nope"],
    ["member: the table key", MEMBER, { ref: OTHER }, "creatorMember.ref"],
    [
      "member: an undefined value",
      MEMBER,
      { code: undefined },
      "creatorMember.code",
    ],
    [
      "member: an invalid value",
      MEMBER,
      { code: "abcd" },
      "creatorMember.code",
    ],
    ["member: null", MEMBER, null, "creatorMember"],
    ["member: not an object", MEMBER, [], "creatorMember"],
    ["member: a revoked Proxy", MEMBER, revoked(), "creatorMember"],
    ["member: a value getter", MEMBER, throwing("code"), "creatorMember.code"],
    // Р-A3-8: реквізити за порядком каталогу, невідомі ключі — після них.
    [
      "member: an unknown key before an invalid value",
      MEMBER,
      { nope: 1, code: "abcd" },
      "creatorMember.code",
    ],
    [
      "member: two invalid values",
      MEMBER,
      { amount: 1.5, code: "abcd" },
      "creatorMember.code",
    ],
    ["header: a key outside update", HEADER, { frozen: "x" }, "frozen"],
    ["header: the table key", HEADER, { ref: OTHER }, "ref"],
    ["header: not an object", HEADER, [], "values"],
    ["header: an array element", HEADER, { tags: [1, 2.5] }, "tags.1"],
    [
      "header: outside the grant after a value",
      HEADER,
      { frozen: "x", code: "abcd" },
      "code",
    ],
    [
      "header: unknown keys in input order",
      HEADER,
      { nope: 1, zzz: 2 },
      "nope",
    ],
    [
      "row: a key outside insert",
      ROW,
      { ref: OTHER, computed: 1 },
      "lines.0.computed",
    ],
    ["row: an unknown key", ROW, { ref: OTHER, nope: 1 }, "lines.0.nope"],
    ["row: an invalid value", ROW, { ref: OTHER, code: 1 }, "lines.0.code"],
    ["row: not an object", ROW, null, "lines.0"],
    ["row: a value getter", ROW, throwing("code"), "lines.0.code"],
  ])("rejects %s", (_, options, values, path) => {
    expect(encodeAttributes(attributes, values, options)).toEqual({
      error: { code: "command.invalid", path },
    })
  })

  it.each<[string, EncodeAttributesOptions, unknown, Record<string, unknown>]>([
    [
      "member: values and pairs by physical column",
      MEMBER,
      {
        code: "abc",
        amount: "12.50",
        subject: { type: "Catalog.Project", id: OTHER },
      },
      {
        code_col: "abc",
        amount_col: "12.50",
        subject_type: "project",
        subject_col: OTHER,
      },
    ],
    ["member: null", MEMBER, { code: null }, { code_col: null }],
    ["member: empty", MEMBER, {}, {}],
    // Примушений ключ відхиляється лише тоді, коли він є у вході.
    [
      "header: the same attribute without forced keys",
      HEADER,
      { user: OTHER, tags: [1, null] },
      { user_col: OTHER, tags_col: [1, null] },
    ],
    [
      "row: the row key stays out of the columns",
      ROW,
      { ref: OTHER, frozen: "f", code: "abc" },
      { code_col: "abc", frozen_col: "f" },
    ],
  ])("encodes %s", (_, options, values, columns) => {
    expect(encodeAttributes(attributes, values, options)).toEqual({ columns })
  })
})

// `maxBytes` (Рд26, Р7): міра — `jsonBytes` закодованого значення форми
// передачі, тож лапки JSON, екранування й UTF-8 кирилиці входять у межу.
describe("encodeAttributes: maxBytes", () => {
  const INPUT = { ...HEADER, maxBytes: true } as const
  it.each<[string, CatalogEntryAttribute["type"], boolean, unknown, number]>([
    ["Text", "Text", false, "abc", 5],
    ["Cyrillic Text", "Text", false, "їж", 6],
    ["Text with a quote and a backslash", "Text", false, 'a"\\', 7],
    ["Json", "Json", false, { a: "в" }, 10],
    ["Bytes as the \\x text", "Bytes", false, "\\xff00", 9],
    ["a Text array as a whole", "Text", true, ["ab", "в"], 11],
  ])(
    "%s: the limit passes, one byte less refuses",
    (_, type, array, value, bytes) => {
      const at = (maxBytes: number) => [
        attr("big", type, { maxBytes, ...(array ? { array: true } : {}) }),
      ]
      expect(encodeAttributes(at(bytes), { big: value }, INPUT)).toHaveProperty(
        "columns.big_col"
      )
      expect(encodeAttributes(at(bytes - 1), { big: value }, INPUT)).toEqual({
        error: { code: "command.invalid", path: "big", reason: "too-large" },
      })
    }
  )

  // Р7: міра — форма, якою значення піде дротом, а не форма входу.
  // `Numeric(p, s)` база доповнює до `s` дробових цифр, `DateTime` кодек
  // нормалізує до фіксованої ширини UTC; надісланий базі вхід — без змін.
  it.each<[string, Partial<CatalogEntryAttribute>, unknown, number]>([
    [
      'a Numeric(20, 10) array of "0" by its padded scale',
      { type: "Numeric", precision: 20, scale: 10, array: true },
      ["0", "0", "0"],
      jsonBytes(["0.0000000000", "0.0000000000", "0.0000000000"]),
    ],
    [
      '"0" in Numeric(38, 10) as "0.0000000000"',
      { type: "Numeric", precision: 38, scale: 10 },
      "0",
      jsonBytes("0.0000000000"),
    ],
    [
      "a negative Numeric(5, 2) with its sign",
      { type: "Numeric", precision: 5, scale: 2 },
      "-5",
      jsonBytes("-5.00"),
    ],
    [
      "Numeric(5, 0) without a point or leading zeros",
      { type: "Numeric", precision: 5, scale: 0 },
      "+007",
      jsonBytes("7"),
    ],
    // Дробових цифр понад `s` база округлює: перенос може додати цілу цифру.
    [
      "Numeric(10, 2) past its scale with a carry digit",
      { type: "Numeric", precision: 10, scale: 2 },
      "1.5000",
      jsonBytes("01.50"),
    ],
    [
      "a DateTime array by its fixed-width UTC form",
      { type: "DateTime", array: true },
      ["2026-01-01T00:00+02:00", null],
      jsonBytes(["2025-12-31T22:00:00.000000Z", null]),
    ],
  ])("measures %s", (_, extra, value, bytes) => {
    const at = (maxBytes: number) => [
      attr("big", extra.type ?? "Text", { ...extra, maxBytes }),
    ]
    expect(jsonBytes(value)).not.toBe(bytes)
    expect(encodeAttributes(at(bytes), { big: value }, INPUT)).toEqual({
      columns: { big_col: value },
    })
    expect(encodeAttributes(at(bytes - 1), { big: value }, INPUT)).toEqual({
      error: { code: "command.invalid", path: "big", reason: "too-large" },
    })
  })

  it("names the row path of a tabular section value", () => {
    const row = [attr("memo", "Text", { maxBytes: 4 })]
    expect(
      encodeAttributes(
        row,
        { ref: OTHER, memo: "abc" },
        { ...ROW, maxBytes: true }
      )
    ).toEqual({
      error: {
        code: "command.invalid",
        path: "lines.0.memo",
        reason: "too-large",
      },
    })
  })

  // Без опції межі немає: обхід кличуть і не лише команди.
  it("does not check without the option", () => {
    const big = [attr("memo", "Text", { maxBytes: 1 })]
    expect(encodeAttributes(big, { memo: "abc" }, HEADER)).toEqual({
      columns: { memo_col: "abc" },
    })
  })
})

// Вхід `DateTime` перевіряється правилом дроту (`normalDateTime`): момент, що
// в UTC виходить за роки 1–9999, суворий декодер не прочитав би з бази.
describe("encodeAttributes: DateTime by the wire rule", () => {
  const at = [attr("at", "DateTime"), attr("ats", "DateTime", { array: true })]
  it.each<[string, unknown, string]>([
    ["past 9999 in UTC", { at: "9999-12-31T23:59:59-05:00" }, "at"],
    ["before 0001 in UTC", { at: "0001-01-01T00:30:00+01:00" }, "at"],
    [
      "an array element past 9999 in UTC",
      { ats: ["9999-12-31T23:59:59Z", "9999-12-31T23:59:59-05:00"] },
      "ats.1",
    ],
  ])("refuses %s", (_, values, path) => {
    expect(encodeAttributes(at, values, HEADER)).toEqual({
      error: { code: "command.invalid", path },
    })
  })

  it.each(["9999-12-31T23:59:59Z", "0001-01-01T00:00:00Z"])(
    "accepts the edge %s",
    (value) => {
      expect(encodeAttributes(at, { at: value, ats: [value] }, HEADER)).toEqual(
        { columns: { at_col: value, ats_col: [value] } }
      )
    }
  )
})
