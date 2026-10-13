import { describe, expect, it } from "vitest"
import { loadSqlParser } from "simetra/compiler"
import type { CatalogModel, CatalogTable } from "simetra/model"
import {
  coversMode,
  footprintSubjects,
  footprintTables,
  intentStep,
  joinModes,
  lockPrivileges,
  lockRightsSql,
  planFootprint,
  planLocks,
  providerStatement,
  providerStatements,
  providerTableNames,
  stepFootprint,
  tableKey,
  type FootprintModels,
  type PlanStep,
  type ProviderLockSet,
} from "simetra/schema"

/**
 * Слід кроків і блокування плану (спека промоції §7.2, «З'єднання й
 * блокування», R26 плану П3-2a):
 * власна таблиця з класу кроку, наслідки для FK зі структурних об'єктів і
 * моделей, вихідні імена, найсильніший режим на таблицю й детермінований
 * порядок.
 */

function engineStep(
  id: string,
  lockClass: string,
  tables: { schema: string; name: string }[],
  over: Partial<PlanStep> = {}
): PlanStep {
  return {
    id,
    origin: "engine",
    sql: "SELECT 1",
    verb: "alter",
    class: "catalogOnly",
    lockClass,
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: tables,
    produces: [],
    consumes: [],
    destroys: [],
    produced: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
    ...over,
  }
}

const t = (schema: string, name: string) => ({ schema, name })

function table(
  name: string,
  foreignKeys: {
    name: string
    columns: string[]
    references: { table: string; columns: string[] }
  }[] = [],
  over: Partial<CatalogTable> = {}
): CatalogTable {
  return {
    schema: "app",
    name,
    rowLevelSecurity: "none",
    columns: [],
    uniques: [],
    checks: [],
    indexes: [],
    foreignKeys: foreignKeys.map((fk) => ({
      ...fk,
      references: { schema: "app", ...fk.references },
      onDelete: "noAction",
      onUpdate: "noAction",
      deferrable: "no",
    })),
    ...over,
  } as CatalogTable
}

const model = (...tables: CatalogTable[]): CatalogModel => ({
  tables,
  enumTypes: [],
  units: [],
})

/** `c.p_id → p.id`: c посилається на p. */
const withFk = model(
  table("p", [], { primaryKey: { name: "p_pkey", columns: ["id"] } }),
  table("c", [
    {
      name: "c_p_fk",
      columns: ["p_id"],
      references: { table: "p", columns: ["id"] },
    },
  ])
)
const withoutFk = model(table("p"), table("c"))

const models = (over: Partial<FootprintModels> = {}): FootprintModels => ({
  source: withFk,
  desired: withFk,
  typeChanges: [],
  newToOld: new Map(),
  columnsNewToOld: new Map(),
  live: [],
  providerStatements: new Map(),
  providerLocks: [],
  ...over,
})

const constraint = (name: string) => ({
  kind: "constraint",
  schema: "app",
  table: "c",
  name,
})

