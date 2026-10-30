import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import type { CatalogModel, CatalogTable } from "simetra/model"
import {
  checkPermissions,
  classifySteps,
  lintSteps,
  requiredPermissions,
  type DriftReport,
  type EngineAction,
  type PlanStep,
  type StepClass,
} from "simetra/schema"

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

function target(unique: boolean): CatalogModel {
  const table: CatalogTable = {
    schema: "app",
    name: "t",
    rowLevelSecurity: "off",
    columns: [
      { name: "c", type: "text", notNull: true },
      { name: "x", type: "integer", notNull: false },
      // Типи у формі `format_type()`, як їх читає адаптер
      ...Object.entries({
        s: "smallint",
        v: "character varying(100)",
        vu: "character varying",
        n: "numeric(12,4)",
        ts: "timestamp with time zone",
        ch: "character(5)",
        d: "app.d",
        arr: "integer[]",
      }).map(([name, type]) => ({ name, type, notNull: false })),
    ],
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [
      {
        name: "u",
        unique,
        method: "btree",
        keys: [{ column: "x" }],
        include: [],
        nullsNotDistinct: false,
      },
    ],
  }
  return { tables: [table], enumTypes: [], units: [] }
}

const UNIQUE = target(true)
const PLAIN = target(false)

const dropConstraint = action("ALTER TABLE app.t DROP CONSTRAINT k", {
  destroys: ["constraint:app.t.k"],
})
const addCheck = action("ALTER TABLE app.t ADD CONSTRAINT k CHECK (x > 0)", {
  produces: ["constraint:app.t.k"],
})
const dropTrigger = action("DROP TRIGGER tr ON app.t", {
  verb: "drop",
  destroys: ["trigger:app.t.tr"],
})

