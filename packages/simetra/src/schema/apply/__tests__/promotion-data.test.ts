import { beforeAll, describe, expect, it } from "vitest"
import {
  loadSqlParser,
  type PromotionRecord,
  type SqlParser,
} from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import {
  ApplyDbError,
  castGuardForms,
  dataComputeSql,
  dataCountSql,
  dataFactRefusals,
  dataGuardSql,
  dataPlan,
  dataStepRefusals,
  dataWriteSql,
  GUARD_PAIR_SQLSTATES,
  preservationTypeRefusals,
  preservationTypeStepRefusals,
  statementSubjects,
  intentStep,
  promotionPermissionItems,
  readDataFacts,
  tableKey,
  triggerSql,
  typeIdentity,
  type ApplyTransaction,
  type DataFacts,
  type DataTable,
  type PlannedDataTable,
  type PlanStep,
  type Removal,
  type TypePresence,
} from "simetra/schema"

/**
 * Секція кроків даних промоції (рішення 1–5, 12, 13 плану П3-2b-2): звірка
 * запису, ідентифікатори й тимчасові імена, межі кроку, рендер SQL, факти
 * цілі й відмови з них. Справжня база — у `build-plan.db.test.ts` designer.
 */

const OBJECT_ID = "00000000-0000-4000-8000-000000000001"
const SECTION_ID = "00000000-0000-4000-8000-000000000002"
const FILE = `plans/${OBJECT_ID}.promotion.json`
const ORIGIN = { objectId: OBJECT_ID, file: FILE }

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
  columns: Readonly<Record<string, string>>,
  origin: PhysicalTable["origin"] = { objectId: OBJECT_ID }
): PhysicalTable {
  return {
    schema: "app",
    name,
    origin,
    rowLevelSecurity: "enabled",
    columns: Object.entries(columns).map(([c, type]) => ({
      name: c,
      type,
      notNull: false,
      origin: {},
    })),
    primaryKey: { name: `${name}_pkey`, columns: ["id"] },
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  }
}

let n = 0
const column = (table: string, from: string, to: string) => ({
  id: `00000000-0000-4000-8000-0000000001${String(++n).padStart(2, "0")}`,
  sourceId: `00000000-0000-4000-8000-0000000002${String(n).padStart(2, "0")}`,
  schema: "app",
  table,
  from,
  to,
})

const step = (
  table: string,
  column: string,
  expression: string,
  kind: PromotionRecord["dataSteps"][number]["kind"]
): PromotionRecord["dataSteps"][number] => ({
  names: "beforeRenames",
  schema: "app",
  table,
  key: "id",
  column,
  expression,
  kind,
})

/** `app.items` → `app.catalog_items`, ТЧ `app.item_lines` → `app.catalog_item_lines`. */
const TABLES = [
  { id: OBJECT_ID, schema: "app", from: "items", to: "catalog_items" },
  {
    id: SECTION_ID,
    schema: "app",
    from: "item_lines",
    to: "catalog_item_lines",
  },
]
const COLUMNS = [
  column("catalog_items", "id", "id"),
  column("catalog_items", "code", "code"),
  column("catalog_items", "price", "price"),
  column("catalog_items", "payload", "payload"),
  column("catalog_item_lines", "id", "id"),
  column("catalog_item_lines", "item_id", "parent_id"),
]
const RETIRED = [
  { sourceId: OBJECT_ID, schema: "app", table: "items", column: "inactive" },
]

const SOURCE = {
  tables: [
    table("items", {
      id: "uuid",
      code: "text",
      price: "integer",
      payload: "text",
      inactive: "boolean",
    }),
    table(
      "item_lines",
      { id: "uuid", item_id: "uuid" },
      { objectId: SECTION_ID }
    ),
  ],
}

const desiredOf = (codeType = "text", priceType = "integer") => ({
  physical: {
    tables: [
      table("catalog_items", {
        id: "uuid",
        code: codeType,
        price: priceType,
        payload: "jsonb",
        deletion_mark: "boolean",
        label: "text",
      }),
      table(
        "catalog_item_lines",
        { id: "uuid", parent_id: "uuid", line_number: "integer" },
        { objectId: OBJECT_ID, tabularSectionId: SECTION_ID }
      ),
    ],
    enumTypes: [],
  },
  sqlUnits: [],
})

const plan = (
  r: PromotionRecord,
  desired: ReturnType<typeof desiredOf> = desiredOf()
) => dataPlan({ record: r, file: FILE, source: SOURCE, desired, parse })

const planned = (r: PromotionRecord, desired = desiredOf()) => {
  const out = plan(r, desired)
  if ("refusal" in out)
    throw new Error(out.refusal.map((d) => d.message).join("; "))
  return out
}

const refusals = (r: PromotionRecord, desired = desiredOf()) => {
  const out = plan(r, desired)
  if (!("refusal" in out)) throw new Error("expected a refusal")
  return out.refusal.map((d) => [d.code, d.params])
}

const unitRecord = (over: Partial<PromotionRecord>) =>
  record({ tables: TABLES, columns: COLUMNS, retired: RETIRED, ...over })

