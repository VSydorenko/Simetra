import { describe, expect, it } from "vitest"
import {
  commandCoreLayer,
  compileRights,
  policyDomain,
  writeRoles,
} from "./fixtures/rights"

/** Колонки, які ядро кладе в `jsonb_build_object(… ::text)`. */
const textColumnsIn = (sql: string) =>
  [...sql.matchAll(/'([a-z_]+)', v_[a-z]+\.[a-z_]+::text/g)].map((m) => m[1]!)

describe("text-encoded columns of the command core", () => {
  it("returns exactly the numeric and bigint columns as text", async () => {
    const { model } = await compileRights(
      policyDomain(writeRoles(), commandCoreLayer())
    )
    const saves = model!.sqlUnits.filter((u) =>
      /^function:public\.[a-z_]+_save\(jsonb,int8\)$/.test(u.identity)
    )
    expect(saves.map((u) => u.identity)).toContain(
      "function:public.ticket_save(jsonb,int8)"
    )
    for (const unit of saves) {
      const table = unit.identity.slice(
        "function:public.".length,
        -"_save(jsonb,int8)".length
      )
      const columns = model!.physical.tables.find(
        (t) => t.name === table
      )!.columns
      // Явний перелік: фікстура A2 не має інших `numeric`/`bigint` колонок
      // у таблицях довідників, крім версії.
      expect(
        columns
          .filter((c) => /^(bigint|numeric)/.test(c.type))
          .map((c) => c.name),
        table
      ).toEqual(["version"])
      expect(textColumnsIn(unit.sql), table).toEqual(["version"])
    }
  })
})
