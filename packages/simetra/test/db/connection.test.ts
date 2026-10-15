import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  newRunTag,
  RUN_TAG_ENV,
  runObjectPatterns,
  runTag,
  SHADOW_PREFIX,
  shadowAgeMinutes,
  shadowSuffix,
  testDatabaseName,
  testRoleName,
} from "./connection"

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

describe("run tag names", () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it("generates a tag of 6 chars [0-9a-z]", () => {
    expect(newRunTag()).toMatch(/^[0-9a-z]{6}$/)
  })

  it("refuses to work without the tag set by the stack-guard", () => {
    vi.stubEnv(RUN_TAG_ENV, "")
    delete process.env[RUN_TAG_ENV]
    expect(() => runTag()).toThrow(/stack-guard/)
  })

  it("builds role names from the label and the tag", () => {
    vi.stubEnv(RUN_TAG_ENV, "abc123")
    expect(testRoleName("build_plan_owner")).toBe(
      "simetra_build_plan_owner_abc123"
    )
    expect(() => testRoleName("Bad-Label")).toThrow()
  })

  it("matches own names with the run patterns", () => {
    vi.stubEnv(RUN_TAG_ENV, "abc123")
    const { databases, roles } = runObjectPatterns("abc123")
    expect(testDatabaseName("copy")).toMatch(databases)
    expect(SHADOW_PREFIX + shadowSuffix()).toMatch(databases)
    expect(testRoleName("x")).toMatch(roles)
  })

  it("reads the shadow age from the tagged name", () => {
    vi.stubEnv(RUN_TAG_ENV, "abc123")
    expect(shadowAgeMinutes(SHADOW_PREFIX + shadowSuffix())).toBeLessThan(1)
  })

  it("does not match foreign names", () => {
    const { databases, roles } = runObjectPatterns("abc123")
    for (const name of [
      "pgdelta_shadow_mv9rieqo_6uepn5",
      "metahub_copy",
      "metahub_copy_rehearsal",
      "p3_3_spike_a",
      "simetra_build_plan_owner",
      "simetra_copy_zzz999_k3j2h1",
      "postgres",
    ]) {
      expect(name).not.toMatch(databases)
      expect(name).not.toMatch(roles)
    }
  })
})
