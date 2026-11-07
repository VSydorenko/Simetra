import { z } from "zod"
import { describe, expect, it } from "vitest"
import { FILTER_OPERATORS, filterSchema, type Filter } from "../read"

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
