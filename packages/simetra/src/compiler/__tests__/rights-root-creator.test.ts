import { beforeAll, describe, expect, it } from "vitest"
import type { CompileResult, CompiledModel } from "simetra/compiler"
import { executeGrants } from "../sql/execute-grants"
import { hasEmptySearchPath } from "../sql/closed-forms"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import { commandContractOf } from "./fixtures/catalog-command"
import {
  ORG_KIND_ID,
  TENANT_OWNER_ID,
  compileRights,
  policyDomain,
  rootCreationDomain,
  tenantOperator,
  tenantSelfService,
  usersRootCreator,
  withRoles,
} from "./fixtures/rights"
import { bodyShape, loadShapeParsers, nodes, tree } from "./fixtures/sql-shape"

let parse: SqlParser
let plpgsql: PlpgsqlParser
let model: CompiledModel
let ownerWithoutFullAccess: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
  model = await compiled(compileRights(rootCreationDomain()))
  ownerWithoutFullAccess = await compiled(
    compileRights(
      policyDomain(tenantSelfService({ fullAccess: false }), tenantOperator())
    )
  )
})

async function compiled(
  result: CompileResult | Promise<CompileResult>
): Promise<CompiledModel> {
  const { model, diagnostics } = await result
  expect(diagnostics).toEqual([])
  return model!
}

const GRANT_FN = "simetra.org_id_root_creator"
const SIGNATURE = `function:${GRANT_FN}(uuid,uuid,jsonb)`
const unitOf = (m: CompiledModel) => {
  const unit = m.sqlUnits.find((u) => u.identity === SIGNATURE)
  expect(unit).toBeDefined()
  return unit!
}

/** Рядкові константи дерева в порядку обходу. */
const strings = (value: unknown) =>
  nodes(value, "A_Const").flatMap((c) => {
    const text = (c as { sval?: { sval: string } }).sval?.sval
    return text === undefined ? [] : [text]
  })

type Step =
  | readonly [type: string, sql: string, into?: string]
  | readonly ["getdiag"]
  | readonly ["refuse"]

/** Оператори тіла як кроки: вид і дерево виразу, відмова — її рядки. */
function steps(sql: string): unknown[] {
  return bodyShape(sql)
    .filter((s) => s.type !== "block" && s.type !== "return")
    .map((s) =>
      s.type === "raise"
        ? ["refuse", strings(s.expressions)]
        : s.type === "getdiag"
          ? ["getdiag"]
          : [s.type, s.target?.variable ?? null, s.expressions[0]?.tree]
    )
}

function expected(list: readonly Step[]): unknown[] {
  return list.map((step) => {
    if (step[0] === "refuse")
      return ["refuse", ["42501", "command.forbidden", "rights-context"]]
    if (step[0] === "getdiag") return ["getdiag"]
    const [type, sql, into] = step as readonly [string, string, string?]
    const match = /^(\w+) := (.*)$/s.exec(sql)
    return match === null
      ? [type, into ?? null, tree(type === "if" ? `SELECT ${sql}` : sql)]
      : [type, match[1], tree(`SELECT ${match[2]}`)]
  })
}

const K = `'${ORG_KIND_ID}'::uuid`
const ROLE = `'${TENANT_OWNER_ID}'::uuid`
const ME = "(SELECT simetra.current_user_id())"
const context = (action: string, object: string, root: string) =>
  `SELECT set_config('simetra.command', jsonb_build_object('action', '${action}', 'object', '${object}', 'root', ${root})::text, true)`

