import { parsePlPgSQLSync } from "@libpg-query/parser"
import { beforeAll, describe, expect, it } from "vitest"
import type { CompileResult, CompiledModel } from "simetra/compiler"
import { rightsCheck } from "../catalog-command/rights-check"
import { referenceViolations } from "../catalog-command/units"
import { executeGrants } from "../sql/execute-grants"
import { hasEmptySearchPath } from "../sql/closed-forms"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { commandContractOf } from "./fixtures/catalog-command"
import { compileRights, rootCreationDomain } from "./fixtures/rights"
import { bodyShape, loadShapeParsers, nodes, tree } from "./fixtures/sql-shape"

let parse: SqlParser
let plpgsql: PlpgsqlParser
let model: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
  model = await compiled(compileRights(rootCreationDomain()))
})

async function compiled(
  result: CompileResult | Promise<CompileResult>
): Promise<CompiledModel> {
  const { model, diagnostics } = await result
  expect(diagnostics).toEqual([])
  return model!
}

const identity = (table: string) =>
  `function:public.${table}_create_root(jsonb,jsonb,uuid)`
const unitOf = (table: string) => {
  const unit = model.sqlUnits.find((u) => u.identity === identity(table))
  expect(unit, table).toBeDefined()
  return unit!
}
const contract = (table: string) =>
  commandContractOf(model, table, { parse, plpgsql })

type Shape = ReturnType<typeof bodyShape>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Індекс оператора `type`, чий перший вираз — дерево `sql`. */
const at = (shape: Shape, type: string, sql: string, from = 0) =>
  shape.findIndex(
    (s, i) =>
      i >= from && s.type === type && same(s.expressions[0]?.tree, tree(sql))
  )
const ifAt = (shape: Shape, condition: string) =>
  at(shape, "if", `SELECT ${condition}`)
/** Рядкові константи дерева в порядку обходу. */
const strings = (value: unknown) =>
  nodes(value, "A_Const").flatMap((c) => {
    const text = (c as { sval?: { sval: string } }).sval?.sval
    return text === undefined ? [] : [text]
  })
/** Відмова одразу за `IF` з індексом `i`. */
const raised = (shape: Shape, i: number) => strings(shape[i + 1]!.expressions)
const dmlKind = (s: Shape[number]) =>
  ["InsertStmt", "UpdateStmt", "DeleteStmt"].find(
    (kind) => nodes(s.expressions[0]?.tree, kind).length > 0
  )
const invalid = (...detail: string[]) => ["22023", "command.invalid", ...detail]

