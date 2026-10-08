import { buildFactBase, encodeId, type StableId } from "@supabase/pg-delta"
import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import type { FunctionVolatility } from "simetra/model"
import { mapModel } from "../pg-delta/map-model"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const schema: StableId = { kind: "schema", name: "app" }
const fn: StableId = { kind: "function", schema: "app", name: "f", args: [] }

/** Одна функція без волатильності в тексті — як її друкує `pg_get_functiondef`. */
function mapped(volatility: ReadonlyMap<string, FunctionVolatility>) {
  const view = buildFactBase(
    [
      { id: schema, payload: {} },
      {
        id: fn,
        parent: schema,
        payload: {
          def: "CREATE OR REPLACE FUNCTION app.f()\n RETURNS integer\n LANGUAGE sql\nAS $function$ SELECT 1 $function$",
        },
      },
    ],
    []
  )
  return mapModel(view, {
    produced: new Map(),
    parse,
    defaults: { owner: "postgres", entries: [] },
    extensionComments: new Map(),
    volatility,
  })
}

describe("function volatility in the catalog model", () => {
  it("the catalog fact becomes the unit's volatility", () => {
    const { model, issues } = mapped(new Map([[encodeId(fn), "volatile"]]))
    expect(issues.filter((i) => i.property === "volatility")).toEqual([])
    expect(model.units.find((u) => u.class === "function")?.volatility).toBe(
      "volatile"
    )
  })

  // Ключ, що не збігся з ідентичністю двигуна, — не тиха відсутність слова
  it("a function without a volatility fact is unrepresentable by name", () => {
    const { issues } = mapped(new Map())
    expect(issues.filter((i) => i.property === "volatility")).toEqual([
      {
        object: fn,
        property: "volatility",
        detail: "pg_proc has no volatility under the engine identity",
      },
    ])
  })
})
