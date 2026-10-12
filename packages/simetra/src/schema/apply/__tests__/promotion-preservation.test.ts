import { describe, expect, it } from "vitest"
import type { PromotionRecord } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import {
  preservationPlan,
  preservationQuery,
  renameIntent,
  type PreservedTable,
} from "simetra/schema"

/**
 * Доказ збереження рядків і значень змаплених колонок (рішення 6 плану
 * П3-2a): які вирази заміри «до» й «після» порівнюють і як виглядає один
 * прохід по таблиці. Справжня база — у `execute-plan.db.test.ts` designer.
 */

const OBJECT_ID = "00000000-0000-4000-8000-000000000001"

function record(over: Partial<PromotionRecord>): PromotionRecord {
  return {
    format: 1,
    base: "0".repeat(64),
    result: "1".repeat(64),
    objectId: OBJECT_ID,
    kind: "Catalog",
    labelDropped: false,
    tables: [],
    columns: [],
    typeChanges: [],
    dataSteps: [],
    retired: [],
    relaxed: [],
    tightened: [],
    rowLevelSecurity: [],
    deleteSemantics: [],
    conversions: [],
    movedUnits: [],
    rewrittenUnits: [],
    contractChanges: [],
    ...over,
  }
}

function table(
  name: string,
  columns: readonly string[],
  primaryKey?: readonly string[]
): PhysicalTable {
  return {
    schema: "app",
    name,
    origin: { objectId: OBJECT_ID },
    rowLevelSecurity: "enabled",
    columns: columns.map((c) => ({
      name: c,
      type: "text",
      notNull: false,
      origin: {},
    })),
    ...(primaryKey === undefined
      ? {}
      : { primaryKey: { name: `${name}_pkey`, columns: [...primaryKey] } }),
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  }
}

