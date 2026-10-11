import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import type { CatalogModel, CatalogTable } from "simetra/model"
import {
  checkPermissions,
  classifySteps,
  lintSteps,
  requiredPermissions,
  type EngineAction,
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
      action("CREATE UNIQUE INDEX v ON app.n (x)", {
        verb: "create",
        produces: ["index:app.v"],
      }),
    ],
    UNIQUE,
    ["catalogOnly"],
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

describe("classifySteps", () => {
  it.each(CASES)("%s", (_name, actions, model, classes) => {
    expect(classifySteps(actions, model, parse).map((s) => s.class)).toEqual(
      classes
    )
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
        dataLoss: false,
        rewriteRisk: false,
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
        dataLoss: false,
        rewriteRisk: false,
      },
    ])
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
    expect(requiredPermissions(steps)).toEqual(["s2", "s3"])
  })

  it("needs nothing for a replacement", () => {
    expect(
      requiredPermissions(
        classifySteps([dropConstraint, addCheck], UNIQUE, parse)
      )
    ).toEqual([])
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
      { code: "apply.cascade", severity: "error", params: { step: "s1" } },
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
      { code: "apply.cascade", severity: "error", params: { step: "s2" } },
    ])
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
        addCheck,
        dropTrigger,
      ],
      UNIQUE,
      parse
    )
  const check = (allow: string[]) =>
    checkPermissions(steps(), allow).map((d) => ({
      code: d.code,
      severity: d.severity,
      params: d.params,
    }))

  it("passes when every step that needs permission is allowed", () => {
    expect(check(["s1", "s3"])).toEqual([])
  })

  it("refuses a destructive step without permission", () => {
    expect(check(["s3"])).toEqual([
      {
        code: "apply.permission-required",
        severity: "error",
        params: { steps: "s1" },
      },
    ])
  })

  it("lists every missing permission in one diagnostic", () => {
    expect(check([])).toEqual([
      {
        code: "apply.permission-required",
        severity: "error",
        params: { steps: "s1, s3" },
      },
    ])
  })

  it("refuses an id the plan does not have", () => {
    expect(check(["s1", "s3", "s9"])).toEqual([
      {
        code: "apply.permission-unknown",
        severity: "error",
        params: { steps: "s9" },
      },
    ])
  })

  it("refuses an id of a step that needs no permission", () => {
    expect(check(["s1", "s2", "s3"])).toEqual([
      {
        code: "apply.permission-unknown",
        severity: "error",
        params: { steps: "s2" },
      },
    ])
  })
})
