import { buildFactBase, encodeId, type StableId } from "@supabase/pg-delta"
import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import {
  PROVIDER_OWNER_ROLES,
  type DatabaseProvider,
  type FunctionVolatility,
} from "simetra/model"
import { mapModel } from "../pg-delta/map-model"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const schema: StableId = { kind: "schema", name: "app" }
const fn: StableId = { kind: "function", schema: "app", name: "f", args: [] }

/** Одна функція без волатильності в тексті — як її друкує `pg_get_functiondef`. */
function mapped(
  volatility: ReadonlyMap<string, FunctionVolatility>,
  provider: DatabaseProvider = "supabase"
) {
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
    provider,
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

describe("provider preset of the public schema grants", () => {
  // Схема `public` без жодного ACL-факту: усе, що пресет провайдера дає
  // `public`, відкликане, і мапер називає саме отримувачів пресету
  const revokes = (provider: DatabaseProvider) => {
    const view = buildFactBase(
      [{ id: { kind: "schema", name: "public" }, payload: {} }],
      []
    )
    return mapModel(view, {
      provider,
      produced: new Map(),
      parse,
      defaults: { owner: "postgres", entries: [] },
      extensionComments: new Map(),
      volatility: new Map(),
    }).model.units.map((u) => u.sql)
  }

  it("supabase revokes its five preset grantees", () => {
    expect(revokes("supabase")).toHaveLength(5)
  })

  it("postgres revokes only PUBLIC", () => {
    expect(revokes("postgres")).toEqual([
      "REVOKE USAGE ON SCHEMA public FROM PUBLIC",
    ])
  })
})

describe("the owner edge to the session role", () => {
  const table: StableId = { kind: "table", schema: "app", name: "doc" }
  // Ребро `owner` у виді двигуна — як його лишає проєкція: на postgres
  // типового власника немає, тож ребро до ролі сесії доходить до мапера
  const ownerIssues = (provider: DatabaseProvider, owner: string) => {
    const role: StableId = { kind: "role", name: owner }
    const view = buildFactBase(
      [
        { id: schema, payload: {} },
        { id: table, parent: schema, payload: {} },
        { id: role, payload: {} },
      ],
      [{ from: table, to: role, kind: "owner" }]
    )
    return mapModel(view, {
      provider,
      produced: new Map(),
      parse,
      defaults: { owner: PROVIDER_OWNER_ROLES[provider], entries: [] },
      extensionComments: new Map(),
      volatility: new Map(),
    }).issues.filter((i) => i.property === "owner")
  }

  it.each(["postgres", "supabase"] as const)(
    "%s: an object owned by the session role raises no issue",
    (provider) => {
      expect(ownerIssues(provider, PROVIDER_OWNER_ROLES[provider])).toEqual([])
    }
  )

  it.each(["postgres", "supabase"] as const)(
    "%s: an owner other than the session role is unrepresentable by name",
    (provider) => {
      expect(ownerIssues(provider, "app_admin")).toEqual([
        {
          object: table,
          property: "owner",
          detail: "owner role:app_admin is not the default owner",
        },
      ])
    }
  )
})