const column = (table: string, from: string, to: string, n: number) => ({
  id: `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`,
  sourceId: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`,
  schema: "app",
  table,
  from,
  to,
})

/** Таблиця `t` → `u`: ключ `id` → `ref`, `Name` → `name`, `x` міняє тип. */
const RENAMED = record({
  tables: [{ id: OBJECT_ID, schema: "app", from: "t", to: "u" }],
  columns: [
    column("u", "id", "ref", 1),
    column("u", "Name", "name", 2),
    column("u", "x", "x", 3),
  ],
  typeChanges: [
    { schema: "app", table: "u", column: "x", from: "bigint", to: "integer" },
  ],
  retired: [{ sourceId: OBJECT_ID, schema: "app", table: "t", column: "old" }],
})
const BEFORE = { tables: [table("t", ["id", "Name", "x", "old"], ["id"])] }
const DESIRED = { tables: [table("u", ["ref", "name", "x"], ["ref"])] }
const STEPS = new Map([[JSON.stringify(["app", "u", "x"]), "s7"]])

const plan = (
  r: PromotionRecord = RENAMED,
  before: { tables: PhysicalTable[] } = BEFORE,
  desired: { tables: PhysicalTable[] } = DESIRED,
  steps: ReadonlyMap<string, string> = STEPS
): PreservedTable[] =>
  preservationPlan(r, renameIntent(r, desired), before, steps)

describe("preservationPlan", () => {
  it("measures before in old names and after in new names", () => {
    expect(plan()).toEqual([
      {
        before: { schema: "app", table: "t" },
        after: { schema: "app", table: "u" },
        key: { before: "id", after: "ref" },
        columns: [
          { before: "id", after: "ref" },
          { before: '"Name"', after: "name" },
          { before: "(x::integer)", after: "x", typeChangeStep: "s7" },
        ],
      },
    ])
  })

  it("casts a type-changed column to the new type before", () => {
    const [t] = plan()
    expect(preservationQuery(t!, "before")).toContain("(x::integer)")
    expect(preservationQuery(t!, "after")).not.toContain("::integer")
  })

  it("leaves retired columns out", () => {
    const [t] = plan()
    const all = t!.columns.flatMap((c) => [c.before, c.after])
    expect(all.some((e) => e.includes("old"))).toBe(false)
    expect(preservationQuery(t!, "before")).not.toContain("old")
  })

  it("keys a composite primary key as a row", () => {
    const r = record({
      tables: [{ id: OBJECT_ID, schema: "app", from: "t", to: "t" }],
      columns: [column("t", "k1", "k1", 1), column("t", "K 2", "k2", 2)],
    })
    const [t] = plan(
      r,
      { tables: [table("t", ["k1", "K 2"], ["k1", "K 2"])] },
      { tables: [table("t", ["k1", "k2"], ["k1", "k2"])] },
      new Map()
    )
    expect(t!.key).toEqual({
      before: 'ROW(k1, "K 2")::text',
      after: "ROW(k1, k2)::text",
    })
  })

  it("casts a type-changed key column too", () => {
    const r = record({
      tables: [{ id: OBJECT_ID, schema: "app", from: "t", to: "t" }],
      columns: [column("t", "id", "id", 1)],
      typeChanges: [
        {
          schema: "app",
          table: "t",
          column: "id",
          from: "integer",
          to: "bigint",
        },
      ],
    })
    const [t] = plan(
      r,
      { tables: [table("t", ["id"], ["id"])] },
      { tables: [table("t", ["id"], ["id"])] },
      new Map([[JSON.stringify(["app", "t", "id"]), "s2"]])
    )
    expect(t!.key).toEqual({ before: "(id::bigint)", after: "id" })
  })

  it("does not glue the table and column of a step key", () => {
    // `["app", "u.x", "y"]` і `["app", "u", "x.y"]` злиплися б у `app.u.x.y`
    const r = record({
      tables: [{ id: OBJECT_ID, schema: "app", from: "u.x", to: "u.x" }],
      columns: [column("u.x", "id", "id", 1), column("u.x", "y", "y", 2)],
      typeChanges: [
        { schema: "app", table: "u.x", column: "y", from: "text", to: "int" },
      ],
    })
    expect(() =>
      plan(
        r,
        { tables: [table("u.x", ["id", "y"], ["id"])] },
        { tables: [table("u.x", ["id", "y"], ["id"])] },
        new Map([[JSON.stringify(["app", "u", "x.y"]), "s1"]])
      )
    ).toThrow(/no step/)
  })

  it("throws on a primary key column without a mapping", () => {
    // Вилучена колонка ключа лишила б ключ «після» зі старим іменем
    const r = record({
      tables: [{ id: OBJECT_ID, schema: "app", from: "t", to: "t" }],
      columns: [column("t", "Name", "name", 1)],
      retired: [
        { sourceId: OBJECT_ID, schema: "app", table: "t", column: "id" },
      ],
    })
    expect(() =>
      plan(
        r,
        { tables: [table("t", ["id", "Name"], ["id"])] },
        { tables: [table("t", ["name"])] },
        new Map()
      )
    ).toThrow(/primary key column app\.t\.id has no mapping/)
  })

  it("throws on a unit table without a primary key", () => {
    // Виявлення переходу відмовляє `plan.promotion-unsupported` раніше
    expect(() =>
      plan(RENAMED, { tables: [table("t", ["id", "Name", "x", "old"])] })
    ).toThrow(/primary key/)
  })
})

describe("preservationQuery", () => {
  const [t] = plan()

  it("hashes key, NULL marker and value in one pass without ONLY", () => {
    const sql = preservationQuery(t!, "before")
    expect(sql).toBe(
      [
        "SELECT count(*) AS rows",
        `sum(hashtextextended(id::text || ':' || CASE WHEN (id) IS NULL THEN 'n' ELSE 'v' || (id)::text END, 0)::numeric) AS c0`,
        `sum(hashtextextended(id::text || ':' || CASE WHEN ("Name") IS NULL THEN 'n' ELSE 'v' || ("Name")::text END, 0)::numeric) AS c1`,
        `sum(hashtextextended(id::text || ':' || CASE WHEN ((x::integer)) IS NULL THEN 'n' ELSE 'v' || ((x::integer))::text END, 0)::numeric) AS c2 FROM app.t`,
      ].join(", ")
    )
    expect(sql).not.toMatch(/\bONLY\b/)
  })

  it("reads the new names after", () => {
    expect(preservationQuery(t!, "after")).toMatch(/ FROM app\.u$/)
    expect(preservationQuery(t!, "after")).toContain("hashtextextended(ref::")
  })
})
