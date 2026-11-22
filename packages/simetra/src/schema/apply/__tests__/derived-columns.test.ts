import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import type { CatalogModel, PhysicalTable } from "simetra/model"
import { classifySteps, type EngineAction } from "simetra/schema"
import { planDerivedColumns } from "../derived-columns"

/**
 * Похідна колонка пошуку (спека П2 §5, «Поля пошуку») — об'єкт платформи:
 * план перебудовує її навколо зміни типу джерела, а її зняття — не втрата
 * даних. Похідність — факт знімка (`origin.searchOf`), не ім'я.
 */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

function action(sql: string, over: Partial<EngineAction> = {}): EngineAction {
  return {
    sql,
    verb: "alter",
    produces: [],
    consumes: [],
    destroys: [],
    produced: [],
    destroyed: [],
    consumed: [],
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: [],
    lockClass: "accessExclusive",
    dataLoss: false,
    rewriteRisk: false,
    ...over,
  }
}

/** Таблиця знімка; `derived` — чи несе нормалізована колонка походження. */
function snapshot(derived = true): PhysicalTable {
  return {
    schema: "app",
    name: "t",
    origin: { objectId: "00000000-0000-4000-8000-000000000001" },
    rowLevelSecurity: "enabled",
    columns: [
      { name: "id", type: "uuid", notNull: true, origin: { standard: "ref" } },
      {
        name: "c",
        type: "character varying(200)",
        notNull: true,
        origin: { standard: "description" },
      },
      {
        name: "c_search",
        type: "text",
        notNull: false,
        generated: { expression: `left(lower(c COLLATE "default"), 660)` },
        origin: derived ? { searchOf: "c" } : {},
      },
    ],
    primaryKey: { name: "t_pkey", columns: ["id"] },
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [
      {
        name: "t_c_search_idx",
        unique: false,
        method: "btree",
        keys: [{ column: "c_search", opclass: { name: "text_pattern_ops" } }],
        include: [],
        nullsNotDistinct: false,
      },
    ],
  }
}

const live = (
  withSearch: boolean,
  o: { table?: string; source?: string } = {}
): CatalogModel => ({
  tables: [
    {
      schema: "app",
      name: o.table ?? "t",
      rowLevelSecurity: "enabled",
      columns: [
        { name: "id", type: "uuid", notNull: true },
        {
          name: o.source ?? "c",
          type: "character varying(150)",
          notNull: true,
        },
        ...(withSearch
          ? [
              {
                name: "c_search",
                type: "text",
                notNull: false,
                generated: {
                  expression: `"left"(lower(((${o.source ?? "c"})::text COLLATE "default")), 660)`,
                },
              },
            ]
          : []),
      ],
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: withSearch
        ? [
            {
              name: "t_c_search_idx",
              unique: false,
              method: "btree",
              keys: [
                { column: "c_search", opclass: { name: "text_pattern_ops" } },
              ],
              include: [],
              nullsNotDistinct: false,
            },
          ]
        : [],
    },
  ],
  enumTypes: [],
  units: [],
})

const SAME = {
  table: (t: { schema: string; name: string }) => t,
  column: (_t: unknown, c: string) => c,
}

const ref = (kind: string, name: string, table = "t") => ({
  kind,
  schema: "app",
  ...(kind === "column" ? { table } : {}),
  name,
})

const dropSearch = action(`ALTER TABLE "app"."t" DROP COLUMN "c_search"`, {
  destroys: ["column:app.t.c_search"],
  destroyed: [ref("column", "c_search")],
  dataLoss: true,
})
const dropIndex = action(`DROP INDEX "app"."t_c_search_idx"`, {
  verb: "drop",
  destroys: ["index:app.t_c_search_idx"],
  destroyed: [ref("index", "t_c_search_idx")],
})
const alter = action(
  `ALTER TABLE "app"."t" ALTER COLUMN "c" TYPE character varying(200) USING "c"::character varying(200)`,
  // Як у двигуна: зміна типу переписує таблицю
  { rewriteRisk: true }
)

/** Правило похідних колонок і класи кроків — як у плані. */
function planned(
  actions: EngineAction[],
  o: {
    derived?: boolean
    desired?: PhysicalTable[]
    live?: CatalogModel
    names?: typeof SAME
  } = {}
) {
  const source = o.live ?? live(true)
  const rewritten = planDerivedColumns(actions, {
    live: source,
    applied: [snapshot(o.derived ?? true)],
    desired: o.desired ?? [],
    names: o.names ?? SAME,
    parse,
  })
  return classifySteps(rewritten, source, parse)
}

