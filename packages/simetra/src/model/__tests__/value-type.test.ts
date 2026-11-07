import { describe, it, expect } from "vitest"
import { z } from "zod"
import {
  LOGICAL_TYPES,
  valueTypeShape,
  refineValueType,
} from "../schemas/value-type"
import {
  attributeSchema,
  catalogAttributeSchema,
  registerFieldSchema,
} from "../schemas/attribute"
import { constantSchema } from "../schemas/constant"
import { tabularSectionSchema } from "../schemas/tabular-section"
import { registerAttributesSchema } from "../schemas/attribute"

const schema = z.object(valueTypeShape).superRefine(refineValueType)

function rules(input: unknown): string[] {
  const res = schema.safeParse(input)
  if (res.success) return []
  return res.error.issues.map(
    (i) => (i as { params?: { rule?: string } }).params?.rule ?? "?"
  )
}

const target = { kind: "Catalog", name: "Products" }

describe("value type rules", () => {
  it("String requires length", () => {
    expect(rules({ type: "String" })).toContain("type.length-required")
    expect(rules({ type: "String", length: 50 })).toEqual([])
  })

  it("length only for String", () => {
    expect(rules({ type: "Integer", length: 5 })).toContain(
      "type.length-not-allowed"
    )
  })

  it("Numeric accepts no precision", () => {
    expect(schema.safeParse({ type: "Numeric" }).success).toBe(true)
    expect(rules({ type: "Numeric", precision: 10, scale: 2 })).toEqual([])
  })

  it("scale requires precision", () => {
    expect(rules({ type: "Numeric", scale: 2 })).toContain(
      "type.scale-requires-precision"
    )
  })

  it("precision only for Numeric", () => {
    expect(rules({ type: "Integer", precision: 10 })).toContain(
      "type.precision-not-allowed"
    )
  })

  it("Ref needs exactly one of ref and allowedTypes", () => {
    expect(rules({ type: "Ref" })).toContain("type.ref-target-required")
    expect(
      rules({ type: "Ref", ref: target, allowedTypes: [target] })
    ).toContain("type.ref-exclusive")
    expect(rules({ type: "Ref", ref: target })).toEqual([])
    expect(rules({ type: "Ref", allowedTypes: [target] })).toEqual([])
  })

  it("allowedTypes must not be empty: an empty set yields a pair without CHECK", () => {
    expect(schema.safeParse({ type: "Ref", allowedTypes: [] }).success).toBe(
      false
    )
  })

  it("ref only for Ref", () => {
    expect(rules({ type: "String", length: 5, ref: target })).toContain(
      "type.ref-not-allowed"
    )
    expect(rules({ type: "Integer", allowedTypes: [target] })).toContain(
      "type.ref-not-allowed"
    )
  })

  it("array flag accepted for every logical type", () => {
    for (const type of LOGICAL_TYPES) {
      const input: Record<string, unknown> = { type, array: true }
      if (type === "String") input.length = 10
      if (type === "Ref") input.ref = target
      expect(rules(input), type).toEqual([])
    }
  })

  it("Binary is gone", () => {
    expect(schema.safeParse({ type: "Binary" }).success).toBe(false)
    expect(schema.safeParse({ type: "Bytes" }).success).toBe(true)
  })
})

/** Пара (правило, шлях) кожної власної перевірки — для типового значення. */
function defaultRules(input: Record<string, unknown>): [string, string][] {
  const res = attributeSchema.safeParse({ name: "field", ...input })
  if (res.success) return []
  return res.error.issues.map((i) => [
    (i as { params?: { rule?: string } }).params?.rule ?? "?",
    i.path.join("/"),
  ])
}

const MISMATCH: [string, string][] = [["type.default-mismatch", "defaultValue"]]
const INVALID: [string, string][] = [["type.default-invalid", "defaultValue"]]
const NOT_ALLOWED: [string, string][] = [
  ["type.default-not-allowed", "defaultValue"],
]