describe("dataPlan", () => {
  it("numbers data steps and temp tables in record order", () => {
    const { tables, sources } = planned(
      unitRecord({
        dataSteps: [
          step(
            "items",
            "deletion_mark",
            "coalesce(inactive, false)",
            "conversion"
          ),
          step(
            "item_lines",
            "line_number",
            "row_number() over (order by id)",
            "backfill"
          ),
          step("items", "code", "left(code, 20)", "repair"),
        ],
      })
    )
    expect(
      tables.map((t) => [t.temp, t.columns.map((c) => [c.step, c.column])])
    ).toEqual([
      [
        "simetra_fill_1",
        [
          ["d1", "deletion_mark"],
          ["d3", "code"],
        ],
      ],
      ["simetra_fill_2", [["d2", "line_number"]]],
    ])
    expect(tables[0]!.before).toEqual({
      schema: "app",
      table: "items",
      key: "id",
    })
    expect(tables[1]!.after).toEqual({
      schema: "app",
      table: "catalog_item_lines",
      key: "id",
    })
    // Старе ім'я джерела — лише для змапленої цілі
    expect([...sources]).toEqual([["d3", "code"]])
  })

  it("plans nothing without data steps", () => {
    expect(planned(unitRecord({}))).toEqual({ tables: [], sources: new Map() })
  })

  it("types each column by the desired column, and a mapped type change by the old type", () => {
    // Аудит Codex: у CTAS бажаний `varchar(20)` мовчки обрізав би наявні
    // довгі коди, а старий тип несе їх до кроку двигуна з його сторожем
    const r = unitRecord({
      typeChanges: [
        {
          schema: "app",
          table: "catalog_items",
          column: "code",
          from: "text",
          to: "character varying(20)",
        },
      ],
      dataSteps: [
        step("items", "code", "coalesce(code, 'x')", "backfill"),
        step(
          "items",
          "deletion_mark",
          "coalesce(inactive, false)",
          "conversion"
        ),
      ],
    })
    const [t] = planned(r, desiredOf("character varying(20)")).tables
    expect(t!.columns.map((c) => [c.column, c.type])).toEqual([
      ["code", "text"],
      ["deletion_mark", "boolean"],
    ])
  })

  it("guards the cast of each data step", () => {
    const [t] = planned(
      unitRecord({
        dataSteps: [step("items", "code", "left(code, 20)", "repair")],
      })
    ).tables
    // Форма з порівнянням — до проби на копії
    expect(t!.columns[0]!.guard).toBe(
      "SELECT pg_catalog.count(*) AS lost FROM (SELECT (\nleft(code, 20)\n) AS x FROM app.items) AS s WHERE x IS NOT NULL AND (x::text) IS DISTINCT FROM x"
    )
    expect(
      dataGuardSql(
        { schema: "app", table: "items" },
        { expression: "payload", type: "jsonb" },
        "text"
      )
    ).toBe(
      "SELECT pg_catalog.count(*) AS lost FROM (SELECT (\npayload\n) AS x FROM app.items) AS s WHERE x IS NOT NULL AND (x::jsonb)::pg_catalog.text IS DISTINCT FROM x::pg_catalog.text"
    )
  })

  it("refuses a repair recorded as a conversion", () => {
    expect(
      refusals(
        unitRecord({
          dataSteps: [step("items", "code", "left(code, 20)", "conversion")],
        })
      )
    ).toEqual([
      [
        "plan.promotion-record-mismatch",
        {
          objectId: OBJECT_ID,
          file: FILE,
          // Рішення 2: `detail` — буквально `dataSteps`
          detail: "dataSteps",
          step: "d1",
          reason: "derived repair, recorded conversion",
        },
      ],
    ])
  })

  it("refuses a data step on a table outside the record", () => {
    const [[code, params]] = refusals(
      unitRecord({
        dataSteps: [step("others", "code", "left(code, 20)", "repair")],
      })
    ) as [[string, Record<string, string>]]
    expect(code).toBe("plan.promotion-record-mismatch")
    expect(params).toMatchObject({ detail: "dataSteps", step: "d1" })
    expect(params.reason).toMatch(/^table app\.others /)
  })

  it("refuses a data step on a column the desired table lacks", () => {
    const [[code, params]] = refusals(
      unitRecord({
        dataSteps: [step("items", "missing", "left(code, 20)", "backfill")],
      })
    ) as [[string, Record<string, string>]]
    expect(code).toBe("plan.promotion-record-mismatch")
    expect(params).toMatchObject({ detail: "dataSteps", step: "d1" })
    expect(params.reason).toMatch(/^column missing /)
  })

  it("refuses a recorded expression that is not a data step", () => {
    const [[code, params]] = refusals(
      unitRecord({
        dataSteps: [step("items", "code", "random()::text", "repair")],
      })
    ) as [[string, Record<string, string>]]
    expect(code).toBe("plan.promotion-record-mismatch")
    expect(params.reason).toMatch(/not a data step \(volatile\)/)
  })

  const keyRefusal = (r: PromotionRecord) =>
    refusals(r)
      .filter(([c]) => c === "plan.promotion-unsupported")
      .map(([, p]) => (p as Record<string, string>).reason)

  it("refuses a key that is a fill target", () => {
    const r = unitRecord({
      dataSteps: [
        step("items", "code", "left(code, 20)", "repair"),
        step(
          "items",
          "id",
          "coalesce(id, '00000000-0000-4000-8000-000000000000'::uuid)",
          "backfill"
        ),
      ],
    })
    expect(keyRefusal(r)).toEqual(["dataStepKey", "dataStepKey"])
    expect(refusals(r)[0]![1]).toMatchObject({
      step: "d1",
      table: "app.items",
      key: "id",
      detail: "fillTarget",
    })
  })

  it("refuses a key that is retired", () => {
    const r = unitRecord({
      columns: COLUMNS.filter(
        (c) => !(c.table === "catalog_items" && c.from === "id")
      ),
      retired: [
        ...RETIRED,
        { sourceId: OBJECT_ID, schema: "app", table: "items", column: "id" },
      ],
      dataSteps: [step("items", "code", "left(code, 20)", "repair")],
    })
    expect(refusals(r)).toEqual([
      [
        "plan.promotion-unsupported",
        expect.objectContaining({ reason: "dataStepKey", detail: "retired" }),
      ],
    ])
  })

  it("refuses a key whose type changes", () => {
    const r = unitRecord({
      typeChanges: [
        {
          schema: "app",
          table: "catalog_items",
          column: "id",
          from: "uuid",
          to: "text",
        },
      ],
      dataSteps: [step("items", "code", "left(code, 20)", "repair")],
    })
    expect(refusals(r)).toEqual([
      [
        "plan.promotion-unsupported",
        expect.objectContaining({
          reason: "dataStepKey",
          detail: "typeChange",
        }),
      ],
    ])
  })

  it("refuses a key that is not the primary key", () => {
    const r = unitRecord({
      dataSteps: [
        { ...step("items", "label", "'x'", "backfill"), key: "code" },
      ],
    })
    expect(refusals(r)).toEqual([
      [
        "plan.promotion-unsupported",
        expect.objectContaining({
          reason: "dataStepKey",
          key: "code",
          detail: "notPrimaryKey",
        }),
      ],
    ])
  })

  it("refuses a data step on a mapped column whose old type is not text", () => {
    const changed = (from: string, to: string, expression: string) =>
      unitRecord({
        typeChanges: [
          { schema: "app", table: "catalog_items", column: "price", from, to },
        ],
        dataSteps: [step("items", "price", expression, "repair")],
      })
    expect(
      refusals(
        changed("integer", "numeric(10,2)", "price * 2"),
        desiredOf("text", "numeric(10,2)")
      )
    ).toEqual([
      [
        "plan.promotion-unsupported",
        expect.objectContaining({
          reason: "dataStepType",
          step: "d1",
          column: "price",
          type: "integer",
          detail: "oldType",
        }),
      ],
    ])
    // Свідома конверсія з рядкового типу без межі — без відмови
    const jsonb = unitRecord({
      typeChanges: [
        {
          schema: "app",
          table: "catalog_items",
          column: "payload",
          from: "text",
          to: "jsonb",
        },
      ],
      dataSteps: [step("items", "payload", "payload::jsonb::text", "repair")],
    })
    expect(planned(jsonb).tables[0]!.columns[0]!.type).toBe("text")
  })
})

