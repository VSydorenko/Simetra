import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import type {
  CatalogColumn,
  CatalogModel,
  CatalogTable,
  MetadataKind,
  PhysicalSnapshot,
  PhysicalTable,
} from "simetra/model"
import {
  backfillStepRefusals,
  backfillTargets,
  backfillWriteTables,
  classifySteps,
  columnKey,
  intentStep,
  notNullColumns,
  planBackfills,
  readWriteFacts,
  requiredPermissions,
  tableKey,
  writeFactRefusals,
  type ApplyTransaction,
  type BackfillInput,
  type BackfillTarget,
  type EngineAction,
  type PlanAction,
  type PlanStep,
  type WriteFacts,
} from "simetra/schema"

/**
 * Заповнення `NULL` перед `NOT NULL` (платформна спека §6.6, спека
 * промоції §4): вибір колонок, вставка кроку, порядок default, відмови й
 * дозвіл — на синтетичних діях двигуна. Справжня база — у DB-тестах
 * designer.
 */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const OBJECT_ID = "00000000-0000-4000-8000-000000000001"

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
    lockedTables: [{ schema: "app", name: "items" }],
    lockClass: "accessExclusive",
    dataLoss: false,
    rewriteRisk: false,
    ...over,
  }
}

const SET_NOT_NULL = action(
  'ALTER TABLE "app"."items" ALTER COLUMN "note" SET NOT NULL'
)
const SET_DEFAULT = action(
  'ALTER TABLE "app"."items" ALTER COLUMN "note" SET DEFAULT \'\'::text'
)
const ALTER_TYPE = action(
  'ALTER TABLE "app"."items" ALTER COLUMN "note" TYPE character varying(50)'
)
const OTHER = action(
  'ALTER TABLE "app"."items" ALTER COLUMN "code" SET NOT NULL'
)

const column = (
  name: string,
  over: Partial<CatalogColumn> = {}
): CatalogColumn => ({ name, type: "text", notNull: false, ...over })

const table = (
  columns: CatalogColumn[],
  over: Partial<CatalogTable> = {}
): CatalogTable => ({
  schema: "app",
  name: "items",
  rowLevelSecurity: "off",
  columns,
  uniques: [],
  checks: [],
  foreignKeys: [],
  indexes: [],
  ...over,
})

const model = (...tables: CatalogTable[]): CatalogModel => ({
  tables,
  enumTypes: [],
  units: [],
})

/** Вихідний стан: `note` nullable без default, `code` теж. */
const SOURCE = model(table([column("id"), column("note"), column("code")]))
/** Бажаний стан: `note` NOT NULL DEFAULT ''. */
const DESIRED = model(
  table([
    column("id"),
    column("note", { notNull: true, default: "''::text" }),
    column("code", { notNull: true }),
  ])
)

/** Знімок компілятора: таблиця виду з тим самим default. */
const physical = (
  kindDefault: string | undefined = "''::text",
  over: Partial<PhysicalTable> = {}
): PhysicalSnapshot => ({
  tables: [
    {
      ...table([]),
      origin: { objectId: OBJECT_ID },
      columns: [
        { name: "id", type: "uuid", notNull: true, origin: {} },
        {
          name: "note",
          type: "text",
          notNull: true,
          ...(kindDefault === undefined ? {} : { default: kindDefault }),
          origin: {},
        },
      ],
      ...over,
    },
  ],
  enumTypes: [],
})

const input = (over: Partial<BackfillInput> = {}): BackfillInput => ({
  actions: [SET_DEFAULT, SET_NOT_NULL],
  parse,
  source: SOURCE,
  desired: DESIRED,
  physical: physical(),
  objects: [{ id: OBJECT_ID, kind: "Catalog" as MetadataKind }],
  ...over,
})

/** Кількість на ціль: `nulls` за колонкою, решта — нуль. */
const counts =
  (rows: Readonly<Record<string, number>>) =>
  (t: BackfillTarget): number =>
    rows[t.column] ?? 0

const run = (
  over: Partial<BackfillInput> = {},
  rows: Readonly<Record<string, number>> = { note: 3 }
) => planBackfills({ ...input(over), rows: counts(rows) })

/** SQL дій у порядку плану; заповнення — `BACKFILL <колонка>`. */
const order = (actions: readonly PlanAction[]): string[] =>
  actions.map((a) =>
    "backfill" in a ? `BACKFILL ${a.backfill.column}` : a.sql
  )

const codes = (r: { refusals: { code: string }[] }) =>
  r.refusals.map((d) => d.code)