describe("default value (spec §5)", () => {
  it("Boolean takes a boolean", () => {
    expect(defaultRules({ type: "Boolean", defaultValue: false })).toEqual([])
    expect(defaultRules({ type: "Boolean", defaultValue: "true" })).toEqual(
      MISMATCH
    )
  })

  it("integer types take an integer within their range", () => {
    expect(defaultRules({ type: "Integer", defaultValue: 3 })).toEqual([])
    expect(defaultRules({ type: "Integer", defaultValue: 1.5 })).toEqual(
      INVALID
    )
    expect(defaultRules({ type: "Integer", defaultValue: "3" })).toEqual(
      MISMATCH
    )
    expect(defaultRules({ type: "Integer", defaultValue: 2 ** 31 })).toEqual(
      INVALID
    )
    expect(defaultRules({ type: "SmallInt", defaultValue: 32767 })).toEqual([])
    expect(defaultRules({ type: "SmallInt", defaultValue: 32768 })).toEqual(
      INVALID
    )
    expect(defaultRules({ type: "BigInt", defaultValue: 2 ** 40 })).toEqual([])
    expect(defaultRules({ type: "BigInt", defaultValue: 2 ** 60 })).toEqual(
      INVALID
    )
  })

  it("Numeric takes a number or a decimal string", () => {
    expect(defaultRules({ type: "Numeric", defaultValue: 0.5 })).toEqual([])
    expect(defaultRules({ type: "Numeric", defaultValue: "-12.50" })).toEqual(
      []
    )
    expect(defaultRules({ type: "Numeric", defaultValue: "1e3" })).toEqual(
      INVALID
    )
    expect(defaultRules({ type: "Numeric", defaultValue: true })).toEqual(
      MISMATCH
    )
  })

  it("string and temporal types take a string", () => {
    for (const type of ["Text", "Date", "DateTime"]) {
      const value = {
        Text: "x",
        Date: "2026-10-01",
        DateTime: "2026-10-01T00:00:00Z",
      }[type]
      expect(defaultRules({ type, defaultValue: value }), type).toEqual([])
      expect(defaultRules({ type, defaultValue: 1 }), type).toEqual(MISMATCH)
    }
    expect(
      defaultRules({ type: "String", length: 3, defaultValue: "UAH" })
    ).toEqual([])
    expect(
      defaultRules({ type: "String", length: 3, defaultValue: false })
    ).toEqual(MISMATCH)
  })

  // Правило дроту (спека П4-B §4.4): момент DDL `DEFAULT` поза роками
  // 1–9999 в UTC база збереже, а суворий декодер рядка не прочитає.
  it.each<[string, [string, string][]]>([
    ["9999-12-31T23:59:59-05:00", INVALID],
    ["0001-01-01T00:30:00+01:00", INVALID],
    ["9999-12-31T23:59:59Z", []],
    ["0001-01-01T00:00:00Z", []],
  ])("DateTime default %s by the UTC year rule", (value, expected) => {
    expect(defaultRules({ type: "DateTime", defaultValue: value })).toEqual(
      expected
    )
  })

  it("UUID takes a UUID string", () => {
    expect(
      defaultRules({
        type: "UUID",
        defaultValue: "00000000-0000-4000-8000-0000000000AB",
      })
    ).toEqual([])
    expect(defaultRules({ type: "UUID", defaultValue: "not-a-uuid" })).toEqual(
      INVALID
    )
  })

  it("single Ref takes a string: the target is checked by stage 4", () => {
    expect(
      defaultRules({ type: "Ref", ref: target, defaultValue: "Open" })
    ).toEqual([])
    expect(defaultRules({ type: "Ref", ref: target, defaultValue: 1 })).toEqual(
      MISMATCH
    )
  })

  it("array value takes no default", () => {
    expect(
      defaultRules({ type: "Boolean", array: true, defaultValue: false })
    ).toEqual(NOT_ALLOWED)
  })

  it("polymorphic Ref takes no default", () => {
    expect(
      defaultRules({ type: "Ref", allowedTypes: [target], defaultValue: "x" })
    ).toEqual(NOT_ALLOWED)
  })

  it("Bytes takes no default", () => {
    expect(defaultRules({ type: "Bytes", defaultValue: "AA==" })).toEqual(
      NOT_ALLOWED
    )
  })

  it("Json takes no default", () => {
    expect(defaultRules({ type: "Json", defaultValue: "{}" })).toEqual(
      NOT_ALLOWED
    )
  })

  it.each([
    [{ type: "DateTime", defaultValue: { fill: "now" } }, []],
    [{ type: "Date", defaultValue: { fill: "today" } }, []],
    [{ type: "UUID", defaultValue: { fill: "newUuid" } }, []],
    [
      { type: "Date", defaultValue: { fill: "now" } },
      ["type.default-fill-mismatch"],
    ],
    [
      { type: "DateTime", array: true, defaultValue: { fill: "now" } },
      ["type.default-fill-mismatch"],
    ],
    [
      { type: "String", length: 5, array: true, defaultValue: { empty: true } },
      [],
    ],
    [{ type: "Json", defaultValue: { empty: "array" } }, []],
    [
      { type: "Json", defaultValue: { empty: true } },
      ["type.default-empty-mismatch"],
    ],
    [
      { type: "Integer", defaultValue: { empty: "object" } },
      ["type.default-empty-mismatch"],
    ],
    [
      { type: "Integer", array: true, defaultValue: { empty: "array" } },
      ["type.default-empty-mismatch"],
    ],
  ])("default form %j", (input, expected) =>
    expect(defaultRules(input).map(([rule]) => rule)).toEqual(expected)
  )

  it("constant default follows the same rules", () => {
    const issues = (input: Record<string, unknown>) =>
      constantSchema
        .safeParse({ kind: "Constant", name: "C", ...input })
        .error?.issues.map(
          (i) => (i as { params?: { rule?: string } }).params?.rule
        ) ?? []
    expect(issues({ type: "Integer", defaultValue: 3 })).toEqual([])
    expect(issues({ type: "Integer", defaultValue: "3" })).toEqual([
      "type.default-mismatch",
    ])
    expect(issues({ type: "Json", defaultValue: "{}" })).toEqual([
      "type.default-not-allowed",
    ])
  })
})