describe("stepFootprint", () => {
  it("takes the own table in the mode of the step's lock class", () => {
    expect(
      stepFootprint(engineStep("s1", "share", [t("app", "c")]), models())
    ).toEqual([{ schema: "app", name: "c", mode: "share" }])
    expect(
      stepFootprint(engineStep("s1", "none", [t("app", "c")]), models())
    ).toEqual([])
    // Невідомий клас — найгірший випадок
    expect(
      stepFootprint(engineStep("s1", "mystery", [t("app", "c")]), models())
    ).toEqual([{ schema: "app", name: "c", mode: "accessExclusive" }])
  })

  it("takes SHARE ROW EXCLUSIVE on the referenced table of a created FK", () => {
    const step = engineStep("s1", "shareRowExclusive", [t("app", "c")], {
      verb: "create",
      produced: [constraint("c_p_fk")],
    })
    expect(
      stepFootprint(step, models({ source: withoutFk, desired: withFk }))
    ).toEqual([
      { schema: "app", name: "c", mode: "shareRowExclusive" },
      { schema: "app", name: "p", mode: "shareRowExclusive" },
    ])
  })

  it.each([
    ["the FK", constraint("c_p_fk")],
    [
      "the FK column",
      { kind: "column", schema: "app", table: "c", name: "p_id" },
    ],
    ["the referencing table", { kind: "table", schema: "app", name: "c" }],
  ])(
    "takes ACCESS EXCLUSIVE on the referenced table when it drops %s",
    (_, ref) => {
      const step = engineStep("s1", "accessExclusive", [t("app", "c")], {
        verb: "drop",
        destroyed: [ref],
      })
      expect(
        stepFootprint(step, models({ desired: withoutFk }))
      ).toContainEqual({ schema: "app", name: "p", mode: "accessExclusive" })
    }
  )

  it("does not lock the referenced table for a dropped non-FK constraint", () => {
    const step = engineStep("s1", "accessExclusive", [t("app", "p")], {
      verb: "drop",
      destroyed: [
        { kind: "constraint", schema: "app", table: "p", name: "p_pkey" },
      ],
    })
    expect(stepFootprint(step, models())).toEqual([
      { schema: "app", name: "p", mode: "accessExclusive" },
    ])
  })

  it("takes ACCESS EXCLUSIVE on both sides of a column type change in an FK", () => {
    const step = (table: string) =>
      engineStep("s1", "accessExclusive", [t("app", table)])
    // Колонка FK: та, на яку посилаються
    expect(
      stepFootprint(
        step("c"),
        models({
          typeChanges: [
            { step: "s1", schema: "app", table: "c", column: "p_id" },
          ],
        })
      )
    ).toContainEqual({ schema: "app", name: "p", mode: "accessExclusive" })
    // Колонка, на яку посилаються: ті, що посилаються
    expect(
      stepFootprint(
        step("p"),
        models({
          typeChanges: [
            { step: "s1", schema: "app", table: "p", column: "id" },
          ],
        })
      )
    ).toContainEqual({ schema: "app", name: "c", mode: "accessExclusive" })
    // Зміна типу іншого кроку цього кроку не стосується
    expect(
      stepFootprint(
        step("c"),
        models({
          typeChanges: [
            { step: "s2", schema: "app", table: "c", column: "p_id" },
          ],
        })
      )
    ).toEqual([{ schema: "app", name: "c", mode: "accessExclusive" }])
  })

  it("takes ACCESS EXCLUSIVE on every FK-linked table when the model cannot tell", () => {
    // Обмеження, якого модель не знає (виключення, тригер обмеження), і
    // зміна FK на місці
    const unknown = engineStep("s1", "accessExclusive", [t("app", "c")], {
      verb: "create",
      produced: [constraint("c_excl")],
    })
    expect(stepFootprint(unknown, models())).toContainEqual({
      schema: "app",
      name: "p",
      mode: "accessExclusive",
    })
    const altered = engineStep("s1", "accessExclusive", [t("app", "c")], {
      verb: "alter",
      consumed: [constraint("c_p_fk")],
    })
    expect(stepFootprint(altered, models())).toEqual([
      { schema: "app", name: "c", mode: "accessExclusive" },
      { schema: "app", name: "p", mode: "accessExclusive" },
    ])
  })

  it("translates engine tables to old names and keeps intent tables as they are", () => {
    // Обмін: нове `c` — старе `p`, і навпаки. Крок наміру вже несе старе ім'я
    const newToOld = new Map([
      [tableKey("app", "c"), tableKey("app", "p")],
      [tableKey("app", "p"), tableKey("app", "c")],
    ])
    const intent: PlanStep = {
      ...intentStep("ALTER TABLE app.c RENAME TO tmp", [t("app", "c")]),
      id: "s1",
    }
    expect(stepFootprint(intent, models({ newToOld }))).toEqual([
      { schema: "app", name: "c", mode: "accessExclusive" },
    ])
    const drop = engineStep("s2", "accessExclusive", [t("app", "c")], {
      verb: "drop",
      destroyed: [constraint("c_p_fk")],
    })
    expect(stepFootprint(drop, models({ newToOld }))).toEqual([
      { schema: "app", name: "p", mode: "accessExclusive" },
      { schema: "app", name: "c", mode: "accessExclusive" },
    ])
  })
})

