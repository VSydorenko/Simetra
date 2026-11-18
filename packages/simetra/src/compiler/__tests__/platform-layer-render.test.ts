import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import { isObjectTable } from "simetra/model"
import { mechanicsUpdateTriggerName } from "../mechanics-units"
import { renderModelIndependentLayer } from "../platform-triggers"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { compileRights, policyDomain, writeRoles } from "./fixtures/rights"
import { expectClean } from "./helpers"

let parse: SqlParser
let model: CompiledModel
beforeAll(async () => {
  parse = await loadSqlParser()
  const result = await compileRights(policyDomain(writeRoles()))
  expectClean(result)
  model = result.model!
})

// Одне джерело тексту: те, що кладе `build*Units`, збігається з рендером шару,
// який читає еталон зворотної генерації.
describe("renderModelIndependentLayer", () => {
  it("equals the build*Units output for every table of a kind without carrier copies", () => {
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
        "supabase",
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
  })

  it("covers the shared functions and the three trigger families", () => {
    const table = model.physical.tables.filter(isObjectTable)[0]!
    const identities = renderModelIndependentLayer(
      table,
      "supabase",
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
  })
})