describe("attribute uniqueness", () => {
  const issues = (input: Record<string, unknown>) =>
    (
      attributeSchema.safeParse({ name: "a", ...input }).error?.issues ?? []
    ).map((i) => (i as { params?: { rule?: string } }).params?.rule)

  it("ignoreCase is only for a scalar String or Text", () => {
    expect(issues({ type: "String", length: 5, unique: "ignoreCase" })).toEqual(
      []
    )
    expect(issues({ type: "Text", unique: "ignoreCase" })).toEqual([])
    expect(issues({ type: "Integer", unique: "ignoreCase" })).toEqual([
      "type.unique-ignore-case-type",
    ])
    expect(
      issues({ type: "String", length: 5, array: true, unique: "ignoreCase" })
    ).toEqual(["type.unique-ignore-case-type"])
    expect(issues({ type: "Integer", unique: true })).toEqual([])
  })

  it("personalData with required is an error", () => {
    const issues = (input: Record<string, unknown>) =>
      (
        attributeSchema.safeParse({ name: "a", type: "Boolean", ...input })
          .error?.issues ?? []
      ).map((i) => (i as { params?: { rule?: string } }).params?.rule)
    expect(issues({ personalData: true, required: true })).toEqual([
      "attribute.personal-data-required",
    ])
    expect(issues({ personalData: true })).toEqual([])
    expect(issues({ required: true })).toEqual([])
    expect(
      (
        catalogAttributeSchema.safeParse({
          name: "a",
          type: "Boolean",
          personalData: true,
          required: true,
        }).error?.issues ?? []
      ).map((i) => (i as { params?: { rule?: string } }).params?.rule)
    ).toEqual(["attribute.personal-data-required"])
  })

  it("uniqueWithin requires unique and exists only on catalog attributes", () => {
    const own = (input: Record<string, unknown>) =>
      (
        catalogAttributeSchema.safeParse({ name: "a", ...input }).error
          ?.issues ?? []
      ).map((i) => (i as { params?: { rule?: string } }).params?.rule)
    expect(
      own({ type: "Integer", unique: true, uniqueWithin: "owner" })
    ).toEqual([])
    expect(own({ type: "Integer", uniqueWithin: "parent" })).toEqual([
      "attribute.unique-within-requires-unique",
    ])
    expect(
      own({ type: "Integer", unique: false, uniqueWithin: "parent" })
    ).toEqual(["attribute.unique-within-requires-unique"])
    expect(
      catalogAttributeSchema.safeParse({
        name: "a",
        type: "Integer",
        unique: true,
        uniqueWithin: "x",
      }).success
    ).toBe(false)
    expect(
      attributeSchema.safeParse({
        name: "a",
        type: "Integer",
        unique: true,
        uniqueWithin: "owner",
      }).success
    ).toBe(false)
  })
})