/** Таблиця секції для рендерів: два кроки й тригери обох режимів. */
const ITEMS: DataTable = {
  temp: "simetra_fill_1",
  before: { schema: "app", table: "items", key: "id" },
  after: { schema: "app", table: "catalog_items", key: "id" },
  columns: [
    {
      step: "d1",
      column: "code",
      type: "text",
      expression: "left(code, 20)",
      kind: "repair",
      guard: "",
    },
    {
      step: "d2",
      column: "deletion_mark",
      type: "boolean",
      expression: "coalesce(inactive, false)",
      kind: "conversion",
      guard: "",
    },
  ],
  triggers: [
    { name: "a", enabled: "A" },
    { name: "o", enabled: "O" },
  ],
}

describe("data step renders", () => {
  it("renders one compute and one write per table", () => {
    expect(dataComputeSql(ITEMS)).toBe(
      "CREATE TEMP TABLE simetra_fill_1 ON COMMIT DROP AS SELECT id AS k, ((\nleft(code, 20)\n)::text) AS v1, ((\ncoalesce(inactive, false)\n)::boolean) AS v2 FROM app.items"
    )
    expect(dataCountSql(ITEMS)).toBe(
      "SELECT pg_catalog.count(*) AS computed FROM pg_temp.simetra_fill_1"
    )
    expect(dataWriteSql(ITEMS)).toBe(
      "WITH u AS (UPDATE app.catalog_items AS t SET code = d.v1, deletion_mark = d.v2 FROM pg_temp.simetra_fill_1 AS d WHERE t.id OPERATOR(pg_catalog.=) d.k RETURNING 1) SELECT pg_catalog.count(*) AS written FROM u"
    )
    expect(triggerSql(ITEMS, false)).toEqual([
      "ALTER TABLE app.catalog_items DISABLE TRIGGER a",
      "ALTER TABLE app.catalog_items DISABLE TRIGGER o",
    ])
    // Завжди ввімкнений тригер повертається в `A`, а не в `O`
    expect(triggerSql(ITEMS, true)).toEqual([
      "ALTER TABLE app.catalog_items ENABLE ALWAYS TRIGGER a",
      "ALTER TABLE app.catalog_items ENABLE TRIGGER o",
    ])
  })

  it("parses every render as one statement, a comment in the expression included", () => {
    const commented: DataTable = {
      ...ITEMS,
      columns: [{ ...ITEMS.columns[0]!, expression: "left(code, 20) -- trim" }],
    }
    for (const sql of [
      dataComputeSql(commented),
      dataWriteSql(commented),
      dataGuardSql(commented.before, commented.columns[0]!, "compare"),
    ]) {
      const result = parse(sql)
      expect(result.ok && result.statements.length).toBe(1)
    }
  })
})

