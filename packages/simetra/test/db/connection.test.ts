import { readFileSync } from "node:fs"
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

describe("connection.ts weight", () => {
  // globalSetup і прибиральник вантажать цей модуль у головному процесі та в
  // spawnSync, тож він має лишатися легким
  it("imports nothing from the package sources", () => {
    const source = readFileSync(
      new URL("./connection.ts", import.meta.url),
      "utf8"
    )
    expect(source).not.toMatch(/from\s+"\.\.\/\.\.\/src/)
  })
})