// Лінивість (Рд25): колонки пари й реквізити ТЧ лінивими не бувають — фасад
// звіряє пару цілком, а масив ТЧ без лінивого поля стер би його значення.
describe("attribute load", () => {
  const pair = {
    name: "subject",
    type: "Ref",
    allowedTypes: [target, { kind: "Catalog", name: "Regions" }],
  }
  const issues = (
    schema: z.ZodType,
    input: Record<string, unknown>
  ): { rule?: string; path: PropertyKey[] }[] =>
    (schema.safeParse(input).error?.issues ?? []).map((i) => ({
      rule: (i as { params?: { rule?: string } }).params?.rule,
      path: i.path,
    }))
  const rule = "attribute.lazy-not-allowed"
  // Поле `attributes` регістра — та сама схема, що в обох видах регістрів.
  const informationRegisterLoadProbe = z.strictObject({
    attributes: registerAttributesSchema,
  })

  it.each<[string, z.ZodType, Record<string, unknown>, unknown[]]>([
    [
      "a lazy scalar",
      attributeSchema,
      { name: "a", type: "Bytes", load: "lazy" },
      [],
    ],
    ["an eager pair", attributeSchema, { ...pair, load: "eager" }, []],
    [
      "a lazy single Ref",
      catalogAttributeSchema,
      { name: "a", type: "Ref", ref: target, load: "lazy" },
      [],
    ],
    [
      "a lazy pair",
      attributeSchema,
      { ...pair, load: "lazy" },
      [{ rule, path: ["load"] }],
    ],
    [
      "a lazy pair of a catalog",
      catalogAttributeSchema,
      { ...pair, load: "lazy" },
      [{ rule, path: ["load"] }],
    ],
    [
      "an eager register attribute",
      informationRegisterLoadProbe,
      { attributes: [{ name: "a", type: "Integer", load: "eager" }] },
      [{ rule: "attribute.load-not-allowed", path: ["attributes", 0, "load"] }],
    ],
    [
      "a lazy tabular section attribute",
      tabularSectionSchema,
      {
        name: "lines",
        attributes: [
          { name: "qty", type: "Integer" },
          { name: "scan", type: "Bytes", load: "lazy" },
        ],
      },
      [{ rule, path: ["attributes", 1, "load"] }],
    ],
    [
      "an eager tabular section attribute",
      tabularSectionSchema,
      {
        name: "lines",
        attributes: [{ name: "scan", type: "Bytes", load: "eager" }],
      },
      [],
    ],
  ])("%s", (_, schema, input, expected) => {
    expect(issues(schema, input)).toEqual(expected)
  })

  it("a register field has no load", () => {
    const result = registerFieldSchema.safeParse({
      name: "a",
      type: "Integer",
      load: "eager",
    })
    expect(result.error?.issues.map((i) => i.code)).toEqual([
      "unrecognized_keys",
    ])
  })
})

