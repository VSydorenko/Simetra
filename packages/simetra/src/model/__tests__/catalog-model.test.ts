import { describe, it, expect } from "vitest"
import {
  catalogFromSnapshot,
  diffCatalogModels,
  type CatalogModel,
  type CatalogTable,
  type PhysicalSnapshot,
} from "../physical"

function table(over: Partial<CatalogTable> = {}): CatalogTable {
  return {
    schema: "public",
    name: "orders",
    rowLevelSecurity: "none",
    columns: [
      { name: "id", type: "uuid", notNull: true },
      { name: "amount", type: "numeric", notNull: false },
    ],
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
    ...over,
  } as CatalogTable
}

const model = (t: CatalogTable = table()): CatalogModel => ({
  tables: [t],
  enumTypes: [],
  units: [],
})

describe("catalog model", () => {
  it("catalog from snapshot drops origin", () => {
    const snapshot = {
      tables: [
        {
          ...table(),
          origin: { objectId: "o1" },
          columns: table().columns.map((c) => ({
            ...c,
            origin: { standard: "id" },
          })),
        },
      ],
      enumTypes: [
        {
          schema: "public",
          name: "e",
          values: ["a"],
          origin: { objectId: "o2" },
        },
      ],
    } as PhysicalSnapshot
    const catalog = catalogFromSnapshot(snapshot)
    expect(catalog.tables).toEqual([table()])
    expect(catalog.enumTypes).toEqual([
      { schema: "public", name: "e", values: ["a"] },
    ])
  })

  it("a row rule check equals the same check without origin", () => {
    const check = {
      name: "orders_amount_set",
      expression: "amount IS NOT NULL",
    }
    const snapshot = {
      tables: [
        {
          ...table({ checks: [check] }),
          origin: { objectId: "o1" },
          checks: [{ ...check, origin: { rowRule: { file: "x.sql" } } }],
        },
      ],
      enumTypes: [],
    } as unknown as PhysicalSnapshot
    const catalog = catalogFromSnapshot(snapshot)
    expect(catalog.tables).toEqual([table({ checks: [check] })])
    expect(
      diffCatalogModels(
        { ...catalog, units: [] },
        model(table({ checks: [check] }))
      )
    ).toEqual([])
  })

  it("identical models have no differences", () => {
    expect(diffCatalogModels(model(), model())).toEqual([])
  })

  it("reordered columns are an order difference", () => {
    const t = table()
    const reordered = table({ columns: [...t.columns].reverse() })
    expect(diffCatalogModels(model(), model(reordered))).toEqual([
      expect.objectContaining({
        path: "tables.public.orders.columns",
        kind: "order",
      }),
    ])
  })

  it("missing and extra index", () => {
    const ix = (name: string) => ({
      name,
      unique: false,
      method: "btree",
      keys: [{ column: "amount" }],
      include: [],
      nullsNotDistinct: false,
    })
    const diffs = diffCatalogModels(
      model(table({ indexes: [ix("ix_a")] })),
      model(table({ indexes: [ix("ix_b")] }))
    )
    expect(diffs.map((d) => [d.path, d.kind])).toEqual([
      ["tables.public.orders.indexes.ix_a", "missing"],
      ["tables.public.orders.indexes.ix_b", "extra"],
    ])
  })

  it("changed check expression", () => {
    const diffs = diffCatalogModels(
      model(table({ checks: [{ name: "c", expression: "amount > 0" }] })),
      model(table({ checks: [{ name: "c", expression: "amount >= 0" }] }))
    )
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({
      path: "tables.public.orders.checks.c",
      kind: "changed",
    })
  })

  it("units compared by identity and text", () => {
    const unit = (identity: string, sql: string) => ({
      class: "function" as const,
      identity,
      schema: "public",
      name: "f",
      sql,
    })
    const a: CatalogModel = {
      tables: [],
      enumTypes: [],
      units: [
        unit("function:public.f()", "select 1"),
        unit("function:public.g()", "x"),
      ],
    }
    const b: CatalogModel = {
      tables: [],
      enumTypes: [],
      units: [
        unit("function:public.f()", "select 2"),
        unit("function:public.h()", "x"),
      ],
    }
    expect(diffCatalogModels(a, b).map((d) => [d.path, d.kind])).toEqual([
      ["units.function:public.f()", "changed"],
      ["units.function:public.g()", "missing"],
      ["units.function:public.h()", "extra"],
    ])
  })
})