const CASES: [string, EngineAction[], CatalogModel, StepClass[]][] = [
  [
    "dataLoss is destructive",
    [action("ALTER TABLE app.t ALTER c TYPE integer", { dataLoss: true })],
    UNIQUE,
    ["destructive"],
  ],
  [
    "a destroyed column is destructive without dataLoss",
    [
      action("ALTER TABLE app.t DROP COLUMN c", {
        destroys: ["column:app.t.c"],
      }),
    ],
    UNIQUE,
    ["destructive"],
  ],
  [
    "a dropped and recreated sequence stays destructive",
    [
      action("DROP SEQUENCE app.s", {
        verb: "drop",
        destroys: ["sequence:app.s"],
      }),
      action("CREATE SEQUENCE app.s", {
        verb: "create",
        produces: ["sequence:app.s"],
      }),
    ],
    UNIQUE,
    ["destructive", "catalogOnly"],
  ],
  [
    "rewriteRisk is tableRewrite",
    [
      action("ALTER TABLE app.t ALTER x TYPE bigint", {
        rewriteRisk: true,
      }),
    ],
    UNIQUE,
    ["tableRewrite"],
  ],
  [
    "DROP NOT NULL is a relaxation",
    [action("ALTER TABLE app.t ALTER c DROP NOT NULL")],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "dropping an index unique in the target is a relaxation",
    [action("DROP INDEX app.u", { verb: "drop", destroys: ["index:app.u"] })],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "dropping a non-unique index is catalogOnly",
    [action("DROP INDEX app.u", { verb: "drop", destroys: ["index:app.u"] })],
    PLAIN,
    ["catalogOnly"],
  ],
  [
    "dropping an index the target model does not know is a relaxation",
    [
      action("DROP INDEX app.unseen", {
        verb: "drop",
        destroys: ["index:app.unseen"],
      }),
    ],
    PLAIN,
    ["relaxation"],
  ],
  [
    "NO FORCE ROW LEVEL SECURITY is a relaxation",
    [action("ALTER TABLE app.t NO FORCE ROW LEVEL SECURITY")],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "DISABLE ROW LEVEL SECURITY is a relaxation",
    [action("ALTER TABLE app.t DISABLE ROW LEVEL SECURITY")],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "a dropped trigger that is not recreated is a relaxation",
    [dropTrigger],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "a dropped trigger recreated by a later step is catalogOnly",
    [
      dropTrigger,
      action(
        "CREATE TRIGGER tr BEFORE INSERT ON app.t FOR EACH ROW EXECUTE FUNCTION app.f()",
        { verb: "create", produces: ["trigger:app.t.tr"] }
      ),
    ],
    UNIQUE,
    ["catalogOnly", "catalogOnly"],
  ],
  [
    "DISABLE TRIGGER is a relaxation",
    [action("ALTER TABLE app.t DISABLE TRIGGER tr")],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "ADD CONSTRAINT without NOT VALID scans",
    [addCheck],
    UNIQUE,
    ["validationScan"],
  ],
  [
    "ADD CONSTRAINT NOT VALID is catalogOnly",
    [
      action("ALTER TABLE app.t ADD CONSTRAINT k CHECK (x > 0) NOT VALID", {
        produces: ["constraint:app.t.k"],
      }),
    ],
    UNIQUE,
    ["catalogOnly"],
  ],
  [
    "SET NOT NULL scans",
    [action("ALTER TABLE app.t ALTER x SET NOT NULL")],
    UNIQUE,
    ["validationScan"],
  ],
  [
    "VALIDATE CONSTRAINT scans",
    [action("ALTER TABLE app.t VALIDATE CONSTRAINT k")],
    UNIQUE,
    ["validationScan"],
  ],
  [
    "CREATE UNIQUE INDEX on an existing table scans",
    [
      action("CREATE UNIQUE INDEX v ON app.t (x)", {
        verb: "create",
        produces: ["index:app.v"],
      }),
    ],
    UNIQUE,
    ["validationScan"],
  ],
  [
    "CREATE UNIQUE INDEX on a table the plan creates is catalogOnly",
    [
      action("CREATE TABLE app.n (x int)", {
        verb: "create",
        produces: ["table:app.n"],
      }),
      action("CREATE UNIQUE INDEX v ON app.n (x)", {
        verb: "create",
        produces: ["index:app.v"],
      }),
    ],
    UNIQUE,
    ["catalogOnly", "catalogOnly"],
  ],
  [
    "CREATE UNIQUE INDEX on a table the model does not know scans",
    [
      action("CREATE UNIQUE INDEX v ON app.unseen (x)", {
        verb: "create",
        produces: ["index:app.v"],
      }),
    ],
    UNIQUE,
    ["validationScan"],
  ],
  [
    "a dropped constraint recreated later is a replacement",
    [dropConstraint, addCheck],
    UNIQUE,
    ["catalogOnly", "validationScan"],
  ],
  [
    "a dropped constraint that is not recreated is a relaxation",
    [dropConstraint],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "a recreation before the drop is not a replacement",
    [addCheck, dropConstraint],
    UNIQUE,
    ["validationScan", "relaxation"],
  ],
  [
    "a replacement must recreate every destroyed object",
    [
      action("ALTER TABLE app.t DROP CONSTRAINT k", {
        destroys: ["constraint:app.t.k", "constraint:app.t.j"],
      }),
      addCheck,
    ],
    UNIQUE,
    ["relaxation", "validationScan"],
  ],
  [
    "a recreated policy with dataLoss stays destructive",
    [
      action("DROP POLICY p ON app.t", {
        verb: "drop",
        destroys: ["policy:app.t.p"],
        dataLoss: true,
      }),
      action("CREATE POLICY p ON app.t USING (true)", {
        verb: "create",
        produces: ["policy:app.t.p"],
      }),
    ],
    UNIQUE,
    ["destructive", "catalogOnly"],
  ],
  [
    "a dropped then recreated unique index is a replacement",
    [
      action("DROP INDEX app.u", { verb: "drop", destroys: ["index:app.u"] }),
      action("CREATE UNIQUE INDEX u ON app.t (x)", {
        verb: "create",
        produces: ["index:app.u"],
      }),
    ],
    UNIQUE,
    ["catalogOnly", "validationScan"],
  ],
  [
    "ENABLE REPLICA TRIGGER is a relaxation",
    [action("ALTER TABLE app.t ENABLE REPLICA TRIGGER tr")],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "ENABLE ALWAYS TRIGGER is catalogOnly",
    [action("ALTER TABLE app.t ENABLE ALWAYS TRIGGER tr")],
    UNIQUE,
    ["catalogOnly"],
  ],
  [
    "ENABLE TRIGGER is catalogOnly",
    [action("ALTER TABLE app.t ENABLE TRIGGER tr")],
    UNIQUE,
    ["catalogOnly"],
  ],
  [
    "ENABLE REPLICA RULE is a relaxation",
    [action("ALTER TABLE app.t ENABLE REPLICA RULE r")],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "DISABLE RULE is a relaxation",
    [action("ALTER TABLE app.t DISABLE RULE r")],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "a dropped rule that is not recreated is a relaxation",
    [
      action("DROP RULE r ON app.t", {
        verb: "drop",
        destroys: ["rule:app.t.r"],
      }),
    ],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "a dropped rule recreated by a later step is a replacement",
    [
      action("DROP RULE r ON app.t", {
        verb: "drop",
        destroys: ["rule:app.t.r"],
      }),
      action("CREATE RULE r AS ON DELETE TO app.t DO INSTEAD NOTHING", {
        verb: "create",
        produces: ["rule:app.t.r"],
      }),
    ],
    UNIQUE,
    ["catalogOnly", "catalogOnly"],
  ],
  [
    "domain DROP NOT NULL is a relaxation",
    [action("ALTER DOMAIN app.d DROP NOT NULL")],
    UNIQUE,
    ["relaxation"],
  ],
  [
    "domain SET NOT NULL scans",
    [action("ALTER DOMAIN app.d SET NOT NULL")],
    UNIQUE,
    ["validationScan"],
  ],
  [
    "domain VALIDATE CONSTRAINT scans",
    [action("ALTER DOMAIN app.d VALIDATE CONSTRAINT k")],
    UNIQUE,
    ["validationScan"],
  ],
  [
    "a dropped domain constraint is a relaxation",
    [
      action("ALTER DOMAIN app.d DROP CONSTRAINT k", {
        destroys: ["constraint:app.d.k"],
      }),
    ],
    UNIQUE,
    ["relaxation"],
  ],
]

