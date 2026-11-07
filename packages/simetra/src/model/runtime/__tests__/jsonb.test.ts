import { describe, expect, it } from "vitest"
import { JSONB_PAIRS_PER_CALL, jsonbBuildObject } from "../jsonb"

const pairs = (count: number) =>
  Array.from({ length: count }, (_, i) => `'k${i}', ${i}`)

/** Кількість пар у кожному виклику `jsonb_build_object`, за порядком. */
const chunkSizes = (sql: string) =>
  [...sql.matchAll(/jsonb_build_object\(([^)]*)\)/g)].map(
    (m) => m[1]!.split(", ").length / 2
  )

describe("jsonbBuildObject", () => {
  it.each([
    [1, [1]],
    [JSONB_PAIRS_PER_CALL, [50]],
    [51, [50, 1]],
    [120, [50, 50, 20]],
  ])("splits %i pairs into calls of at most 50", (count, sizes) => {
    const sql = jsonbBuildObject(pairs(count))
    expect(chunkSizes(sql)).toEqual(sizes)
    // Один виклик — без дужок; кілька — `||` у дужках, щоб `||` не змішався з
    // оператором навколо.
    if (sizes.length === 1) expect(sql).toMatch(/^jsonb_build_object\(.*\)$/)
    else expect(sql).toMatch(/^\(jsonb_build_object\(.*\) \|\| .*\)$/)
  })

  it("keeps the pair order across chunks", () => {
    expect(jsonbBuildObject(pairs(51))).toBe(
      `(jsonb_build_object(${pairs(50).join(", ")}) || jsonb_build_object('k50', 50))`
    )
  })

  it("throws on no pairs", () => {
    expect(() => jsonbBuildObject([])).toThrow()
  })
})
