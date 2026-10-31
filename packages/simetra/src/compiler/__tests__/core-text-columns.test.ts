import { describe, expect, it } from "vitest"
import {
  commandCoreLayer,
  compileRights,
  policyDomain,
  runtimeValuesLayer,
  writeRoles,
} from "./fixtures/rights"

/** Колонки, які ядро кладе в `jsonb_build_object(… ::text)`, з формою приведення. */
const textColumnsIn = (sql: string, row: string) =>
  [
    ...sql.matchAll(
      new RegExp(`'([a-z_]+)', ${row}\\.[a-z_]+::(text(?:\\[\\])?)`, "g")
    ),
  ].map((m) => `${m[1]}::${m[2]}`)

describe("text-encoded columns of the command core", () => {
  // `Gauge` має `Numeric`, `BigInt` і масив `BigInt` у шапці та `Numeric` у ТЧ:
  // генератор, що віддає текстом лише версію, тут червоніє.
  it("returns the numeric and bigint columns of the header and the section as text", async () => {
    const { model } = await compileRights(
      policyDomain(writeRoles(), commandCoreLayer(), runtimeValuesLayer())
    )
    const save = model!.sqlUnits.find(
      (u) => u.identity === "function:public.gauge_save(jsonb,int8)"
    )!
    expect(textColumnsIn(save.sql, "v_row")).toEqual([
      "version::text",
      "amount::text",
      "counter::text",
      "marks::text[]",
    ])
    expect(textColumnsIn(save.sql, "r")).toEqual(["qty::text"])
  })
})