/**
 * Зміна типу колонки. Двигун позначає її `rewriteRisk`; без втрат лишаються
 * лише переходи зі списку, решта — `destructive` (платформна спека §6.6).
 */
const TYPE_CASES: [string, string, StepClass][] = [
  [
    "varchar(100) → varchar(10)",
    "ALTER v TYPE character varying(10)",
    "destructive",
  ],
  [
    "numeric(12,4) → numeric(12,2)",
    "ALTER n TYPE numeric(12,2)",
    "destructive",
  ],
  ["timestamptz → date", "ALTER ts TYPE date", "destructive"],
  ["bpchar → text trims trailing spaces", "ALTER ch TYPE text", "destructive"],
  ["integer → smallint", "ALTER x TYPE smallint", "destructive"],
  [
    "varchar → varchar(10)",
    "ALTER vu TYPE character varying(10)",
    "destructive",
  ],
  [
    "numeric(12,4) → numeric(14,2)",
    "ALTER n TYPE numeric(14,2)",
    "destructive",
  ],
  ["a domain column", "ALTER d TYPE character varying(200)", "destructive"],
  ["an array column", "ALTER arr TYPE bigint[]", "destructive"],
  [
    "a column the source state does not show",
    "ALTER zz TYPE bigint",
    "destructive",
  ],
  ["int2 → int4", "ALTER s TYPE integer", "tableRewrite"],
  ["int2 → int8", "ALTER s TYPE bigint", "tableRewrite"],
  ["int4 → int8", "ALTER x TYPE bigint", "tableRewrite"],
  [
    "varchar(100) → varchar(200)",
    "ALTER v TYPE character varying(200)",
    "tableRewrite",
  ],
  ["varchar(100) → varchar(100)", "ALTER v TYPE varchar(100)", "tableRewrite"],
  ["varchar(100) → varchar", "ALTER v TYPE character varying", "tableRewrite"],
  ["varchar(100) → text", "ALTER v TYPE text", "tableRewrite"],
  ["varchar → text", "ALTER vu TYPE text", "tableRewrite"],
  [
    "numeric(12,4) → numeric(14,4)",
    "ALTER n TYPE numeric(14,4)",
    "tableRewrite",
  ],
  ["numeric(12,4) → numeric", "ALTER n TYPE numeric", "tableRewrite"],
  [
    "a cast of the same column in USING",
    "ALTER s TYPE integer USING s::integer",
    "tableRewrite",
  ],
  [
    "an expression in USING",
    "ALTER s TYPE integer USING (s + 1)",
    "destructive",
  ],
  [
    "a cast of another column in USING",
    "ALTER s TYPE integer USING x::integer",
    "destructive",
  ],
  [
    "a cast to another type in USING",
    "ALTER s TYPE bigint USING s::integer",
    "destructive",
  ],
]