/** Факти цілі без відмов. */
const FACTS = (over: Partial<DataFacts> = {}): DataFacts => ({
  triggers: new Map(),
  inherited: [],
  tempPrivilege: true,
  replicationRole: "origin",
  types: new Map<string, TypePresence>([
    ["text", "found"],
    ["boolean", "found"],
  ]),
  functions: [],
  cascading: [],
  ...over,
})

const PLANNED: PlannedDataTable[] = [
  {
    temp: ITEMS.temp,
    before: ITEMS.before,
    after: ITEMS.after,
    columns: ITEMS.columns,
  },
]

/** Функції моделі бажаного стану (`modelFunctions(...).immutable`). */
const MODELS: ReadonlySet<string> = new Set(["app.norm"])

const factCodes = (facts: DataFacts) =>
  dataFactRefusals(PLANNED, facts, "postgres", ORIGIN, MODELS).map((d) => [
    d.code,
    d.params,
  ])

describe("dataFactRefusals", () => {
  it("refuses nothing on a fitting target", () => {
    expect(factCodes(FACTS())).toEqual([])
    expect(
      dataFactRefusals([], FACTS({ tempPrivilege: false }), "r", ORIGIN, MODELS)
    ).toEqual([])
  })

  it("refuses a catalog function that is not immutable on the target", () => {
    const lower = { step: "d1", name: "lower", immutable: false, exists: true }
    expect(factCodes(FACTS({ functions: [lower] }))).toEqual([
      ["plan.data-step-volatile", { step: "d1", function: "lower" }],
    ])
    // Функції, якої на цілі немає, детермінованість теж не доведено
    expect(
      factCodes(
        FACTS({ functions: [{ ...lower, immutable: true, exists: false }] })
      )
    ).toEqual([["plan.data-step-volatile", { step: "d1", function: "lower" }]])
  })

  it("refuses a model function the target lacks as one the plan creates", () => {
    expect(
      factCodes(
        FACTS({
          functions: [
            {
              step: "d2",
              schema: "app",
              name: "norm",
              immutable: false,
              exists: false,
            },
          ],
        })
      )
    ).toEqual([
      ["plan.data-step-function-changed", { step: "d2", function: "app.norm" }],
    ])
    // Відсутня функція не моделі план не створює: її детермінованість на
    // цілі просто не доведено
    expect(
      factCodes(
        FACTS({
          functions: [
            {
              step: "d2",
              schema: "extensions",
              name: "norm",
              immutable: false,
              exists: false,
            },
          ],
        })
      )
    ).toEqual([
      ["plan.data-step-volatile", { step: "d2", function: "extensions.norm" }],
    ])
  })

  it("refuses an inherited table", () => {
    expect(factCodes(FACTS({ inherited: [tableKey("app", "items")] }))).toEqual(
      [
        [
          "plan.promotion-unsupported",
          {
            objectId: OBJECT_ID,
            file: FILE,
            reason: "dataStepTable",
            step: "d1",
            table: "app.items",
          },
        ],
      ]
    )
  })

  it("refuses a target type absent on the target", () => {
    expect(factCodes(FACTS({ types: new Map([["text", "found"]]) }))).toEqual([
      [
        "plan.promotion-unsupported",
        expect.objectContaining({
          reason: "dataStepType",
          step: "d2",
          column: "deletion_mark",
          type: "boolean",
          detail: "missing",
        }),
      ],
    ])
  })

  it("refuses a target type the plan cannot name as its own detail", () => {
    expect(
      factCodes(
        FACTS({
          types: new Map<string, TypePresence>([
            ["text", "found"],
            ["boolean", "unparsed"],
          ]),
        })
      ).map(([, p]) => (p as Record<string, string>).detail)
    ).toEqual(["unparsed"])
  })

  it("refuses a fill target referenced with a cascading update", () => {
    expect(factCodes(FACTS({ cascading: ["d1"] }))).toEqual([
      [
        "plan.promotion-unsupported",
        expect.objectContaining({
          reason: "dataStepReferenced",
          step: "d1",
          column: "code",
        }),
      ],
    ])
  })

  it("refuses without the TEMP privilege", () => {
    expect(factCodes(FACTS({ tempPrivilege: false }))).toEqual([
      ["plan.temp-privilege", { role: "postgres" }],
    ])
  })

  it("refuses a session replication role other than origin", () => {
    expect(factCodes(FACTS({ replicationRole: "replica" }))).toEqual([
      ["plan.replication-role", { value: "replica" }],
    ])
  })
})

