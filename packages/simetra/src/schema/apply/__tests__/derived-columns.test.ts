import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import type { CatalogModel, PhysicalTable } from "simetra/model"
import { classifySteps, type EngineAction } from "simetra/schema"
import { aroundTypeChanges, derivedColumnKeys } from "../derived-columns"

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
        generated: { expression: `lower(c COLLATE "default")` },
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

const live = (withSearch: boolean): CatalogModel => ({
  tables: [
    {
      schema: "app",
      name: "t",
      rowLevelSecurity: "enabled",
      columns: [
        { name: "id", type: "uuid", notNull: true },
        { name: "c", type: "character varying(150)", notNull: true },
        ...(withSearch
          ? [
              {
                name: "c_search",
                type: "text",
                notNull: false,
                generated: {
                  expression: `lower(((c)::text COLLATE "default"))`,
                },
              },
            ]
          : []),
      ],
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
    },
  ],
  enumTypes: [],
  units: [],
})

const dropSearch = action(`ALTER TABLE "app"."t" DROP COLUMN "c_search"`, {
  destroys: ["column:app.t.c_search"],
  destroyed: [{ kind: "column", schema: "app", table: "t", name: "c_search" }],
  dataLoss: true,
})

describe("derived columns: classification", () => {
  it("dropping a derived column is not destructive", () => {
    const [step] = classifySteps([dropSearch], live(true), parse, 0, {
      derived: derivedColumnKeys([snapshot()]),
    })
    expect(step?.class).toBe("catalogOnly")
  })

  it("the same column without the snapshot fact is an ordinary column", () => {
    const [step] = classifySteps([dropSearch], live(true), parse, 0, {
      derived: derivedColumnKeys([snapshot(false)]),
    })
    expect(step?.class).toBe("destructive")
  })

  it("a step that also drops an ordinary column stays destructive", () => {
    const both = action(
      `ALTER TABLE "app"."t" DROP COLUMN "c_search", DROP COLUMN "c"`,
      {
        destroys: ["column:app.t.c_search", "column:app.t.c"],
        destroyed: [
          { kind: "column", schema: "app", table: "t", name: "c_search" },
          { kind: "column", schema: "app", table: "t", name: "c" },
        ],
        dataLoss: true,
      }
    )
    const [step] = classifySteps([both], live(true), parse, 0, {
      derived: derivedColumnKeys([snapshot()]),
    })
    expect(step?.class).toBe("destructive")
  })
})

describe("derived columns: around a type change of the source", () => {
  const alter = action(
    `ALTER TABLE "app"."t" ALTER COLUMN "c" TYPE character varying(200) USING "c"::character varying(200)`
  )

  it("drops the derived column before and recreates it with its index after", () => {
    const steps = aroundTypeChanges([alter], [snapshot()], live(true), parse)
    expect(steps.map((s) => s.sql)).toEqual([
      "ALTER TABLE app.t DROP COLUMN c_search",
      alter.sql,
      `ALTER TABLE app.t ADD COLUMN c_search text GENERATED ALWAYS AS (lower(c COLLATE "default")) STORED`,
      "CREATE INDEX t_c_search_idx ON app.t USING btree (c_search text_pattern_ops)",
    ])
    expect(steps.map((s) => s.rewriteRisk)).toEqual([false, false, true, false])
    expect(steps[0]!.lockedTables).toEqual([{ schema: "app", name: "t" }])
  })

  it("leaves the plan alone when the target has no derived column yet", () => {
    expect(
      aroundTypeChanges([alter], [snapshot()], live(false), parse)
    ).toEqual([alter])
  })

  it("a generated column without the snapshot fact is not rebuilt", () => {
    expect(
      aroundTypeChanges([alter], [snapshot(false)], live(true), parse)
    ).toEqual([alter])
  })
})