// `maxBytes` (Рд26): лише для значень без межі типу; реквізит регістра його
// не задає — регістрів у каталозі рантайму ще немає (Рд1).
describe("attribute maxBytes", () => {
  const issues = (
    schema: z.ZodType,
    input: Record<string, unknown>
  ): { rule?: string; path: PropertyKey[] }[] =>
    (schema.safeParse(input).error?.issues ?? []).map((i) => ({
      rule: (i as { params?: { rule?: string } }).params?.rule,
      path: i.path,
    }))
  const typeRule = "type.max-bytes-type"
  const registerProbe = z.strictObject({ attributes: registerAttributesSchema })

  it.each<[string, z.ZodType, Record<string, unknown>, unknown[]]>([
    ["Text", attributeSchema, { name: "a", type: "Text", maxBytes: 1 }, []],
    [
      "Json",
      catalogAttributeSchema,
      { name: "a", type: "Json", maxBytes: 1 },
      [],
    ],
    ["Bytes", attributeSchema, { name: "a", type: "Bytes", maxBytes: 1 }, []],
    [
      "an Integer array",
      attributeSchema,
      { name: "a", type: "Integer", array: true, maxBytes: 1 },
      [],
    ],
    [
      "a tabular section Text",
      tabularSectionSchema,
      { name: "lines", attributes: [{ name: "a", type: "Text", maxBytes: 9 }] },
      [],
    ],
    [
      "a scalar Integer",
      attributeSchema,
      { name: "a", type: "Integer", maxBytes: 1 },
      [{ rule: typeRule, path: ["maxBytes"] }],
    ],
    [
      "a scalar String of a catalog",
      catalogAttributeSchema,
      { name: "a", type: "String", length: 10, maxBytes: 1 },
      [{ rule: typeRule, path: ["maxBytes"] }],
    ],
    [
      "a register attribute",
      registerProbe,
      { attributes: [{ name: "a", type: "Text", maxBytes: 1 }] },
      [
        {
          rule: "attribute.max-bytes-not-allowed",
          path: ["attributes", 0, "maxBytes"],
        },
      ],
    ],
  ])("%s", (_, schema, input, expected) => {
    expect(issues(schema, input)).toEqual(expected)
  })

  it.each([0, -1, 1.5])("refuses maxBytes %s", (maxBytes) => {
    expect(
      attributeSchema.safeParse({ name: "a", type: "Text", maxBytes }).success
    ).toBe(false)
  })
})