/**
 * Транзакція-шпигун: записує запити й відповідає на кожен рядками
 * `answer`. Витягу двигуна факти не просять.
 */
function spyTx(
  answer: (sql: string, params: readonly unknown[]) => Record<string, unknown>[]
): {
  tx: ApplyTransaction
  log: { sql: string; params: readonly unknown[] }[]
} {
  const log: { sql: string; params: readonly unknown[] }[] = []
  return {
    log,
    tx: {
      query: async <R extends Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = []
      ) => {
        log.push({ sql, params })
        return answer(sql, params) as R[]
      },
      extract: () => {
        throw new Error("the data facts do not extract")
      },
    },
  }
}

/** Відповіді фактів: сесія годиться, решта — з `over`. */
const factAnswers =
  (
    over: {
      functions?: (asked: { i: number; name: string }[]) => unknown[]
      types?: boolean
    } = {}
  ) =>
  (sql: string, params: readonly unknown[]): Record<string, unknown>[] => {
    if (sql.includes("has_database_privilege"))
      return [{ temp: true, role: "origin" }]
    if (sql.includes("pg_proc")) {
      const asked = JSON.parse(params[0] as string) as {
        i: number
        name: string
      }[]
      return (over.functions?.(asked) ?? []) as Record<string, unknown>[]
    }
    if (sql.includes("pg_type")) {
      const asked = JSON.parse(params[0] as string) as { i: number }[]
      return asked.map((a) => ({ i: a.i, found: over.types ?? true }))
    }
    return []
  }

const withExpressions = (
  ...columns: [string, string, string][]
): PlannedDataTable[] => [
  {
    ...PLANNED[0]!,
    columns: columns.map(([step, expression, type]) => ({
      step,
      column: `c_${step}`,
      type,
      expression,
      kind: "backfill" as const,
      guard: "",
    })),
  },
]

describe("readDataFacts", () => {
  it("exempts only the transaction time functions", async () => {
    // Вердикт архітектора: час транзакції T1 уже допустив поза ремонтом,
    // а `STABLE`-функцію поза переліком план питає й відхиляє
    const tables = withExpressions(
      ["d1", "coalesce(created_at, now())", "timestamp with time zone"],
      ["d2", "pg_catalog.transaction_timestamp()", "timestamp with time zone"],
      ["d3", "current_setting('x')", "text"]
    )
    const { tx, log } = spyTx(
      factAnswers({
        functions: (asked) =>
          asked.map((a) => ({ i: a.i, overloads: 1, immutable: false })),
      })
    )
    const facts = await readDataFacts(tx, tables, parse)
    const asked = log.find((q) => q.sql.includes("pg_proc"))!
    expect(JSON.parse(asked.params[0] as string)).toEqual([
      { i: 0, schema: "pg_catalog", name: "current_setting" },
    ])
    expect(facts.functions).toEqual([
      { step: "d3", name: "current_setting", immutable: false, exists: true },
    ])
    expect(
      dataFactRefusals(tables, facts, "postgres", ORIGIN, MODELS).map(
        (d) => d.code
      )
    ).toEqual(["plan.data-step-volatile"])
  })

  it("asks a model function in its own schema", async () => {
    const { tx, log } = spyTx(factAnswers())
    const facts = await readDataFacts(
      tx,
      withExpressions(["d1", "app.norm(code)", "text"]),
      parse
    )
    const asked = log.find((q) => q.sql.includes("pg_proc"))!
    expect(JSON.parse(asked.params[0] as string)).toEqual([
      { i: 0, schema: "app", name: "norm" },
    ])
    expect(facts.functions).toEqual([
      {
        step: "d1",
        schema: "app",
        name: "norm",
        immutable: false,
        exists: false,
      },
    ])
  })

  it("normalizes a bare type to pg_catalog and refuses a bare user type", async () => {
    // Рішення В5: знімок адаптера кваліфікує кожен тип поза `pg_catalog`, тож
    // голе `citext` при `public.citext` у знімку — тип каталогу, якого немає
    expect(typeIdentity("citext", parse)).toEqual({
      schema: "pg_catalog",
      name: "citext",
    })
    expect(typeIdentity("public.citext", parse)).toEqual({
      schema: "public",
      name: "citext",
    })
    expect(typeIdentity("character varying(20)[]", parse)).toEqual({
      schema: "pg_catalog",
      name: "varchar",
    })
    const tables = withExpressions(["d1", "code", "citext"])
    const { tx, log } = spyTx(factAnswers({ types: false }))
    const facts = await readDataFacts(tx, tables, parse)
    const asked = log.find((q) => q.sql.includes("pg_type"))!
    expect(JSON.parse(asked.params[0] as string)).toEqual([
      { i: 0, schema: "pg_catalog", name: "citext" },
    ])
    expect(facts.types).toEqual(new Map([["citext", "missing"]]))
    expect(
      dataFactRefusals(tables, facts, "postgres", ORIGIN, MODELS).map((d) => [
        d.code,
        d.params.reason,
      ])
    ).toEqual([["plan.promotion-unsupported", "dataStepType"]])
  })

  it("reads cascading references only for mapped targets in old names", async () => {
    const { tx, log } = spyTx(factAnswers())
    await readDataFacts(
      tx,
      withExpressions(["d1", "left(code, 20)", "text"], ["d2", "'x'", "text"]),
      parse,
      new Map([["d1", "code"]])
    )
    const asked = log.find((q) => q.sql.includes("confupdtype"))!
    expect(JSON.parse(asked.params[0] as string)).toEqual([
      { step: "d1", schema: "app", table: "items", column: "code" },
    ])
  })
})