/** Очікуване тіло функції гранту виду `org`; `holders` — лише з `fullAccess`. */
function grantSteps(m: CompiledModel, fullAccess: boolean): Step[] {
  const member = commandContractOf(m, "org_member", { parse, plpgsql })
  const forced = new Map([
    ["id", "p_member_id"],
    ["org_id", "p_root"],
    ["user_id", ME],
  ])
  const columns = [...new Set([...forced.keys(), ...member.createKeys])]
  // Пропущений ключ дає типове значення колонки; єдине таке серед ключів —
  // найменування (`''`), решта — NULL. Літерал, а не значення з таблиці: тест
  // має упіймати зміну типового.
  const absent = (c: string) => (c === "description" ? "''" : "NULL")
  const values = columns.map(
    (c) =>
      forced.get(c) ??
      `CASE WHEN p_member ? '${c}' THEN v_in.${c} ELSE ${absent(c)} END`
  )
  const header = (fact: string) =>
    `NOT EXISTS (SELECT 1 FROM simetra.rights_tx_header h WHERE h.xid = txid_current() AND h.fact = '${fact}' AND h.actor = ${ME})`
  return [
    // (1) контекст create саме цього кореня
    [
      "execsql",
      "SELECT c.action, c.object, c.root FROM simetra.command_current() c",
      "v_action, v_object, v_root",
    ],
    [
      "if",
      "v_action IS DISTINCT FROM 'create' OR v_object IS DISTINCT FROM 'organization' OR v_root IS DISTINCT FROM p_root",
    ],
    ["refuse"],
    // (2) маркер цієї транзакції, виду, кореня й актора
    [
      "execsql",
      `DELETE FROM simetra.rights_tx_root_marker m WHERE m.xid = txid_current() AND m.scope_kind_id = ${K} AND m.root = p_root AND m.actor = ${ME}`,
    ],
    ["getdiag"],
    ["if", "v_count = 0"],
    ["refuse"],
    // (3) скоуп без учасників і призначень
    [
      "if",
      "EXISTS (SELECT 1 FROM public.org_member r WHERE r.org_id = p_root) OR EXISTS (SELECT 1 FROM public.org_role_assignments r WHERE r.org_id = p_root)",
    ],
    ["refuse"],
    // (4) повторна перевірка рядка членства (прямий виклик оминає ядро),
    // далі членство творця під власним контекстом
    [
      "if",
      "public.org_member_simetra_member_check(p_member - ARRAY['id', 'org_id', 'user_id']::text[], p_root) IS NOT NULL",
    ],
    ["refuse"],
    ["assign", "v_context := current_setting('simetra.command', true)"],
    ["perform", context("create", "org_member", "p_member_id")],
    [
      "assign",
      "v_in := jsonb_populate_record(NULL::public.org_member, p_member)",
    ],
    [
      "execsql",
      `INSERT INTO public.org_member (${columns.join(", ")}) VALUES (${values.join(", ")})`,
    ],
    // (5) знімок обох фактів цього актора
    ["if", `${header("rights")} OR ${header("scopes")}`],
    ["refuse"],
    // (6) кеш прав початку ще порожній
    [
      "if",
      "EXISTS (SELECT 1 FROM simetra.rights_tx_start s WHERE s.xid = txid_current())",
    ],
    ["refuse"],
    // (7) входи знімка
    ["assign", "v_assignment := gen_random_uuid()"],
    [
      "execsql",
      `INSERT INTO simetra.rights_tx_typed (xid, storage, storage_id, scope_kind_id, scope, container, custom_role, archetype, level, level_id, provenance, assignment) VALUES (txid_current(), 'scope', ${K}, ${K}, p_root, NULL, NULL, ${ROLE}, 'scope', ${K}, 'root-creator', v_assignment)`,
    ],
    ...(fullAccess
      ? [
          [
            "execsql",
            `INSERT INTO simetra.rights_tx_holders (xid, level, level_id, scope) VALUES (txid_current(), 'scope', ${K}, p_root)`,
          ] as const,
        ]
      : []),
    [
      "execsql",
      `INSERT INTO simetra.rights_tx_scopes (xid, scope_kind_id, scope, member, catalog) VALUES (txid_current(), ${K}, p_root, p_member_id, true)`,
    ],
    // (8) призначення під administerRights «Призначень»
    [
      "perform",
      context("administerRights", "org_role_assignments", "v_assignment"),
    ],
    [
      "execsql",
      `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES (v_assignment, p_root, p_member_id, ${ROLE})`,
    ],
    // (9) контекст кореня
    ["perform", "SELECT set_config('simetra.command', v_context, true)"],
  ]
}

