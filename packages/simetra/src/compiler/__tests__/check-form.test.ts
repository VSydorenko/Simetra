import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { SqlFunctionDeclaration } from "simetra/model"
import { uuid } from "./helpers"
import { STATUS_FILE, withRoles } from "./fixtures/rights"

const SQL = "sql/public/fns.sql"
const FUNCTIONS = "sql/public/fns.functions.json"

const fn = (args: string, shell = "SECURITY DEFINER") =>
  `CREATE FUNCTION public.f(${args}) RETURNS int LANGUAGE sql STABLE ${shell} SET search_path = '' AS $$ SELECT 1 $$;\n`

type Check = NonNullable<SqlFunctionDeclaration["check"]>

function files(check: Check, sql: string): Map<string, string> {
  const all = withRoles()
  // Перелік не має контракту прав: об'єкт існує, але прав на нього немає.
  all.set(
    STATUS_FILE,
    JSON.stringify({
      id: uuid(7902),
      kind: "Enumeration",
      name: "Status",
      physicalName: "status",
      values: [{ id: uuid(7903), name: "Draft", physicalName: "draft" }],
    })
  )
  all.set(SQL, sql)
  all.set(
    FUNCTIONS,
    JSON.stringify({
      functions: [
        {
          id: uuid(7900),
          function: { name: "f" },
          // Роль без сесії судить `check-missing`, а `user` без доказу — стадія 4:
          // суддя Р1 стоїть після неї, тож `service` доводить його ізольовано.
          callers: ["service"],
          check,
        },
      ],
    })
  )
  return all
}

async function judged(check: Check, sql: string, repair?: true) {
  const result = await compile(files(check, sql), repair ? { repair } : {})
  return {
    result,
    forms: result.diagnostics
      .filter((d) => d.code === "sql.declaration-check-form")
      .map((d) => [d.file, d.pointer, d.params]),
  }
}

const at = (reason: string) => [
  FUNCTIONS,
  "/functions/0",
  { schema: "public", name: "f", function: "public.f", reason },
]

const TASK: Check["object"] = { kind: "Document", name: "Task" }
const ANNOUNCEMENT: Check["object"] = { kind: "Document", name: "Announcement" }
const ORGANIZATION: Check["object"] = { kind: "Catalog", name: "Organization" }

// Інваріант І6: кожна причина `check-form` має червоний тест. Мутація — прибрати
// відповідну гілку `checkFormReason`; тест червоніє, бо діагностики немає.
describe("sql.declaration-check-form", () => {
  it.each<{ name: string; check: Check; sql: string; reason: string }>([
    {
      name: "invoker: a check on a SECURITY INVOKER function",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("p_row uuid", ""),
      reason: "invoker",
    },
    {
      name: "noRights: the object is absent",
      check: { action: "read", object: { kind: "Catalog", name: "Nope" } },
      sql: fn(""),
      reason: "noRights",
    },
    {
      name: "noRights: the object has no rights contract",
      check: {
        action: "read",
        object: { kind: "Enumeration", name: "Status" },
      },
      sql: fn(""),
      reason: "noRights",
    },
    {
      name: "unknownAction: no such action on the object",
      check: { action: "nope", object: TASK, row: "p_row" },
      sql: fn("p_row uuid"),
      reason: "unknownAction",
    },
    {
      name: "twoTargets: row and scope together",
      check: { action: "read", object: TASK, row: "p_row", scope: "p_scope" },
      sql: fn("p_row uuid, p_scope uuid"),
      reason: "twoTargets",
    },
    {
      name: "targetParameter: no such parameter",
      check: { action: "read", object: TASK, row: "p_other" },
      sql: fn("p_row uuid"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: not uuid",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("p_row text"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: a uuid array",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("p_row uuid[]"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: an OUT parameter",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("OUT p_row uuid"),
      reason: "targetParameter",
    },
    {
      name: "targetParameter: an INOUT parameter",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("INOUT p_row uuid"),
      reason: "targetParameter",
    },
    {
      name: "scopeUnscoped: scope on an unscoped object",
      check: { action: "read", object: ANNOUNCEMENT, scope: "p_scope" },
      sql: fn("p_scope uuid"),
      reason: "scopeUnscoped",
    },
    {
      name: "createOnRow: create with row",
      check: { action: "create", object: TASK, row: "p_row" },
      sql: fn("p_row uuid"),
      reason: "createOnRow",
    },
    {
      name: "createOnRoot: create of a scope kind root with scope",
      check: { action: "create", object: ORGANIZATION, scope: "p_scope" },
      sql: fn("p_scope uuid"),
      reason: "createOnRoot",
    },
    {
      name: "createOnRoot: create of a scope kind root without a target",
      check: { action: "create", object: ORGANIZATION },
      sql: fn(""),
      reason: "createOnRoot",
    },
    {
      name: "targetRequired: a scoped object without a target",
      check: { action: "read", object: TASK },
      sql: fn(""),
      reason: "targetRequired",
    },
    {
      name: "targetRequired: create of a scoped object without a target",
      check: { action: "create", object: TASK },
      sql: fn(""),
      reason: "targetRequired",
    },
    {
      name: "targetForbidden: a row on an object without carriers",
      check: { action: "read", object: ANNOUNCEMENT, row: "p_row" },
      sql: fn("p_row uuid"),
      reason: "targetForbidden",
    },
  ])("$name", async ({ check, sql, reason }) => {
    const { result, forms } = await judged(check, sql)
    expect(forms).toEqual([at(reason)])
    expect(result.ok).toBe(false)
    expect(result.model).toBeUndefined()
  })

  it.each<{ name: string; check: Check; sql: string }>([
    {
      name: "read of a scoped row",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("p_row uuid"),
    },
    {
      name: "an unnamed IN mode and a pg_catalog.uuid type",
      check: { action: "read", object: TASK, row: "p_row" },
      sql: fn("IN p_row pg_catalog.uuid"),
    },
    {
      name: "create in a scope of a scoped object",
      check: { action: "create", object: TASK, scope: "p_scope" },
      sql: fn("p_scope uuid"),
    },
    {
      name: "a read of a scope",
      check: { action: "read", object: TASK, scope: "p_scope" },
      sql: fn("p_scope uuid"),
    },
    {
      name: "an object without carriers, no target",
      check: { action: "read", object: ANNOUNCEMENT },
      sql: fn(""),
    },
    {
      name: "create without a target on an object without carriers",
      check: { action: "create", object: ANNOUNCEMENT },
      sql: fn(""),
    },
  ])("accepts $name", async ({ check, sql }) => {
    const { result, forms } = await judged(check, sql)
    expect(forms).toEqual([])
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  })

  // Р2: `check-form` не клас ремонту — режим `repair` модель не повертає.
  it("is not in the repair class: repair mode returns no model", async () => {
    const { result, forms } = await judged(
      { action: "nope", object: TASK, row: "p_row" },
      fn("p_row uuid"),
      true
    )
    expect(forms).toEqual([at("unknownAction")])
    expect(result.model).toBeUndefined()
  })

  it("a custom action resolves by its name", async () => {
    const all = files({ action: "approve", object: ANNOUNCEMENT }, fn(""))
    const path = "documents/Announcement/Announcement.meta.json"
    const object = JSON.parse(all.get(path)!)
    all.set(
      path,
      JSON.stringify({
        ...object,
        customActions: [{ id: uuid(7901), name: "approve" }],
      })
    )
    const result = await compile(all)
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  })
})