describe("notNullColumns", () => {
  const of = (sql: string) => {
    const result = parse(sql)
    if (!result.ok) throw new Error(result.message)
    return notNullColumns(result.statements.map((s) => s.stmt))
  }

  it("reads SET NOT NULL and ADD COLUMN … NOT NULL from the tree", () => {
    expect(of(SET_NOT_NULL.sql)).toEqual([
      {
        schema: "app",
        table: "items",
        column: "note",
        via: "setNotNull",
        filled: false,
      },
    ])
    expect(
      of("ALTER TABLE app.items ADD COLUMN a text NOT NULL, ADD COLUMN b text")
    ).toEqual([
      {
        schema: "app",
        table: "items",
        column: "a",
        via: "addColumn",
        filled: false,
      },
    ])
    for (const fill of [
      "DEFAULT ''",
      "GENERATED ALWAYS AS IDENTITY",
      "GENERATED ALWAYS AS (id::text) STORED",
    ])
      expect(
        of(`ALTER TABLE app.items ADD COLUMN a text NOT NULL ${fill}`).map(
          (c) => c.filled
        )
      ).toEqual([true])
  })

  // І8: ні коментар, ні ім'я колонки не роблять оператор `SET NOT NULL`
  it("does not take SET NOT NULL from a comment or a column name", () => {
    expect(
      of(
        'UPDATE "app"."items" SET "set_not_null" = DEFAULT WHERE "set_not_null" IS NULL'
      )
    ).toEqual([])
    expect(
      of(
        "ALTER TABLE app.items ALTER COLUMN set_not_null SET DEFAULT '' -- SET NOT NULL"
      )
    ).toEqual([])
    expect(of("COMMENT ON COLUMN app.items.note IS 'SET NOT NULL'")).toEqual([])
  })
})