describe("classifySteps", () => {
  it.each(CASES)("%s", (_name, actions, model, classes) => {
    expect(classifySteps(actions, model, parse).map((s) => s.class)).toEqual(
      classes
    )
  })

  it("keeps a replacement a relaxation for the steps named by noReplacement", () => {
    // Наскрізна нумерація: крок двигуна після двох кроків наміру — `s3`
    const steps = classifySteps([dropConstraint, addCheck], UNIQUE, parse, 2, {
      noReplacement: new Set(["s3"]),
    })
    expect(steps.map((s) => [s.id, s.class])).toEqual([
      ["s3", "relaxation"],
      ["s4", "validationScan"],
    ])
    // Інший id у множині виняток не знімає
    expect(
      classifySteps([dropConstraint, addCheck], UNIQUE, parse, 2, {
        noReplacement: new Set(["s1"]),
      })[0]?.class
    ).toBe("catalogOnly")
  })

  it.each(TYPE_CASES)("type change %s", (_name, change, cls) => {
    const step = action(`ALTER TABLE app.t ${change}`, { rewriteRisk: true })
    expect(classifySteps([step], UNIQUE, parse).map((s) => s.class)).toEqual([
      cls,
    ])
  })

  it("classes a typed table attribute type change by the same rule", () => {
    const step = action(
      "ALTER TYPE app.ct ALTER ATTRIBUTE a TYPE bigint CASCADE"
    )
    expect(classifySteps([step], UNIQUE, parse)[0]?.class).toBe("destructive")
  })

  it("puts a lossy type change above a relaxation in the same statement", () => {
    const step = action(
      "ALTER TABLE app.t ALTER c DROP NOT NULL, ALTER v TYPE character varying(10)"
    )
    expect(classifySteps([step], UNIQUE, parse)[0]?.class).toBe("destructive")
  })

  it("numbers steps in engine order and keeps the engine fields", () => {
    const steps = classifySteps(
      [
        action("ALTER TABLE app.t ALTER x SET NOT NULL", {
          consumes: ["column:app.t.x"],
          lockedTables: [{ schema: "app", name: "t" }],
        }),
        action("ALTER TYPE app.e ADD VALUE 'b'", {
          transactionality: "commitBoundaryAfter",
          lockClass: "shareUpdateExclusive",
        }),
      ],
      UNIQUE,
      parse
    )
    expect(steps).toEqual([
      {
        id: "s1",
        sql: "ALTER TABLE app.t ALTER x SET NOT NULL",
        verb: "alter",
        class: "validationScan",
        lockClass: "accessExclusive",
        transactionality: "transactional",
        newSegmentBefore: false,
        lockedTables: [{ schema: "app", name: "t" }],
        produces: [],
        consumes: ["column:app.t.x"],
        destroys: [],
        produced: [],
        destroyed: [],
        consumed: [],
        dataLoss: false,
        rewriteRisk: false,
        origin: "engine",
        guards: [],
      },
      {
        id: "s2",
        sql: "ALTER TYPE app.e ADD VALUE 'b'",
        verb: "alter",
        class: "catalogOnly",
        lockClass: "shareUpdateExclusive",
        transactionality: "commitBoundaryAfter",
        newSegmentBefore: false,
        lockedTables: [],
        produces: [],
        consumes: [],
        destroys: [],
        produced: [],
        destroyed: [],
        consumed: [],
        dataLoss: false,
        rewriteRisk: false,
        origin: "engine",
        guards: [],
      },
    ])
  })

  it("numbers engine steps after the intent steps", () => {
    const destroyed = [
      { kind: "column", schema: "app", table: "t.x", name: "c.d" },
    ]
    const steps = classifySteps(
      [
        action("ALTER TABLE app.t DROP COLUMN c", {
          destroys: ["column:app.t.c"],
          destroyed,
        }),
        action("ALTER TABLE app.t ALTER x SET NOT NULL"),
      ],
      UNIQUE,
      parse,
      3
    )
    expect(steps.map((s) => s.id)).toEqual(["s4", "s5"])
    expect(steps[0]).toMatchObject({ origin: "engine", guards: [], destroyed })
  })

  it("refuses engine SQL that does not parse", () => {
    expect(() => classifySteps([action("ALTER TABL")], UNIQUE, parse)).toThrow(
      /s1/
    )
  })
})

