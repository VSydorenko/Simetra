import { beforeAll, describe, expect, it } from "vitest"
import {
  loadSqlParser,
  type PromotionRecord,
  type SqlParser,
} from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import {
  intentStep,
  lintSteps,
  renameIntent,
  tableKey,
  withTempNames,
} from "simetra/schema"

/**
 * Намір перейменувань (рішення 2–3 плану П3-2a): кроки платформи, що до
 * diff двигуна переводять таблиці й колонки одиниці на нові імена за
 * записом, виведеним з ідентичностей.
 */

const OBJECT_ID = "00000000-0000-4000-8000-000000000001"
const SECTION_ID = "00000000-0000-4000-8000-000000000002"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

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
  origin: PhysicalTable["origin"] = { objectId: OBJECT_ID }
): PhysicalTable {
  return {
    schema: "app",
    name,
    origin,
    rowLevelSecurity: "enabled",
    columns: columns.map((c) => ({
      name: c,
      type: "text",
      notNull: false,
      origin: {},
    })),
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

const COUNTERPARTIES = {
  id: OBJECT_ID,
  schema: "app",
  from: "counterparties",
  to: "catalog_counterparties",
}

describe("renameIntent", () => {
  it("renames tables first, then columns, in topological order", () => {
    const intent = renameIntent(
      record({
        tables: [COUNTERPARTIES],
        columns: [
          column("catalog_counterparties", "title", "description", 1),
          column("catalog_counterparties", "name", "title", 2),
        ],
      }),
      { tables: [table("catalog_counterparties", ["description", "title"])] }
    )
    expect(intent.steps.map((s) => s.sql)).toEqual([
      "ALTER TABLE app.counterparties RENAME TO catalog_counterparties",
      // `title` звільняється раніше, ніж його займає `name`
      "ALTER TABLE app.catalog_counterparties RENAME COLUMN title TO description",
      "ALTER TABLE app.catalog_counterparties RENAME COLUMN name TO title",
    ])
    expect([...intent.tablesNewToOld]).toEqual([
      [
        tableKey("app", "catalog_counterparties"),
        tableKey("app", "counterparties"),
      ],
    ])
    expect(intent.tempNames.size).toBe(0)
  })

  it("orders a table rename after the rename that frees its name", () => {
    const intent = renameIntent(
      record({
        tables: [
          { id: OBJECT_ID, schema: "app", from: "a", to: "b" },
          { id: SECTION_ID, schema: "app", from: "b", to: "c" },
        ],
      }),
      {
        tables: [
          table("b", []),
          table("c", [], { objectId: OBJECT_ID, tabularSectionId: SECTION_ID }),
        ],
      }
    )
    expect(intent.steps.map((s) => s.sql)).toEqual([
      "ALTER TABLE app.b RENAME TO c",
      "ALTER TABLE app.a RENAME TO b",
    ])
  })

  it("swaps two columns through a temporary name", () => {
    const intent = renameIntent(
      record({
        tables: [COUNTERPARTIES],
        columns: [
          column("catalog_counterparties", "a", "b", 1),
          column("catalog_counterparties", "b", "a", 2),
        ],
      }),
      { tables: [table("catalog_counterparties", ["a", "b"])] }
    )
    expect(intent.steps.slice(1).map((s) => s.sql)).toEqual([
      "ALTER TABLE app.catalog_counterparties RENAME COLUMN a TO simetra_tmp_1",
      "ALTER TABLE app.catalog_counterparties RENAME COLUMN b TO a",
      "ALTER TABLE app.catalog_counterparties RENAME COLUMN simetra_tmp_1 TO b",
    ])
    // Тимчасове ім'я обміну до кінця наміру не доживає
    expect(intent.tempNames.size).toBe(0)
  })

  it("moves a retired column out of the way of a new column with its name", () => {
    const intent = renameIntent(
      record({
        tables: [COUNTERPARTIES],
        columns: [column("catalog_counterparties", "title", "code", 1)],
        retired: [
          {
            sourceId: "00000000-0000-4000-8000-000000000301",
            schema: "app",
            table: "counterparties",
            column: "description",
          },
          {
            sourceId: "00000000-0000-4000-8000-000000000302",
            schema: "app",
            table: "counterparties",
            column: "legacy_note",
          },
          {
            sourceId: "00000000-0000-4000-8000-000000000303",
            schema: "app",
            table: "counterparties",
            column: "code",
          },
        ],
      }),
      {
        tables: [
          table("catalog_counterparties", ["id", "code", "description"]),
        ],
      }
    )
    expect(intent.steps.map((s) => s.sql)).toEqual([
      "ALTER TABLE app.counterparties RENAME TO catalog_counterparties",
      // Вилучена колонка, чиє ім'я не потрібне бажаній таблиці, лишається
      "ALTER TABLE app.catalog_counterparties RENAME COLUMN description TO simetra_retired_1",
      "ALTER TABLE app.catalog_counterparties RENAME COLUMN code TO simetra_retired_2",
      "ALTER TABLE app.catalog_counterparties RENAME COLUMN title TO code",
    ])
    expect([...intent.tempNames]).toEqual([
      [
        JSON.stringify(["app", "catalog_counterparties", "simetra_retired_1"]),
        "description",
      ],
      [
        JSON.stringify(["app", "catalog_counterparties", "simetra_retired_2"]),
        "code",
      ],
    ])
    // Секція плану бере перейменування колонок звідси, у порядку кроків
    const at = { schema: "app", name: "catalog_counterparties" }
    expect(intent.columns).toEqual([
      { table: at, from: "description", to: "simetra_retired_1" },
      { table: at, from: "code", to: "simetra_retired_2" },
      { table: at, from: "title", to: "code" },
    ])
  })

  it("locks intent steps by old table names", () => {
    const intent = renameIntent(
      record({
        tables: [COUNTERPARTIES],
        columns: [column("catalog_counterparties", "name", "description", 1)],
      }),
      { tables: [table("catalog_counterparties", ["description"])] }
    )
    expect(intent.steps.map((s) => s.lockedTables)).toEqual([
      [{ schema: "app", name: "counterparties" }],
      [{ schema: "app", name: "counterparties" }],
    ])
  })

  it("emits nothing for a column whose name does not change", () => {
    const intent = renameIntent(
      record({
        tables: [{ ...COUNTERPARTIES, to: "counterparties" }],
        columns: [column("counterparties", "inn", "inn", 1)],
      }),
      { tables: [table("counterparties", ["inn"])] }
    )
    expect(intent.steps).toEqual([])
    expect(intent.tablesNewToOld.size).toBe(0)
  })

  it("quotes identifiers", () => {
    const intent = renameIntent(
      record({
        tables: [
          { id: OBJECT_ID, schema: "my.app", from: 'we"ird.t', to: "Nice" },
        ],
        columns: [
          {
            ...column("Nice", 'a"b.c', "select", 1),
            schema: "my.app",
          },
        ],
      }),
      { tables: [{ ...table("Nice", ["select"]), schema: "my.app" }] }
    )
    expect(intent.steps.map((s) => s.sql)).toEqual([
      'ALTER TABLE "my.app"."we""ird.t" RENAME TO "Nice"',
      'ALTER TABLE "my.app"."Nice" RENAME COLUMN "a""b.c" TO "select"',
    ])
    expect(intent.steps[0]!.lockedTables).toEqual([
      { schema: "my.app", name: 'we"ird.t' },
    ])
  })

  it("gives intent steps fixed classes that pass the step lint", () => {
    const intent = renameIntent(
      record({
        tables: [COUNTERPARTIES],
        columns: [
          column("catalog_counterparties", "a", "b", 1),
          column("catalog_counterparties", "b", "a", 2),
        ],
      }),
      { tables: [table("catalog_counterparties", ["a", "b"])] }
    )
    expect(intent.steps[0]).toEqual({
      sql: "ALTER TABLE app.counterparties RENAME TO catalog_counterparties",
      origin: "intent",
      verb: "alter",
      class: "catalogOnly",
      lockClass: "accessExclusive",
      transactionality: "transactional",
      newSegmentBefore: false,
      lockedTables: [{ schema: "app", name: "counterparties" }],
      produces: [],
      consumes: [],
      destroys: [],
      destroyed: [],
      consumed: [],
      dataLoss: false,
      rewriteRisk: false,
      guards: [],
    })
    const steps = intent.steps.map((s, i) => ({ ...s, id: `s${i + 1}` }))
    expect(lintSteps(steps, parse)).toEqual([])
  })
})

describe("intentStep", () => {
  it("is the same step whatever the SQL", () => {
    expect(intentStep("SELECT 1", [])).toMatchObject({
      origin: "intent",
      class: "catalogOnly",
      guards: [],
      destroyed: [],
      consumed: [],
    })
  })
})

describe("withTempNames", () => {
  it("adds temporary names without touching the steps", () => {
    const intent = renameIntent(record({ tables: [COUNTERPARTIES] }), {
      tables: [table("catalog_counterparties", [])],
    })
    const key = JSON.stringify([
      "app",
      "catalog_counterparties",
      "simetra_tmp_9",
    ])
    const more = withTempNames(intent, new Map([[key, "pk"]]))
    expect(more.steps).toBe(intent.steps)
    expect(more.tablesNewToOld).toBe(intent.tablesNewToOld)
    expect([...more.tempNames]).toEqual([[key, "pk"]])
    expect(intent.tempNames.size).toBe(0)
  })
})
