import { describe, expect, it } from "vitest"
import { mechanicsTriggerName } from "simetra/compiler"
import type { CatalogModel, PhysicalTable } from "simetra/model"
import {
  liveMechanicsTables,
  planRowVersionSteps,
  rowVersionFirstTables,
  rowVersionSteps,
  type RowVersionInput,
} from "../row-version"
import type { PlanStep } from "../steps"

const t = { schema: "app", name: "items" }
const input = (o: Partial<RowVersionInput>): RowVersionInput => ({
  sequenceFresh: false,
  epochExists: true,
  mechanicsTables: [],
  entering: [],
  rewritten: [],
  ...o,
})

describe("rowVersionSteps", () => {
  it.each([
    ["nothing to do", input({}), []],
    [
      "fresh sequence over a mechanics table",
      input({ sequenceFresh: true, mechanicsTables: [t] }),
      ["validationScan", "catalogOnly"],
    ],
    [
      "entering table without a new epoch",
      input({ entering: [t] }),
      ["validationScan"],
    ],
    ["missing epoch row only", input({ epochExists: false }), ["catalogOnly"]],
    [
      "fresh sequence without tables has no seed step",
      input({ sequenceFresh: true }),
      ["catalogOnly"],
    ],
  ])("%s", (_, i, classes) => {
    const steps = rowVersionSteps(i, 3)
    expect(steps.map((s) => s.class)).toEqual(classes)
    expect(steps.every((s) => s.origin === "versions")).toBe(true)
    expect(steps.map((s) => s.id)).toEqual(classes.map((_, k) => `s${4 + k}`))
  })

  it("seeds a fresh sequence under locks and an entering table after a lock-free check", () => {
    const [fresh] = rowVersionSteps(
      input({ sequenceFresh: true, mechanicsTables: [t] }),
      0
    )
    expect(fresh!.sql).toContain("LOCK TABLE app.items IN SHARE MODE")
    expect(fresh!.sql).toContain("ALTER SEQUENCE simetra.row_version NO CYCLE")
    expect(fresh!.sql.indexOf("ALTER SEQUENCE")).toBeLessThan(
      fresh!.sql.indexOf("setval")
    )
    // `fresh` — без перевірки до замків: замки першими
    expect(fresh!.sql.indexOf("LOCK TABLE")).toBeLessThan(
      fresh!.sql.indexOf("max(")
    )
    const [entering] = rowVersionSteps(input({ entering: [t] }), 0)
    const sql = entering!.sql
    // перевірка без замка → замки → повторне сканування → setval
    const check = sql.indexOf("IF v_max >= v_next")
    const lock = sql.indexOf("LOCK TABLE")
    const rescan = sql.indexOf("max(", lock)
    const set = sql.indexOf("setval")
    expect(check).toBeGreaterThan(0)
    expect(check).toBeLessThan(lock)
    expect(lock).toBeLessThan(rescan)
    expect(rescan).toBeLessThan(set)
    expect(entering!.lockedTables).toEqual([t])
    expect(entering!.lockClass).toBe("share")
  })

  it("the next value respects is_called", () => {
    const [seed] = rowVersionSteps(input({ entering: [t] }), 0)
    expect(seed!.sql).toContain(
      "CASE WHEN is_called THEN last_value + 1 ELSE last_value END"
    )
  })

  it("the epoch step upserts one row with a new UUID", () => {
    const [epoch] = rowVersionSteps(input({ epochExists: false }), 0)
    expect(epoch!.sql).toBe(
      "INSERT INTO simetra.version_epoch DEFAULT VALUES ON CONFLICT (singleton) DO UPDATE SET epoch = gen_random_uuid()"
    )
    expect(epoch!.lockedTables).toEqual([])
  })
})

const mechanicsColumns = [
  { name: "id", type: "uuid", notNull: true, origin: { standard: "ref" } },
  {
    name: "updated_at",
    type: "timestamp with time zone",
    notNull: true,
    origin: { standard: "updatedAt" },
  },
  {
    name: "version",
    type: "bigint",
    notNull: true,
    origin: { standard: "version" },
  },
]

const desiredTable = (name: string): PhysicalTable =>
  ({
    schema: "app",
    name,
    origin: { objectId: "x" },
    columns: mechanicsColumns,
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  }) as unknown as PhysicalTable

const model = (...names: string[]) =>
  ({
    project: { naming: { attributeCase: "camelCase" } },
    physical: { tables: names.map(desiredTable), enumTypes: [] },
  }) as never

const touch = (table: string) => ({
  class: "trigger" as const,
  identity: `trigger:app.${table}.${mechanicsTriggerName(table)}`,
  schema: "app",
  name: mechanicsTriggerName(table),
  sql: `CREATE TRIGGER ${mechanicsTriggerName(table)} BEFORE INSERT OR UPDATE ON app.${table} FOR EACH ROW EXECUTE FUNCTION simetra.touch()`,
})

const SEQUENCE = {
  class: "sequence" as const,
  identity: "sequence:simetra.row_version",
  schema: "simetra",
  name: "row_version",
  sql: "CREATE SEQUENCE simetra.row_version",
}