describe("requiredPermissions", () => {
  it("lists destructive and relaxation steps in order", () => {
    const steps = classifySteps(
      [
        addCheck,
        dropTrigger,
        action("ALTER TABLE app.t DROP COLUMN c", {
          destroys: ["column:app.t.c"],
        }),
        action("ALTER TABLE app.t ENABLE ROW LEVEL SECURITY"),
      ],
      UNIQUE,
      parse
    )
    expect(
      requiredPermissions({ steps, drift: null, promotion: null })
    ).toEqual(["s2", "s3"])
  })

  it("needs nothing for a carrier copy data step", () => {
    // Крок копій лише виводить значення з джерела, тож дозволу не
    // просить; дозвіл — лише для `destructive` і `relaxation`
    const [base] = classifySteps([addCheck], UNIQUE, parse)
    const carriers: PlanStep = {
      ...base!,
      origin: "carriers",
      class: "dataStep",
      lockClass: "shareRowExclusive",
    }
    expect(
      requiredPermissions({ steps: [carriers], drift: null, promotion: null })
    ).toEqual([])
  })

  it("needs nothing for a replacement", () => {
    expect(
      requiredPermissions({
        steps: classifySteps([dropConstraint, addCheck], UNIQUE, parse),
        drift: null,
        promotion: null,
      })
    ).toEqual([])
  })

  it("puts drift first: it is reviewed before the steps", () => {
    expect(
      requiredPermissions({
        steps: classifySteps([dropTrigger], UNIQUE, parse),
        drift: { reason: "drift", sections: ["owner"], paths: [] },
        promotion: null,
      })
    ).toEqual(["drift", "s1"])
  })

  it("orders permissions drift, access, delete, remove, then steps", () => {
    // Пункти промоції подано врозсип: порядок задає сам `requiredPermissions`
    const items = [
      "remove:app.b",
      "delete:app.x.x_fkey",
      "access:app.z",
      "remove:app.a",
      "access:app.a",
      "delete:app.a.a_fkey",
    ].map((token) => ({ token, summary: [] }))
    expect(
      requiredPermissions({
        steps: classifySteps([dropTrigger], UNIQUE, parse),
        drift: { reason: "drift", sections: ["owner"], paths: [] },
        promotion: { permissionItems: items },
      })
    ).toEqual([
      "drift",
      "access:app.a",
      "access:app.z",
      "delete:app.a.a_fkey",
      "delete:app.x.x_fkey",
      "remove:app.a",
      "remove:app.b",
      "s1",
    ])
  })
})

