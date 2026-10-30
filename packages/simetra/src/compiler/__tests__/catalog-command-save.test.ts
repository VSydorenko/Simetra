import { parsePlPgSQLSync } from "@libpg-query/parser"
import { beforeAll, describe, expect, it } from "vitest"
import type { CompileResult, CompiledModel } from "simetra/compiler"
import {
  catalogCommandContracts,
  type CatalogCommandContract,
} from "../catalog-command/contracts"
import { rightsCheck } from "../catalog-command/rights-check"
import { HIERARCHY_LOCK_SPACE } from "../hierarchy-units"
import { executeGrants } from "../sql/execute-grants"
import { hasEmptySearchPath } from "../sql/closed-forms"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { loadPlpgsqlParser, type PlpgsqlParser } from "../sql/plpgsql"
import {
  TICKET_CHECKLIST_TABLE,
  catalog,
  commandCoreLayer,
  compileRights,
  compiledPolicyDomain,
  grant,
  objects,
  policyDomain,
  role,
  ticketParentHandler,
  writeRoles,
  type Layer,
} from "./fixtures/rights"
import { snakeCaseTwin } from "./fixtures/snake-case"
import {
  bodyShape,
  loadShapeParsers,
  lockStrengths,
  nodes,
  tree,
} from "./fixtures/sql-shape"
import { uuid } from "./helpers"

let parse: SqlParser
let plpgsql: PlpgsqlParser
let domain: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  parse = await loadSqlParser()
  plpgsql = await loadPlpgsqlParser()
  domain = await compiled(
    compileRights(policyDomain(writeRoles(), commandCoreLayer()))
  )
})

async function compiled(
  result: CompileResult | Promise<CompileResult>
): Promise<CompiledModel> {
  const { model, diagnostics } = await result
  expect(diagnostics).toEqual([])
  return model!
}

function contractOf(
  model: CompiledModel,
  table: string
): CatalogCommandContract {
  const found = catalogCommandContracts({
    access: model.contracts.access,
    rights: model.contracts.rights,
    physical: model.physical,
    objects: model.objects,
    attributeCase: model.project.naming.attributeCase,
    usersObjectId: model.contracts.users?.objectId,
    scopeRootIds: new Set(
      model.scopeKinds.flatMap((k) =>
        "objectId" in k.root ? [k.root.objectId] : []
      )
    ),
    subscriptions: model.contracts.eventSubscriptions,
    units: model.sqlUnits,
    parse,
    plpgsql,
  }).find((c) => c.table.name === table)
  expect(found, table).toBeDefined()
  return found!
}

const saveSql = (model: CompiledModel, table: string) => {
  const unit = model.sqlUnits.find(
    (u) => u.identity === `function:public.${table}_save(jsonb,int8)`
  )
  expect(unit, table).toBeDefined()
  return unit!.sql
}

type Shape = ReturnType<typeof bodyShape>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
/** Індекс оператора `type`, чий перший вираз — дерево `sql`. */
const at = (shape: Shape, type: string, sql: string, from = 0) =>
  shape.findIndex(
    (s, i) =>
      i >= from && s.type === type && same(s.expressions[0]?.tree, tree(sql))
  )
const ifAt = (shape: Shape, condition: string, from = 0) =>
  at(shape, "if", `SELECT ${condition}`, from)
const rightsOf = (model: CompiledModel, table: string) =>
  model.contracts.rights.find(
    (r) => r.objectId === contractOf(model, table).objectId
  )!
const mainOf = (model: CompiledModel, table: string) =>
  model.physical.tables.find((t) => t.name === table)!
const context = (action: string, label: string) =>
  `(SELECT simetra.command_action()) IS DISTINCT FROM '${action}' OR (SELECT simetra.command_root('${label}')) IS DISTINCT FROM v_in.id`
const lock = (table: string) =>
  `SELECT pg_advisory_xact_lock(${HIERARCHY_LOCK_SPACE}, 'public.${table}'::regclass::oid::int)`
/** Рядкові константи дерева в порядку обходу. */
const strings = (value: unknown) =>
  nodes(value, "A_Const").flatMap((c) => {
    const text = (c as { sval?: { sval: string } }).sval?.sval
    return text === undefined ? [] : [text]
  })
/** Рядкові константи масиву `ARRAY[…]` дерева. */
const arrayLiterals = (value: unknown) => strings(nodes(value, "A_ArrayExpr"))
/** Блоки plpgsql, чий власний обробник ловить `condition`. */
const handlerBlocks = (sql: string, condition: string) =>
  (
    nodes(parsePlPgSQLSync(sql), "PLpgSQL_stmt_block") as {
      body: unknown[]
      exceptions?: unknown
    }[]
  ).filter((b) => nodes(b.exceptions, "condname").includes(condition))