describe("planBackfills", () => {
  // Таблиця випадків: default є/немає × NULL 0/>0 × таблиця наявна/створена
  const created = (sql: string): EngineAction =>
    action(sql, {
      verb: "create",
      produced: [{ kind: "table", schema: "app", name: "items" }],
    })
  const CASES: [
    string,
    { default: boolean; nulls: number; created: boolean },
    string[],
    string[],
  ][] = [
    [
      "default, NULL, existing table → backfill",
      { default: true, nulls: 3, created: false },
      [SET_DEFAULT.sql, "BACKFILL note", SET_NOT_NULL.sql],
      [],
    ],
    [
      "default, no NULL, existing table → as is",
      { default: true, nulls: 0, created: false },
      [SET_DEFAULT.sql, SET_NOT_NULL.sql],
      [],
    ],
    [
      "no default, NULL, existing table → refusal",
      { default: false, nulls: 3, created: false },
      [SET_NOT_NULL.sql],
      ["plan.not-null-violation"],
    ],
    [
      "no default, no NULL, existing table → as is",
      { default: false, nulls: 0, created: false },
      [SET_NOT_NULL.sql],
      [],
    ],
    [
      "default, created table → as is",
      { default: true, nulls: 3, created: true },
      ["CREATE", SET_DEFAULT.sql, SET_NOT_NULL.sql],
      [],
    ],
    [
      "default, no NULL, created table → as is",
      { default: true, nulls: 0, created: true },
      ["CREATE", SET_DEFAULT.sql, SET_NOT_NULL.sql],
      [],
    ],
    [
      "no default, created table → as is",
      { default: false, nulls: 3, created: true },
      ["CREATE", SET_NOT_NULL.sql],
      [],
    ],
    [
      "no default, no NULL, created table → as is",
      { default: false, nulls: 0, created: true },
      ["CREATE", SET_NOT_NULL.sql],
      [],
    ],
  ]
  it.each(CASES)("%s", (_name, c, expected, refusals) => {
    const create = created("CREATE TABLE app.items (id text)")
    const actions = [
      ...(c.created ? [create] : []),
      ...(c.default ? [SET_DEFAULT] : []),
      SET_NOT_NULL,
    ]
    const desired = c.default
      ? DESIRED
      : model(table([column("id"), column("note", { notNull: true })]))
    const r = run({ actions, desired }, { note: c.nulls })
    expect(
      order(r.actions).map((sql) => (sql === create.sql ? "CREATE" : sql))
    ).toEqual(expected)
    expect(codes(r)).toEqual(refusals)
    expect(backfillTargets(input({ actions, desired })).length).toBe(
      c.created ? 0 : 1
    )
  })

  it("names the table, the column and the rows of a refusal", () => {
    const desired = model(
      table([column("id"), column("note", { notNull: true })])
    )
    expect(
      run({ actions: [SET_NOT_NULL], desired }).refusals.map((d) => d.params)
    ).toEqual([{ table: "app.items", column: "note", rows: 3 }])
  })

  // І4 і перестановка пари (платформна спека §6.6)
  describe("default order", () => {
    it("moves SET DEFAULT before SET NOT NULL of the same column", () => {
      // Порядок pg-delta: SET NOT NULL, потім SET DEFAULT
      const r = run({ actions: [SET_NOT_NULL, OTHER, SET_DEFAULT] })
      expect(codes(r)).toEqual([])
      expect(order(r.actions)).toEqual([
        SET_DEFAULT.sql,
        "BACKFILL note",
        SET_NOT_NULL.sql,
        OTHER.sql,
      ])
    })

    it("refuses when another action on the column stands between them", () => {
      // Default типізований: ставити його до зміни типу не можна
      const r = run({ actions: [SET_NOT_NULL, ALTER_TYPE, SET_DEFAULT] })
      expect(codes(r)).toEqual(["plan.backfill-order"])
      expect(r.refusals[0]!.params).toEqual({
        table: "app.items",
        column: "note",
      })
    })

    it("refuses when an action between creates what SET DEFAULT uses", () => {
      const fn = action(
        "CREATE FUNCTION app.f() RETURNS text AS 'x' LANGUAGE sql",
        {
          verb: "create",
          produces: ["procedure:app.f()"],
        }
      )
      const r = run({
        actions: [
          SET_NOT_NULL,
          fn,
          { ...SET_DEFAULT, consumes: ["procedure:app.f()"] },
        ],
      })
      expect(codes(r)).toEqual(["plan.backfill-order"])
    })

    it("does not move a SET DEFAULT that does more than set the default", () => {
      const both = action(
        'ALTER TABLE "app"."items" ALTER COLUMN "note" SET DEFAULT \'\'::text, ALTER COLUMN "code" DROP DEFAULT'
      )
      expect(codes(run({ actions: [SET_NOT_NULL, both] }))).toEqual([
        "plan.backfill-order",
      ])
    })

    it("takes a live default equal to the desired one without SET DEFAULT", () => {
      const source = model(
        table([
          column("id"),
          column("note", { default: "''::text" }),
          column("code"),
        ])
      )
      const r = run({ actions: [SET_NOT_NULL], source })
      expect(codes(r)).toEqual([])
      expect(order(r.actions)).toEqual(["BACKFILL note", SET_NOT_NULL.sql])
    })

    it("refuses without SET DEFAULT when the live default differs", () => {
      const source = model(
        table([
          column("id"),
          column("note", { default: "'x'::text" }),
          column("code"),
        ])
      )
      expect(codes(run({ actions: [SET_NOT_NULL], source }))).toEqual([
        "plan.backfill-order",
      ])
      expect(codes(run({ actions: [SET_NOT_NULL] }))).toEqual([
        "plan.backfill-order",
      ])
    })

    it("refuses a default dropped after it was set", () => {
      const drop = action(
        'ALTER TABLE "app"."items" ALTER COLUMN "note" DROP DEFAULT'
      )
      expect(
        codes(run({ actions: [SET_DEFAULT, drop, SET_NOT_NULL] }))
      ).toEqual(["plan.backfill-order"])
    })
  })

  // І9
  it("refuses ADD COLUMN … NOT NULL without a default only on a table with rows", () => {
    const add = action(
      'ALTER TABLE "app"."items" ADD COLUMN "extra" text NOT NULL'
    )
    const r = run({ actions: [add] }, { extra: 2 })
    expect(r.refusals.map((d) => [d.code, d.params])).toEqual([
      [
        "plan.not-null-violation",
        {
          table: "app.items",
          column: "extra",
          rows: 2,
          detail: "addColumn",
        },
      ],
    ])
    expect(backfillTargets(input({ actions: [add] }))).toEqual([
      {
        table: { schema: "app", name: "items" },
        column: "extra",
        count: "rows",
      },
    ])
    expect(codes(run({ actions: [add] }, { extra: 0 }))).toEqual([])
    const filled = action(
      'ALTER TABLE "app"."items" ADD COLUMN "extra" text NOT NULL DEFAULT \'\''
    )
    expect(backfillTargets(input({ actions: [filled] }))).toEqual([])
    // Перестворена таблиця порожня
    const recreated = action("CREATE TABLE app.items (id text)", {
      verb: "create",
      produced: [{ kind: "table", schema: "app", name: "items" }],
    })
    expect(backfillTargets(input({ actions: [recreated, add] }))).toEqual([])
  })

  // І13
  it("leaves a promotion data column to its data step and refuses the unit table", () => {
    const promotion = {
      tables: new Set([tableKey("app", "items")]),
      dataColumns: new Set([columnKey("app", "items", "note")]),
    }
    expect(backfillTargets(input({ promotion }))).toEqual([])
    expect(codes(run({ promotion }))).toEqual([])
    const unit = { ...promotion, dataColumns: new Set<string>() }
    expect(backfillTargets(input({ promotion: unit })).length).toBe(1)
    expect(
      run({ promotion: unit }).refusals.map((d) => d.params.detail)
    ).toEqual(["promotion"])
  })

  // І18
  it("refuses one default for several NULL of a unique column", () => {
    const unique = (over: Partial<CatalogTable>) =>
      model(table([column("id"), column("note"), column("code")], over))
    const index = {
      name: "items_note",
      unique: true,
      method: "btree",
      keys: [{ column: "note" }],
      include: [],
      nullsNotDistinct: false,
    }
    const key = {
      name: "items_note_key",
      columns: ["note"],
      nullsNotDistinct: false,
    }
    for (const source of [
      unique({ indexes: [index] }),
      unique({ uniques: [key] }),
    ])
      expect(codes(run({ source }))).toEqual(["plan.backfill-unique"])
    const source = unique({ indexes: [index] })
    expect(codes(run({ source }, { note: 1 }))).toEqual([])
    // Кожен рядок отримує власний `newUuid`
    const uuid = model(
      table([
        column("id"),
        column("note", { notNull: true, default: "gen_random_uuid()" }),
      ])
    )
    const setUuid = action(
      'ALTER TABLE "app"."items" ALTER COLUMN "note" SET DEFAULT gen_random_uuid()'
    )
    expect(
      codes(run({ source, desired: uuid, actions: [setUuid, SET_NOT_NULL] }))
    ).toEqual([])
  })

  // Межа копій носіїв (рішення архітекторки): заповнення не пише колонку,
  // яку читає копія
  it("refuses a column a rights carrier copy reads", () => {
    const copyOf = (through: string, source: string) => ({
      tables: [
        ...physical().tables,
        {
          ...physical().tables[0]!,
          name: "lines",
          columns: [
            {
              name: "copy",
              type: "text",
              notNull: false,
              origin: {
                copyOf: {
                  table: { schema: "app", name: "items" },
                  column: source,
                  through,
                },
              },
            },
          ],
        },
      ],
      enumTypes: [],
    })
    const r = run({ physical: copyOf("item_id", "note") })
    expect(r.refusals.map((d) => [d.code, d.params.copy])).toEqual([
      ["plan.backfill-carrier-source", "app.lines.copy"],
    ])
    expect(codes(run({ physical: copyOf("item_id", "code") }))).toEqual([])
    // Колонка зв'язку `through` на самій таблиці копії
    const own = {
      ...physical(),
      tables: [
        {
          ...physical().tables[0]!,
          columns: [
            ...physical().tables[0]!.columns,
            {
              name: "copy",
              type: "text",
              notNull: false,
              origin: {
                copyOf: {
                  table: { schema: "app", name: "parent" },
                  column: "x",
                  through: "note",
                },
              },
            },
          ],
        },
      ],
    }
    expect(codes(run({ physical: own }))).toEqual([
      "plan.backfill-carrier-source",
    ])
  })
})

