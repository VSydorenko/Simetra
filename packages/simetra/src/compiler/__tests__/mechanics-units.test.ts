import { beforeAll, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { PhysicalSnapshot, PhysicalTable } from "simetra/model"
import { executeGrants } from "../sql/execute-grants"
import { platformFunctionSignatures, withoutLocations } from "../sql/units"
import {
  buildMechanicsUnits,
  contentChangeCondition,
  contentColumns,
  MECHANICS_FUNCTION,
  mechanicsTriggerName,
} from "../mechanics-units"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { compileRights, policyDomain } from "./fixtures/rights"
import {
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
  salesDocument,
  uuid,
} from "./helpers"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const ITEM = "catalogs/Item/Item.meta.json"

async function compiled(entries: Record<string, unknown>) {
  const result = await compile(metaFiles(entries))
  expect(result.diagnostics).toEqual([])
  return result.model!
}

const mechanics = <T extends { generator?: string }>(units: readonly T[]) =>
  units.filter((u) => u.generator === "mechanics")

function table(
  name: string,
  standards: readonly string[],
  objectId = uuid(9001)
): PhysicalTable {
  return {
    schema: "public",
    name,
    origin: { objectId },
    rowLevelSecurity: "on",
    columns: [
      { name: "id", type: "uuid", notNull: true, origin: { standard: "ref" } },
      ...standards.map((standard) => ({
        name: standard === "version" ? "version" : "updated_at",
        type: standard === "version" ? "bigint" : "timestamp with time zone",
        notNull: true,
        origin: { standard },
      })),
    ],
    uniques: [],
    checks: [],
    foreignKeys: [],
    indexes: [],
  } as unknown as PhysicalTable
}

const snapshot = (tables: PhysicalTable[]) =>
  ({ tables, enumTypes: [] }) as unknown as PhysicalSnapshot

describe("buildMechanicsUnits", () => {
  it("a Catalog gets the platform function, its revokes and one BEFORE INSERT OR UPDATE trigger", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      [ITEM]: catalog("Item", { id: uuid(9001) }),
    })
    const units = mechanics(model.sqlUnits)
    const fn = units.find((u) => u.class === "function")!
    expect(fn.identity).toBe("function:simetra.touch()")
    expect(fn.ownerObjectId).toBeUndefined()
    expect(fn.sql).toContain("IF TG_OP = 'INSERT' THEN")
    expect(fn.sql).toContain("NEW.version := 1;")
    expect(fn.sql).toContain("NEW.version := OLD.version + 1;")
    expect(fn.sql).toContain("NEW.updated_at := now();")
    expect(fn.sql).not.toContain("created_at")
    expect(fn.sql).toContain("SECURITY INVOKER")
    expect(fn.sql).toContain("SET search_path = ''")
    expect(
      units
        .filter((u) => u.class === "grant")
        .map((u) => u.sql)
        .sort()
    ).toEqual(executeGrants("simetra.touch()", [], "supabase").sort())
    const triggers = units.filter((u) => u.class === "trigger")
    expect(triggers.map((u) => u.identity)).toEqual([
      "trigger:public.item.item_simetra_touch",
    ])
    expect(triggers[0]!.sql).toMatch(
      /^CREATE TRIGGER item_simetra_touch BEFORE INSERT OR UPDATE ON public\.item FOR EACH ROW EXECUTE FUNCTION simetra\.touch\(\);$/
    )
    expect(triggers[0]!.ownerObjectId).toBe(uuid(9001))
    for (const unit of units) {
      expect(unit.generator).toBe("mechanics")
      expect(unit.file).toBeUndefined()
      expect(unit.module).toBe("TestApp")
    }
    expect(MECHANICS_FUNCTION).toEqual({ schema: "simetra", name: "touch" })
  })

  it("a Catalog with a tabular section gets the trigger on the main table only", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      [ITEM]: catalog("Item", {
        tabularSections: [
          {
            id: uuid(9002),
            name: "lines",
            physicalName: "lines",
            attributes: [attribute("flag")],
          },
        ],
      }),
    })
    expect(
      mechanics(model.sqlUnits)
        .filter((u) => u.class === "trigger")
        .map((u) => u.identity)
    ).toEqual(["trigger:public.item.item_simetra_touch"])
  })

  it("a snake_case project finds the mechanics columns by its styled names", async () => {
    const model = await compiled({
      "project.meta.json": project({ naming: { attributeCase: "snake_case" } }),
      [ITEM]: catalog("Item"),
    })
    expect(
      mechanics(model.sqlUnits)
        .filter((u) => u.class === "trigger")
        .map((u) => u.identity)
    ).toEqual(["trigger:public.item.item_simetra_touch"])
  })

  it("a project with only a CustomTable and an Enumeration gets no mechanics unit", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      "custom-tables/Codes/Codes.meta.json": customTable("Codes"),
      "enumerations/Color/Color.meta.json": {
        id: uuid(9003),
        kind: "Enumeration",
        name: "Color",
        physicalName: "color",
        values: [],
      },
    })
    expect(mechanics(model.sqlUnits)).toEqual([])
  })

  it("a table with updated_at but no version is a model defect", () => {
    expect(() =>
      buildMechanicsUnits(
        snapshot([table("item", ["updatedAt"])]),
        "camelCase",
        "supabase",
        "app",
        parse
      )
    ).toThrow(/^internal:/)
  })

  it("the trigger name of a 60-byte table is 63 bytes with the whole label", () => {
    const name = "t".repeat(60)
    const trigger = mechanicsTriggerName(name)
    expect(new TextEncoder().encode(trigger).length).toBe(63)
    expect(trigger.endsWith("_simetra_touch")).toBe(true)
    const units = buildMechanicsUnits(
      snapshot([table(name, ["updatedAt", "version"])]),
      "camelCase",
      "supabase",
      "app",
      parse
    )
    expect(units.filter((u) => u.class === "trigger")[0]!.identity).toBe(
      `trigger:public.${name}.${trigger}`
    )
  })

  it("the mechanics function is a platform function, a verbatim one is not", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      [ITEM]: catalog("Item"),
      "sql/public/f.sql":
        "CREATE FUNCTION public.f(n int4) RETURNS int4 LANGUAGE sql IMMUTABLE AS $$ SELECT n $$;",
    })
    expect(platformFunctionSignatures(model.sqlUnits)).toEqual([
      "simetra.touch()",
    ])
  })

  it("a movement query wrapper stays under plpgsql_check: it is not a platform function", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      ...salesDocument(),
    })
    const wrappers = model.sqlUnits.filter(
      (u) => u.generator === "movementQuery"
    )
    expect(wrappers.length).toBeGreaterThan(0)
    const platform = platformFunctionSignatures(model.sqlUnits)
    expect(platform).toContain("simetra.touch()")
    for (const wrapper of wrappers)
      expect(platform).not.toContain(
        wrapper.identity.slice(wrapper.identity.indexOf(":") + 1)
      )
  })

  it("a copy-only update does not touch the row", async () => {
    // Поширення копій носіїв пише лише копії (Р2a2-19): умова оновлення —
    // зміст (без механіки, копій і генерованих колонок) змінився, або копії
    // не змінилися.
    const model = (await compileRights(policyDomain())).model!
    const trees = (table: string) =>
      mechanics(model.sqlUnits)
        .filter(
          (u) =>
            u.class === "trigger" &&
            u.identity.startsWith(`trigger:public.${table}.`)
        )
        .map((u) => u.tree)
    const tree = (sql: string) => {
      const parsed = parse(sql)
      if (!parsed.ok) throw new Error(sql)
      return withoutLocations(parsed.statements[0]!.stmt)
    }
    const changed = (columns: readonly string[]) =>
      columns.map((c) => `OLD.${c} IS DISTINCT FROM NEW.${c}`).join(" OR ")
    const split = (table: string, content: readonly string[]) => [
      tree(
        `CREATE TRIGGER ${table}_simetra_touch BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION simetra.touch();`
      ),
      tree(
        `CREATE TRIGGER ${table}_simetra_touch_update BEFORE UPDATE ON public.${table} FOR EACH ROW ` +
          `WHEN ((${changed(content)}) OR NOT (${changed(["task_id_assignee_id"])})) ` +
          "EXECUTE FUNCTION simetra.touch();"
      ),
    ]
    expect(trees("task_comment")).toEqual(
      split("task_comment", [
        "id",
        "org_id",
        "code",
        "description",
        "deletion_mark",
        "predefined_name",
        "created_at",
        "task_id",
      ])
    )
    // Генерована колонка періоду номера (`number_period`) — не зміст.
    expect(trees("task_report")).toEqual(
      split("task_report", [
        "id",
        "org_id",
        "number",
        "date",
        "posted",
        "deletion_mark",
        "created_at",
        "task_id",
      ])
    )
    expect(trees("task")).toEqual([
      tree(
        "CREATE TRIGGER task_simetra_touch BEFORE INSERT OR UPDATE ON public.task FOR EACH ROW EXECUTE FUNCTION simetra.touch();"
      ),
    ])
  })

  it("content columns are one list for the condition and the effects", async () => {
    // Р2b1-9, Р2b1-15: умову механіки й порівняння тригера ефектів дає один
    // перелік — без механіки, копій і генерованих колонок.
    const model = (await compileRights(policyDomain())).model!
    const report = model.physical.tables.find((t) => t.name === "task_report")!
    const content = contentColumns(report, "camelCase")
    expect(content.map((c) => c.name)).toEqual([
      "id",
      "org_id",
      "number",
      "date",
      "posted",
      "deletion_mark",
      "created_at",
      "task_id",
    ])
    const changed = (columns: readonly { name: string }[]) =>
      columns
        .map((c) => `(OLD.${c.name} IS DISTINCT FROM NEW.${c.name})`)
        .join(" OR ")
    expect(contentChangeCondition(report, "camelCase")).toBe(
      `(${changed(content)}) OR NOT (${changed([{ name: "task_id_assignee_id" }])})`
    )
  })

  it("compile orders the trigger after its table and the function", async () => {
    const model = await compiled({
      "project.meta.json": project(),
      [ITEM]: catalog("Item"),
    })
    const index = (
      match: (n: (typeof model.creationOrder)[number]) => boolean
    ) => model.creationOrder.findIndex(match)
    const trigger = index(
      (n) =>
        n.type === "unit" &&
        n.identity === "trigger:public.item.item_simetra_touch"
    )
    const fn = index(
      (n) => n.type === "unit" && n.identity === "function:simetra.touch()"
    )
    const tbl = index(
      (n) => n.type === "table" && n.schema === "public" && n.name === "item"
    )
    expect(trigger).toBeGreaterThan(-1)
    expect(fn).toBeGreaterThan(-1)
    expect(tbl).toBeGreaterThan(-1)
    expect(trigger).toBeGreaterThan(fn)
    expect(trigger).toBeGreaterThan(tbl)
  })
})
