import { describe, expect, it } from "vitest"
import {
  commandCoreLayer,
  compileRights,
  policyDomain,
  runtimeValuesLayer,
  wideBigintLayer,
  writeRoles,
} from "./fixtures/rights"

/** Колонки, які ядро кладе в `jsonb_build_object(… ::text)`, з формою приведення. */
const textColumnsIn = (sql: string, row: string) =>
  [
    ...sql.matchAll(
      new RegExp(`'([a-z0-9_]+)', ${row}\\.[a-z0-9_]+::(text(?:\\[\\])?)`, "g")
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

  // 4 текстові колонки `Gauge` + 60 `BigInt` = 64 пари: один виклик дав би 128
  // аргументів, а Postgres приймає до 100 — ядро впало б на першому виконанні.
  it("splits more than 50 text columns into chunked jsonb_build_object calls", async () => {
    const { model } = await compileRights(
      policyDomain(writeRoles(), commandCoreLayer(), wideBigintLayer(60))
    )
    const save = model!.sqlUnits.find(
      (u) => u.identity === "function:public.gauge_save(jsonb,int8)"
    )!
    expect(textColumnsIn(save.sql, "v_row")).toHaveLength(64)
    const result = save.sql.match(/v_result := (.*);/)![1]!
    const chunks = [...result.matchAll(/jsonb_build_object\(/g)]
    expect(chunks).toHaveLength(2)
    expect(result).toMatch(
      /^to_jsonb\(v_row\) \|\| \(jsonb_build_object\(.*\) \|\| jsonb_build_object\(.*\)\)$/
    )
  })
})
