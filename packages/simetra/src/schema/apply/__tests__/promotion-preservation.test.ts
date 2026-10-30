import { describe, expect, it } from "vitest"
import { loadSqlParser, type PromotionRecord } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import {
  castProbeQuery,
  preservationPlan,
  preservationQuery,
  renameIntent,
  type PreservedTable,
} from "simetra/schema"

/**
 * Доказ збереження рядків і значень змаплених колонок (спека
 * промоції §7.2): які вирази заміри «до» й «після» порівнюють і як виглядає один
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
  preservationPlan(r, renameIntent(r, desired), before, steps, [])

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

  it("measures a fill target by its expression", () => {
    const r = record({
      tables: [{ id: OBJECT_ID, schema: "app", from: "t", to: "u" }],
      columns: [column("u", "id", "id", 1), column("u", "code", "code", 2)],
      typeChanges: [
        {
          schema: "app",
          table: "u",
          column: "code",
          from: "text",
          to: "varchar(20)",
        },
      ],
    })
    const data = [
      {
        before: { schema: "app", table: "t", key: "id" },
        columns: [
          {
            step: "d1",
            column: "code",
            type: "text",
            expression: "left(code, 20)",
            kind: "repair" as const,
            guard: "",
          },
          {
            step: "d2",
            column: "deletion_mark",
            type: "boolean",
            expression: "coalesce(inactive, false)",
            kind: "conversion" as const,
            guard: "",
          },
        ],
      },
    ]
    const [t] = preservationPlan(
      r,
      renameIntent(r, { tables: [table("u", ["id", "code"], ["id"])] }),
      { tables: [table("t", ["id", "code", "inactive"], ["id"])] },
      new Map([[JSON.stringify(["app", "u", "code"]), "s5"]]),
      data
    )
    expect(t!.columns).toEqual([
      { before: "id", after: "id" },
      // Змаплена ціль: вираз у старому типі, далі — приведення кроку двигуна;
      // звичайного запису колонки немає
      {
        before: "(((\nleft(code, 20)\n)::text)::varchar(20))",
        after: "code",
        dataStep: "d1",
        typeChangeStep: "s5",
      },
      // Незмаплена ціль — додатковий запис у бажаному типі
      {
        before: "((\ncoalesce(inactive, false)\n)::boolean)",
        after: "deletion_mark",
        dataStep: "d2",
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
  const sum = (i: number) =>
    `pg_catalog.sum(pg_catalog.hashtextextended(k::pg_catalog.text OPERATOR(pg_catalog.||) ':' OPERATOR(pg_catalog.||) CASE WHEN x${i} IS NULL THEN 'n' ELSE 'v' OPERATOR(pg_catalog.||) x${i}::pg_catalog.text END, 0)::pg_catalog.numeric) AS c${i}`

  it("hashes key, NULL marker and value in one pass without ONLY", () => {
    const sql = preservationQuery(t!, "before")
    expect(sql).toBe(
      `SELECT pg_catalog.count(*) AS rows, ${sum(0)}, ${sum(1)}, ${sum(2)} FROM (SELECT id AS k, (\nid\n) AS x0, (\n"Name"\n) AS x1, (\n(x::integer)\n) AS x2 FROM app.t) AS s`
    )
    expect(sql).not.toMatch(/\bONLY\b/)
  })

  it("measures every expression in a subquery", () => {
    // Віконна функція в агрегаті заборонена: кожен вираз рахується в
    // підзапиті, а агрегати — над його колонками, з обох боків однаково
    expect(preservationQuery(t!, "after")).toBe(
      `SELECT pg_catalog.count(*) AS rows, ${sum(0)}, ${sum(1)}, ${sum(2)} FROM (SELECT ref AS k, (\nref\n) AS x0, (\nname\n) AS x1, (\nx\n) AS x2 FROM app.u) AS s`
    )
  })

  it("reads the new names after", () => {
    expect(preservationQuery(t!, "after")).toMatch(/ FROM app\.u\) AS s$/)
    expect(preservationQuery(t!, "after")).toContain("SELECT ref AS k")
  })
})

describe("castProbeQuery", () => {
  const windowed: PreservedTable = {
    before: { schema: "app", table: "t" },
    after: { schema: "app", table: "u" },
    key: { before: "id", after: "id" },
    columns: [
      { before: "row_number() over (order by id)", after: "n" },
      { before: "left(code, 20) -- trim", after: "code" },
    ],
  }

  it("probes a windowed expression in a subquery", () => {
    // Віконна функція прямо в `count` дала б `42803`, а не клас `22`
    expect(castProbeQuery(windowed, windowed.columns[0]!)).toBe(
      "SELECT pg_catalog.count(x) AS probe FROM (SELECT (\nrow_number() over (order by id)\n) AS x FROM app.t) AS s"
    )
  })

  it("survives a comment in the expression", async () => {
    const parse = await loadSqlParser()
    const commented = windowed.columns[1]!
    const statements = [
      castProbeQuery(windowed, commented),
      preservationQuery({ ...windowed, columns: [commented] }, "before"),
    ]
    for (const sql of statements) {
      const parsed = parse(sql)
      expect(parsed.ok, sql).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.statements, sql).toHaveLength(1)
      const select = (
        parsed.statements[0]!.stmt as {
          SelectStmt?: { fromClause?: unknown[] }
        }
      ).SelectStmt
      // Однорядковий рендер закоментував би `FROM` разом із рештою
      expect(select?.fromClause, sql).toHaveLength(1)
    }
  })
})
