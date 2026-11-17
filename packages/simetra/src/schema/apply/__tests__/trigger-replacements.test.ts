import { beforeAll, describe, expect, it } from "vitest"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import type { CatalogModel } from "simetra/model"
import {
  classifySteps,
  foreignChanges,
  requiredPermissions,
  triggerReplacements,
  type EngineAction,
} from "simetra/schema"

/**
 * Пара дій двигуна `DROP TRIGGER` + `CREATE TRIGGER` одного тригера стає
 * одним `CREATE OR REPLACE TRIGGER`: pg-delta міняє визначення тригера лише заміною, а `DROP` на чужій таблиці
 * (таблиця ідентичності) вимагає власника. Синтетичні дії; справжній план —
 * у DB-тестах designer.
 */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const TABLE = { schema: "app", name: "items" }
const triggerRef = (name: string, table = TABLE.name) => ({
  kind: "trigger",
  schema: TABLE.schema,
  table,
  name,
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
    lockedTables: [{ schema: TABLE.schema, name: TABLE.name }],
    lockClass: "shareRowExclusive",
    dataLoss: false,
    rewriteRisk: false,
    ...over,
  }
}

const id = (name: string, table = TABLE.name) =>
  `trigger:${TABLE.schema}.${table}.${name}`

function dropTrigger(
  name: string,
  table = TABLE.name,
  over: Partial<EngineAction> = {}
): EngineAction {
  return action(`DROP TRIGGER "${name}" ON "${TABLE.schema}"."${table}"`, {
    verb: "drop",
    destroys: [id(name, table)],
    destroyed: [triggerRef(name, table)],
    lockClass: "accessExclusive",
    ...over,
  })
}

function createTrigger(
  name: string,
  o: { table?: string; constraint?: boolean; over?: Partial<EngineAction> } = {}
): EngineAction {
  const table = o.table ?? TABLE.name
  const head =
    o.constraint === true
      ? `CREATE CONSTRAINT TRIGGER ${name} AFTER INSERT`
      : `CREATE TRIGGER ${name} AFTER INSERT OR UPDATE`
  return action(
    `${head} ON ${TABLE.schema}.${table} FOR EACH ROW EXECUTE FUNCTION app.f()`,
    {
      verb: "create",
      produces: [id(name, table)],
      produced: [triggerRef(name, table)],
      consumes: ["function:app.f()"],
      ...o.over,
    }
  )
}

/**
 * Живий тригер `name` у вихідній моделі — звичайний чи обмеження — на
 * кожній таблиці `tables`.
 */
function source(
  name: string,
  constraint = false,
  tables: readonly string[] = [TABLE.name]
): CatalogModel {
  return {
    tables: [],
    enumTypes: [],
    units: tables.map((table) => ({
      class: "trigger" as const,
      identity: id(name, table),
      schema: TABLE.schema,
      name,
      sql: `${constraint ? "CREATE CONSTRAINT TRIGGER" : "CREATE TRIGGER"} ${name} AFTER INSERT ON ${TABLE.schema}.${table} FOR EACH ROW EXECUTE FUNCTION app.f()`,
    })),
  }
}

const unrelated = action("CREATE TABLE app.other (id uuid)", {
  verb: "create",
  produces: ["table:app.other"],
  produced: [{ kind: "table", schema: "app", name: "other" }],
  lockedTables: [],
})

