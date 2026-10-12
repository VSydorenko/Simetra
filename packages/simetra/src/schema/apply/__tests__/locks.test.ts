import { describe, expect, it } from "vitest"
import type { CatalogModel, CatalogTable } from "simetra/model"
import {
  coversMode,
  footprintTables,
  intentStep,
  joinModes,
  lockPrivileges,
  planFootprint,
  planLocks,
  stepFootprint,
  tableKey,
  type FootprintModels,
  type PlanStep,
} from "simetra/schema"

/**
 * Слід кроків і блокування плану (спека промоції §8, R26 плану П3-2a):
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