/** Крок двигуна: SQL, дія й об'єкти, які він створює, знищує чи вживає. */
const engineStep = (
  over: Partial<
    Pick<PlanStep, "sql" | "produced" | "destroyed" | "consumed" | "verb">
  >
): PlanStep => ({
  ...intentStep("SELECT 1", []),
  id: "s9",
  origin: "engine",
  produced: [],
  destroyed: [],
  consumed: [],
  ...over,
})

const NORM = { kind: "function", schema: "app", name: "norm" }
const CODE_T = { kind: "domain", schema: "app", name: "code_t" }

const stepCodes = (tables: PlannedDataTable[], steps: PlanStep[]) =>
  dataStepRefusals(tables, steps, parse, ORIGIN).map((d) => [d.code, d.params])

describe("dataStepRefusals", () => {
  it("refuses a type a step creates", () => {
    const tables = withExpressions(["d1", "code", "app.code_t"])
    expect(
      dataStepRefusals(
        tables,
        [engineStep({ produced: [CODE_T] })],
        parse,
        ORIGIN
      ).map((d) => [d.code, d.params.reason, d.params.detail, d.params.by])
    ).toEqual([["plan.promotion-unsupported", "dataStepType", "changed", "s9"]])
  })

  it("refuses a type whose constraint a step changes", () => {
    const tables = withExpressions(["d1", "code", "app.code_t"])
    expect(
      dataStepRefusals(
        tables,
        [
          engineStep({
            destroyed: [
              {
                kind: "constraint",
                schema: "app",
                table: "code_t",
                name: "code_t_check",
              },
            ],
          }),
        ],
        parse,
        ORIGIN
      ).map((d) => d.params.reason)
    ).toEqual(["dataStepType"])
  })

  it("refuses a model function a step creates, any overload", () => {
    expect(
      stepCodes(withExpressions(["d1", "app.norm(code)", "text"]), [
        engineStep({ produced: [NORM] }),
      ])
    ).toEqual([
      [
        "plan.data-step-function-changed",
        { step: "d1", function: "app.norm", detail: "changed", by: "s9" },
      ],
    ])
  })

  it("refuses a model function a step replaces in place", () => {
    // `CREATE OR REPLACE FUNCTION` двигун дає дією `alter` із функцією лише в
    // `consumed`: предмет оператора — сама функція
    expect(
      stepCodes(withExpressions(["d1", "app.norm(code)", "text"]), [
        engineStep({
          verb: "alter",
          sql: "CREATE OR REPLACE FUNCTION app.norm(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper(t) $$",
          consumed: [NORM],
        }),
      ])
    ).toEqual([
      [
        "plan.data-step-function-changed",
        { step: "d1", function: "app.norm", detail: "changed", by: "s9" },
      ],
    ])
  })

  it("refuses a create of an overload with the name of the fill function", () => {
    // Вердикт R4: предмет оператора важить для будь-якої дії. Нове
    // перевантаження з тим самим ім'ям змінює те, що розв'яже виклик, навіть
    // коли `produced` його не називає
    expect(
      stepCodes(withExpressions(["d1", "app.norm(code)", "text"]), [
        engineStep({
          verb: "create",
          sql: "CREATE FUNCTION app.norm(t int) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT t::text $$",
        }),
      ])
    ).toEqual([
      [
        "plan.data-step-function-changed",
        { step: "d1", function: "app.norm", detail: "changed", by: "s9" },
      ],
    ])
  })

  it("lets through a trigger that calls the fill function", () => {
    // `CREATE TRIGGER` вживає функцію (`consumed`), але не змінює її: предмет
    // — тригер, і «не доведено» для `create` не діє
    expect(
      stepCodes(withExpressions(["d1", "app.norm(code)", "text"]), [
        engineStep({
          verb: "create",
          sql: "CREATE TRIGGER t_norm BEFORE UPDATE ON app.t FOR EACH ROW EXECUTE FUNCTION app.norm()",
          produced: [
            { kind: "trigger", schema: "app", table: "t", name: "t_norm" },
          ],
          consumed: [NORM],
        }),
      ])
    ).toEqual([])
  })

  it("lets through an alter of another table that only reads the domain", () => {
    // Вердикт В7: `ALTER TABLE … ALTER COLUMN … TYPE <домен>` — теж `alter` із
    // доменом у `consumed`, але предмет — таблиця
    expect(
      stepCodes(withExpressions(["d1", "code", "app.code_t"]), [
        engineStep({
          verb: "alter",
          sql: "ALTER TABLE app.other ALTER COLUMN c TYPE app.code_t",
          consumed: [
            { kind: "column", schema: "app", table: "other", name: "c" },
            CODE_T,
          ],
        }),
      ])
    ).toEqual([])
  })

  it("refuses as unproven an alter whose statement has no determined subject", () => {
    // Вузол поза переліком (`GRANT`) і ім'я без схеми — третій випадок: крок
    // вживає функцію, а що він змінює, з дерева не визначити
    for (const sql of [
      "GRANT EXECUTE ON FUNCTION app.norm(text) TO anon",
      "CREATE OR REPLACE FUNCTION norm(t text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT t $$",
    ])
      expect(
        stepCodes(withExpressions(["d1", "app.norm(code)", "text"]), [
          engineStep({ verb: "alter", sql, consumed: [NORM] }),
        ]),
        sql
      ).toEqual([
        [
          "plan.data-step-function-changed",
          { step: "d1", function: "app.norm", detail: "unproven", by: "s9" },
        ],
      ])
    // Без самого об'єкта в `consumed` невизначений предмет не важить
    expect(
      stepCodes(withExpressions(["d1", "app.norm(code)", "text"]), [
        engineStep({
          verb: "alter",
          sql: "GRANT SELECT ON app.t TO anon",
          consumed: [{ kind: "table", schema: "app", name: "t" }],
        }),
      ])
    ).toEqual([])
  })

  it("refuses when one statement of a multi-statement step is the subject", () => {
    expect(
      stepCodes(withExpressions(["d1", "code", "app.code_t"]), [
        engineStep({
          verb: "alter",
          sql: "ALTER TABLE app.other ALTER COLUMN c SET NOT NULL; ALTER DOMAIN app.code_t SET DEFAULT ''",
          consumed: [CODE_T],
        }),
      ]).map(([, p]) => (p as Record<string, string>).detail)
    ).toEqual(["changed"])
  })

  it("lets through steps that touch other types and functions", () => {
    expect(
      stepCodes(withExpressions(["d1", "app.norm(code)", "app.code_t"]), [
        engineStep({
          produced: [
            { kind: "domain", schema: "app", name: "other_t" },
            { kind: "function", schema: "other", name: "norm" },
            { kind: "table", schema: "app", name: "code_t2" },
          ],
        }),
        engineStep({
          verb: "alter",
          sql: "ALTER TYPE app.other_t ADD VALUE 'x'",
          consumed: [{ kind: "type", schema: "app", name: "other_t" }],
        }),
      ])
    ).toEqual([])
  })
})

