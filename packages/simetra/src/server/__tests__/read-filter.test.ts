import type { Filter, RuntimeAttribute } from "simetra/model"
import { describe, expect, it } from "vitest"
import {
  renderFilter,
  topLevelParentEq,
  type FilterColumn,
} from "../read-filter"
import { ID, OTHER, attributeOf } from "./fixtures"

// Колонки — з реквізитів фікстури; типи приведення — як їх дає компілятор.
const fromAttribute = (
  name: string,
  extra: Partial<RuntimeAttribute> = {},
  lazy = false
): [string, FilterColumn] => {
  const attribute = { ...attributeOf(name), ...extra }
  return [
    attribute.name,
    {
      name: attribute.name,
      column: attribute.column,
      castType: attribute.castType,
      type: attribute.type,
      attribute,
      lazy,
    },
  ]
}

const columns: ReadonlyMap<string, FilterColumn> = new Map([
  [
    "ref",
    { name: "ref", column: "id", castType: "uuid", type: "Key", lazy: false },
  ],
  [
    "version",
    {
      name: "version",
      column: "version",
      castType: "bigint",
      type: "Version",
      lazy: false,
    },
  ],
  [
    "lineNumber",
    {
      name: "lineNumber",
      column: "line_number",
      castType: "integer",
      type: "LineNumber",
      lazy: false,
    },
  ],
  fromAttribute("code"),
  fromAttribute("note"),
  fromAttribute("owner", { pgType: "uuid", castType: "uuid" }),
  fromAttribute("count", { castType: "integer" }),
  fromAttribute("flag", { castType: "boolean" }),
  fromAttribute("blob", { castType: "bytea" }),
  fromAttribute("payload", { castType: "jsonb" }),
  fromAttribute("tags", { castType: "integer[]" }),
  fromAttribute("status"),
  fromAttribute("subject"),
  fromAttribute(
    "body",
    { name: "body", column: "body_col", type: "Text" },
    true
  ),
] as [string, FilterColumn][])

/** Рендер з `bind`, що збирає параметри, як будівник `read.ts`. */
function render(filter: Filter) {
  const params: (string | null)[] = []
  const result = renderFilter(
    filter,
    columns,
    (value, cast) => {
      params.push(value)
      return `$${params.length}::${cast}`
    },
    "where"
  )
  return "error" in result ? result : { sql: result.sql, params }
}

const cond = (attribute: string, op: string, value?: unknown): Filter =>
  (value === undefined ? { attribute, op } : { attribute, op, value }) as Filter