describe("root creator grant function", () => {
  it("runs steps (1)…(9) in order with fullAccess holders", () => {
    expect(steps(unitOf(model).sql)).toEqual(expected(grantSteps(model, true)))
  })

  it("writes a holders input only for a fullAccess archetype", () => {
    expect(steps(unitOf(ownerWithoutFullAccess).sql)).toEqual(
      expected(grantSteps(ownerWithoutFullAccess, false))
    )
  })

  it("exists only for a scope kind with a root creator", () => {
    expect(
      model.sqlUnits
        .filter(
          (u) => u.class === "function" && u.identity.includes("_root_creator(")
        )
        .map((u) => u.identity)
    ).toEqual([SIGNATURE])
  })

  it("is VOLATILE SECURITY DEFINER with empty search_path and row_security off, returns void", () => {
    const unit = unitOf(model)
    const create = (
      unit.tree as {
        CreateFunctionStmt: {
          returnType: unknown
          options: { DefElem: { defname: string; arg?: unknown } }[]
        }
      }
    ).CreateFunctionStmt
    const option = (name: string) =>
      create.options.find((o) => o.DefElem.defname === name)?.DefElem.arg
    expect(option("security")).toEqual({ Boolean: { boolval: true } })
    expect(option("volatility")).toEqual({ String: { sval: "volatile" } })
    expect(hasEmptySearchPath(unit.tree as never)).toBe(true)
    expect(
      nodes(create.options, "VariableSetStmt").map((v) => [
        (v as { name: string }).name,
        strings(v),
      ])
    ).toEqual([
      ["search_path", [""]],
      ["row_security", ["off"]],
    ])
    expect(JSON.stringify(create.returnType)).toContain('"void"')
  })

  it("has no dynamic SQL", () => {
    expect(
      bodyShape(unitOf(model).sql).filter((s) => s.type === "dynexecute")
    ).toEqual([])
  })

  it("has no EXECUTE except command", () => {
    expect(
      model.sqlUnits
        .filter(
          (u) => u.class === "grant" && u.identity.includes(`${GRANT_FN}(`)
        )
        .map((u) => JSON.stringify(u.tree))
        .sort()
    ).toEqual(
      executeGrants(`${GRANT_FN}(uuid, uuid, jsonb)`, ["command"], "supabase")
        .map((sql) => JSON.stringify(tree(sql)))
        .sort()
    )
  })

  it("requires the tables and functions its body names", () => {
    expect(unitOf(model).requires).toEqual([
      {
        type: "unit",
        identity: "function:public.org_member_simetra_member_check(jsonb,uuid)",
      },
      { type: "unit", identity: "function:simetra.command_current()" },
      { type: "unit", identity: "function:simetra.current_user_id()" },
      ...[
        ["public", "org_member"],
        ["public", "org_role_assignments"],
        ["simetra", "rights_tx_header"],
        ["simetra", "rights_tx_holders"],
        ["simetra", "rights_tx_root_marker"],
        ["simetra", "rights_tx_scopes"],
        ["simetra", "rights_tx_start"],
        ["simetra", "rights_tx_typed"],
      ].map(([schema, name]) => ({ type: "table", schema, name })),
    ])
  })
})

describe("root creator whose root no command creates", () => {
  /** Одиниці, що їх дає факт творця: функція гранту, ядро кореня, маркер. */
  const creatorUnits = (m: CompiledModel) =>
    m.sqlUnits
      .filter((u) => u.class !== "grant")
      .filter((u) =>
        /_root_creator\(|_create_root\(|INSERT INTO simetra\.rights_tx_root_marker\b/.test(
          u.sql
        )
      )
      .map((u) => u.identity)

  it("the creator units filter sees all three on a creatable root", () => {
    expect(creatorUnits(model)).toEqual([
      "function:public.branch_create_root(jsonb,jsonb,uuid)",
      "function:public.organization_create_root(jsonb,jsonb,uuid)",
      "function:public.organization_simetra_effects()",
      SIGNATURE,
    ])
  })

  // Корінь «Користувачі» створює провізія: творця не призначить жодне
  // створення тенанта — попередження, і жодного генератора факту творця
  it("compiles with the unreachable warning and no grant function, create core or marker", async () => {
    const { model, diagnostics } = await compileRights(
      withRoles(usersRootCreator())
    )
    expect(diagnostics.map((d) => [d.code, d.severity, d.file])).toEqual([
      [
        "rights.root-creator-unreachable",
        "warning",
        "roles/TenantOwner/TenantOwner.meta.json",
      ],
    ])
    expect(model!.scopeKinds.map((k) => k.rootCreator)).toEqual([undefined])
    expect(creatorUnits(model!)).toEqual([])
  })
})
