import { describe, expect, it } from "vitest"
import {
  FILTER_DEPTH_MAX,
  FILTER_NODES_MAX,
  ORDER_BY_MAX,
  filterWithinLimits,
  type Filter,
  type OrderBy,
} from "../read"
import { keysetFilter, keysetNodesMax, type KeysetCursor } from "../keyset"

const KEY = "ref"

const c = (attribute: string, op: string, value?: unknown): Filter =>
  value === undefined
    ? { attribute, op: op as "isNull" }
    : { attribute, op: op as "eq", value }
const and = (...items: Filter[]): Filter => ({ and: items })
const or = (...items: Filter[]): Filter => ({ or: items })
const notNull = (attribute: string): Filter => ({
  not: c(attribute, "isNull"),
})

const after = (values: KeysetCursor["values"], key = "k"): KeysetCursor => ({
  values,
  key,
  direction: "after",
})
const before = (values: KeysetCursor["values"], key = "k"): KeysetCursor => ({
  values,
  key,
  direction: "before",
})

const A_LAST: OrderBy = [{ attribute: "a", direction: "asc" }]
const A_FIRST: OrderBy = [{ attribute: "a", direction: "asc", nulls: "first" }]

/** Глибина за мірою `withinLimits`: лист — рівень 1. */
const depthOf = (filter: Filter): number =>
  "and" in filter
    ? 1 + Math.max(...filter.and.map(depthOf))
    : "or" in filter
      ? 1 + Math.max(...filter.or.map(depthOf))
      : "not" in filter
        ? 1 + depthOf(filter.not)
        : 1

describe("keysetFilter", () => {
  it.each<[string, OrderBy, KeysetCursor, Filter]>([
    [
      "one column, nulls first, after",
      A_FIRST,
      after({ a: 5 }),
      and(
        c("a", "gte", 5),
        or(c("a", "gt", 5), and(c("a", "eq", 5), c(KEY, "gt", "k")))
      ),
    ],
    [
      "one column, default nulls last, after",
      A_LAST,
      after({ a: 5 }),
      and(
        or(c("a", "gte", 5), c("a", "isNull")),
        or(
          or(c("a", "gt", 5), c("a", "isNull")),
          and(c("a", "eq", 5), c(KEY, "gt", "k"))
        )
      ),
    ],
    [
      "one column descending (nulls first by default), after",
      [{ attribute: "a", direction: "desc" }],
      after({ a: 5 }),
      and(
        c("a", "lte", 5),
        or(c("a", "lt", 5), and(c("a", "eq", 5), c(KEY, "gt", "k")))
      ),
    ],
    [
      "one column, nulls last, before mirrors after",
      A_LAST,
      before({ a: 5 }),
      and(
        c("a", "lte", 5),
        or(c("a", "lt", 5), and(c("a", "eq", 5), c(KEY, "lt", "k")))
      ),
    ],
    [
      "one column descending, before: NULL side joins the bound",
      [{ attribute: "a", direction: "desc" }],
      before({ a: 5 }),
      and(
        or(c("a", "gte", 5), c("a", "isNull")),
        or(
          or(c("a", "gt", 5), c("a", "isNull")),
          and(c("a", "eq", 5), c(KEY, "lt", "k"))
        )
      ),
    ],
    [
      "NULL cursor, nulls last, after: only NULLs remain",
      A_LAST,
      after({ a: null }),
      and(c("a", "isNull"), and(c("a", "isNull"), c(KEY, "gt", "k"))),
    ],
    [
      "NULL cursor, nulls first, after: the bound would be vacuous and is omitted",
      A_FIRST,
      after({ a: null }),
      or(notNull("a"), and(c("a", "isNull"), c(KEY, "gt", "k"))),
    ],
    [
      "NULL cursor, nulls last, before: the bound would be vacuous and is omitted",
      A_LAST,
      before({}),
      or(notNull("a"), and(c("a", "isNull"), c(KEY, "lt", "k"))),
    ],
    [
      "two columns, mixed directions",
      [
        { attribute: "a", direction: "asc", nulls: "first" },
        { attribute: "b", direction: "desc", nulls: "first" },
      ],
      after({ a: 1, b: 2 }),
      and(
        c("a", "gte", 1),
        or(
          c("a", "gt", 1),
          and(c("a", "eq", 1), c("b", "lt", 2)),
          and(c("a", "eq", 1), c("b", "eq", 2), c(KEY, "gt", "k"))
        )
      ),
    ],
    [
      "two columns, NULL second value, nulls last: its branch drops out",
      [
        { attribute: "a", direction: "asc", nulls: "first" },
        { attribute: "b", direction: "asc" },
      ],
      after({ a: 1, b: null }),
      and(
        c("a", "gte", 1),
        or(
          c("a", "gt", 1),
          and(c("a", "eq", 1), c("b", "isNull"), c(KEY, "gt", "k"))
        )
      ),
    ],
    [
      "three columns, nulls first",
      [
        { attribute: "a", direction: "asc", nulls: "first" },
        { attribute: "b", direction: "asc", nulls: "first" },
        { attribute: "c", direction: "asc", nulls: "first" },
      ],
      after({ a: 1, b: 2, c: 3 }),
      and(
        c("a", "gte", 1),
        or(
          c("a", "gt", 1),
          and(c("a", "eq", 1), c("b", "gt", 2)),
          and(c("a", "eq", 1), c("b", "eq", 2), c("c", "gt", 3)),
          and(
            c("a", "eq", 1),
            c("b", "eq", 2),
            c("c", "eq", 3),
            c(KEY, "gt", "k")
          )
        )
      ),
    ],
    [
      "the order already ends with the key: it is not added twice",
      [
        { attribute: "a", direction: "asc", nulls: "first" },
        { attribute: KEY, direction: "desc" },
      ],
      after({ a: 5 }),
      and(
        c("a", "gte", 5),
        or(c("a", "gt", 5), and(c("a", "eq", 5), c(KEY, "lt", "k")))
      ),
    ],
    [
      "no columns: the key alone, without a redundant bound",
      [],
      after({}),
      c(KEY, "gt", "k"),
    ],
  ])("%s", (_, orderBy, cursor, expected) => {
    expect(keysetFilter(orderBy, cursor, KEY)).toEqual(expected)
  })

  it("refuses a cursor without a key", () => {
    expect(() =>
      keysetFilter(A_LAST, { ...after({ a: 1 }), key: undefined! }, KEY)
    ).toThrow(TypeError)
  })
})