describe("triggerReplacements", () => {
  it("merges a drop and a create of the same trigger into one CREATE OR REPLACE", () => {
    const create = createTrigger("t")
    const out = triggerReplacements(
      [dropTrigger("t"), unrelated, create],
      source("t"),
      parse
    )
    expect(out).toEqual([
      unrelated,
      {
        ...create,
        sql: create.sql.replace("CREATE TRIGGER", "CREATE OR REPLACE TRIGGER"),
        destroys: [],
        destroyed: [],
      },
    ])
    const parsed = parse(out[1]!.sql)
    expect(parsed.ok && parsed.statements.length).toBe(1)
  })

  it.each<[string, () => EngineAction[], CatalogModel]>([
    [
      "the new trigger is a constraint trigger",
      () => [dropTrigger("t"), createTrigger("t", { constraint: true })],
      source("t"),
    ],
    [
      "the live trigger is a constraint trigger",
      () => [dropTrigger("t"), createTrigger("t")],
      source("t", true),
    ],
    [
      "another table",
      () => [dropTrigger("t"), createTrigger("t", { table: "others" })],
      // Живий тригер з тим самим ім'ям є на обох таблицях
      source("t", false, [TABLE.name, "others"]),
    ],
    ["another name", () => [dropTrigger("t"), createTrigger("u")], source("t")],
    [
      "another phase (a commit boundary before the create)",
      () => [
        dropTrigger("t"),
        createTrigger("t", { over: { newSegmentBefore: true } }),
      ],
      source("t"),
    ],
    [
      // Межа коміту на самому DROP: злиття зняло б її разом із дією
      "another phase (a commit boundary before the drop)",
      () => [
        dropTrigger("t", TABLE.name, { newSegmentBefore: true }),
        createTrigger("t"),
      ],
      source("t"),
    ],
    [
      "another phase (non-transactional create)",
      () => [
        dropTrigger("t"),
        createTrigger("t", { over: { transactionality: "nonTransactional" } }),
      ],
      source("t"),
    ],
    [
      // Старий тригер міг тримати знятий об'єкт: без DROP TRIGGER зняття впало б
      "a step between destroys an object",
      () => [
        dropTrigger("t"),
        action("DROP FUNCTION app.g()", {
          verb: "drop",
          destroys: ["function:app.g()"],
          destroyed: [{ kind: "function", schema: "app", name: "g" }],
          lockedTables: [],
        }),
        createTrigger("t"),
      ],
      source("t"),
    ],
    [
      // Зміна колонки, яку читає визначення тригера, при живому тригері відмовляє
      "a step between changes the table",
      () => [
        dropTrigger("t"),
        action('ALTER TABLE "app"."items" ALTER COLUMN "note" TYPE text', {
          consumed: [
            { kind: "column", schema: "app", table: "items", name: "note" },
          ],
        }),
        createTrigger("t"),
      ],
      source("t"),
    ],
  ])("leaves the pair when %s", (_name, actions, live) => {
    const input = actions()
    expect(triggerReplacements(input, live, parse)).toEqual(input)
  })
})

/**
 * Злитий крок перевизначає той самий тригер, що й пара: чужий тригер (немає
 * в останньому застосованому стані) лишається послабленням з дозволом,
 * власний — без дозволу (платформна спека §6.6).
 */
describe("a merged trigger keeps the class of the pair", () => {
  // Таблиця тригера — чужа й у цілі, і в marker: кроки на ній — лише тригерів
  const live = source("t")
  const classes = (applied: CatalogModel | undefined) => {
    const pair = [dropTrigger("t"), createTrigger("t")]
    const merged = triggerReplacements(pair, live, parse)
    const classify = (actions: EngineAction[]) => {
      const steps = classifySteps(actions, live, parse, 0, {
        foreign: foreignChanges(actions, applied, live, 0),
      })
      return {
        classes: steps.map((s) => s.class),
        permissions: requiredPermissions({
          steps,
          drift: null,
          promotion: null,
        }),
      }
    }
    return { pair: classify(pair), merged: classify(merged) }
  }

  it.each<[string, CatalogModel | undefined]>([
    [
      "absent from the last applied state",
      { tables: [], enumTypes: [], units: [] },
    ],
    ["on the first apply", undefined],
  ])("a foreign trigger %s needs the permission of the pair", (_n, applied) => {
    const { pair, merged } = classes(applied)
    expect(pair).toEqual({
      classes: ["relaxation", "catalogOnly"],
      permissions: ["s1"],
    })
    expect(merged).toEqual({ classes: ["relaxation"], permissions: ["s1"] })
  })

  it("an own trigger stays without a permission", () => {
    const { pair, merged } = classes(source("t"))
    expect(pair).toEqual({
      classes: ["catalogOnly", "catalogOnly"],
      permissions: [],
    })
    expect(merged).toEqual({ classes: ["catalogOnly"], permissions: [] })
  })

  it("a first creation of a trigger is no redefinition", () => {
    const created = [createTrigger("u")]
    expect(foreignChanges(created, undefined, live, 0)).toEqual(new Set())
  })
})
