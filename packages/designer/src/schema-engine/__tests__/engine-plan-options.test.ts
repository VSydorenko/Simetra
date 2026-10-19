import type { FactBase, PlanOptions } from "@supabase/pg-delta"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { EngineScope } from "simetra/schema"

const planSpy = vi.hoisted(() => vi.fn())
vi.mock("@supabase/pg-delta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@supabase/pg-delta")>()),
  plan: planSpy,
}))

// Імпорт після `vi.mock`, щоб адаптер узяв підміну двигуна
const { PgDeltaCatalog, createPgDeltaEngine, scopeKeyOf } =
  await import("../pg-delta/adapter")

const scope: EngineScope = { schemas: ["app"], provider: "supabase" }
const noFacts = { facts: () => [] } as unknown as FactBase

function catalog(tag: string, key = scopeKeyOf(scope)) {
  const options = { params: { tag } } as unknown as PlanOptions
  return { options, catalog: new PgDeltaCatalog(noFacts, options, key) }
}

/**
 * `optionsFrom`: опції плану (роль, можливості, профіль) беруться з бази, до
 * якої план застосують, а не з джерела. Двигун підмінено, щоб бачити, які
 * опції до нього дійшли.
 */
describe("SchemaEngine.plan options", () => {
  beforeEach(() => {
    planSpy.mockReset()
    planSpy.mockReturnValue({ actions: [], preamble: [], diagnostics: [] })
  })
  const engine = createPgDeltaEngine()

  it("plans with the options of optionsFrom, not of the source", () => {
    const source = catalog("source")
    const target = catalog("target")
    const applied = catalog("applied")
    engine.plan(source.catalog, target.catalog, scope, {
      optionsFrom: applied.catalog,
    })
    expect(planSpy).toHaveBeenCalledTimes(1)
    expect(planSpy.mock.calls[0]![2]).toBe(applied.options)
  })

  it("keeps the options of the source without optionsFrom", () => {
    const source = catalog("source")
    engine.plan(source.catalog, catalog("target").catalog, scope)
    expect(planSpy.mock.calls[0]![2]).toBe(source.options)
  })

  it("refuses an optionsFrom catalog extracted under another scope", () => {
    expect(() =>
      engine.plan(catalog("a").catalog, catalog("b").catalog, scope, {
        optionsFrom: catalog("c", "other").catalog,
      })
    ).toThrow("different scope")
  })
})

/**
 * Преамбула двигуна проти дозволеного переліку — на кожному шляху плану
 * адаптера: невідоме налаштування дає помилку в діагностиках плану, а не
 * тихе виконання (рішення 13 плану П3-2a).
 */
describe("SchemaEngine.plan preamble", () => {
  const engine = createPgDeltaEngine()

  it("reports a preamble setting outside the allowed list", () => {
    planSpy.mockReset()
    planSpy.mockReturnValue({
      actions: [],
      preamble: [{ name: "role", value: "postgres" }],
      diagnostics: [],
    })
    const enginePlan = engine.plan(
      catalog("source").catalog,
      catalog("target").catalog,
      scope
    )
    expect(enginePlan.preamble).toEqual([{ name: "role", value: "postgres" }])
    expect(
      enginePlan.diagnostics.map((d) => [d.code, d.severity, d.params])
    ).toEqual([
      ["engine.preamble-unknown", "error", { name: "role", value: "postgres" }],
    ])
  })
})