describe("live foreign keys", () => {
  /** `ext.r.p_code → app.p.code` на живій цілі: таблиця поза межею двигуна. */
  const outside = {
    schema: "ext",
    table: "r",
    columns: ["p_code"],
    references: { schema: "app", table: "p", columns: ["code"] },
  }

  it("takes ACCESS EXCLUSIVE on a live referencing table outside the models", () => {
    const step = engineStep("s1", "accessExclusive", [t("app", "p")])
    const typeChanges = [
      { step: "s1", schema: "app", table: "p", column: "code" },
    ]
    expect(
      stepFootprint(step, models({ typeChanges, live: [outside] }))
    ).toContainEqual({ schema: "ext", name: "r", mode: "accessExclusive" })
    // Інша колонка тієї самої таблиці FK не перебудовує
    expect(
      stepFootprint(
        step,
        models({
          typeChanges: [{ ...typeChanges[0]!, column: "id" }],
          live: [outside],
        })
      ).map((x) => x.name)
    ).not.toContain("r")
  })

  it("matches a renamed table and column by their old names", () => {
    // Намір: `app.p` → `app.party`, `code` → `tax_code`; ціль — ще в старих
    const step = engineStep("s3", "accessExclusive", [t("app", "party")])
    expect(
      stepFootprint(
        step,
        models({
          typeChanges: [
            { step: "s3", schema: "app", table: "party", column: "tax_code" },
          ],
          newToOld: new Map([[tableKey("app", "party"), tableKey("app", "p")]]),
          columnsNewToOld: new Map([
            [JSON.stringify(["app", "party", "tax_code"]), "code"],
          ]),
          live: [outside],
        })
      )
    ).toEqual([
      { schema: "app", name: "p", mode: "accessExclusive" },
      { schema: "ext", name: "r", mode: "accessExclusive" },
    ])
  })

  it("adds live links in both directions to the fallback", () => {
    const step = engineStep("s1", "accessExclusive", [t("app", "p")], {
      verb: "create",
      produced: [
        { kind: "constraint", schema: "app", table: "p", name: "p_excl" },
      ],
    })
    const back = {
      schema: "app",
      table: "p",
      columns: ["owner"],
      references: { schema: "auth", table: "users", columns: ["id"] },
    }
    const names = stepFootprint(step, models({ live: [outside, back] })).map(
      (x) => `${x.schema}.${x.name}:${x.mode}`
    )
    expect(names).toEqual(
      expect.arrayContaining([
        "ext.r:accessExclusive",
        "auth.users:accessExclusive",
      ])
    )
  })

  it("names the tables whose live foreign keys the footprint needs, in old names", () => {
    const steps = [
      engineStep("s1", "accessExclusive", [t("app", "party")]),
      engineStep("s2", "accessExclusive", [t("app", "c")], {
        verb: "create",
        produced: [constraint("c_excl")],
      }),
    ]
    const subjects = footprintSubjects(steps, {
      source: withFk,
      desired: withFk,
      typeChanges: [
        { step: "s1", schema: "app", table: "party", column: "code" },
      ],
      newToOld: new Map([[tableKey("app", "party"), tableKey("app", "p")]]),
      columnsNewToOld: new Map(),
    })
    // Таблиця зміни типу — у старому імені; власна таблиця запасного правила
    expect(subjects).toEqual([t("app", "p"), t("app", "c")])
  })
})