describe("<root>_create_root", () => {
  it("runs input → creatorMember → context → after-state → right → INSERT → grant → reads", () => {
    const root = contract("organization")
    const shape = bodyShape(unitOf("organization").sql)
    const main = model.physical.tables.find((t) => t.name === "organization")!
    const rights = model.contracts.rights.find(
      (r) => r.objectId === root.objectId
    )!
    const steps = {
      shape: ifAt(shape, "jsonb_typeof(p_item) IS DISTINCT FROM 'object'"),
      tabular: ifAt(shape, "p_item ? 'tabular'"),
      key: ifAt(shape, "v_in.id IS NULL"),
      member: ifAt(
        shape,
        "p_member IS NULL OR p_member_id IS NULL OR jsonb_typeof(p_member) IS DISTINCT FROM 'object'"
      ),
      check: at(
        shape,
        "assign",
        "SELECT public.org_member_simetra_member_check(p_member, v_in.id)"
      ),
      checked: ifAt(shape, "v_column IS NOT NULL"),
      context: ifAt(
        shape,
        "(SELECT simetra.command_action()) IS DISTINCT FROM 'create' OR (SELECT simetra.command_root('organization')) IS DISTINCT FROM v_in.id"
      ),
      after: at(
        shape,
        "assign",
        "SELECT jsonb_populate_record(NULL::public.organization, '{}')"
      ),
      author: at(shape, "assign", "SELECT (SELECT simetra.current_user_id())"),
      reference: ifAt(
        shape,
        "v_new.owner_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.users g WHERE g.id = v_new.owner_id)"
      ),
      right: ifAt(
        shape,
        `(${rightsCheck(rights, "create", main, "v_new", "insert")}) IS NOT TRUE`
      ),
      insert: at(
        shape,
        "execsql",
        `INSERT INTO public.organization (${root.createKeys.join(", ")}) VALUES (${root.createKeys.map((c) => `v_new.${c}`).join(", ")})`
      ),
      grant: at(
        shape,
        "perform",
        "SELECT simetra.org_id_root_creator(v_in.id, p_member_id, p_member)"
      ),
      root: at(
        shape,
        "execsql",
        "SELECT * FROM public.organization r WHERE r.id = v_in.id"
      ),
      memberRow: at(
        shape,
        "execsql",
        "SELECT * FROM public.org_member r WHERE r.id = p_member_id"
      ),
    }
    const order = Object.values(steps)
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(shape[steps.author]!.target).toEqual({
      variable: "v_new.created_by_id",
    })
    expect(raised(shape, steps.shape)).toEqual(invalid("p_item"))
    expect(raised(shape, steps.tabular)).toEqual(invalid("tabular"))
    expect(raised(shape, steps.key)).toEqual(invalid("id"))
    expect(raised(shape, steps.member)).toEqual(invalid("creatorMember"))
    expect(raised(shape, steps.checked)).toEqual(invalid("creatorMember."))
    expect(nodes(shape[steps.checked + 1]!.expressions, "ColumnRef")).toEqual([
      { fields: [{ String: { sval: "v_column" } }] },
    ])
    expect(raised(shape, steps.right)).toEqual([
      "42501",
      "command.forbidden",
      "no-right",
    ])
    expect(shape[steps.root]!.target).toEqual({ variable: "v_row" })
    expect(shape[steps.memberRow]!.target).toEqual({ variable: "v_member_row" })
  })

  it("refuses tabular before the first unknown key", () => {
    const shape = bodyShape(unitOf("organization").sql)
    const unknown = shape.findIndex(
      (s) => s.type === "execsql" && s.target?.variable === "v_key"
    )
    const tabular = ifAt(shape, "p_item ? 'tabular'")
    expect(tabular).toBeGreaterThan(0)
    expect(tabular).toBeLessThan(unknown)
    // Дозволені ключі — рівно ключі вставки кореня, без `tabular`.
    expect(
      strings(nodes(shape[unknown]!.expressions[0]!.tree, "A_ArrayExpr"))
    ).toEqual(contract("organization").createKeys)
  })

  it("on a kind without root creator refuses any creatorMember and grants nothing", () => {
    const shape = bodyShape(unitOf("branch").sql)
    const refusal = ifAt(
      shape,
      "p_member IS NOT NULL OR p_member_id IS NOT NULL"
    )
    expect(raised(shape, refusal)).toEqual(invalid("creatorMember"))
    expect(
      ifAt(
        shape,
        "(SELECT simetra.command_action()) IS DISTINCT FROM 'create' OR (SELECT simetra.command_root('branch')) IS DISTINCT FROM v_in.id"
      )
    ).toBeGreaterThan(refusal)
    expect(
      nodes(
        shape.map((s) => s.expressions.map((e) => e.tree)),
        "FuncCall"
      ).filter((f) =>
        JSON.stringify(f).match(/root_creator|simetra_member_check/)
      )
    ).toEqual([])
    expect(at(shape, "assign", "SELECT NULL")).toBeGreaterThan(0)
  })

  it("INSERT has no RETURNING and is alone in the unique_violation block", () => {
    const sql = unitOf("organization").sql
    const shape = bodyShape(sql)
    const inserts = shape.filter((s) => dmlKind(s) === "InsertStmt")
    expect(inserts).toHaveLength(1)
    expect(inserts[0]!.target).toBeUndefined()
    expect(nodes(inserts[0]!.expressions[0]!.tree, "returningList")).toEqual([])
    const blocks = (
      nodes(parsePlPgSQLSync(sql), "PLpgSQL_stmt_block") as {
        body: unknown[]
        exceptions?: unknown
      }[]
    ).filter((b) =>
      nodes(b.exceptions, "condname").includes("unique_violation")
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0]!.body).toHaveLength(1)
    const insert = shape.indexOf(inserts[0]!)
    expect(shape[insert + 1]).toMatchObject({ type: "getdiag" })
    expect(
      at(
        shape,
        "perform",
        "SELECT 1 FROM public.organization r WHERE r.id = v_in.id",
        insert
      )
    ).toBe(insert + 4)
    expect(strings(shape[insert + 6]!.expressions)).toEqual([
      "P0001",
      "command.conflict",
      "exists",
    ])
    expect(strings(shape[insert + 7]!.expressions)).toEqual([
      "42501",
      "command.forbidden",
      "no-right",
    ])
  })

  it("renders a visible row like save and an invisible one as key and the inserted version", () => {
    const shape = bodyShape(unitOf("organization").sql)
    // `at` шукає по всьому тілу, тож порядок закріплюємо `from`: версія кореня —
    // після вставки і всього блоку `unique_violation` (він закінчується
    // відмовою `no-right` на insert + 7), версія члена — після `PERFORM` гранту,
    // що вставляє члена.
    const insert = shape.findIndex((s) => dmlKind(s) === "InsertStmt")
    const grant = at(
      shape,
      "perform",
      "SELECT simetra.org_id_root_creator(v_in.id, p_member_id, p_member)"
    )
    expect(insert).toBeGreaterThanOrEqual(0)
    expect(grant).toBeGreaterThan(insert)
    for (const [table, row, id, into, version, from] of [
      [
        "organization",
        "v_row",
        "v_in.id",
        "v_result",
        "v_root_version",
        insert + 8,
      ],
      [
        "org_member",
        "v_member_row",
        "p_member_id",
        "v_member",
        "v_member_version",
        grant + 1,
      ],
    ] as const) {
      // Версію вставки читаємо з налаштування тригера механіки одразу після
      // вставки, а не літералом `1`.
      const setting = at(
        shape,
        "assign",
        `SELECT current_setting('simetra.row_version_' || 'public.${table}'::regclass::oid::text, true)`,
        from
      )
      expect(setting).toBeGreaterThanOrEqual(from)
      expect(shape[setting]).toMatchObject({ target: { variable: version } })
      const read = at(
        shape,
        "execsql",
        `SELECT * FROM public.${table} r WHERE r.id = ${id}`
      )
      expect(shape.slice(read + 1, read + 4)).toMatchObject([
        { type: "if", expressions: [{ tree: tree("SELECT FOUND") }] },
        {
          type: "assign",
          target: { variable: into },
          expressions: [
            {
              tree: tree(
                `SELECT to_jsonb(${row}) || jsonb_build_object('version', ${row}.version::text)`
              ),
            },
          ],
        },
        {
          type: "assign",
          target: { variable: into },
          expressions: [
            {
              tree: tree(
                `SELECT jsonb_build_object('id', ${id}, 'version', ${version})`
              ),
            },
          ],
        },
      ])
    }
    const result = [...shape].reverse().find((s) => s.type === "return")!
    expect(result.expressions[0]!.tree).toEqual(
      tree(
        "SELECT jsonb_build_object('root', v_result, 'member', v_member)::text"
      )
    )
  })

  it("checks the root's own references on the after-state like save", () => {
    const root = contract("organization")
    const shape = bodyShape(unitOf("organization").sql)
    const conditions = root.references.flatMap((reference) =>
      referenceViolations(reference, {
        value: (c) => `v_new.${c}`,
        scope: "v_new.id",
        scopeKindId: model.scopeKinds.find((k) => k.name === "org")!.id,
      })
    )
    expect(conditions.length).toBeGreaterThan(0)
    for (const { column, condition } of conditions) {
      expect(raised(shape, ifAt(shape, condition)), column).toEqual(
        invalid(column)
      )
    }
  })

  it("is SECURITY INVOKER with empty search_path, no dynamic SQL, EXECUTE only command", () => {
    for (const table of ["organization", "branch"]) {
      const unit = unitOf(table)
      const create = (
        unit.tree as {
          CreateFunctionStmt: {
            options: { DefElem: { defname: string; arg?: unknown } }[]
          }
        }
      ).CreateFunctionStmt
      expect(
        create.options.find((o) => o.DefElem.defname === "security")?.DefElem
          .arg
      ).toEqual({ Boolean: { boolval: false } })
      expect(hasEmptySearchPath(unit.tree as never)).toBe(true)
      expect(
        bodyShape(unit.sql).filter((s) => s.type === "dynexecute")
      ).toEqual([])
      expect(
        model.sqlUnits
          .filter(
            (u) =>
              u.class === "grant" &&
              u.identity.includes(`public.${table}_create_root(`)
          )
          .map((u) => JSON.stringify(u.tree))
          .sort()
      ).toEqual(
        executeGrants(
          `public.${table}_create_root(jsonb, jsonb, uuid)`,
          ["command"],
          "supabase"
        )
          .map((sql) => JSON.stringify(tree(sql)))
          .sort()
      )
    }
  })

  it("requires the member check and the grant function it calls", () => {
    expect(unitOf("organization").requires).toEqual(
      expect.arrayContaining([
        {
          type: "unit",
          identity:
            "function:public.org_member_simetra_member_check(jsonb,uuid)",
        },
        {
          type: "unit",
          identity: "function:simetra.org_id_root_creator(uuid,uuid,jsonb)",
        },
      ])
    )
  })

  it("exists only on scope roots; save of the root keeps refusing create", () => {
    expect(
      model.sqlUnits
        .filter(
          (u) => u.class === "function" && u.identity.includes("_create_root(")
        )
        .map((u) => u.identity)
        .sort()
    ).toEqual([identity("branch"), identity("organization")])
    const save = bodyShape(
      model.sqlUnits.find(
        (u) => u.identity === "function:public.organization_save(jsonb,int8)"
      )!.sql
    )
    expect(raised(save, ifAt(save, "p_expected_version IS NULL"))).toEqual(
      invalid("create")
    )
  })
})
