import { z } from "zod"
import { describe, expect, it } from "vitest"
import {
  FILTER_OPERATORS,
  READ_LIMIT_MAX,
  filterSchema,
  knownFormAllowed,
  knownSchema,
  type Filter,
} from "../read"

// Шлях — від поля запиту `where`: так його побачить `prepareRead`.
const querySchema = z.strictObject({ where: filterSchema })
const pathOf = (where: unknown): string | undefined => {
  const parsed = querySchema.safeParse({ where })
  return parsed.success ? undefined : parsed.error.issues[0]!.path.join(".")
}

const leaf = (value: unknown = "x"): Filter => ({
  attribute: "code",
  op: "eq",
  value,
})
const nested = (depth: number): Filter =>
  depth === 1 ? leaf() : { not: nested(depth - 1) }
const values = (n: number) => Array.from({ length: n }, (_, i) => i)

describe("filterSchema", () => {
  it.each<[string, unknown]>([
    ...FILTER_OPERATORS.map((op): [string, unknown] => [
      op,
      op === "isNull"
        ? { attribute: "code", op }
        : { attribute: "code", op, value: op === "in" ? ["a"] : "a" },
    ]),
    ["and of conditions", { and: [leaf(), leaf()] }],
    ["or under not", { not: { or: [leaf(), leaf()] } }],
    ["depth 8", nested(8)],
    ["64 nodes", { and: values(63).map(() => leaf()) }],
    ["in with 200 values", { attribute: "code", op: "in", value: values(200) }],
  ])("accepts %s", (_, where) => {
    expect(pathOf(where)).toBeUndefined()
  })

  it.each<[string, unknown, string]>([
    ["depth 9", nested(9), "where"],
    ["65 nodes", { and: values(64).map(() => leaf()) }, "where"],
    // Межу перевіряють усі ключі вузла: інакше глибина під другим ключем
    // доходила б до рекурсії Zod і давала RangeError замість відмови.
    ["deep or beside and", { and: [leaf()], or: [nested(5000)] }, "where"],
    ["deep not beside and", { and: [leaf()], not: nested(5000) }, "where"],
    ["an empty and", { and: [] }, "where.and"],
    ["an empty or", { or: [] }, "where.or"],
    [
      "in with 201 values",
      { attribute: "code", op: "in", value: values(201) },
      "where.value",
    ],
    ["an empty in", { attribute: "code", op: "in", value: [] }, "where.value"],
    [
      "in without an array",
      { attribute: "code", op: "in", value: "a" },
      "where.value",
    ],
    [
      "isNull with a value",
      { attribute: "code", op: "isNull", value: 1 },
      "where.value",
    ],
    ["eq without a value", { attribute: "code", op: "eq" }, "where.value"],
    ["an unknown node", { and: [leaf(), { search: "x" }] }, "where.and.1"],
    [
      "an unknown operator",
      { attribute: "code", op: "like", value: "a" },
      "where.op",
    ],
    [
      "a nested unknown operator",
      { not: { attribute: "code", op: "like" } },
      "where.not.op",
    ],
    ["an extra key", { attribute: "code", op: "eq", value: 1, x: 1 }, "where"],
    ["a non-object node", { or: [leaf(), 5] }, "where.or.1"],
  ])("rejects %s at its node", (_, where, path) => {
    expect(pathOf(where)).toBe(path)
  })
})

describe("knownSchema", () => {
  const EPOCH = "0123456789abcdef".repeat(4)
  const key = (i: number) =>
    `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`
  const KEY = key(1)
  // Ключ з літерами: на ключі з одних цифр регістр нічого не змінює.
  const LETTERS = "abcdefab-cdef-4abc-8def-abcdefabcdef"
  const known = (fields: Record<string, unknown> = {}) => ({
    epoch: EPOCH,
    keys: [KEY],
    versions: ["1"],
    ...fields,
  })
  const many = (n: number) => ({
    keys: Array.from({ length: n }, (_, i) => key(i)),
    versions: Array.from({ length: n }, () => "1"),
  })
  const pathOf = (value: unknown): string | undefined => {
    const parsed = knownSchema.safeParse(value)
    return parsed.success ? undefined : parsed.error.issues[0]!.path.join(".")
  }

  it.each<[string, unknown]>([
    ["one key", known()],
    [`${READ_LIMIT_MAX} keys`, known(many(READ_LIMIT_MAX))],
    ["no keys", known({ keys: [], versions: [] })],
    ["the largest safe version", known({ versions: ["9007199254740991"] })],
    ["a key in upper case", known({ keys: [LETTERS.toUpperCase()] })],
  ])("accepts %s", (_, value) => {
    expect(pathOf(value)).toBeUndefined()
  })

  it.each<[string, unknown, string]>([
    ["a short epoch", known({ epoch: EPOCH.slice(1) }), "epoch"],
    ["an upper-case epoch", known({ epoch: EPOCH.toUpperCase() }), "epoch"],
    ["a null epoch", known({ epoch: null }), "epoch"],
    ["a key that is not a UUID", known({ keys: ["k"] }), "keys.0"],
    [
      "a repeated key",
      known({ keys: [KEY, key(2), KEY], versions: ["1", "1", "1"] }),
      "keys.2",
    ],
    // Postgres рівняє UUID без регістру: інакше два записи одного рядка.
    [
      "a key repeated in another case",
      known({
        keys: [LETTERS, LETTERS.toUpperCase()],
        versions: ["1", "1"],
      }),
      "keys.1",
    ],
    ["more versions than keys", known({ versions: ["1", "2"] }), "versions"],
    [`${READ_LIMIT_MAX + 1} keys`, known(many(READ_LIMIT_MAX + 1)), "keys"],
    ["version 0", known({ versions: ["0"] }), "versions.0"],
    ["a negative version", known({ versions: ["-1"] }), "versions.0"],
    [
      "a version with a leading zero",
      known({ versions: ["01"] }),
      "versions.0",
    ],
    ["a fractional version", known({ versions: ["1.5"] }), "versions.0"],
    [
      "a version past 2^53 - 1",
      known({ versions: ["9007199254740992"] }),
      "versions.0",
    ],
    ["a version that is a number", known({ versions: [1] }), "versions.0"],
    ["an extra field", known({ more: true }), ""],
  ])("rejects %s", (_, value, path) => {
    expect(pathOf(value)).toBe(path)
  })
})

describe("knownFormAllowed", () => {
  const ID = "11111111-1111-4111-8111-111111111111"
  it.each<[string, boolean, Record<string, unknown>]>([
    ["a list", true, { limit: 1 }],
    ["a card", true, { id: ID }],
    ["a count", false, { count: true }],
    ["a section page", false, { tabularSection: "s", limit: 1 }],
    ["the lines of one owner", false, { tabularSection: "s", owner: ID }],
    ["a card with sections", false, { id: ID, tabularSections: true }],
    ["a card with include", false, { id: ID, include: ["org"] }],
    ["a list with include", false, { limit: 1, include: ["org"] }],
  ])("%s -> %s", (_, allowed, query) => {
    expect(knownFormAllowed(query)).toBe(allowed)
  })
})
