import { beforeAll, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import type { SqlFunctionDeclaration } from "simetra/model"
import type { RightsContract } from "../contracts"
import { isRepairError } from "../diagnostics"
import { guardOf, type GuardProof } from "../sql/guard-of"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import type { VerbatimUnit } from "../sql/units"
import { uuid } from "./helpers"
import { withRoles } from "./fixtures/rights"

const ACTION_ID = "0a1b2c3d-0000-4000-8000-000000000001"

const contract = {
  objectId: uuid(1),
  kindLabel: "task",
  actions: [
    { action: "read", name: "read" },
    { action: "create", name: "create" },
    { action: ACTION_ID, name: "approve" },
  ],
} as unknown as RightsContract

const declaration = (
  target: { row: string } | { scope: string } | undefined,
  action = "read"
): SqlFunctionDeclaration => ({
  id: uuid(2),
  function: { name: "f" },
  callers: ["user"],
  check: { action, object: { kind: "Document", name: "Task" }, ...target },
})

const ROW = { row: "p_row" }

let parse: SqlParser
let plpgsql: PlpgsqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
})

const unitOf = (sql: string): VerbatimUnit => ({
  class: "function",
  identity: "function:public.f",
  schema: "public",
  name: "f",
  file: "f.sql",
  line: 1,
  sql,
  tree: undefined,
})

const body = (text: string, args = "p_row uuid") =>
  `CREATE FUNCTION public.f(${args}) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$${text}$$;`

const prove = (
  sql: string,
  target: { row: string } | { scope: string } | undefined,
  action = "read"
): GuardProof =>
  guardOf(unitOf(sql), declaration(target, action), contract, plpgsql, parse)

const guard = (args: string, fnName = "rights_require") =>
  `simetra.${fnName}(${args})`
const GOOD = guard("'read', 'task', p_row")
const perform = (call: string) => body(`BEGIN PERFORM ${call}; END`)

