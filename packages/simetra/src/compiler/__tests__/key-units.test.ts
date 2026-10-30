import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { KEY_FUNCTION, keyTriggerNames } from "../key-units"
import { executeGrants } from "../sql/execute-grants"
import type { SqlUnit } from "../sql/units"
import {
  ATTACHMENTS_TABLE,
  CHECKLIST_TABLE,
  COMMENT_TABLE,
  HOURS_TABLES,
  compileRights,
  policyDomain,
  writeRoles,
} from "./fixtures/rights"
import { kitchenSink } from "./fixtures/kitchen-sink"
import { loadShapeParsers, tree } from "./fixtures/sql-shape"
import { catalog, expectClean, metaFiles, project } from "./helpers"

const keyUnits = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "key")

/** Тригери ключа за таблицею `schema.table`. */
function keyTriggers(model: CompiledModel, schema: string, table: string) {
  return keyUnits(model).filter(
    (u) =>
      u.class === "trigger" &&
      u.identity.startsWith(`trigger:${schema}.${table}.`)
  )
}

/** Оракул — оператори за Рб1-4, а не вихід генератора. */
const expected = (schema: string, table: string, key = "id") => {
  const names = keyTriggerNames(table)
  return [
    `CREATE TRIGGER ${names.before} BEFORE UPDATE ON ${schema}.${table} FOR EACH ROW WHEN (NEW.${key} IS DISTINCT FROM OLD.${key}) EXECUTE FUNCTION simetra.key_immutable('${key}')`,
    `CREATE TRIGGER ${names.after} AFTER UPDATE ON ${schema}.${table} FOR EACH ROW WHEN (NEW.${key} IS DISTINCT FROM OLD.${key}) EXECUTE FUNCTION simetra.key_immutable('${key}')`,
  ].map(tree)
}

let domain: CompiledModel
let sink: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  const rights = await compileRights(policyDomain(writeRoles()))
  expectClean(rights)
  domain = rights.model!
  const result = await compile(kitchenSink())
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  sink = result.model!
})

describe("buildKeyUnits", () => {
  it.each([
    ["catalog main table", COMMENT_TABLE],
    ["catalog tabular section", ATTACHMENTS_TABLE],
    ["document main table", "task"],
    ["document tabular section", CHECKLIST_TABLE],
    ["membership", "org_member"],
    ["users", "users"],
    ["rights system catalog", "org_role_assignments"],
  ])("%s: BEFORE and AFTER triggers on the key", (_, table) => {
    const triggers = keyTriggers(domain, "public", table)
    expect(
      triggers.map((u) => tree(u.sql)),
      table
    ).toEqual(expected("public", table))
    for (const unit of triggers) {
      expect(unit.ownerObjectId).toBeDefined()
      expect(unit.file).toBeUndefined()
    }
  })

  it("a register has no key trigger", () => {
    for (const table of Object.values(HOURS_TABLES))
      expect(keyTriggers(domain, "public", table), table).toEqual([])
  })

  it("rights guards no longer carry an id trigger of their own", () => {
    expect(
      domain.sqlUnits.filter(
        (u) => u.generator !== "key" && u.name.includes("_rights_id")
      )
    ).toEqual([])
  })

  it("follows the kind: catalogs and documents get it, registers, constants and CustomTable do not", () => {
    const kindOf = new Map(sink.objects.map((o) => [o.id, o.kind]))
    const withKey = new Set(["Catalog", "Document"])
    let checked = { with: 0, without: 0 }
    for (const table of sink.physical.tables) {
      const kind = kindOf.get(table.origin.objectId) ?? ""
      const triggers = keyTriggers(sink, table.schema, table.name)
      // Похідні таблиці виду (`identities` «Користувачів», службові таблиці
      // прав) — не рядки довідника: ключа `ref` у них немає.
      if (withKey.has(kind) && table.origin.part === undefined) {
        expect(
          triggers.map((u) => tree(u.sql)),
          table.name
        ).toEqual(expected(table.schema, table.name))
        checked = { ...checked, with: checked.with + 1 }
      } else {
        expect(triggers, `${kind} ${table.name}`).toEqual([])
        checked = { ...checked, without: checked.without + 1 }
      }
    }
    // Обидві гілки справді перевірено: kitchen-sink має й ті, й ті таблиці.
    expect(checked.with).toBeGreaterThan(0)
    expect(checked.without).toBeGreaterThan(0)
    const kinds = new Set(
      sink.physical.tables.map((t) => kindOf.get(t.origin.objectId))
    )
    for (const kind of ["AccumulationRegister", "Constant", "CustomTable"])
      expect(kinds.has(kind as never), kind).toBe(true)
    // Службові таблиці `simetra` тригера ключа не мають.
    expect(
      keyUnits(sink).filter(
        (u) =>
          u.class === "trigger" && u.identity.startsWith("trigger:simetra.")
      )
    ).toEqual([])
  })

  it("a minimal catalog without rights gets the trigger", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Item/Item.meta.json": catalog("Item"),
      })
    )
    expectClean(result)
    // Проєкт без функцій прав: незмінність ключа від прав не залежить.
    expect(result.model!.sqlUnits.some((u) => u.generator === "rights")).toBe(
      false
    )
    expect(
      keyTriggers(result.model!, "public", "item").map((u) => tree(u.sql))
    ).toEqual(expected("public", "item"))
  })

  it("one INVOKER function with an empty search_path, EXECUTE to nobody", () => {
    expect(KEY_FUNCTION).toEqual({ schema: "simetra", name: "key_immutable" })
    const shared = keyUnits(domain).filter(
      (u) => u.class === "function" || u.class === "grant"
    )
    const fn = shared.filter((u) => u.class === "function")
    expect(fn).toHaveLength(1)
    expect(tree(fn[0]!.sql)).toEqual(
      tree(
        "CREATE OR REPLACE FUNCTION simetra.key_immutable() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$\nBEGIN\n  RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.forbidden', DETAIL = 'effect', TABLE = TG_TABLE_NAME, COLUMN = TG_ARGV[0];\n  RETURN NULL;\nEND\n$$"
      )
    )
    expect(fn[0]!.ownerObjectId).toBeUndefined()
    expect(
      shared
        .filter((u: SqlUnit) => u.class === "grant")
        .map((u) => u.sql)
        .sort()
    ).toEqual(executeGrants("simetra.key_immutable()", [], "supabase").sort())
  })
})
