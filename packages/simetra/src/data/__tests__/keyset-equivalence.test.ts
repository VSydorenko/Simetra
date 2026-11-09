import {
  keysetFilter,
  type Filter,
  type KeysetCursor,
  type OrderBy,
} from "simetra/model"
import { describe, expect, it } from "vitest"
import {
  compareRows,
  compileFilter,
  fieldInfoOf,
  filterCollator,
} from "../store/filter"
import {
  FILTER_ROWS,
  filterObject,
  key,
} from "../store/__tests__/filter-fixture"
import type { Values } from "../store/types"

/*
 * Keyset-умова T0 і порядок `full` ядра мають збігатися: умова пропускає
 * рівно ті рядки, що йдуть після (до) курсора за компаратором. Колонки лише
 * `Integer` і `DateTime`: колатор клієнта й `COLLATE "C"` бази розходяться на
 * рядках, а тут порівнюється логіка гілок, не колатор.
 */

const info = fieldInfoOf(filterObject)
const collator = filterCollator()

/** Детермінований ГПСЧ (mulberry32): ті самі 500 рядків на кожному запуску. */
function prng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomRows(count: number): Values[] {
  const random = prng(20261108)
  const pick = (n: number) => Math.floor(random() * n)
  const days = Array.from(
    { length: 4 },
    (_, i) => `2026-01-0${i + 1}T10:00:00.000000Z`
  )
  return Array.from({ length: count }, (_, i) => ({
    ref: key(i + 1),
    // Мало різних значень першої колонки: групи рівних, `NULL` у кожній.
    count: pick(5) === 0 ? null : pick(4),
    small: pick(4) === 0 ? null : pick(3),
    at: pick(4) === 0 ? null : days[pick(days.length)],
    day: pick(4) === 0 ? null : `2026-02-0${1 + pick(3)}`,
  }))
}

const ROWS = randomRows(500)

const term = (
  attribute: string,
  direction: "asc" | "desc",
  nulls?: "first" | "last"
) => ({ attribute, direction, ...(nulls === undefined ? {} : { nulls }) })

const ORDERS: [string, OrderBy][] = [
  ["one column, default nulls", [term("count", "asc")]],
  ["one column descending", [term("count", "desc")]],
  ["nulls first ascending", [term("count", "asc", "first")]],
  ["nulls last descending", [term("count", "desc", "last")]],
  ["two columns", [term("count", "asc"), term("at", "desc")]],
  [
    "two columns, nulls reversed",
    [term("count", "asc", "first"), term("at", "desc", "last")],
  ],
  [
    "three columns, mixed",
    [term("count", "desc"), term("small", "asc", "first"), term("at", "asc")],
  ],
  [
    "four columns",
    [
      term("small", "asc"),
      term("count", "desc", "first"),
      term("day", "asc", "last"),
      term("at", "desc"),
    ],
  ],
  ["the key last, descending", [term("count", "asc"), term("ref", "desc")]],
  ["the key alone", []],
]

describe("keysetFilter against the full-view comparator", () => {
  it.each(ORDERS)("%s", (_, orderBy) => {
    const compare = compareRows(orderBy, info, "ref", collator)
    const sorted = [...ROWS].sort(compare)
    const cursors = [
      0,
      1,
      7,
      Math.floor(sorted.length / 2),
      sorted.length - 2,
      sorted.length - 1,
      ...sorted.flatMap((row, i) =>
        orderBy.some((e) => row[e.attribute] === null) && i % 40 === 0
          ? [i]
          : []
      ),
    ]
    for (const at of cursors) {
      const row = sorted[at]!
      for (const direction of ["after", "before"] as const) {
        const cursor: KeysetCursor = {
          values: row,
          key: row.ref as string,
          direction,
        }
        const filter: Filter = keysetFilter(orderBy, cursor, "ref")
        const test = compileFilter(filter, info, collator)
        const expected = (
          direction === "after" ? sorted.slice(at + 1) : sorted.slice(0, at)
        ).map((r) => r.ref)
        const passed = sorted.filter(test).map((r) => r.ref)
        expect({ at, direction, passed }).toEqual({
          at,
          direction,
          passed: expected,
        })
      }
    }
  })

  it("pages the fixture through NULL without loss or duplicates", () => {
    const orderBy: OrderBy = [
      term("day", "desc", "last"),
      term("amount", "asc"),
      term("ref", "desc"),
    ]
    const compare = compareRows(orderBy, info, "ref", collator)
    const all = [...FILTER_ROWS].sort(compare).map((r) => r.ref)
    const out: unknown[] = []
    let rest = [...FILTER_ROWS].sort(compare)
    while (rest.length > 0) {
      const page = rest.slice(0, 3)
      out.push(...page.map((r) => r.ref))
      const last = page[page.length - 1]!
      const test = compileFilter(
        keysetFilter(
          orderBy,
          { values: last, key: last.ref as string, direction: "after" },
          "ref"
        ),
        info,
        collator
      )
      rest = FILTER_ROWS.filter(test).sort(compare)
    }
    expect(out).toEqual(all)
  })
})