// Інваріант І5: кожна причина `check-not-applied` має червоний тест. Мутація —
// прибрати відповідну перевірку `guardOf`: рядок тоді дає `{ ok: true }`.
describe("guardOf", () => {
  it.each<{ name: string; sql: string; reason: string }>([
    {
      name: "language: a LANGUAGE sql body",
      sql: `CREATE FUNCTION public.f(p_row uuid) RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT 1 $$;`,
      reason: "language",
    },
    {
      name: "declareSection: DECLARE",
      sql: body(`DECLARE x int; BEGIN PERFORM ${GOOD}; END`),
      reason: "declareSection",
    },
    {
      name: "declareSection: DECLARE after /* BEGIN */",
      sql: body(`/* BEGIN */ DECLARE x int; BEGIN PERFORM ${GOOD}; END`),
      reason: "declareSection",
    },
    {
      name: "declareSection: DECLARE after -- BEGIN",
      sql: body(`-- BEGIN\nDECLARE x int; BEGIN PERFORM ${GOOD}; END`),
      reason: "declareSection",
    },
    {
      name: "declareSection: DECLARE after a quoted label with >>",
      sql: body(`<<"a>> BEGIN">> DECLARE x int; BEGIN PERFORM ${GOOD}; END`),
      reason: "declareSection",
    },
    {
      name: "firstStatement: the guard in a branch",
      sql: body(`BEGIN IF true THEN PERFORM ${GOOD}; END IF; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: the guard in a loop",
      sql: body(`BEGIN LOOP PERFORM ${GOOD}; EXIT; END LOOP; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: the guard in a nested block",
      sql: body(`BEGIN BEGIN PERFORM ${GOOD}; END; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: another statement first",
      sql: body(`BEGIN PERFORM 1; PERFORM ${GOOD}; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: an empty body",
      sql: body(`BEGIN END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: PERFORM ... WHERE false",
      sql: body(`BEGIN PERFORM ${GOOD} WHERE false; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: PERFORM ... LIMIT 0",
      sql: body(`BEGIN PERFORM ${GOOD} LIMIT 0; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: PERFORM ... OFFSET 1",
      sql: body(`BEGIN PERFORM ${GOOD} OFFSET 1; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: PERFORM ... FROM a table",
      sql: body(`BEGIN PERFORM ${GOOD} FROM pg_class; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: PERFORM ... GROUP BY",
      sql: body(`BEGIN PERFORM ${GOOD} GROUP BY 1; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: PERFORM ... ORDER BY",
      sql: body(`BEGIN PERFORM ${GOOD} ORDER BY 1; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: PERFORM DISTINCT",
      sql: body(`BEGIN PERFORM DISTINCT ${GOOD}; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: a WITH clause",
      sql: body(
        `BEGIN PERFORM ${GOOD} FROM (WITH w AS (SELECT 1) SELECT 1) s; END`
      ),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: a set operation",
      sql: body(`BEGIN PERFORM ${GOOD} UNION SELECT NULL; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: a WINDOW clause",
      sql: body(`BEGIN PERFORM ${GOOD} WINDOW w AS (); END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: a CASE wrapper",
      sql: body(
        `BEGIN PERFORM CASE WHEN p_row IS NULL THEN NULL ELSE ${GOOD} END; END`
      ),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: a COALESCE wrapper",
      sql: body(`BEGIN PERFORM COALESCE(${GOOD}, NULL); END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: a second target",
      sql: body(`BEGIN PERFORM ${GOOD}, 1; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: a named argument",
      sql: body(
        `BEGIN PERFORM simetra.rights_require(p_action => 'read', p_object => 'task', p_row => p_row); END`
      ),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: the same function name in another schema",
      sql: perform(guard("'read', 'task', p_row").replace("simetra.", "app.")),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: DISTINCT inside the call",
      sql: perform(guard("DISTINCT 'read', 'task', p_row")),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: FILTER on the call",
      sql: perform(`${GOOD} FILTER (WHERE false)`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: OVER on the call",
      sql: perform(`${GOOD} OVER ()`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: an alias of the target",
      sql: perform(`${GOOD} AS x`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: an unqualified call",
      sql: body(`BEGIN PERFORM rights_require('read', 'task', p_row); END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: another function",
      sql: body(`BEGIN PERFORM simetra.has_right('read', 'task', p_row); END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: the scope guard for a row target",
      sql: perform(guard("'read', 'task', p_row", "rights_require_scope")),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: an assignment first",
      sql: body(`BEGIN p_row := p_row; PERFORM ${GOOD}; END`),
      reason: "firstStatement",
    },
    {
      name: "firstStatement: SELECT ... INTO instead of PERFORM",
      sql: body(`BEGIN SELECT ${GOOD} INTO p_row; END`),
      reason: "firstStatement",
    },
    {
      // Три частини — база.схема.функція: на базі з іменем `simetra` це інша функція.
      name: "firstStatement: a three-part function name",
      sql: perform(
        GOOD.replace("simetra.rights_require", "simetra.rights_require.x")
      ),
      reason: "firstStatement",
    },
    {
      name: "arguments: another action",
      sql: perform(guard("'create', 'task', p_row")),
      reason: "arguments",
    },
    {
      name: "arguments: a custom action by its name instead of its UUID",
      sql: perform(guard("'approve', 'task', p_row")),
      reason: "arguments",
    },
    {
      name: "arguments: another kind label",
      sql: perform(guard("'read', 'other', p_row")),
      reason: "arguments",
    },
    {
      name: "arguments: another parameter",
      sql: perform(guard("'read', 'task', p_other")),
      reason: "arguments",
    },
    {
      name: "arguments: a qualified parameter",
      sql: perform(guard("'read', 'task', f.p_row")),
      reason: "arguments",
    },
    {
      name: "arguments: a field of the parameter",
      sql: perform(guard("'read', 'task', p_row.x")),
      reason: "arguments",
    },
    {
      name: "arguments: a positional $1",
      sql: perform(guard("'read', 'task', $1")),
      reason: "arguments",
    },
    {
      name: "arguments: NULL with a target",
      sql: perform(guard("'read', 'task', NULL")),
      reason: "arguments",
    },
    {
      name: "arguments: a cast of the parameter",
      sql: perform(guard("'read', 'task', p_row::uuid")),
      reason: "arguments",
    },
    {
      name: "arguments: a cast of the action",
      sql: perform(guard("'read'::text, 'task', p_row")),
      reason: "arguments",
    },
    {
      name: "arguments: an expression for the target",
      sql: perform(guard("'read', 'task', COALESCE(p_row, p_row)")),
      reason: "arguments",
    },
    {
      name: "arguments: an expression for the action",
      sql: perform(guard("'re' || 'ad', 'task', p_row")),
      reason: "arguments",
    },
    {
      name: "arguments: a fourth argument",
      sql: perform(guard("'read', 'task', p_row, NULL")),
      reason: "arguments",
    },
    {
      name: "arguments: two arguments",
      sql: perform(guard("'read', 'task'")),
      reason: "arguments",
    },
    {
      name: "exceptionBlock: EXCEPTION WHEN OTHERS",
      sql: body(`BEGIN PERFORM ${GOOD}; EXCEPTION WHEN OTHERS THEN NULL; END`),
      reason: "exceptionBlock",
    },
  ])("$name", ({ sql, reason }) => {
    expect(prove(sql, ROW)).toEqual({ ok: false, reason })
  })

  it.each<{
    name: string
    sql: string
    target?: { row: string } | { scope: string } | undefined
    action?: string
  }>([
    { name: "a row target", sql: perform(GOOD) },
    {
      name: "a lowercase call in a labelled block",
      sql: body(`<<b>> BEGIN perform ${GOOD}; END`),
    },
    {
      name: "a comment before BEGIN",
      sql: body(`-- note\nBEGIN PERFORM ${GOOD}; PERFORM 1; END`),
    },
    {
      name: "a custom action by its UUID",
      sql: perform(guard(`'${ACTION_ID}', 'task', p_row`)),
      action: "approve",
    },
    {
      name: "a scope target",
      sql: perform(guard("'create', 'task', p_scope", "rights_require_scope")),
      target: { scope: "p_scope" },
      action: "create",
    },
    {
      name: "no target",
      sql: perform(guard("'read', 'task', NULL")),
      target: undefined,
    },
  ])("proves $name", (c) => {
    const { sql, target, action } = c
    const sqlWithArgs = sql.replace(
      "(p_row uuid)",
      "(p_row uuid, p_scope uuid)"
    )
    expect(prove(sqlWithArgs, "target" in c ? target : ROW, action)).toEqual({
      ok: true,
    })
  })
})

// Конвеєр: суддя стоїть після `check-form`, а причина — клас ремонту.
describe("sql.declaration-check-not-applied in the pipeline", () => {
  const SQL = "sql/public/fns.sql"
  const FUNCTIONS = "sql/public/fns.functions.json"
  const files = (
    text: string,
    callers: SqlFunctionDeclaration["callers"] = ["user"]
  ) => {
    const all = withRoles()
    all.set(
      SQL,
      `CREATE FUNCTION public.f(p_row uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$${text}$$;\n`
    )
    all.set(
      FUNCTIONS,
      JSON.stringify({
        functions: [
          {
            id: uuid(7901),
            function: { name: "f" },
            callers,
            check: {
              action: "read",
              object: { kind: "Document", name: "Task" },
              row: "p_row",
            },
          },
        ],
      })
    )
    return all
  }

  it("a body without the guard is refused with firstStatement", async () => {
    const { diagnostics, ok } = await compile(files("BEGIN PERFORM 1; END"))
    const found = diagnostics.filter(
      (d) => d.code === "sql.declaration-check-not-applied"
    )
    expect(ok).toBe(false)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      file: FUNCTIONS,
      pointer: "/functions/0",
      params: { schema: "public", name: "f", reason: "firstStatement" },
    })
    expect(isRepairError(found[0]!)).toBe(true)
  })

  // Мутація: звузити фільтр `checkDeclaredGuards` до `callers.includes("user")`.
  it.each<{ callers: SqlFunctionDeclaration["callers"] }>([
    { callers: ["command"] },
    { callers: ["command", "service"] },
    { callers: ["user", "service"] },
  ])(
    "callers $callers: a body without the guard is refused",
    async ({ callers }) => {
      const { diagnostics } = await compile(
        files("BEGIN PERFORM 1; END", callers)
      )
      const found = diagnostics.filter(
        (d) => d.code === "sql.declaration-check-not-applied"
      )
      expect(found).toHaveLength(1)
      expect(found[0]!.params).toMatchObject({ reason: "firstStatement" })
    }
  )

  it("a service-only caller is not judged", async () => {
    const { diagnostics } = await compile(
      files("BEGIN PERFORM 1; END", ["service"])
    )
    expect(
      diagnostics.filter((d) => d.code === "sql.declaration-check-not-applied")
    ).toEqual([])
  })
})