/** Усі порядки з `n` колонок: напрям і `nulls` кожної (типове теж). */
function orders(n: number): OrderBy[] {
  let out: OrderBy[] = [[]]
  for (let i = 0; i < n; i++) {
    out = out.flatMap((prefix) =>
      (["asc", "desc"] as const).flatMap((direction) =>
        [undefined, "first", "last"].map((nulls) => [
          ...prefix,
          {
            attribute: `c${i}`,
            direction,
            ...(nulls === undefined ? {} : { nulls: nulls as "first" }),
          },
        ])
      )
    )
  }
  return out
}

/** Перебір напрямів і NULL / не-NULL курсора: незалежний від `keysetNodesMax`. */
function enumerated(orderBy: OrderBy): Filter[] {
  const out: Filter[] = []
  for (const direction of ["after", "before"] as const) {
    for (let mask = 0; mask < 1 << orderBy.length; mask++) {
      const values: Record<string, unknown> = {}
      orderBy.forEach((entry, i) => {
        values[entry.attribute] = (mask >> i) & 1 ? null : 7
      })
      out.push(keysetFilter(orderBy, { values, key: "k", direction }, KEY))
    }
  }
  return out
}

const nodes = (filter: Filter): number =>
  "and" in filter
    ? 1 + filter.and.reduce((n, f) => n + nodes(f), 0)
    : "or" in filter
      ? 1 + filter.or.reduce((n, f) => n + nodes(f), 0)
      : "not" in filter
        ? 1 + nodes(filter.not)
        : 1

describe("keyset depth and budget", () => {
  const ALL = [...orders(1), ...orders(2), ...orders(ORDER_BY_MAX)]

  it("holds depth 5 for every order up to ORDER_BY_MAX columns", () => {
    const depths = ALL.flatMap((orderBy) => enumerated(orderBy)).map(depthOf)
    expect(Math.max(...depths)).toBe(5)
    expect(
      ALL.every((orderBy) => enumerated(orderBy).every(filterWithinLimits))
    ).toBe(true)
  })

  it("pins the node count of the ORDER_BY_MAX default order", () => {
    const orderBy: OrderBy = Array.from({ length: ORDER_BY_MAX }, (_, i) => ({
      attribute: `c${i}`,
      direction: "asc" as const,
    }))
    expect(keysetNodesMax(orderBy)).toBe(
      Math.max(...enumerated(orderBy).map(nodes))
    )
    expect(keysetNodesMax(orderBy)).toBe(EXPECTED_WORST_ASC)
  })

  it("keysetNodesMax equals the enumerated maximum for every order", () => {
    const mismatches = ALL.filter(
      (orderBy) =>
        keysetNodesMax(orderBy) !== Math.max(...enumerated(orderBy).map(nodes))
    )
    expect(mismatches).toEqual([])
  })

  /** Фільтр глибини 7 рівно з `count` вузлів. */
  const where = (count: number, depth = FILTER_DEPTH_MAX - 1): Filter => {
    let inner: Filter = or(
      ...Array.from({ length: count - depth + 1 }, () => c("a", "isNull"))
    )
    for (let level = 0; level < depth - 2; level++) inner = { not: inner }
    return inner
  }

  it.each(
    [orders(1)[0]!, orders(2)[3]!, orders(ORDER_BY_MAX)[100]!, A_LAST].map(
      (orderBy, i) => [i, orderBy] as const
    )
  )(
    "a where of depth limit-1 fits with the worst keyset exactly at the node limit (order %i)",
    (_, orderBy) => {
      const room = FILTER_NODES_MAX - keysetNodesMax(orderBy) - 1
      const worst = enumerated(orderBy).reduce((a, b) =>
        nodes(a) >= nodes(b) ? a : b
      )
      const fits = where(room)
      expect(depthOf(fits)).toBe(FILTER_DEPTH_MAX - 1)
      expect(nodes(fits)).toBe(room)
      expect(filterWithinLimits(and(fits, worst))).toBe(true)
      expect(filterWithinLimits(and(where(room + 1), worst))).toBe(false)
    }
  )

  it("a where at the depth limit does not fit with any keyset", () => {
    expect(
      filterWithinLimits(
        and(
          where(FILTER_DEPTH_MAX + 2, FILTER_DEPTH_MAX),
          enumerated(A_LAST)[0]!
        )
      )
    ).toBe(false)
  })
})

const EXPECTED_WORST_ASC = 32
