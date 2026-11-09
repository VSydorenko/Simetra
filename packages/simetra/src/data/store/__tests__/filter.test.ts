import {
  CommandFailure,
  keysetFilter,
  type Filter,
  type OrderBy,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import { DataError } from "../../errors"
import {
  checkFilterBudget,
  compareRows,
  compileFilter,
  evaluateFilter,
  fieldInfoOf,
  filterCollator,
} from "../filter"
import type { Values } from "../types"
import {
  FILTER_CASES,
  FILTER_REFUSALS,
  FILTER_ROWS,
  filterObject,
  key,
} from "./filter-fixture"

const info = fieldInfoOf(filterObject)
const collator = filterCollator()

/** Номери рядків фікстури, які пропускає фільтр. */
const selected = (filter: Filter, rows: readonly Values[] = FILTER_ROWS) =>
  rows
    .filter((row) => evaluateFilter(filter, row, info, collator))
    .map((row) => Number((row.ref as string).slice(-12)))

const refusal = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    if (error instanceof CommandFailure) return error.error
    if (error instanceof DataError) return { code: error.code }
    throw error
  }
  throw new Error("no refusal")
}

describe("evaluateFilter", () => {
  it.each(FILTER_CASES)("%s", (_, filter, expected) => {
    expect(selected(filter)).toEqual(expected)
  })

  it.each(FILTER_REFUSALS)("refuses %s", (_, filter, error) => {
    expect(refusal(() => selected(filter))).toEqual(error)
  })

  it("refuses at compilation, before any row", () => {
    expect(
      refusal(() =>
        compileFilter({ attribute: "nope", op: "isNull" }, info, collator)
      )
    ).toEqual({ code: "data.unsupported-predicate" })
  })
})

describe("compareRows", () => {
  const order = (orderBy: OrderBy, user = collator) =>
    [...FILTER_ROWS]
      .sort(compareRows(orderBy, info, "ref", user))
      .map((row) => Number((row.ref as string).slice(-12)))
  const nulls = [6, 7, 8, 9, 10, 11, 12, 13, 14, 16]

  it("orders Numeric numerically, NULL last ascending, key last", () => {
    expect(order([{ attribute: "amount", direction: "asc" }])).toEqual([
      4,
      5,
      2,
      1,
      15,
      3,
      ...nulls,
    ])
  })

  it("puts NULL first descending", () => {
    expect(order([{ attribute: "amount", direction: "desc" }])).toEqual([
      ...nulls,
      3,
      1,
      15,
      2,
      5,
      4,
    ])
  })

  it("takes nulls and the key direction from orderBy", () => {
    expect(
      order([
        { attribute: "amount", direction: "asc", nulls: "first" },
        { attribute: "ref", direction: "desc" },
      ])
    ).toEqual([...[...nulls].reverse(), 4, 5, 2, 15, 1, 3])
  })

  it("orders DateTime lexically", () => {
    expect(order([{ attribute: "at", direction: "asc" }]).slice(0, 2)).toEqual([
      2, 1,
    ])
  })

  it("orders an enumeration by label", () => {
    expect(
      order([{ attribute: "status", direction: "asc" }]).slice(0, 3)
    ).toEqual([2, 3, 1])
  })

  it("orders strings by the user's collator", () => {
    const rows = [
      { ref: key(1), name: "ö" },
      { ref: key(2), name: "z" },
    ]
    const sorted = (locale: string) =>
      [...rows]
        .sort(
          compareRows(
            [{ attribute: "name", direction: "asc" }],
            info,
            "ref",
            new Intl.Collator(locale)
          )
        )
        .map((row) => row.name)
    expect(sorted("en")).toEqual(["ö", "z"])
    expect(sorted("sv")).toEqual(["z", "ö"])
  })

  it.each<[string, OrderBy, object]>([
    [
      "an array",
      [{ attribute: "tags", direction: "asc" }],
      { path: "orderBy.0.attribute" },
    ],
    [
      "a pair",
      [{ attribute: "subject", direction: "asc" }],
      { path: "orderBy.0.attribute" },
    ],
    [
      "Json",
      [{ attribute: "payload", direction: "asc" }],
      { path: "orderBy.0.attribute" },
    ],
    [
      "Bytes",
      [{ attribute: "blob", direction: "asc" }],
      { path: "orderBy.0.attribute" },
    ],
    [
      "an unknown attribute",
      [{ attribute: "nope", direction: "asc" }],
      { path: "orderBy.0.attribute" },
    ],
    [
      "a lazy attribute",
      [{ attribute: "memo", direction: "asc" }],
      { path: "orderBy.0.attribute", reason: "lazy" },
    ],
    [
      "the key before the last place",
      [
        { attribute: "ref", direction: "asc" },
        { attribute: "name", direction: "asc" },
      ],
      { path: "orderBy.0" },
    ],
  ])("refuses sorting by %s", (_, orderBy, error) => {
    expect(refusal(() => compareRows(orderBy, info, "ref", collator))).toEqual({
      code: "command.invalid",
      ...error,
    })
  })
})

describe("checkFilterBudget", () => {
  const deep = (depth: number): Filter =>
    depth === 1 ? { attribute: "name", op: "isNull" } : { not: deep(depth - 1) }

  it("passes a filter at the depth limit", () => {
    expect(() => checkFilterBudget(deep(8))).not.toThrow()
  })

  it("refuses a user filter at the limit plus a keyset", () => {
    const orderBy: OrderBy = [{ attribute: "count", direction: "asc" }]
    const combined: Filter = {
      and: [
        deep(8),
        keysetFilter(
          orderBy,
          { values: FILTER_ROWS[0]!, key: key(1), direction: "after" },
          "ref"
        ),
      ],
    }
    expect(refusal(() => checkFilterBudget(combined))).toEqual({
      code: "command.invalid",
      path: "where",
    })
  })

  it("refuses a filter over the node limit", () => {
    const wide: Filter = {
      or: Array.from({ length: 64 }, () => deep(1)),
    }
    expect(refusal(() => checkFilterBudget(wide))).toEqual({
      code: "command.invalid",
      path: "where",
    })
  })
})