describe("provider locks", () => {
  /** Перелік, як його прочитав би план з цілі (R27). */
  const providerLocks: ProviderLockSet[] = [
    {
      setting: "supautils.policy_grants",
      statements: [
        "createPolicy",
        "alterPolicy",
        "dropPolicy",
        "commentPolicy",
      ],
      tables: [t("auth", "users"), t("storage", "objects")],
    },
    {
      setting: "supautils.drop_trigger_grants",
      statements: ["dropTrigger"],
      tables: [t("auth", "users"), t("realtime", "messages")],
    },
  ]

  it.each([
    ["CREATE POLICY p ON app.t USING (true)", "createPolicy"],
    ["ALTER POLICY p ON app.t USING (false)", "alterPolicy"],
    ["DROP POLICY p ON app.t", "dropPolicy"],
    ["COMMENT ON POLICY p ON app.t IS 'x'", "commentPolicy"],
    ["DROP TRIGGER tr ON app.t", "dropTrigger"],
    [
      "CREATE TRIGGER tr BEFORE INSERT ON app.t FOR EACH ROW EXECUTE FUNCTION app.f()",
      undefined,
    ],
    ["ALTER POLICY p ON app.t RENAME TO q", undefined],
    ["DROP TABLE app.t", undefined],
    ["COMMENT ON TABLE app.t IS 'x'", undefined],
  ])("classifies %s from the parse tree", async (sql, expected) => {
    const parse = await loadSqlParser()
    const result = parse(sql)
    if (!result.ok) throw new Error(result.message)
    expect(providerStatement(result.statements[0]!.stmt)).toBe(expected)
  })

  it("maps steps to their provider statements and skips the rest", async () => {
    const steps = [
      engineStep("s1", "accessExclusive", [t("app", "t")], {
        sql: "CREATE POLICY p ON app.t USING (true)",
      }),
      engineStep("s2", "accessExclusive", [t("app", "t")], {
        sql: "ALTER TABLE app.t ADD COLUMN x int",
      }),
    ]
    expect(providerStatements(steps, await loadSqlParser())).toEqual(
      new Map([["s1", ["createPolicy"]]])
    )
  })

  it("takes ACCESS EXCLUSIVE on the tables of the matching source only", () => {
    const m = models({
      providerLocks,
      providerStatements: new Map([
        ["s1", ["createPolicy"]],
        ["s2", ["dropTrigger"]],
      ]),
    })
    const own = t("app", "c")
    expect(
      stepFootprint(engineStep("s1", "accessExclusive", [own]), m)
    ).toEqual([
      { ...own, mode: "accessExclusive" },
      { schema: "auth", name: "users", mode: "accessExclusive" },
      { schema: "storage", name: "objects", mode: "accessExclusive" },
    ])
    expect(
      stepFootprint(engineStep("s2", "accessExclusive", [own]), m)
    ).toEqual([
      { ...own, mode: "accessExclusive" },
      { schema: "auth", name: "users", mode: "accessExclusive" },
      { schema: "realtime", name: "messages", mode: "accessExclusive" },
    ])
    // Крок без провайдерського оператора (створення тригера) — лише своє
    expect(
      stepFootprint(engineStep("s3", "shareRowExclusive", [own]), m)
    ).toEqual([{ ...own, mode: "shareRowExclusive" }])
  })

  it("reads the tables of the plan role from the setting", () => {
    const raw = JSON.stringify({
      postgres: ["auth.users", "storage.objects"],
      other: ["auth.sessions"],
    })
    expect(providerTableNames(raw, "postgres")).toEqual([
      { schema: "auth", name: "users" },
      { schema: "storage", name: "objects" },
    ])
  })

  it.each([
    ["no setting", null, "postgres"],
    ["an empty setting", "", "postgres"],
    ["broken JSON", '{"postgres": ["auth.users"', "postgres"],
    ["a JSON array", '["auth.users"]', "postgres"],
    ["no key for the role", '{"other": ["auth.users"]}', "postgres"],
    [
      "a role entry that is not a list",
      '{"postgres": "auth.users"}',
      "postgres",
    ],
    // Ключ ролі — лише власний, не з ланцюжка прототипів
    ["an inherited key", "{}", "toString"],
    // JSON-примітив як усе значення налаштування
    ["a JSON number", "5", "postgres"],
    ["a JSON boolean", "true", "postgres"],
    ["a JSON null", "null", "postgres"],
    ["a JSON string", '"auth.users"', "postgres"],
  ])("gives no tables for %s", (_, raw, role) => {
    expect(providerTableNames(raw, role)).toEqual([])
  })

  it("parses names into parts and drops what the catalog lookup cannot take", () => {
    const raw = JSON.stringify({
      postgres: [
        "auth.users",
        1,
        // Кваліфіковане базою ім'я — не з переліку провайдера
        "postgres.auth.users",
        "x..y",
        '"',
        "Auth.Users",
        '"Auth"."Users"',
        // Некваліфіковане — шукається в current_schemas(true)
        "users",
        // NUL параметр запиту не передасть
        "auth.us\u0000ers",
        // Одинокий сурогат json_to_recordset відкинув би з 22P02
        "auth.us\ud800ers",
      ],
    })
    expect(providerTableNames(raw, "postgres")).toEqual([
      { schema: "auth", name: "users" },
      { schema: "auth", name: "users" },
      { schema: "Auth", name: "Users" },
      { name: "users" },
    ])
  })
})