describe("statementSubjects", () => {
  it("names the subject of each statement structurally", () => {
    expect(
      statementSubjects(
        `CREATE OR REPLACE FUNCTION app.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;
         ALTER FUNCTION app.f() STABLE;
         ALTER DOMAIN app.d ADD CONSTRAINT c CHECK (VALUE <> '');
         ALTER TYPE app.e ADD VALUE 'x';
         ALTER TYPE app.c ADD ATTRIBUTE a int;
         ALTER TYPE app.e RENAME TO e2;
         ALTER FUNCTION app.f() OWNER TO anon;
         ALTER DOMAIN app.d SET SCHEMA other;
         ALTER TABLE app.t ALTER COLUMN c TYPE app.d;
         COMMENT ON FUNCTION app.f() IS 'x';
         GRANT EXECUTE ON FUNCTION app.f() TO anon;
         ALTER DOMAIN d SET DEFAULT ''`,
        parse
      )
    ).toEqual([
      { kind: "routine", schema: "app", name: "f" },
      { kind: "routine", schema: "app", name: "f" },
      { kind: "type", schema: "app", name: "d" },
      { kind: "type", schema: "app", name: "e" },
      { kind: "type", schema: "app", name: "c" },
      { kind: "type", schema: "app", name: "e" },
      { kind: "routine", schema: "app", name: "f" },
      { kind: "type", schema: "app", name: "d" },
      { kind: "other" },
      { kind: "other" },
      { kind: "unknown" },
      // Ім'я без схеми — не вгадується
      { kind: "unknown" },
    ])
  })
})

describe("preservation types", () => {
  const changed = (to: string) =>
    record({
      typeChanges: [
        { schema: "app", table: "item", column: "code", from: "text", to },
      ],
    })

  it("refuses a new type absent on the target before the copy", () => {
    expect(
      preservationTypeRefusals(
        changed("app.code_t"),
        new Map<string, TypePresence>([["app.code_t", "missing"]])
      ).map((d) => [d.code, d.params])
    ).toEqual([
      [
        "plan.preservation-type",
        { column: "app.item.code", type: "app.code_t", detail: "missing" },
      ],
    ])
    expect(
      preservationTypeRefusals(
        changed("character varying(20)"),
        new Map<string, TypePresence>([["character varying(20)", "found"]])
      )
    ).toEqual([])
  })

  it("refuses a new type a step creates, changes or cannot prove", () => {
    const steps = [engineStep({ produced: [CODE_T] })]
    expect(
      preservationTypeStepRefusals(changed("app.code_t"), steps, parse).map(
        (d) => [d.code, d.params]
      )
    ).toEqual([
      [
        "plan.preservation-type",
        {
          column: "app.item.code",
          type: "app.code_t",
          detail: "changed",
          by: "s9",
        },
      ],
    ])
    // Зміна типу самої колонки лише читає домен
    expect(
      preservationTypeStepRefusals(
        changed("app.code_t"),
        [
          engineStep({
            verb: "alter",
            sql: "ALTER TABLE app.item ALTER COLUMN code TYPE app.code_t",
            consumed: [CODE_T],
          }),
        ],
        parse
      )
    ).toEqual([])
  })
})