/** Вид вузла виразу дерева DML оператора. */
const dmlKind = (s: Shape[number]) =>
  ["InsertStmt", "UpdateStmt", "DeleteStmt"].find(
    (kind) => nodes(s.expressions[0]?.tree, kind).length > 0
  )

describe("buildCatalogCommandUnits — <t>_save", () => {
  it("порядок зміни: контекст → замок → версія → право «до» → право «після» → UPDATE → GET DIAGNOSTICS", () => {
    const shape = bodyShape(saveSql(domain, "ticket"))
    const rights = rightsOf(domain, "ticket")
    const main = mainOf(domain, "ticket")
    const ctx = ifAt(shape, context("update", "ticket"))
    const lockAt = shape.findIndex(
      (s) => s.type === "execsql" && s.target?.variable === "v_old"
    )
    const version = ifAt(
      shape,
      "v_old.version IS DISTINCT FROM p_expected_version"
    )
    const before = ifAt(
      shape,
      `(${rightsCheck(rights, "update", main, "v_old")}) IS NOT TRUE`
    )
    const after = ifAt(
      shape,
      `(${rightsCheck(rights, "update", main, "v_new")}) IS NOT TRUE`
    )
    const update = shape.findIndex(
      (s, i) => i > ctx && dmlKind(s) === "UpdateStmt"
    )
    const order = [ctx, lockAt, version, before, after, update]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(new Set(order).size).toBe(order.length)
    // Замок — `FOR NO KEY UPDATE` у дереві запиту рядка «до» (Р-A2-20):
    // `FOR UPDATE` конфліктував би з `KEY SHARE` RI-перевірок.
    expect(shape[lockAt]!.expressions[0]!.tree).toEqual(
      tree(
        "SELECT * FROM public.ticket r WHERE r.id = v_in.id FOR NO KEY UPDATE"
      )
    )
    expect(lockStrengths(shape[lockAt]!.expressions[0]!.tree)).toEqual([
      "LCS_FORNOKEYUPDATE",
    ])
    // `GET DIAGNOSTICS` іде одразу після `UPDATE`, за ним — відмова на нулі.
    expect(shape[update + 1]).toMatchObject({
      type: "getdiag",
      target: { variable: "v_count" },
    })
    expect(ifAt(shape, "v_count = 0", update + 2)).toBe(update + 2)
  })

  it("порядок створення: контекст → exists → посилання → копії → право → INSERT", () => {
    const contract = contractOf(domain, "task_comment")
    const shape = bodyShape(saveSql(domain, "task_comment"))
    const rights = rightsOf(domain, "task_comment")
    const main = mainOf(domain, "task_comment")
    const [link] = contract.carrierLinks
    const copy = link!.copies[0]!
    const ctx = ifAt(shape, context("create", "task_comment"))
    const exists = at(
      shape,
      "perform",
      "SELECT 1 FROM public.task_comment r WHERE r.id = v_in.id"
    )
    const reference = ifAt(
      shape,
      "v_new.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.task g WHERE g.id = v_new.task_id)"
    )
    const copies = at(
      shape,
      "execsql",
      `SELECT s.${copy.column} FROM public.task s WHERE s.org_id = v_new.org_id AND s.id = v_new.task_id`
    )
    expect(shape[copies]?.target).toEqual({
      variable: expect.stringContaining("v_new"),
    })
    const check = ifAt(
      shape,
      `(${rightsCheck(rights, "create", main, "v_new")}) IS NOT TRUE`
    )
    const insert = shape.findIndex((s) => dmlKind(s) === "InsertStmt")
    const order = [ctx, exists, reference, copies, check, insert]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it("перевірка права — дерево rightsCheck над v_old і v_new", () => {
    const shape = bodyShape(saveSql(domain, "ticket"))
    const rights = rightsOf(domain, "ticket")
    const main = mainOf(domain, "ticket")
    for (const [action, row] of [
      ["create", "v_new"],
      ["update", "v_old"],
      ["update", "v_new"],
    ] as const) {
      expect(
        ifAt(shape, `(${rightsCheck(rights, action, main, row)}) IS NOT TRUE`),
        `${action} ${row}`
      ).toBeGreaterThan(0)
    }
    // Створення скоупленої таблиці повторює межу тенанта `scope_insert`.
    expect(
      ifAt(
        shape,
        "(v_new.org_id = ANY (ARRAY(SELECT public.org_member_member_scopes()))) IS NOT TRUE"
      )
    ).toBeGreaterThan(0)
  })

  it("ТЧ: DELETE і UPDATE мають parent = корінь у WHERE; INSERT бере parent з кореня", () => {
    const shape = bodyShape(saveSql(domain, "ticket"))
    const ts = `public.${TICKET_CHECKLIST_TABLE}`
    const items = `p_item -> 'tabular' -> '${TICKET_CHECKLIST_TABLE}'`
    const elements = `jsonb_array_elements(${items}) WITH ORDINALITY AS x(e, ord) CROSS JOIN LATERAL jsonb_populate_record(NULL::${ts}, x.e) AS v`
    const dml = (kind: string) =>
      shape
        .filter(
          (s) =>
            dmlKind(s) === kind &&
            nodes(s.expressions[0]!.tree, "relname").includes(
              TICKET_CHECKLIST_TABLE
            )
        )
        .map((s) => s.expressions[0]!.tree)
    expect(dml("DeleteStmt")).toEqual([
      tree(
        `DELETE FROM ${ts} r WHERE r.parent_id = v_in.id AND r.id <> ALL (v_ids)`
      ),
    ])
    expect(dml("UpdateStmt")).toEqual([
      tree(
        `UPDATE ${ts} r SET line_region_id = CASE WHEN x.e ? 'line_region_id' THEN v.line_region_id ELSE r.line_region_id END, related_id = CASE WHEN x.e ? 'related_id' THEN v.related_id ELSE r.related_id END, subject_type = CASE WHEN x.e ? 'subject_type' THEN v.subject_type ELSE r.subject_type END, subject_id = CASE WHEN x.e ? 'subject_id' THEN v.subject_id ELSE r.subject_id END, line_number = x.ord FROM ${elements} WHERE r.id = v.id AND r.parent_id = v_in.id`
      ),
    ])
    expect(dml("InsertStmt")).toEqual([
      tree(
        `INSERT INTO ${ts} (id, parent_id, line_number, org_id, line_region_id, related_id, subject_type, subject_id) SELECT v.id, v_in.id, x.ord, v_new.org_id, CASE WHEN x.e ? 'line_region_id' THEN v.line_region_id ELSE NULL END, CASE WHEN x.e ? 'related_id' THEN v.related_id ELSE NULL END, CASE WHEN x.e ? 'subject_type' THEN v.subject_type ELSE NULL END, CASE WHEN x.e ? 'subject_id' THEN v.subject_id ELSE NULL END FROM ${elements} WHERE NOT EXISTS (SELECT 1 FROM ${ts} r WHERE r.id = v.id AND r.parent_id = v_in.id)`
      ),
    ])
    // Видимий рядок іншого власника — відмова до DML ТЧ (Р-A2-12).
    expect(
      ifAt(
        shape,
        `EXISTS (SELECT 1 FROM ${ts} r WHERE r.id = ANY (v_ids) AND r.parent_id <> v_in.id)`
      )
    ).toBeLessThan(
      shape.findIndex(
        (s) =>
          dmlKind(s) === "DeleteStmt" &&
          nodes(s.expressions[0]!.tree, "relname").includes(
            TICKET_CHECKLIST_TABLE
          )
      )
    )
  })

  // Рядки ТЧ — той самий механізм, що шапка (Р-A2-21): замок рядків власника
  // і звірка кількості рядків кожного DML, інакше рядок, який відсікла
  // політика `DELETE`/`UPDATE`, мовчки загубив би зміну.
  it("ТЧ: замок шапки → UPDATE шапки → замок рядків ТЧ → DELETE → звірка → UPDATE → звірка → INSERT", () => {
    const shape = bodyShape(saveSql(domain, "ticket"))
    const ts = `public.${TICKET_CHECKLIST_TABLE}`
    const ofTs = (s: Shape[number]) =>
      nodes(s.expressions[0]?.tree, "relname").includes(TICKET_CHECKLIST_TABLE)
    const headerLock = shape.findIndex(
      (s) => s.type === "execsql" && s.target?.variable === "v_old"
    )
    const headerUpdate = shape.findIndex(
      (s, i) => i > headerLock && dmlKind(s) === "UpdateStmt" && !ofTs(s)
    )
    const rowsLock = at(
      shape,
      "execsql",
      `SELECT count(*) FILTER (WHERE l.id <> ALL (v_ids)), count(*) FILTER (WHERE l.id = ANY (v_ids)) FROM (SELECT r.id FROM ${ts} r WHERE r.parent_id = v_in.id ORDER BY r.id FOR NO KEY UPDATE) AS l`
    )
    const dml = (kind: string) =>
      shape.findIndex((s) => dmlKind(s) === kind && ofTs(s))
    const remove = dml("DeleteStmt")
    const update = dml("UpdateStmt")
    const insert = dml("InsertStmt")
    const order = [headerLock, headerUpdate, rowsLock, remove, update, insert]
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(shape[rowsLock]!.target).toEqual({
      variable: expect.stringContaining("v_ts_delete"),
    })
    expect(lockStrengths(shape[rowsLock]!.expressions[0]!.tree)).toEqual([
      "LCS_FORNOKEYUPDATE",
    ])
    // Кожен DML рядків ТЧ: одразу `GET DIAGNOSTICS`, звірка з очікуваною
    // кількістю й відмова `no-right`, як нуль рядків шапки.
    for (const [statement, expected] of [
      [remove, "v_ts_delete"],
      [update, "v_ts_update"],
    ] as const) {
      expect(shape[statement + 1], expected).toMatchObject({
        type: "getdiag",
        target: { variable: "v_count" },
      })
      const check = ifAt(
        shape,
        `v_count IS DISTINCT FROM ${expected}`,
        statement + 2
      )
      expect(check, expected).toBe(statement + 2)
      expect(strings(shape[check + 1]!.expressions)).toEqual([
        "42501",
        "command.forbidden",
        "no-right",
      ])
    }
  })

  // Посилання рядка ТЧ перевіряються над рядком «після» (`n`): наявний рядок
  // цього власника з накладеними ключами елемента, новий — значення за
  // замовчуванням з накладеним входом. Над самим входом (`v`) відсутній
  // ключ пари читався б як `NULL` і пропускав перевірку цілі. Змінене
  // звіряється зі збереженим рядком (`o`): незмінене невидиме значення не
  // перевіряється знову.
  it("ТЧ: посилання рядка — над рядком «після», змінене — проти збереженого", () => {
    const shape = bodyShape(saveSql(domain, "ticket"))
    const ts = `public.${TICKET_CHECKLIST_TABLE}`
    const items = `p_item -> 'tabular' -> '${TICKET_CHECKLIST_TABLE}'`
    const after = (c: string) =>
      `CASE WHEN x.e ? '${c}' THEN v.${c} WHEN o.id IS NOT NULL THEN o.${c} ELSE NULL END AS ${c}`
    const rows = `jsonb_array_elements(${items}) WITH ORDINALITY AS x(e, ord) CROSS JOIN LATERAL jsonb_populate_record(NULL::${ts}, x.e) AS v LEFT JOIN ${ts} o ON o.id = v.id AND o.parent_id = v_in.id CROSS JOIN LATERAL (SELECT ${["line_region_id", "related_id", "subject_type", "subject_id"].map(after).join(", ")}) AS n`
    const target = (table: string) =>
      `EXISTS (SELECT 1 FROM public.${table} g WHERE g.id = n.subject_id AND g.org_id = v_new.org_id)`
    const changed =
      "(n.subject_type IS DISTINCT FROM o.subject_type OR n.subject_id IS DISTINCT FROM o.subject_id)"
    for (const [column, condition] of [
      [
        "related_id",
        "n.related_id IS NOT NULL AND n.related_id IS DISTINCT FROM o.related_id AND NOT EXISTS (SELECT 1 FROM public.ticket g WHERE g.id = n.related_id)",
      ],
      [
        "subject_type",
        `n.subject_type IS NOT NULL AND ${changed} AND n.subject_type <> ALL (ARRAY['project', 'region']::text[])`,
      ],
      [
        "subject_id",
        `n.subject_type IS NOT NULL AND ${changed} AND NOT (CASE n.subject_type WHEN 'project' THEN ${target("project")} WHEN 'region' THEN ${target("region")} ELSE true END)`,
      ],
    ] as const) {
      const check = ifAt(
        shape,
        `EXISTS (SELECT 1 FROM ${rows} WHERE ${condition})`
      )
      expect(check, column).toBeGreaterThan(0)
      expect(strings(shape[check + 1]!.expressions)).toEqual([
        "22023",
        "command.invalid",
        `tabular.${TICKET_CHECKLIST_TABLE}.${column}`,
      ])
    }
  })

  it("ТЧ: дозволені ключі елемента — rowKeys і ключ ТЧ", () => {
    const [section] = contractOf(domain, "ticket").tabularSections
    const shape = bodyShape(saveSql(domain, "ticket"))
    const check = shape.filter(
      (s) =>
        s.type === "execsql" &&
        s.target?.variable === "v_key" &&
        JSON.stringify(s.expressions[0]!.tree).includes(
          '"jsonb_array_elements"'
        ) &&
        arrayLiterals(s.expressions[0]!.tree).length > 0
    )
    expect(check.map((s) => arrayLiterals(s.expressions[0]!.tree))).toEqual([
      [...section!.rowKeys, section!.key],
    ])
  })

  it("UPDATE шапки — CASE за кожною колонкою updateKeys", () => {
    const { updateKeys } = contractOf(domain, "ticket")
    const shape = bodyShape(saveSql(domain, "ticket"))
    const set = updateKeys
      .map(
        (c) => `${c} = CASE WHEN p_item ? '${c}' THEN v_in.${c} ELSE ${c} END`
      )
      .join(", ")
    expect(
      shape
        .filter(
          (s) =>
            dmlKind(s) === "UpdateStmt" &&
            nodes(s.expressions[0]!.tree, "relname").includes("ticket")
        )
        .map((s) => s.expressions[0]!.tree)
    ).toEqual([
      tree(`UPDATE public.ticket SET ${set} WHERE id = v_in.id RETURNING *`),
    ])
  })

  it("ключі поза createKeys/updateKeys відхиляє перевірка входу", () => {
    const contract = contractOf(domain, "ticket")
    expect(inputKeys(saveSql(domain, "ticket"))).toEqual([
      [...contract.createKeys, "tabular"],
      [contract.key, ...contract.updateKeys, "tabular"],
    ])
  })

  // Відмови форми входу: кожна умова — `IF`, за яким одразу `RAISE`
  // `command.invalid` з ключем у `DETAIL`. Умова `v_key IS NOT NULL`
  // повторюється, тож рядок проходить, коли хоч одне її входження веде до
  // свого `DETAIL`.
  const items = `p_item -> 'tabular' -> '${TICKET_CHECKLIST_TABLE}'`
  it.each([
    [
      "p_item не об'єкт",
      "ticket",
      "jsonb_typeof(p_item) IS DISTINCT FROM 'object'",
      ["p_item"],
    ],
    ["ключ NULL", "ticket", "v_in.id IS NULL", ["id"]],
    [
      "tabular не об'єкт",
      "ticket",
      "jsonb_typeof(p_item -> 'tabular') IS DISTINCT FROM 'object'",
      ["tabular"],
    ],
    ["невідома ТЧ", "ticket", "v_key IS NOT NULL", ["tabular."]],
    ["tabular у довідника без ТЧ", "region", "p_item ? 'tabular'", ["tabular"]],
    [
      "значення ТЧ не масив",
      "ticket",
      `jsonb_typeof(${items}) IS DISTINCT FROM 'array'`,
      [`tabular.${TICKET_CHECKLIST_TABLE}`],
    ],
    [
      "елемент ТЧ не об'єкт",
      "ticket",
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${items}) AS x(e) WHERE jsonb_typeof(x.e) IS DISTINCT FROM 'object')`,
      [`tabular.${TICKET_CHECKLIST_TABLE}`],
    ],
    [
      "ключ елемента не uuid",
      "ticket",
      `EXISTS (SELECT 1 FROM jsonb_array_elements(${items}) AS x(e) WHERE NOT coalesce(pg_input_is_valid(x.e ->> 'id', 'uuid'), false))`,
      [`tabular.${TICKET_CHECKLIST_TABLE}.id`],
    ],
  ] as const)("форма входу: %s", (_, table, condition, detail) => {
    const shape = bodyShape(saveSql(domain, table))
    const raises = shape.flatMap((s, i) =>
      same(s.expressions[0]?.tree, tree(`SELECT ${condition}`)) &&
      s.type === "if"
        ? [strings(shape[i + 1]!.expressions)]
        : []
    )
    expect(raises).toContainEqual(["22023", "command.invalid", ...detail])
  })

  it("значення, що не приводиться до типу колонки, — command.invalid з ключем", () => {
    // Вузький блок навколо поколонкового приведення (Р-A2-7): клас `22`
    // ловить лише він, а `DETAIL` — ключ, на якому впало приведення.
    const blocks = handlerBlocks(saveSql(domain, "ticket"), "data_exception")
    // Шапка і ТЧ — по блоку; тіло — лише цикл приведення.
    expect(blocks).toHaveLength(2)
    for (const block of blocks) {
      expect(block.body).toHaveLength(1)
      expect(nodes(block.body, "PLpgSQL_stmt_fors")).toHaveLength(1)
      expect(
        nodes(block.exceptions, "PLpgSQL_stmt_raise").map(
          (r) => nodes(r, "query") as string[]
        )
      ).toEqual([expect.arrayContaining(["'22023'", "'command.invalid'"])])
    }
    const shape = bodyShape(saveSql(domain, "ticket"))
    expect(
      at(
        shape,
        "perform",
        "SELECT jsonb_populate_record(NULL::public.ticket, jsonb_build_object(v_key, p_item -> v_key))"
      )
    ).toBeGreaterThan(0)
  })

  it("конфлікт: блок лише навколо INSERT; після 23505 — повторне читання", () => {
    const blocks = handlerBlocks(saveSql(domain, "ticket"), "unique_violation")
    const header = blocks.find((b) =>
      nodes(b.body, "query").some((q) =>
        String(q).startsWith("INSERT INTO public.ticket ")
      )
    )
    expect(header?.body).toHaveLength(1)
    const shape = bodyShape(saveSql(domain, "ticket"))
    const insert = shape.findIndex(
      (s) =>
        dmlKind(s) === "InsertStmt" &&
        nodes(s.expressions[0]!.tree, "relname").includes("ticket")
    )
    const exists = "SELECT 1 FROM public.ticket r WHERE r.id = v_in.id"
    // Обробник: обмеження ключа → повторне читання → exists, інакше no-right.
    expect(shape[insert + 1]).toMatchObject({ type: "getdiag" })
    expect(at(shape, "perform", exists, insert)).toBe(insert + 4)
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
    expect(arrayLiterals(shape[insert + 2]!.expressions[0]!.tree)).toEqual([
      "ticket_pkey",
      "ticket_org_id_id_key",
    ])
  })

  it("гранти: EXECUTE лише command", () => {
    expect(
      domain.sqlUnits
        .filter(
          (u) =>
            u.class === "grant" &&
            u.generator === "catalogCommand" &&
            u.ownerObjectId === contractOf(domain, "ticket").objectId
        )
        .map((u) => u.tree)
        .map((t) => JSON.stringify(t))
        .sort()
    ).toEqual(
      [
        "public.ticket_save(jsonb, bigint)",
        "public.ticket_mark_deletion(uuid, bigint, boolean)",
      ]
        .flatMap((fn) => executeGrants(fn, ["command"], "supabase"))
        .map((sql) => JSON.stringify(tree(sql)))
        .sort()
    )
  })

  it("SECURITY INVOKER, search_path = '', без EXECUTE у тілі", () => {
    const unit = domain.sqlUnits.find(
      (u) => u.identity === "function:public.ticket_save(jsonb,int8)"
    )!
    const create = (
      unit.tree as {
        CreateFunctionStmt: {
          options: { DefElem: { defname: string; arg?: unknown } }[]
        }
      }
    ).CreateFunctionStmt
    expect(
      create.options.find((o) => o.DefElem.defname === "security")?.DefElem.arg
    ).toEqual({ Boolean: { boolval: false } })
    expect(hasEmptySearchPath(unit.tree as never)).toBe(true)
    expect(bodyShape(unit.sql).filter((s) => s.type === "dynexecute")).toEqual(
      []
    )
  })

  it("ієрархічна таблиця: advisory-замок перед замком рядка лише в гілці з parent_id", () => {
    const shape = bodyShape(saveSql(domain, "ticket"))
    const guarded = ifAt(shape, "p_item ? 'parent_id'")
    const locked = at(shape, "perform", lock("ticket"), guarded)
    const forUpdate = shape.findIndex(
      (s) => s.type === "execsql" && s.target?.variable === "v_old"
    )
    expect(guarded).toBeGreaterThan(0)
    expect(locked).toBe(guarded + 1)
    expect(locked).toBeLessThan(forUpdate)
    // Створення: замок перед `INSERT`, лише з батьком.
    const created = ifAt(shape, "v_new.parent_id IS NOT NULL")
    expect(at(shape, "perform", lock("ticket"), created)).toBe(created + 1)
    expect(created).toBeLessThan(
      shape.findIndex((s) => dmlKind(s) === "InsertStmt")
    )
    // Неієрархічна таблиця замка ієрархії не бере.
    expect(
      bodyShape(saveSql(domain, "region")).filter((s) =>
        nodes(
          s.expressions.map((e) => e.tree),
          "sval"
        ).some((v) => (v as { sval: string }).sval === "public.region")
      )
    ).toEqual([])
  })

  describe("обробник beforeWrite присвоює parent_id — замок без умови ключа", () => {
    it.each([
      ["присвоює", "NEW.parent_id := NULL;", true],
      ["не присвоює", "NEW.description := 'x';", false],
    ])("обробник %s parent_id", async (_, body, always) => {
      const handler = ticketParentHandler(body)
      const model = await compiled(
        compiledPolicyDomain(handler.sql, [commandCoreLayer(), handler.layer])
      )
      const shape = bodyShape(saveSql(model, "ticket"))
      const locks = shape
        .map((s, i) => ({ s, i }))
        .filter(({ s }) => same(s.expressions[0]?.tree, tree(lock("ticket"))))
      expect(locks).toHaveLength(2)
      // Без обробника замок — під `IF` (ключ `parent_id` чи батько нового
      // рядка); з обробником — без умови в обох гілках.
      for (const { i } of locks) {
        expect(
          shape[i - 1]!.type === "if" && shape[i]!.depth > shape[i - 1]!.depth
        ).toBe(!always)
      }
    })
  })

  describe("форми посилань", () => {
    const MEMO_FILE = "catalogs/Memo/Memo.meta.json"
    const memo: Layer = {
      [MEMO_FILE]: catalog(uuid(6960), "Memo", "memo", {
        attributes: [
          {
            id: uuid(6961),
            name: "peers",
            physicalName: "peers",
            type: "Ref",
            ref: { kind: "Catalog", name: "OrgMember" },
            array: true,
            crossScope: true,
          },
        ],
      }),
      ["roles/MemoWriter/MemoWriter.meta.json"]: role(
        uuid(6962),
        "MemoWriter",
        { scopeKind: "org" },
        {
          grants: [
            grant(
              objects(["Catalog", "Memo"]),
              ["read", "create", "update"],
              "any"
            ),
          ],
        }
      ),
    }
    let model: CompiledModel
    beforeAll(async () => {
      model = await compiled(
        compileRights(policyDomain(writeRoles(), commandCoreLayer(), memo))
      )
    })

    it.each([
      [
        "pair — мітка з дозволених",
        "ticket",
        "v_new.subject_type IS NOT NULL AND v_new.subject_type <> ALL (ARRAY['project', 'region']::text[])",
      ],
      [
        "pair — видимість цілі з умовою скоупу",
        "ticket",
        "v_new.subject_type IS NOT NULL AND NOT (CASE v_new.subject_type WHEN 'project' THEN EXISTS (SELECT 1 FROM public.project g WHERE g.id = v_new.subject_id AND g.org_id = v_new.org_id) WHEN 'region' THEN EXISTS (SELECT 1 FROM public.region g WHERE g.id = v_new.subject_id AND g.org_id = v_new.org_id) ELSE true END)",
      ],
      [
        "масив single — кожен елемент з умовою скоупу",
        "ticket",
        "EXISTS (SELECT 1 FROM unnest(v_new.watchers) AS a(v) WHERE a.v IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.org_member g WHERE g.id = a.v AND g.org_id = v_new.org_id))",
      ],
      [
        "одиничний single — без умови скоупу (складений FK)",
        "ticket",
        "v_new.assignee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.org_member g WHERE g.id = v_new.assignee_id)",
      ],
      [
        "crossScope — без умови скоупу",
        "memo",
        "EXISTS (SELECT 1 FROM unnest(v_new.peers) AS a(v) WHERE a.v IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.org_member g WHERE g.id = a.v))",
      ],
    ])("%s", (_, table, condition) => {
      // Гілка створення — кожне значення; гілку зміни тримає «лише змінене».
      expect(ifAt(bodyShape(saveSql(model, table)), condition)).toBeGreaterThan(
        0
      )
    })
    // Ціль — корінь того самого виду скоупу без `crossScope` — помилка
    // `scope.root-self-reference`, тож форма «ключ цілі = скоуп рядка» в
    // моделі без помилок недосяжна.

    it("зміна перевіряє лише змінене значення", () => {
      const shape = bodyShape(saveSql(model, "ticket"))
      expect(
        ifAt(
          shape,
          "v_new.assignee_id IS NOT NULL AND v_new.assignee_id IS DISTINCT FROM v_old.assignee_id AND NOT EXISTS (SELECT 1 FROM public.org_member g WHERE g.id = v_new.assignee_id)"
        )
      ).toBeGreaterThan(0)
      expect(
        ifAt(
          shape,
          "EXISTS (SELECT 1 FROM unnest(v_new.watchers) AS a(v) WHERE a.v IS NOT NULL AND (a.v = ANY (coalesce(v_old.watchers, '{}'))) IS NOT TRUE AND NOT EXISTS (SELECT 1 FROM public.org_member g WHERE g.id = a.v AND g.org_id = v_new.org_id))"
        )
      ).toBeGreaterThan(0)
    })
  })

  it("жоден тригер платформи на таблиці довідника не має UPDATE OF", () => {
    for (const table of ["ticket", "task_comment"]) {
      const triggers = domain.sqlUnits
        .filter((u) => u.class === "trigger" && u.file === undefined)
        .map(
          (u) =>
            (u.tree as { CreateTrigStmt: Record<string, unknown> })
              .CreateTrigStmt
        )
        .filter((t) => (t.relation as { relname: string }).relname === table)
      // Серед них є тригери на `UPDATE`: без них перевірка нічого не доводить.
      expect(triggers.length, table).toBeGreaterThan(0)
      expect(triggers.map((t) => t.columns ?? []).flat(), table).toEqual([])
    }
  })

  // Видимість рядка автору гарантує замикання прав (Ф10), тож рядок дає
  // сам DML, а повторного читання після нього немає.
  it("рядок — з RETURNING у v_row: UPDATE → GET DIAGNOSTICS → v_count = 0", () => {
    const shape = bodyShape(saveSql(domain, "ticket"))
    const into = shape.filter(
      (s) => s.type === "execsql" && s.target?.variable === "v_row"
    )
    expect(into.map(dmlKind)).toEqual(["InsertStmt", "UpdateStmt"])
    for (const s of into) {
      expect(nodes(s.expressions[0]!.tree, "returningList")).toHaveLength(1)
    }
    const update = shape.indexOf(into[1]!)
    expect(shape[update + 1]).toMatchObject({
      type: "getdiag",
      target: { variable: "v_count" },
    })
    expect(ifAt(shape, "v_count = 0", update + 2)).toBe(update + 2)
    expect(ifAt(shape, "NOT FOUND", update)).toBe(-1)
  })

  it("кожна перевірка — NULL-безпечна", () => {
    const shape = bodyShape(saveSql(domain, "ticket"))
    const conditions = shape
      .filter((s) => s.type === "if")
      .map((s) => s.expressions[0]!.tree)
    const contexts = conditions.filter((c) =>
      nodes(c, "funcname").some((f) =>
        JSON.stringify(f).includes("command_action")
      )
    )
    expect(contexts).toHaveLength(2)
    for (const c of contexts) {
      expect(
        nodes(c, "A_Expr").map((e) => (e as { kind: string }).kind)
      ).toEqual(["AEXPR_DISTINCT", "AEXPR_DISTINCT"])
    }
    const rights = conditions.filter((c) =>
      nodes(c, "funcname").some((f) => JSON.stringify(f).includes("rights_"))
    )
    expect(rights).toHaveLength(3)
    for (const c of rights) {
      expect(
        (nodes(c, "targetList") as { ResTarget: { val: unknown } }[][])[0]![0]!
          .ResTarget.val
      ).toMatchObject({ BooleanTest: { booltesttype: "IS_NOT_TRUE" } })
    }
  })

  it("широка таблиця: результат без межі аргументів", async () => {
    const attributes = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? {
            id: uuid(7000 + i),
            name: `amount${i}`,
            physicalName: `amount${i}`,
            type: "Numeric",
            precision: 10,
            scale: 2,
          }
        : {
            id: uuid(7000 + i),
            name: `note${i}`,
            physicalName: `note${i}`,
            type: "String",
            length: 20,
          }
    )
    const wide: Layer = {
      "catalogs/Wide/Wide.meta.json": catalog(uuid(6970), "Wide", "wide", {
        attributes,
      }),
      ["roles/WideWriter/WideWriter.meta.json"]: role(
        uuid(6971),
        "WideWriter",
        { scopeKind: "org" },
        {
          grants: [
            grant(
              objects(["Catalog", "Wide"]),
              ["read", "create", "update"],
              "any"
            ),
          ],
        }
      ),
    }
    const model = await compiled(compileRights(policyDomain(wide)))
    const shape = bodyShape(saveSql(model, "wide"))
    const result = shape.find(
      (s) => s.type === "assign" && s.target?.variable === "v_result"
    )!
    const built = nodes(result.expressions[0]!.tree, "FuncCall").filter((f) =>
      JSON.stringify((f as { funcname: unknown }).funcname).includes(
        "jsonb_build_object"
      )
    ) as { args: unknown[] }[]
    expect(built).toHaveLength(1)
    const keys = built[0]!.args
      .filter((_, i) => i % 2 === 0)
      .map((a) => nodes(a, "sval").map((s) => (s as { sval: string }).sval)[0])
    expect(keys).toEqual([
      "version",
      ...attributes
        .filter((a) => a.type === "Numeric")
        .map((a) => a.physicalName),
    ])
  })
})

// Ключі `p_item` — фізичні імена гранту за `origin`, тож однакові в обох
// стилях проєкту.
describe("обидва стилі: ключі p_item у дереві", () => {
  const files = () => policyDomain(writeRoles(), commandCoreLayer())
  it.each([
    ["camelCase", () => files()],
    ["snake_case", () => snakeCaseTwin(files())],
  ] as const)("%s", async (attributeCase, f) => {
    const model = await compiled(compileRights(f()))
    expect(model.project.naming.attributeCase).toBe(attributeCase)
    const sql = saveSql(model, "ticket")
    expect(inputKeys(sql)).toEqual([
      [
        "id",
        "org_id",
        "code",
        "description",
        "parent_id",
        "is_folder",
        "assignee_id",
        "region_id",
        "project_id",
        "subject_type",
        "subject_id",
        "watchers",
        "tabular",
      ],
      [
        "id",
        "code",
        "description",
        "parent_id",
        "is_folder",
        "assignee_id",
        "region_id",
        "project_id",
        "subject_type",
        "subject_id",
        "watchers",
        "tabular",
      ],
    ])
    expect(ifAt(bodyShape(sql), "p_item ? 'parent_id'")).toBeGreaterThan(0)
  })
})

/** Переліки дозволених ключів `p_item` гілок створення й зміни. */
function inputKeys(sql: string): string[][] {
  return bodyShape(sql)
    .filter(
      (s) =>
        s.type === "execsql" &&
        s.target?.variable === "v_key" &&
        nodes(s.expressions[0]!.tree, "FuncCall").some((f) =>
          same((f as { args?: unknown[] }).args, [
            { ColumnRef: { fields: [{ String: { sval: "p_item" } }] } },
          ])
        )
    )
    .map((s) => arrayLiterals(s.expressions[0]!.tree))
    .filter((keys) => keys.length > 0)
}