describe("renderFilter", () => {
  it.each<[string, Filter, string, (string | null)[]]>([
    ["eq", cond("code", "eq", "ab"), `"code_col" = $1::text`, ["ab"]],
    ["ne", cond("count", "ne", 5), `"count_col" <> $1::integer`, ["5"]],
    ["lt", cond("count", "lt", 5), `"count_col" < $1::integer`, ["5"]],
    ["lte", cond("count", "lte", 5), `"count_col" <= $1::integer`, ["5"]],
    ["gt", cond("ref", "gt", ID), `"id" > $1::uuid`, [ID]],
    ["gte", cond("version", "gte", 3), `"version" >= $1::bigint`, ["3"]],
    ["isNull", cond("note", "isNull"), `"note_col" IS NULL`, []],
    [
      "in, one parameter per element",
      cond("owner", "in", [ID, OTHER]),
      `"owner_col" = ANY(ARRAY[$1::uuid, $2::uuid])`,
      [ID, OTHER],
    ],
    [
      "contains with pattern characters",
      cond("note", "contains", "50%_\\"),
      `"note_col" ILIKE $1::text`,
      ["%50\\%\\_\\\\%"],
    ],
    [
      "startsWith with pattern characters",
      cond("code", "startsWith", "%_\\"),
      `"code_col" ILIKE $1::text`,
      ["\\%\\_\\\\%"],
    ],
    [
      "an enum value by its name",
      cond("status", "eq", "Open"),
      `"status_col" = $1::text`,
      ["open"],
    ],
    [
      "a pair eq",
      cond("subject", "eq", { type: "Catalog.Project", id: ID }),
      `("subject_type" = $1::text AND "subject_col" = $2::uuid)`,
      ["project", ID],
    ],
    [
      "a pair ne",
      cond("subject", "ne", { type: "Catalog.Project", id: ID }),
      `NOT ("subject_type" = $1::text AND "subject_col" = $2::uuid)`,
      ["project", ID],
    ],
    [
      "a pair in",
      cond("subject", "in", [
        { type: "Catalog.Project", id: ID },
        { type: "Catalog.Region", id: OTHER },
      ]),
      `(("subject_type" = $1::text AND "subject_col" = $2::uuid) OR ` +
        `("subject_type" = $3::text AND "subject_col" = $4::uuid))`,
      ["project", ID, "region", OTHER],
    ],
    [
      "a pair isNull",
      cond("subject", "isNull"),
      `("subject_type" IS NULL AND "subject_col" IS NULL)`,
      [],
    ],
    ["isNull of an array", cond("tags", "isNull"), `"tags_col" IS NULL`, []],
    [
      "and, or and not as the tree",
      {
        and: [
          cond("code", "eq", "a"),
          { or: [cond("count", "gt", 1), { not: cond("flag", "eq", true) }] },
        ],
      },
      `("code_col" = $1::text AND ("count_col" > $2::integer OR ` +
        `NOT ("flag_col" = $3::boolean)))`,
      ["a", "1", "true"],
    ],
  ])("renders %s", (_, filter, sql, params) => {
    expect(render(filter)).toEqual({ sql, params })
  })

  it.each(["NULL", "a,b", '"', "}", "\\", "{1,2}"])(
    "passes the in element %j verbatim as its own parameter",
    (value) => {
      expect(render(cond("note", "in", [value, "x"]))).toEqual({
        sql: `"note_col" = ANY(ARRAY[$1::text, $2::text])`,
        params: [value, "x"],
      })
    }
  )

  it.each<[string, Filter, string, string?]>([
    [
      "an injected name",
      cond('x"; DROP TABLE t; --', "eq", 1),
      "where.attribute",
    ],
    ["a dotted name", cond("a.b", "eq", 1), "where.attribute"],
    ["a system column", cond("ctid", "eq", 1), "where.attribute"],
    ["an empty name", cond("", "eq", 1), "where.attribute"],
    [
      "the physical column name",
      cond("code_col", "eq", "a"),
      "where.attribute",
    ],
    ["a prototype key", cond("__proto__", "eq", 1), "where.attribute"],
    ["a lazy column", cond("body", "eq", "a"), "where.attribute", "lazy"],
    [
      "isNull of a lazy column",
      cond("body", "isNull"),
      "where.attribute",
      "lazy",
    ],
    ["contains on a number", cond("count", "contains", "1"), "where.op"],
    ["contains on a pair", cond("subject", "startsWith", "a"), "where.op"],
    ["lt on Json", cond("payload", "lt", 1), "where.op"],
    ["lt on Bytes", cond("blob", "lt", "\\x00"), "where.op"],
    ["lt on an array", cond("tags", "lt", 1), "where.op"],
    [
      "lt on a pair",
      cond("subject", "lt", { type: "Catalog.Project", id: ID }),
      "where.op",
    ],
    ["eq on Json", cond("payload", "eq", 1), "where.op"],
    ["in on an array", cond("tags", "in", [1]), "where.op"],
    ["eq with null", cond("code", "eq", null), "where.value", "use-isNull"],
    ["ne with null", cond("subject", "ne", null), "where.value", "use-isNull"],
    [
      "in with a null element",
      cond("code", "in", ["a", null]),
      "where.value.1",
      "use-isNull",
    ],
    ["lt with null", cond("count", "lt", null), "where.value"],
    ["a value of a wrong type", cond("count", "eq", "5"), "where.value"],
    ["a too long string", cond("code", "eq", "abcd"), "where.value"],
    ["a NUL character", cond("note", "contains", "a\u0000"), "where.value"],
    ["a bad in element", cond("owner", "in", [ID, "nope"]), "where.value.1"],
    [
      "a bad pair",
      cond("subject", "eq", { type: "Catalog.Nope", id: ID }),
      "where.value",
    ],
    ["a bad key", cond("ref", "eq", "nope"), "where.value"],
    ["a fractional version", cond("version", "eq", 1.5), "where.value"],
    // Приведення `$n::integer`: значення поза int4 дало б 22003 і command.internal.
    [
      "a line number past int4",
      cond("lineNumber", "gt", 2_147_483_648),
      "where.value",
    ],
    [
      "a line number below int4",
      cond("lineNumber", "in", [1, -2_147_483_649]),
      "where.value.1",
    ],
    [
      "the second operand of and",
      { and: [cond("code", "eq", "a"), cond("ctid", "eq", 1)] },
      "where.and.1.attribute",
    ],
    ["under not", { not: cond("count", "eq", "x") }, "where.not.value"],
  ])("refuses %s without binding", (_, filter, path, reason) => {
    let bound = 0
    const result = renderFilter(filter, columns, () => `$${++bound}`, "where")
    expect(result).toEqual({
      error: {
        code: "command.invalid",
        path,
        ...(reason === undefined ? {} : { reason }),
      },
    })
    expect(bound).toBe(0)
  })
})

describe("topLevelParentEq", () => {
  const parent = cond("owner", "eq", ID)

  it.each<[string, Filter | undefined, unknown]>([
    ["the root condition", parent, ID],
    ["a root and conjunct", { and: [cond("code", "eq", "a"), parent] }, ID],
    ["under or", { or: [parent, cond("code", "eq", "a")] }, undefined],
    ["under not", { not: parent }, undefined],
    ["an in", cond("owner", "in", [ID]), undefined],
    ["a nested and", { and: [{ and: [parent] }] }, undefined],
    ["another attribute", cond("code", "eq", ID), undefined],
    ["no filter", undefined, undefined],
  ])("%s", (_, filter, expected) => {
    expect(topLevelParentEq(filter, "owner")).toBe(expected)
  })
})