describe("castGuardForms", () => {
  /** Копія, де `PREPARE` падає з `sqlstate` на формах, що містять `fails`. */
  const probing = (fails: RegExp, sqlstate = "42883") =>
    spyTx((sql, params) => {
      if (sql.startsWith("PREPARE") && fails.test(sql))
        throw new ApplyDbError("probe failed", sqlstate)
      // Збережені налаштування `withLocalSettings`: по значенню на ім'я
      if (sql.includes("current_setting(s.name)"))
        return (params[0] as string[]).map(() => ({ value: "saved" }))
      return []
    })

  it("keeps the comparison form when it prepares", async () => {
    const { tx, log } = probing(/^$/)
    const out = await castGuardForms(tx, PLANNED, ORIGIN)
    expect("tables" in out && out.tables[0]!.columns[0]!.guard).toBe(
      dataGuardSql(ITEMS.before, ITEMS.columns[0]!, "compare")
    )
    // Під закріпленими налаштуваннями даних, з `DEALLOCATE` після проби
    expect(log.some((q) => q.sql.includes("set_config"))).toBe(true)
    expect(log.filter((q) => q.sql.startsWith("DEALLOCATE"))).toHaveLength(2)
  })

  it("picks the text form when no operator exists", async () => {
    // Форма з порівнянням закінчується самим значенням, текстова — `::text`
    const { tx } = probing(/DISTINCT FROM x$/)
    const out = await castGuardForms(tx, PLANNED, ORIGIN)
    expect("tables" in out && out.tables[0]!.columns[1]!.guard).toBe(
      dataGuardSql(ITEMS.before, ITEMS.columns[1]!, "text")
    )
  })

  it("probes inside a savepoint and deallocates", async () => {
    const statements = (log: { sql: string }[]) =>
      log
        .map((q) => q.sql.split(" ")[0]!)
        .filter((w) =>
          [
            "SAVEPOINT",
            "PREPARE",
            "DEALLOCATE",
            "RELEASE",
            "ROLLBACK",
          ].includes(w)
        )
    const ok = probing(/^$/)
    await castGuardForms(
      ok.tx,
      [{ ...PLANNED[0]!, columns: [ITEMS.columns[0]!] }],
      ORIGIN
    )
    expect(statements(ok.log)).toEqual([
      "SAVEPOINT",
      "PREPARE",
      "DEALLOCATE",
      "RELEASE",
    ])
    // Невдала форма відкочується до точки збереження, і проба йде далі
    const text = probing(/DISTINCT FROM x$/)
    await castGuardForms(
      text.tx,
      [{ ...PLANNED[0]!, columns: [ITEMS.columns[0]!] }],
      ORIGIN
    )
    expect(statements(text.log)).toEqual([
      "SAVEPOINT",
      "PREPARE",
      "ROLLBACK",
      "SAVEPOINT",
      "PREPARE",
      "DEALLOCATE",
      "RELEASE",
    ])
  })

  it("lets an error other than a missing operator or cast propagate", async () => {
    // Права чи повторюваний збій — не відмова «немає приведення»
    for (const sqlstate of ["42501", "40001"]) {
      const { tx } = probing(/IS DISTINCT FROM/, sqlstate)
      await expect(castGuardForms(tx, PLANNED, ORIGIN)).rejects.toMatchObject({
        sqlstate,
      })
    }
    expect([...GUARD_PAIR_SQLSTATES.keys()]).toEqual(["42883", "42846"])
  })

  it("refuses a cast no form prepares", async () => {
    const { tx } = probing(/IS DISTINCT FROM/)
    const out = await castGuardForms(tx, PLANNED, ORIGIN)
    expect(
      "refusal" in out &&
        out.refusal.map((d) => [d.params.reason, d.params.detail])
    ).toEqual([
      ["dataStepType", "cast"],
      ["dataStepType", "cast"],
    ])
  })
})

describe("promotionPermissionItems", () => {
  it("lists repaired columns under repair:", () => {
    const remove: Removal = {
      path: "tables.app.items.indexes.items_code_idx",
      kind: "missing",
      covered: "removed",
      tables: [{ schema: "app", name: "catalog_items" }],
    }
    const items = promotionPermissionItems([], [], [remove], [ITEMS])
    expect(items).toEqual([
      {
        token: "remove:app.catalog_items",
        summary: ["tables.app.items.indexes.items_code_idx"],
      },
      // Конверсія `deletion_mark` пункту не дає
      { token: "repair:app.catalog_items", summary: ["code ← left(code, 20)"] },
    ])
  })
})
