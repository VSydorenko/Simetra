import { provisionCoLocatedShadow } from "@supabase/pg-delta"
import { describe, expect, it } from "vitest"
import type { EngineScope } from "simetra/schema"
import {
  runObjectPatterns,
  runTag,
  testDatabaseUrl,
} from "../../../../simetra/test/support"
import { inTarget, query } from "./db"
import {
  expectNoLeftoverShadows,
  leftoverShadows,
  provisionedShadows,
} from "./shadows"

/**
 * Облік провізій тіней (план тест-інфраструктури, задача 4): обгортка
 * setupFile-у DB-проєкту дає тіні тег прогону й записує її ім'я, а перевірка
 * після файлу ловить лише тіні цього файлу.
 */

const scope: EngineScope = { schemas: ["app"], provider: "supabase" }

async function exists(name: string): Promise<boolean> {
  const rows = await query<{ n: number }>(
    testDatabaseUrl(),
    "select count(*)::int as n from pg_database where datname = $1",
    [name]
  )
  return rows[0]?.n === 1
}

describe("shadow provisioning ledger", () => {
  it("records the engine's shadow under a run-tagged name", async () => {
    const before = provisionedShadows().length
    const seen = await inTarget("select 1;", scope, async (url) =>
      new URL(url).pathname.slice(1)
    )
    const recorded = provisionedShadows().slice(before)
    expect(recorded).toEqual([seen])
    expect(seen).toMatch(runObjectPatterns(runTag()).databases)
    expect(await leftoverShadows()).toEqual([])
  })

  it("keeps a suffix the caller gave", async () => {
    const suffix = `${Date.now().toString(36)}_${runTag()}_given0`
    const shadow = await provisionCoLocatedShadow(testDatabaseUrl(), {
      uniqueSuffix: suffix,
    })
    try {
      expect(shadow.name).toBe(`pgdelta_shadow_${suffix}`)
      expect(provisionedShadows()).toContain(shadow.name)
    } finally {
      await shadow.cleanup()
    }
    expect(await exists(shadow.name)).toBe(false)
  })

  it("drops and names a shadow this file left behind", async () => {
    // Провізія без `cleanup` — сирота, яку лишив би тест, що вийшов за
    // тайм-аут посеред роботи з тінню
    const orphan = await provisionCoLocatedShadow(testDatabaseUrl())
    expect(orphan.name).toMatch(runObjectPatterns(runTag()).databases)
    expect(await leftoverShadows()).toEqual([orphan.name])
    await expect(expectNoLeftoverShadows()).rejects.toThrow(orphan.name)
    expect(await exists(orphan.name)).toBe(false)
    expect(await leftoverShadows()).toEqual([])
  })
})