describe("lintSteps", () => {
  const lint = (...actions: EngineAction[]) =>
    lintSteps(classifySteps(actions, UNIQUE, parse), parse).map((d) => ({
      code: d.code,
      severity: d.severity,
      params: d.params,
    }))

  it("refuses DROP … CASCADE", () => {
    expect(
      lint(
        action("DROP TABLE app.t CASCADE", {
          verb: "drop",
          destroys: ["table:app.t"],
        })
      )
    ).toEqual([
      {
        code: "apply.cascade",
        severity: "error",
        params: { step: "s1", verb: "DROP TABLE" },
      },
    ])
  })

  it("refuses CASCADE inside ALTER TABLE", () => {
    expect(
      lint(
        addCheck,
        action("ALTER TABLE app.t DROP CONSTRAINT k CASCADE", {
          destroys: ["constraint:app.t.k"],
        })
      )
    ).toEqual([
      {
        code: "apply.cascade",
        severity: "error",
        params: { step: "s2", verb: "ALTER TABLE … DROP CONSTRAINT" },
      },
    ])
  })

  const CASCADE_REFUSED: [string, string][] = [
    ["ALTER TABLE app.t DROP COLUMN c CASCADE", "ALTER TABLE … DROP COLUMN"],
    [
      "ALTER TYPE app.ct DROP ATTRIBUTE a CASCADE",
      "ALTER TYPE … DROP ATTRIBUTE",
    ],
    [
      "ALTER DOMAIN app.d DROP CONSTRAINT k CASCADE",
      "ALTER DOMAIN … DROP CONSTRAINT",
    ],
    ["DROP OWNED BY r CASCADE", "DROP OWNED"],
    ["TRUNCATE app.t CASCADE", "TRUNCATE"],
    ["REVOKE SELECT ON app.t FROM r CASCADE", "REVOKE"],
    ["REVOKE r FROM u CASCADE", "REVOKE ROLE"],
    ["REVOKE ADMIN OPTION FOR r FROM u CASCADE", "REVOKE ROLE"],
  ]

  it.each(CASCADE_REFUSED)("refuses %s", (sql, verb) => {
    expect(lint(action(sql))).toEqual([
      {
        code: "apply.cascade",
        severity: "error",
        params: { step: "s1", verb },
      },
    ])
  })

  // CASCADE тут не знищує, а поширює зміну на типізовані таблиці; зміну типу
  // атрибута класифікує правило зміни типу колонки
  it.each([
    "ALTER TYPE app.ct ADD ATTRIBUTE b integer CASCADE",
    "ALTER TYPE app.ct RENAME ATTRIBUTE a TO b CASCADE",
    "ALTER TYPE app.ct ALTER ATTRIBUTE a TYPE bigint CASCADE",
  ])("lets %s through", (sql) => {
    expect(lint(action(sql))).toEqual([])
  })

  it("reads CASCADE from the tree, not the text", () => {
    expect(
      lint(action("COMMENT ON TABLE app.t IS 'DROP TABLE x CASCADE'"))
    ).toEqual([])
  })

  it("refuses a non-transactional step", () => {
    expect(
      lint(
        action("CREATE INDEX CONCURRENTLY v ON app.t (x)", {
          verb: "create",
          transactionality: "nonTransactional",
        })
      )
    ).toEqual([
      {
        code: "apply.non-transactional",
        severity: "error",
        params: { step: "s1" },
      },
    ])
  })

  it("refuses a step that needs a commit before it", () => {
    expect(
      lint(
        action("ALTER TYPE app.e ADD VALUE 'b'", {
          transactionality: "commitBoundaryAfter",
        }),
        action("ALTER TABLE app.t ALTER x SET DEFAULT 1", {
          newSegmentBefore: true,
        })
      )
    ).toEqual([
      {
        code: "apply.commit-boundary",
        severity: "error",
        params: { step: "s2" },
      },
    ])
  })

  it("keeps a commit boundary without a consumer in the transaction", () => {
    expect(
      lint(
        action("ALTER TYPE app.e ADD VALUE 'b'", {
          transactionality: "commitBoundaryAfter",
        })
      )
    ).toEqual([])
  })

  it("speaks English in the message", () => {
    const [diagnostic] = lintSteps(
      classifySteps(
        [action("DROP TABLE app.t CASCADE", { destroys: ["table:app.t"] })],
        UNIQUE,
        parse
      ),
      parse
    )
    expect(diagnostic?.message).toMatch(/s1/)
    expect(diagnostic?.message).toMatch(/DROP TABLE/)
    expect(diagnostic?.message).toMatch(/CASCADE/)
  })
})