/** Кроки плану з вставленим заповненням. */
const stepsOf = (over: Partial<BackfillInput> = {}): PlanStep[] => {
  const r = run(over)
  expect(codes(r)).toEqual([])
  return classifySteps(r.actions, SOURCE, parse)
}

describe("classifySteps with backfill", () => {
  it("numbers the inserted step positionally as a data step", () => {
    const steps = stepsOf({ actions: [SET_NOT_NULL, SET_DEFAULT] })
    expect(steps.map((s) => [s.id, s.origin, s.class])).toEqual([
      ["s1", "engine", "catalogOnly"],
      ["s2", "backfill", "dataStep"],
      ["s3", "engine", "validationScan"],
    ])
    expect(steps[1]).toMatchObject({
      sql: "UPDATE app.items SET note = DEFAULT WHERE note IS NULL",
      lockClass: "accessExclusive",
      lockedTables: [{ schema: "app", name: "items" }],
      guards: [],
      backfill: {
        table: { schema: "app", name: "items" },
        column: "note",
        rowsAtPlan: 3,
        permission: false,
        default: "''::text",
      },
    })
  })
})

// І10, І19
describe("backfill permission", () => {
  const permitted = (over: Partial<BackfillInput>): string[] =>
    requiredPermissions({ steps: stepsOf(over), drift: null, promotion: null })

  const CASES: [string, Partial<BackfillInput>, string[]][] = [
    ["a kind table with the compiler's default", {}, []],
    [
      "an adopted table (consumer data kind)",
      { objects: [{ id: OBJECT_ID, kind: "CustomTable" }] },
      ["s2"],
    ],
    [
      "a table outside the snapshot",
      { physical: { tables: [], enumTypes: [] } },
      ["s2"],
    ],
    ["a table of unknown origin", { objects: [] }, ["s2"]],
    [
      "a kind table whose desired default is not the compiler's",
      { physical: physical("'x'::text") },
      ["s2"],
    ],
  ]
  it.each(CASES)("%s", (_name, over, expected) => {
    expect(permitted(over)).toEqual(expected)
  })
})

