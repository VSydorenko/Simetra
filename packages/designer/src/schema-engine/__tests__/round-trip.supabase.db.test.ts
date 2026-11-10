import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import { reverseGenerate } from "simetra/schema"
import {
  engine,
  errors,
  inTarget,
  parser,
  presetClassFixtures,
  roundTripOf,
  schemaPath,
  scopeOf,
  useRoundTrip,
} from "./round-trip.support"

/**
 * Round-trip на стеку Supabase: класи, що читають пресет провайдера (ACL схеми
 * `public` відносно пресета), і тип з розширення стеку. Решта корпусу —
 * `round-trip.db.test.ts`; спільна підготовка — `round-trip.support.ts`.
 */

useRoundTrip()

describe("class fixtures survive the round trip", () => {
  for (const fixture of presetClassFixtures()) {
    it(fixture.name, async () => {
      const scope = scopeOf(fixture.schemas)
      await inTarget(fixture.sql, scope, async (target) => {
        const result = await roundTripOf(target, scope, {
          defaultSchema: fixture.schemas[0]!,
          attributeCase: "snake_case",
          databaseProvider: "supabase",
        })
        expect(fixture.property(result.target)).toEqual(fixture.expected)
        expect(fixture.property(result.shadow)).toEqual(fixture.expected)
        expect(result.shadow).toEqual(result.target)
      })
    })
  }
})

describe("function volatility is read under the extraction search_path", () => {
  // Рядковий тип представлення розширення стеку: без DDL у `extensions`
  it("a VOLATILE function over a type in extensions gets explicit VOLATILE and is not debt", async () => {
    const scope = scopeOf(["app", "public"])
    await inTarget(
      `CREATE SCHEMA app;
       CREATE FUNCTION app.rate(a extensions.pg_stat_statements_info)
         RETURNS integer LANGUAGE sql VOLATILE AS $$ SELECT 1 $$;`,
      scope,
      async (target) => {
        const extracted = await engine.extract(target, scope)
        expect(errors(extracted.diagnostics)).toEqual([])
        const unit = extracted.model.units.find(
          (u) => u.class === "function" && u.name === "rate"
        )
        expect(unit?.volatility).toBe("volatile")
        const reversed = await reverseGenerate(extracted.model, {
          project: {
            name: "RoundTrip",
            defaultSchema: "app",
            attributeCase: "snake_case",
            databaseProvider: "supabase",
          },
          existing: new Map(),
          newId: () => randomUUID(),
          schemaPath,
          parse: parser(),
        })
        expect(errors(reversed.diagnostics)).toEqual([])
        const text = [...reversed.files].find(([path]) =>
          path.includes("/rate")
        )?.[1]
        expect(text).toMatch(/\bVOLATILE\b/)
        const debt = JSON.parse(
          reversed.files.get("sql-debt.json") ?? "{}"
        ) as { units?: string[] }
        expect(debt.units ?? []).not.toContain(unit!.identity)
      }
    )
  })
})
