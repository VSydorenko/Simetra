import { describe, expect, it } from "vitest"
import { SHADOW_PREFIX, shadowAgeMinutes } from "./connection"

describe("shadowAgeMinutes", () => {
  const NOW = Date.UTC(2026, 9, 14, 12, 0, 0)

  it("reads the age in minutes from the base36 millisecond stamp", () => {
    const created = NOW - 90 * 60_000
    expect(
      shadowAgeMinutes(`${SHADOW_PREFIX}${created.toString(36)}_x`, NOW)
    ).toBeCloseTo(90, 5)
  })

  it("treats a name of another shape as unknown, not as old", () => {
    expect(shadowAgeMinutes("pgdelta_shadow_zz")).toBeUndefined()
    expect(shadowAgeMinutes("other")).toBeUndefined()
  })
})