// І15: передумови спільні з кроками даних промоції
describe("write facts of a backfill", () => {
  const FACTS = (over: Partial<WriteFacts> = {}): WriteFacts => ({
    triggers: new Map(),
    inherited: [],
    ruled: [],
    tempPrivilege: false,
    replicationRole: "origin",
    cascading: [],
    ...over,
  })
  const tables = () => backfillWriteTables(stepsOf())
  const refusals = (facts: WriteFacts) =>
    writeFactRefusals(tables(), facts, "backfill").map((d) => [
      d.code,
      d.params,
    ])
  const key = tableKey("app", "items")

  it("refuses with the promotion codes and names the backfill step", () => {
    // TEMP заповненню не потрібен: тимчасової таблиці немає
    expect(refusals(FACTS())).toEqual([])
    expect(refusals(FACTS({ ruled: [key] }))).toEqual([
      [
        "plan.promotion-unsupported",
        {
          write: "backfill",
          reason: "dataStepTable",
          step: "s2",
          table: "app.items",
          detail: "rule",
        },
      ],
    ])
    expect(refusals(FACTS({ inherited: [key] }))).toEqual([
      [
        "plan.promotion-unsupported",
        {
          write: "backfill",
          reason: "dataStepTable",
          step: "s2",
          table: "app.items",
        },
      ],
    ])
    expect(refusals(FACTS({ cascading: ["s2"] }))).toEqual([
      [
        "plan.promotion-unsupported",
        {
          write: "backfill",
          reason: "dataStepReferenced",
          step: "s2",
          table: "app.items",
          column: "note",
        },
      ],
    ])
    expect(refusals(FACTS({ replicationRole: "replica" }))).toEqual([
      ["plan.replication-role", { value: "replica", write: "backfill" }],
    ])
  })

  it("asks the cascading foreign keys on the backfilled column", async () => {
    const log: { sql: string; params: readonly unknown[] }[] = []
    const tx = {
      query: (sql: string, params: readonly unknown[] = []) => {
        log.push({ sql, params })
        return Promise.resolve(
          sql.includes("has_database_privilege")
            ? [{ temp: true, role: "origin" }]
            : []
        )
      },
    } as unknown as ApplyTransaction
    await readWriteFacts(tx, tables())
    const asked = log.find((q) => q.sql.includes("confupdtype"))!
    expect(JSON.parse(asked.params[0] as string)).toEqual([
      { step: "s2", schema: "app", table: "items", column: "note" },
    ])
  })

  it("refuses a default calling a model function a plan step changes", () => {
    const desired = model(
      table([
        column("id"),
        column("note", { notNull: true, default: "app.norm()" }),
      ])
    )
    const set = action(
      'ALTER TABLE "app"."items" ALTER COLUMN "note" SET DEFAULT app.norm()'
    )
    const steps = stepsOf({
      desired,
      actions: [set, SET_NOT_NULL],
      physical: physical("app.norm()"),
    })
    expect(backfillStepRefusals(steps, parse)).toEqual([])
    const changing: PlanStep = {
      ...intentStep(
        "CREATE OR REPLACE FUNCTION app.norm() RETURNS text AS 'x' LANGUAGE sql",
        []
      ),
      id: "s9",
      origin: "engine",
      produced: [{ kind: "function", schema: "app", name: "norm" }],
    }
    expect(
      backfillStepRefusals([...steps, changing], parse).map((d) => [
        d.code,
        d.params.step,
        d.params.by,
        d.params.write,
      ])
    ).toEqual([["plan.data-step-function-changed", "s2", "s9", "backfill"]])
  })
})