describe("attribute value checks", () => {
  const issues = (input: Record<string, unknown>) =>
    (
      attributeSchema.safeParse({ name: "a", ...input }).error?.issues ?? []
    ).map((i) => (i as { params?: { rule?: string } }).params?.rule)

  it("accepts bounds on numeric and format on string types", () => {
    expect(
      issues({
        type: "Numeric",
        precision: 10,
        scale: 2,
        nonNegative: true,
        maxValue: "1000.50",
      })
    ).toEqual([])
    expect(issues({ type: "Integer", positive: true, maxValue: 10 })).toEqual(
      []
    )
    expect(
      issues({ type: "BigInt", minValue: "-9223372036854775808" })
    ).toEqual([])
    expect(
      issues({
        type: "String",
        length: 10,
        pattern: "^[A-Z]{2,}\\d*$",
        minLength: 2,
      })
    ).toEqual([])
    expect(issues({ type: "Text", pattern: "(?<=a)b(?=c)" })).toEqual([])
  })

  it("positive and nonNegative are mutually exclusive", () => {
    expect(
      issues({ type: "Integer", positive: true, nonNegative: true })
    ).toEqual(["type.bound-conflict"])
  })

  it("minValue must not exceed maxValue", () => {
    expect(issues({ type: "Integer", minValue: 5, maxValue: 4 })).toEqual([
      "type.bound-order",
    ])
    expect(issues({ type: "Integer", minValue: 5, maxValue: 5 })).toEqual([])
    expect(
      issues({ type: "Numeric", minValue: "0.30", maxValue: 0.3 })
    ).toEqual([])
    expect(
      issues({ type: "Numeric", minValue: "10.01", maxValue: 10 })
    ).toEqual(["type.bound-order"])
  })

  it("a bound outside the type is invalid", () => {
    expect(issues({ type: "SmallInt", maxValue: 40000 })).toEqual([
      "type.bound-invalid",
    ])
    expect(issues({ type: "Integer", maxValue: "5" })).toEqual([
      "type.bound-invalid",
    ])
    expect(issues({ type: "Integer", minValue: 1.5 })).toEqual([
      "type.bound-invalid",
    ])
    expect(
      issues({ type: "Numeric", precision: 5, scale: 2, maxValue: "1000" })
    ).toEqual(["type.bound-invalid"])
    expect(issues({ type: "Numeric", maxValue: "abc" })).toEqual([
      "type.bound-invalid",
    ])
  })

  it("bounds apply only to a scalar numeric type", () => {
    expect(issues({ type: "String", length: 5, minValue: 1 })).toEqual([
      "type.bound-type",
    ])
    expect(issues({ type: "Integer", array: true, positive: true })).toEqual([
      "type.bound-type",
    ])
    expect(issues({ type: "Date", nonNegative: true })).toEqual([
      "type.bound-type",
    ])
  })

  it("pattern and minLength apply only to a scalar String or Text", () => {
    expect(issues({ type: "Integer", pattern: "^1$" })).toEqual([
      "type.format-type",
    ])
    expect(
      issues({ type: "String", length: 5, array: true, minLength: 1 })
    ).toEqual(["type.format-type"])
    expect(issues({ type: "String", length: 5, minLength: 0 })).not.toEqual([])
  })

  it.each([
    ["(", "unbalanced group"],
    ["(?<name>x)", "named group"],
    ["\\p{L}", "unicode property"],
    ["\\P{L}", "negated unicode property"],
    ["\\k<a>", "named backreference"],
    ["\\bword\\b", "word boundary"],
    ["[a-z]+(?<n>x)", "named group after a class"],
    ["(?i:a)", "inline modifier group"],
    ["(?-i:a)", "inline modifier removal"],
    ["(?i)a", "embedded option"],
    ["\\u{41}", "code-point escape"],
    ["[\\u{41}]", "code-point escape in a class"],
    ["\\x41", "hex escape"],
    ["[\\x41-\\x5A]", "hex escape in a class"],
  ])("pattern %s is rejected (%s)", (pattern) => {
    expect(issues({ type: "String", length: 5, pattern })).toEqual([
      "type.pattern-invalid",
    ])
  })

  it("an escaped backslash or a class does not trip the divergence scan", () => {
    expect(issues({ type: "Text", pattern: "^\\\\p\\d$" })).toEqual([])
    expect(issues({ type: "Text", pattern: "[(?<a]" })).toEqual([])
    expect(issues({ type: "Text", pattern: "[(?i]" })).toEqual([])
    expect(issues({ type: "Text", pattern: "\\\\x\\\\u" })).toEqual([])
  })

  it("lookaround and non-capturing groups pass the divergence scan", () => {
    expect(issues({ type: "Text", pattern: "(?:a)(?=b)(?!c)" })).toEqual([])
    expect(issues({ type: "Text", pattern: "\\u0041" })).toEqual([])
  })
})
