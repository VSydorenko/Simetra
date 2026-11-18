import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  DATABASE_PROVIDERS,
  isObjectTable,
  type DatabaseProvider,
} from "simetra/model"
import { mechanicsUpdateTriggerName } from "../mechanics-units"
import { renderModelIndependentLayer } from "../platform-triggers"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import {
  PROJECT_FILE,
  compileRights,
  policyDomain,
  writeRoles,
} from "./fixtures/rights"
import { expectClean } from "./helpers"

let parse: SqlParser
const models = new Map<DatabaseProvider, CompiledModel>()
beforeAll(async () => {
  parse = await loadSqlParser()
  for (const provider of DATABASE_PROVIDERS) {
    const files = policyDomain(writeRoles())
    // Гранти залежать від ролей профілю: той самий проєкт — на кожному профілі
    const project = JSON.parse(files.get(PROJECT_FILE)!) as {
      database?: object
    }
    files.set(
      PROJECT_FILE,
      JSON.stringify({
        ...project,
        database: { ...project.database, provider },
      })
    )
    const result = await compileRights(files)
    expectClean(result)
    models.set(provider, result.model!)
  }
})

// Одне джерело тексту: те, що кладе `build*Units`, збігається з рендером шару,
// який читає еталон зворотної генерації.
describe("renderModelIndependentLayer", () => {
  it.each(DATABASE_PROVIDERS)(
    "equals the build*Units output for every table of a kind without carrier copies (%s)",
    (provider) => {
      const model = models.get(provider)!
      const byIdentity = new Map(model.sqlUnits.map((u) => [u.identity, u]))
      let compared = 0
      for (const table of model.physical.tables.filter(isObjectTable)) {
        // Таблиця з копіями носіїв має тригер оновлення з `WHEN` (Р3)
        if (
          byIdentity.has(
            `trigger:${table.schema}.${table.name}.${mechanicsUpdateTriggerName(table.name)}`
          )
        )
          continue
        for (const unit of renderModelIndependentLayer(
          table,
          provider,
          parse
        )) {
          const built = byIdentity.get(unit.identity)
          if (built === undefined) continue
          expect(
            { sql: built.sql, class: built.class, generator: built.generator },
            unit.identity
          ).toEqual({
            sql: unit.sql,
            class: unit.class,
            generator: unit.generator,
          })
          compared++
        }
      }
      expect(compared).toBeGreaterThan(0)
    }
  )

  it.each(DATABASE_PROVIDERS)(
    "covers the shared functions and the three trigger families (%s)",
    (provider) => {
      const table = models
        .get(provider)!
        .physical.tables.filter(isObjectTable)[0]!
      const identities = renderModelIndependentLayer(
        table,
        provider,
        parse
      ).map((u) => u.identity)
      expect(identities).toEqual(
        expect.arrayContaining([
          "function:simetra.touch()",
          "function:simetra.author()",
          "function:simetra.key_immutable()",
        ])
      )
      expect(identities.filter((i) => i.startsWith("trigger:"))).toHaveLength(4)
    }
  )

  it("grants differ between the profiles, so the per-provider rows are not vacuous", () => {
    const table = models
      .get("supabase")!
      .physical.tables.filter(isObjectTable)[0]!
    const grants = (provider: DatabaseProvider) =>
      renderModelIndependentLayer(table, provider, parse)
        .filter((u) => u.class === "grant")
        .map((u) => u.sql)
    expect(grants("postgres")).not.toEqual(grants("supabase"))
  })
})