describe("lockRightsSql", () => {
  it("checks the right on the table and every descendant before PostgreSQL 17", () => {
    const sql = lockRightsSql(160004)
    expect(sql).toContain("WITH RECURSIVE")
    expect(sql).toContain("pg_catalog.pg_inherits i ON i.inhparent = tree.rel")
    expect(sql).toContain("pg_catalog.bool_and(")
  })

  it("checks the right on the table only from PostgreSQL 17", () => {
    const sql = lockRightsSql(170006)
    expect(sql).not.toContain("pg_inherits")
    expect(sql).not.toContain("bool_and")
    expect(sql).toContain("pg_catalog.has_table_privilege(t.oid, $2)")
  })
})

describe("joinModes and coversMode", () => {
  it("joins SHARE and SHARE UPDATE EXCLUSIVE into SHARE ROW EXCLUSIVE", () => {
    expect(joinModes("share", "shareUpdateExclusive")).toBe("shareRowExclusive")
    expect(joinModes("share", "accessExclusive")).toBe("accessExclusive")
    expect(coversMode("share", "shareUpdateExclusive")).toBe(false)
    expect(coversMode("shareRowExclusive", "share")).toBe(true)
    expect(coversMode("share", "accessExclusive")).toBe(false)
  })
})

describe("planLocks", () => {
  const all = (keys: string[], right = true) =>
    new Map(keys.map((k) => [k, right]))

  it("takes the strongest mode per table and sorts by mode, then name", () => {
    const footprint = planFootprint(
      [
        engineStep("s1", "share", [t("b", "z"), t("a", "y")]),
        engineStep("s2", "shareUpdateExclusive", [t("a", "y")]),
        engineStep("s3", "accessExclusive", [t("a", "x"), t("b", "z")]),
      ],
      models()
    )
    const { locks, implicitLocks } = planLocks({
      footprint,
      rights: all(
        footprintTables(footprint).map((x) => tableKey(x.schema, x.name))
      ),
    })
    expect(locks).toEqual([
      { schema: "a", name: "x", mode: "accessExclusive" },
      { schema: "b", name: "z", mode: "accessExclusive" },
      { schema: "a", name: "y", mode: "shareRowExclusive" },
    ])
    expect(implicitLocks).toEqual([])
  })

  it("sorts by code units, not by locale", () => {
    const footprint = planFootprint(
      [engineStep("s1", "accessExclusive", [t("app", "b"), t("app", "B")])],
      models()
    )
    const { locks } = planLocks({
      footprint,
      rights: all([tableKey("app", "b"), tableKey("app", "B")]),
    })
    expect(locks.map((l) => l.name)).toEqual(["B", "b"])
  })

  it("skips a table absent from the target and keeps one without a right as implicit", () => {
    const footprint = planFootprint(
      [
        engineStep("s1", "accessExclusive", [t("app", "new")]),
        engineStep("s2", "shareRowExclusive", [t("auth", "users")]),
        engineStep("s3", "accessExclusive", [t("auth", "users")]),
      ],
      models()
    )
    expect(
      planLocks({ footprint, rights: all([tableKey("auth", "users")], false) })
    ).toEqual({
      locks: [],
      implicitLocks: [
        { schema: "auth", name: "users", mode: "accessExclusive", step: "s3" },
      ],
    })
  })

  it("locks nothing for a plan without locking steps", () => {
    const footprint = planFootprint(
      [engineStep("s1", "none", [t("app", "t")])],
      models()
    )
    expect(footprintTables(footprint)).toEqual([])
    expect(planLocks({ footprint, rights: new Map() })).toEqual({
      locks: [],
      implicitLocks: [],
    })
  })
})

describe("lockPrivileges", () => {
  it("names MAINTAIN only from PostgreSQL 17", () => {
    expect(lockPrivileges(160004)).toBe("UPDATE, DELETE, TRUNCATE")
    expect(lockPrivileges(170006)).toBe("MAINTAIN, UPDATE, DELETE, TRUNCATE")
  })
})