describe("checkPermissions", () => {
  const steps = () =>
    classifySteps(
      [
        action("ALTER TABLE app.t DROP COLUMN c", {
          destroys: ["column:app.t.c"],
        }),
        action("ALTER TABLE app.t ENABLE ROW LEVEL SECURITY"),
        dropTrigger,
      ],
      UNIQUE,
      parse
    )
  const DRIFT: DriftReport = {
    reason: "drift",
    sections: ["owner"],
    paths: [],
  }
  const check = (allow: string[], drift: DriftReport | null = null) =>
    checkPermissions({ steps: steps(), drift, promotion: null }, allow).map(
      (d) => ({
        code: d.code,
        severity: d.severity,
        params: d.params,
      })
    )

  it("passes when every step that needs permission is allowed", () => {
    expect(check(["s1", "s3"])).toEqual([])
  })

  it("refuses a destructive step without permission", () => {
    expect(check(["s3"])).toEqual([
      {
        code: "apply.permission-required",
        severity: "error",
        params: { items: "s1" },
      },
    ])
  })

  it("lists every missing permission in one diagnostic", () => {
    expect(check([])).toEqual([
      {
        code: "apply.permission-required",
        severity: "error",
        params: { items: "s1, s3" },
      },
    ])
  })

  it("refuses an id the plan does not have", () => {
    expect(check(["s1", "s3", "s9"])).toEqual([
      {
        code: "apply.permission-unknown",
        severity: "error",
        params: { items: "s9" },
      },
    ])
  })

  it("refuses an id of a catalogOnly step", () => {
    expect(steps()[1]?.class).toBe("catalogOnly")
    expect(check(["s1", "s2", "s3"])).toEqual([
      {
        code: "apply.permission-unknown",
        severity: "error",
        params: { items: "s2" },
      },
    ])
  })

  it("refuses a plan with drift until drift is allowed", () => {
    expect(check(["s1", "s3"], DRIFT)).toEqual([
      {
        code: "apply.permission-required",
        severity: "error",
        params: { items: "drift" },
      },
    ])
    expect(check(["drift", "s1", "s3"], DRIFT)).toEqual([])
  })

  it("lists drift with the missing steps", () => {
    expect(check([], DRIFT)).toEqual([
      {
        code: "apply.permission-required",
        severity: "error",
        params: { items: "drift, s1, s3" },
      },
    ])
  })

  describe("with promotion items", () => {
    const promotion = {
      permissionItems: [
        { token: "delete:app.items.items_group_fkey", summary: [] },
        { token: "access:app.items", summary: [] },
      ],
    }
    const checkPromotion = (allow: string[]) =>
      checkPermissions({ steps: steps(), drift: null, promotion }, allow).map(
        (d) => ({ code: d.code, params: d.params })
      )

    it("requires every access and delete token", () => {
      expect(checkPromotion(["s1", "s3"])).toEqual([
        {
          code: "apply.permission-required",
          params: {
            items: "access:app.items, delete:app.items.items_group_fkey",
          },
        },
      ])
      expect(checkPromotion(["s1", "s3", "access:app.items"])).toEqual([
        {
          code: "apply.permission-required",
          params: { items: "delete:app.items.items_group_fkey" },
        },
      ])
      expect(
        checkPromotion([
          "s1",
          "s3",
          "access:app.items",
          "delete:app.items.items_group_fkey",
        ])
      ).toEqual([])
    })

    it("refuses an access token the plan does not need", () => {
      const all = [
        "s1",
        "s3",
        "access:app.items",
        "delete:app.items.items_group_fkey",
      ]
      expect(checkPromotion([...all, "access:app.other"])).toEqual([
        {
          code: "apply.permission-unknown",
          params: { items: "access:app.other" },
        },
      ])
      // Без секції промоції жоден токен промоції не потрібен
      expect(check(["s1", "s3", "remove:app.items"])).toEqual([
        {
          code: "apply.permission-unknown",
          severity: "error",
          params: { items: "remove:app.items" },
        },
      ])
    })
  })

  it("refuses allowing drift on a plan without drift", () => {
    expect(check(["drift", "s1", "s3"])).toEqual([
      {
        code: "apply.permission-unknown",
        severity: "error",
        params: { items: "drift" },
      },
    ])
  })
})