describe("derived columns: classification", () => {
  it("dropping a derived column is not destructive", () => {
    expect(planned([dropSearch]).map((s) => s.class)).toEqual(["catalogOnly"])
  })

  it("the same column without the snapshot fact is an ordinary column", () => {
    expect(
      planned([dropSearch], { derived: false }).map((s) => s.class)
    ).toEqual(["destructive"])
  })

  it("a step that also drops an ordinary column stays destructive", () => {
    const both = action(
      `ALTER TABLE "app"."t" DROP COLUMN "c_search", DROP COLUMN "c"`,
      {
        destroys: ["column:app.t.c_search", "column:app.t.c"],
        destroyed: [ref("column", "c_search"), ref("column", "c")],
        dataLoss: true,
      }
    )
    expect(planned([both]).map((s) => s.class)).toEqual(["destructive"])
  })

  it("a lost object without a structural ref keeps the step destructive", () => {
    // Двигун не дає структурного посилання на кожен знятий об'єкт: зняте
    // поза переліком `destroyed` судиться як втрата
    const step = action(`ALTER TABLE "app"."t" DROP COLUMN "c_search"`, {
      destroys: ["column:app.t.c_search", "sequence:app.s"],
      destroyed: [ref("column", "c_search")],
      dataLoss: true,
    })
    expect(planned([step]).map((s) => s.class)).toEqual(["destructive"])
  })
})

describe("derived columns: the drop precedes a type change of the source", () => {
  it("a kept derived column is dropped before and recreated with its index after", () => {
    const steps = planned([alter], { desired: [snapshot()] })
    expect(steps.map((s) => [s.class, s.sql])).toEqual([
      ["catalogOnly", "ALTER TABLE app.t DROP COLUMN c_search"],
      ["tableRewrite", alter.sql],
      [
        "tableRewrite",
        `ALTER TABLE app.t ADD COLUMN c_search text GENERATED ALWAYS AS (left(lower(c COLLATE "default"), 660)) STORED`,
      ],
      [
        "catalogOnly",
        "CREATE INDEX t_c_search_idx ON app.t USING btree (c_search text_pattern_ops)",
      ],
    ])
    expect(steps[0]!.lockedTables).toEqual([{ schema: "app", name: "t" }])
    // CREATE INDEX бере SHARE, а не ACCESS EXCLUSIVE
    expect(steps.map((s) => s.lockClass)).toEqual([
      "accessExclusive",
      "accessExclusive",
      "accessExclusive",
      "share",
    ])
  })

  it("the rebuild renders the desired column and indexes by the shared renderers", () => {
    const desired = snapshot()
    desired.columns[2] = { ...desired.columns[2]!, collation: { name: "C" } }
    desired.indexes = [
      {
        ...desired.indexes[0]!,
        unique: true,
        keys: [
          { column: "c_search", opclass: { name: "text_pattern_ops" } },
          { column: "id" },
        ],
        include: ["c"],
        where: "c_search IS NOT NULL",
      },
    ]
    const steps = planned([alter], { desired: [desired] })
    expect(steps.slice(2).map((s) => s.sql)).toEqual([
      `ALTER TABLE app.t ADD COLUMN c_search text COLLATE "C" GENERATED ALWAYS AS (left(lower(c COLLATE "default"), 660)) STORED`,
      "CREATE UNIQUE INDEX t_c_search_idx ON app.t USING btree (c_search text_pattern_ops, id) INCLUDE (c) WHERE c_search IS NOT NULL",
    ])
  })

  it("a field leaving search and changing type: the engine's drops move before the change", () => {
    const steps = planned([alter, dropIndex, dropSearch])
    expect(steps.map((s) => [s.class, s.sql])).toEqual([
      ["catalogOnly", dropIndex.sql],
      ["catalogOnly", dropSearch.sql],
      ["tableRewrite", alter.sql],
    ])
  })

  it("under promotion the snapshot names are the old ones", () => {
    // Копія після наміру: таблиця `t2`, джерело `d` — у знімку marker `t`, `c`
    const renamed = live(true, { table: "t2", source: "d" })
    const names = {
      table: (t: { schema: string; name: string }) =>
        t.name === "t2" ? { schema: t.schema, name: "t" } : t,
      column: (_t: unknown, c: string) => (c === "d" ? "c" : c),
    }
    const alterD = action(
      `ALTER TABLE "app"."t2" ALTER COLUMN "d" TYPE character varying(200)`,
      { rewriteRisk: true }
    )
    const drop = action(`ALTER TABLE "app"."t2" DROP COLUMN "c_search"`, {
      destroys: ["column:app.t2.c_search"],
      destroyed: [ref("column", "c_search", "t2")],
      dataLoss: true,
    })
    const steps = planned([alterD, drop], { live: renamed, names })
    expect(steps.map((s) => [s.class, s.sql])).toEqual([
      ["catalogOnly", drop.sql],
      ["tableRewrite", alterD.sql],
    ])
  })

  it("without the snapshot fact nothing moves or is rebuilt", () => {
    expect(
      planned([alter, dropSearch], {
        derived: false,
        desired: [snapshot()],
      }).map((s) => s.sql)
    ).toEqual([alter.sql, dropSearch.sql])
  })

  it("without a derived column in the source state the plan is left alone", () => {
    expect(
      planned([alter], { live: live(false), desired: [snapshot()] }).map(
        (s) => s.sql
      )
    ).toEqual([alter.sql])
  })
})