/** Живі таблиці з/без тригера механіки і наявність послідовності. */
const live = (o: {
  tables: string[]
  touched: string[]
  sequence: boolean
}): CatalogModel =>
  ({
    tables: o.tables.map((name) => ({ schema: "app", name })),
    enumTypes: [],
    units: [...(o.sequence ? [SEQUENCE] : []), ...o.touched.map(touch)],
  }) as unknown as CatalogModel

const engine = (over: Partial<PlanStep> = {}) => ({
  produces: [] as string[],
  destroys: [] as string[],
  ...over,
})

const plan = (p: Partial<Parameters<typeof planRowVersionSteps>[0]>) =>
  planRowVersionSteps({
    live: live({ tables: ["a"], touched: ["a"], sequence: true }),
    epochExists: true,
    model: model("a"),
    engineSteps: [],
    offset: 0,
    ...p,
  })

describe("liveMechanicsTables", () => {
  it("is decided by the live trigger, not by column names", () => {
    expect(
      liveMechanicsTables(
        live({ tables: ["a", "b"], touched: ["a"], sequence: true })
      )
    ).toEqual([{ schema: "app", name: "a" }])
  })

  it("ignores a trigger of the same name that runs another function", () => {
    const other = {
      ...touch("a"),
      sql: touch("a").sql.replace("simetra.touch()", "app.other()"),
    }
    const m = live({ tables: ["a"], touched: [], sequence: true })
    m.units.push(other)
    expect(liveMechanicsTables(m)).toEqual([])
  })
})

describe("planRowVersionSteps", () => {
  const classes = (steps: PlanStep[]) => steps.map((s) => s.class)

  it("a base without the sequence: seed over the mechanics table and the epoch", () => {
    const steps = plan({
      live: live({ tables: ["a"], touched: ["a"], sequence: false }),
    })
    expect(classes(steps)).toEqual(["validationScan", "catalogOnly"])
    expect(steps[0]!.lockedTables).toEqual([{ schema: "app", name: "a" }])
  })

  it("repeat without changes gives no steps", () => {
    expect(plan({})).toEqual([])
  })

  it("engine steps that recreate the sequence seed everything and write the epoch", () => {
    const steps = plan({
      live: live({ tables: ["a", "b"], touched: ["a", "b"], sequence: true }),
      model: model("a", "b"),
      engineSteps: [
        engine({ destroys: ["sequence:simetra.row_version"] }),
        engine({ produces: ["sequence:simetra.row_version"] }),
      ],
    })
    expect(classes(steps)).toEqual(["validationScan", "catalogOnly"])
    expect(steps[0]!.lockedTables.map((x) => x.name)).toEqual(["a", "b"])
    expect(steps[0]!.sql).toContain("ALTER SEQUENCE")
  })

  it("a table that the plan destroys is not read by the seed", () => {
    const steps = plan({
      live: live({
        tables: ["a", "gone"],
        touched: ["a", "gone"],
        sequence: false,
      }),
      model: model("a"),
    })
    expect(steps[0]!.lockedTables.map((x) => x.name)).toEqual(["a"])
  })

  it("a missing epoch row gives only the epoch step", () => {
    const steps = plan({ epochExists: false })
    expect(classes(steps)).toEqual(["catalogOnly"])
  })

  it("an adopted table with its own version and updated_at but no mechanics trigger enters", () => {
    const steps = plan({
      live: live({ tables: ["a", "adopted"], touched: ["a"], sequence: true }),
      model: model("a", "adopted"),
    })
    expect(classes(steps)).toEqual(["validationScan"])
    expect(steps[0]!.lockedTables).toEqual([{ schema: "app", name: "adopted" }])
    expect(steps[0]!.sql).not.toContain("app.a\n")
  })

  it("promotion: the table entering the mechanics is seeded in its new name, without an epoch", () => {
    const steps = plan({
      live: live({ tables: ["old"], touched: [], sequence: true }),
      model: model("fresh"),
      liveName: () => ({ schema: "app", name: "old" }),
    })
    expect(classes(steps)).toEqual(["validationScan"])
    expect(steps[0]!.lockedTables).toEqual([{ schema: "app", name: "fresh" }])
  })

  it("a table created by the plan is not seeded", () => {
    expect(
      plan({
        live: live({ tables: [], touched: [], sequence: true }),
        model: model("new"),
      })
    ).toEqual([])
  })

  it("ids continue after the earlier steps", () => {
    const steps = plan({ epochExists: false, offset: 7 })
    expect(steps.map((s) => s.id)).toEqual(["s8"])
  })
})

describe("rowVersionFirstTables", () => {
  it.each([
    ["no sequence, mechanics table", false, ["a"], ["app.a"]],
    ["sequence present", true, ["a"], []],
    ["no sequence, table without mechanics", false, ["b"], []],
  ])("%s", (_, sequence, written, refused) => {
    const m = live({ tables: ["a", "b"], touched: ["a"], sequence })
    expect(
      rowVersionFirstTables(
        m,
        written.map((name) => ({ schema: "app", name }))
      )
    ).toEqual(refused)
  })
})
