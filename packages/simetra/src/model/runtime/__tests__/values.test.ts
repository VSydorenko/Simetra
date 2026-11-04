import { describe, expect, it } from "vitest"
import { runtimeObjectSchema, type RuntimeAttribute } from "../catalog"
import { encodeMemberValues } from "../values"

// Об'єкт каталогу збирається вручну: T0 не імпортує фікстури вищих ярусів.
const attr = (
  name: string,
  type: RuntimeAttribute["type"],
  extra: Partial<RuntimeAttribute> = {}
): RuntimeAttribute => ({
  name,
  column: `${name}_col`,
  pgType: "text",
  castType: "text",
  type,
  required: false,
  insert: true,
  update: true,
  ...extra,
})

const OTHER = "22222222-2222-4222-8222-222222222222"

const member = runtimeObjectSchema.parse({
  id: "00000000-0000-4000-8000-000000000001",
  name: "Member",
  kind: "Catalog",
  kindLabel: "member",
  table: { schema: "public", name: "member" },
  key: "id",
  keyName: "ref",
  versionColumn: "version",
  versionName: "version",
  attributes: [
    attr("user", "UUID", { pgType: "uuid", castType: "uuid" }),
    attr("code", "String", { maxLength: 3 }),
    attr("amount", "Numeric", {
      pgType: "numeric(10,2)",
      precision: 10,
      scale: 2,
    }),
    attr("subject", "Ref", {
      pgType: "uuid",
      castType: "uuid",
      pair: {
        typeColumn: "subject_type",
        targets: [
          { object: { kind: "Catalog", name: "Project" }, label: "project" },
        ],
      },
    }),
    attr("computed", "Integer", { insert: false, update: false }),
  ],
  tabularSections: [],
  operations: {},
  constraints: [],
})

const FORCED = ["user"]

describe("encodeMemberValues", () => {
  it.each([
    ["a forced key", { user: OTHER }, "user"],
    ["a key outside insert", { computed: 1 }, "computed"],
    ["an unknown key", { nope: 1 }, "nope"],
    ["an undefined value", { code: undefined }, "code"],
    ["an invalid value", { code: "abcd" }, "code"],
    ["a table key", { ref: OTHER }, "ref"],
    ["null values", null, "values"],
    ["values that are not an object", [], "values"],
    // Р-A3-8: реквізити за порядком каталогу, невідомі ключі — після них.
    [
      "an unknown key before an invalid value",
      { nope: 1, code: "abcd" },
      "code",
    ],
    ["two invalid values", { amount: 1.5, code: "abcd" }, "code"],
  ])("rejects %s", (_, values, path) => {
    expect(encodeMemberValues(member, values, FORCED)).toEqual({
      error: { code: "command.invalid", path },
    })
  })

  it("encodes values and pairs by physical column", () => {
    expect(
      encodeMemberValues(
        member,
        {
          code: "abc",
          amount: "12.50",
          subject: { type: "Catalog.Project", id: OTHER },
        },
        FORCED
      )
    ).toEqual({
      columns: {
        code_col: "abc",
        amount_col: "12.50",
        subject_type: "project",
        subject_col: OTHER,
      },
    })
    expect(encodeMemberValues(member, { code: null }, FORCED)).toEqual({
      columns: { code_col: null },
    })
    expect(encodeMemberValues(member, {}, FORCED)).toEqual({ columns: {} })
  })
})
