import { isDeepStrictEqual } from "node:util"
import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import { PROVIDER_LOGIN_ROLES } from "simetra/model"
import { maintenanceSql } from "../rights/guard-units"
import { ZERO_UUID } from "../rights/functions"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import type { SqlUnit } from "../sql/units"
import {
  MEMBER_REGION_FILE,
  MEMBER_REGION_ID,
  ORG_KIND_ID,
  PROJECT_FILE,
  compileRights,
  policyDomain,
  regionDimension,
  singleTenantRights,
  writeRoles,
} from "./fixtures/rights"
import {
  bodyShape,
  expectedFunction,
  funcNames,
  loadShapeParsers,
  nodes,
  relationsOf,
  tree,
} from "./fixtures/sql-shape"
import { expectClean, uuid } from "./helpers"

const ref = (kind: string, name: string) => ({ kind, name })

let domain: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  const result = await compileRights(policyDomain(writeRoles()))
  expectClean(result)
  domain = result.model!
})

const ORG = `'${ORG_KIND_ID}'::uuid`
const ZERO = `'${ZERO_UUID}'::uuid`
const OPERATIONS = ["INSERT", "UPDATE", "DELETE"] as const
type Operation = (typeof OPERATIONS)[number]

/** Таблиці системних довідників прав домену — оракул, а не контракт. */
const CATALOG_TABLES = [
  { table: "org_roles", object: "org_roles", scope: "org_id" },
  {
    table: "org_roles_delta",
    object: "org_roles",
    scope: "org_id",
    parent: "parent_id",
  },
  {
    table: "org_role_assignments",
    object: "org_role_assignments",
    scope: "org_id",
  },
  { table: "global_roles", object: "global_roles" },
  { table: "global_roles_delta", object: "global_roles", parent: "parent_id" },
  { table: "global_role_assignments", object: "global_role_assignments" },
] as const

const TRANSITION: Record<Operation, string> = {
  INSERT: "REFERENCING NEW TABLE AS new_rows",
  UPDATE: "REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows",
  DELETE: "REFERENCING OLD TABLE AS old_rows",
}

const guards = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "rightsGuards")

function unit(model: CompiledModel, identity: string): SqlUnit {
  const found = guards(model).find((u) => u.identity === identity)
  expect(found, identity).toBeDefined()
  return found!
}

const fnOf = (model: CompiledModel, table: string, label: string) =>
  unit(model, `function:public.${table}_${label}()`)

const triggerOf = (model: CompiledModel, table: string, name: string) =>
  unit(model, `trigger:public.${table}.${table}_${name}`)

/** Вираз як вузол дерева, без обгортки `SELECT`. */
function expr(sql: string): unknown {
  const select = tree(`SELECT ${sql}`) as {
    SelectStmt: { targetList: { ResTarget: { val: unknown } }[] }
  }
  return select.SelectStmt.targetList[0]!.ResTarget.val
}

/** Чи є `needle` піддеревом `hay` (рівність дерев, не тексту). */
function contains(hay: unknown, needle: unknown): boolean {
  if (isDeepStrictEqual(hay, needle)) return true
  if (Array.isArray(hay)) return hay.some((item) => contains(item, needle))
  if (typeof hay !== "object" || hay === null) return false
  return Object.values(hay).some((child) => contains(child, needle))
}

const insertInto = (statement: unknown) =>
  (statement as { InsertStmt?: { relation: { relname: string } } } | undefined)
    ?.InsertStmt?.relation.relname

/**
 * Кроки тіла тригера оператора в порядку виконання: перевірка контексту,
 * підвищення версії, журнал, черга. Решта операторів кроком не є.
 */
function steps(sql: string): string[] {
  const context = expr("v_action IS NULL AND NOT v_maintenance")
  return bodyShape(sql).flatMap((s) => {
    const trees = s.expressions.map((e) => e.tree)
    if (s.type === "if" && trees.some((t) => contains(t, context)))
      return ["context"]
    if (s.type === "perform" && funcNames([s]).includes("rights_bump"))
      return ["bump"]
    if (s.type !== "execsql") return []
    const target = insertInto(trees[0])
    if (target === "rights_journal") return ["journal"]
    if (target === "rights_tx_pending") return ["queue"]
    return []
  })
}

/** Оператори тіла з викликом `rights_bump`. */
const bumps = (sql: string) =>
  bodyShape(sql)
    .filter(
      (s) => s.type === "perform" && funcNames([s]).includes("rights_bump")
    )
    .map((s) => s.expressions[0]!.tree)

interface JournalInsert {
  InsertStmt: {
    cols: { ResTarget: { name: string } }[]
    selectStmt: {
      SelectStmt: {
        targetList: { ResTarget: { val: unknown } }[]
        fromClause: {
          RangeSubselect: {
            subquery: {
              SelectStmt: {
                targetList: { ResTarget: { name?: string; val: unknown } }[]
              }
            }
          }
        }[]
      }
    }
  }
}

/** Вставки журналу тіла: колонки й вирази зовнішнього й вкладеного SELECT. */
function journalInserts(sql: string) {
  return bodyShape(sql)
    .map((s) => s.expressions[0]?.tree)
    .filter((t) => insertInto(t) === "rights_journal")
    .map((t) => {
      const insert = (t as JournalInsert).InsertStmt
      const cols = insert.cols.map((c) => c.ResTarget.name)
      const select = insert.selectStmt.SelectStmt
      const values = Object.fromEntries(
        cols.map((c, i) => [c, select.targetList[i]!.ResTarget.val])
      )
      const inner = Object.fromEntries(
        select.fromClause[0]!.RangeSubselect.subquery.SelectStmt.targetList.map(
          (target) => [target.ResTarget.name, target.ResTarget.val]
        )
      )
      return { cols, values, inner }
    })
}

/** Вираз зміненого рядка за подією: новий образ, старий або обидва. */
const image = (operation: Operation, column: string) =>
  operation === "INSERT"
    ? `n.${column}`
    : operation === "DELETE"
      ? `o.${column}`
      : `coalesce(n.${column}, o.${column})`

const refusal = (detail: string, table: string) =>
  `RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'command.forbidden', DETAIL = '${detail}', TABLE = '${table}';`

describe("rights guard statement triggers", () => {
  it("covers exactly the rights catalog tables of the project", () => {
    const tables = domain.contracts.rightsCatalogs.flatMap((c) => [
      c.roles.table.name,
      c.roles.delta.name,
      c.assignments.table.name,
    ])
    expect([...tables].sort()).toEqual(
      CATALOG_TABLES.map((t) => t.table).sort()
    )
  })

  it("puts three AFTER statement triggers with event transition tables on every rights catalog table", () => {
    for (const { table } of CATALOG_TABLES) {
      for (const operation of OPERATIONS) {
        const name = `simetra_rights_${operation.toLowerCase()}`
        expect(triggerOf(domain, table, name).tree, `${table} ${name}`).toEqual(
          tree(
            `CREATE TRIGGER ${table}_${name} AFTER ${operation} ON public.${table} ${TRANSITION[operation]} FOR EACH STATEMENT EXECUTE FUNCTION public.${table}_simetra_rights()`
          )
        )
      }
    }
  })

  it("checks the context first, then bumps the version, then journals", () => {
    for (const { table } of CATALOG_TABLES) {
      expect(steps(fnOf(domain, table, "simetra_rights").sql), table).toEqual([
        "context",
        ...OPERATIONS.flatMap(() => ["bump", "journal"]),
      ])
    }
  })

  it("refuses a write without command context unless in maintenance mode", () => {
    for (const { table } of CATALOG_TABLES) {
      const shape = bodyShape(fnOf(domain, table, "simetra_rights").sql)
      const guard = shape.findIndex(
        (s) =>
          s.type === "if" &&
          s.expressions.some((e) =>
            contains(e.tree, expr("v_action IS NULL AND NOT v_maintenance"))
          )
      )
      // Гілка контексту — лише відмова `rights-context`.
      expect(guard, table).toBeGreaterThan(0)
      expect(shape[guard + 1], table).toEqual(
        bodyShape(
          expectedFunction(
            "f",
            `BEGIN IF true THEN ${refusal("rights-context", table)} END IF; END`
          )
        )[2]
      )
      expect(shape[guard + 2]?.depth, table).toBe(1)
    }
  })

  it("bumps the version once per (scope_kind_id, scope) of the statement", () => {
    // Оновлення бачить і старий, і новий скоуп рядка; DISTINCT зводить їх.
    expect(bumps(fnOf(domain, "org_roles", "simetra_rights").sql)[1]).toEqual(
      tree(
        `SELECT simetra.rights_bump(s.scope_kind_id, s.scope) FROM (SELECT DISTINCT r.scope_kind_id, r.scope FROM (SELECT ${ORG} AS scope_kind_id, o.org_id AS scope FROM old_rows o UNION SELECT ${ORG}, n.org_id FROM new_rows n) r) s`
      )
    )
    // Глобальний рівень — нульовий uuid в обох колонках, як у rights_versions.
    expect(
      bumps(fnOf(domain, "global_roles", "simetra_rights").sql)[0]
    ).toEqual(
      tree(
        `SELECT simetra.rights_bump(s.scope_kind_id, s.scope) FROM (SELECT DISTINCT r.scope_kind_id, r.scope FROM (SELECT ${ZERO} AS scope_kind_id, ${ZERO} AS scope FROM new_rows n) r) s`
      )
    )
    for (const { table } of CATALOG_TABLES) {
      const found = bumps(fnOf(domain, table, "simetra_rights").sql)
      expect(found, table).toHaveLength(OPERATIONS.length)
      for (const bump of found) {
        expect(nodes(bump, "FuncCall"), table).toHaveLength(1)
        expect(nodes(bump, "distinctClause"), table).toHaveLength(1)
      }
    }
  })

  it("journals every changed row with xid, relation, row id and the delta's parent", () => {
    const columns = [
      "xid",
      "scope_kind_id",
      "scope",
      "actor",
      "reason",
      "action",
      "object",
      "relation",
      "operation",
      "row_id",
      "parent_id",
      "before",
      "after",
    ]
    for (const config of CATALOG_TABLES) {
      const inserts = journalInserts(
        fnOf(domain, config.table, "simetra_rights").sql
      )
      expect(inserts, config.table).toHaveLength(OPERATIONS.length)
      inserts.forEach(({ cols, values, inner }, index) => {
        const operation = OPERATIONS[index]!
        const at = `${config.table} ${operation}`
        expect(cols, at).toEqual(columns)
        expect(values.xid, at).toEqual(expr("txid_current()"))
        expect(values.object, at).toEqual(expr(`'${config.object}'`))
        // Мітка заголовка й ТЧ однакова — рядки розрізняє таблиця.
        expect(values.relation, at).toEqual(expr(`'public.${config.table}'`))
        expect(values.operation, at).toEqual(expr(`'${operation}'`))
        expect(values.row_id, at).toEqual(expr("r.row_id"))
        expect(values.parent_id, at).toEqual(expr("r.parent_id"))
        expect(inner.row_id, at).toEqual(expr(image(operation, "id")))
        expect(inner.parent_id, at).toEqual(
          expr(
            "parent" in config ? image(operation, config.parent) : "NULL::uuid"
          )
        )
        expect(values.reason, at).toEqual(
          expr("CASE WHEN v_maintenance THEN 'maintenance' ELSE 'command' END")
        )
        expect(values.actor, at).toEqual(
          expr(
            "CASE WHEN v_maintenance THEN NULL ELSE simetra.current_user_id() END"
          )
        )
      })
    }
  })

  it("bumps the scope of membership and relation dimension rows", () => {
    for (const operation of OPERATIONS) {
      const op = operation.toLowerCase()
      const rows =
        operation === "INSERT"
          ? "SELECT r.* FROM new_rows r"
          : operation === "DELETE"
            ? "SELECT r.* FROM old_rows r"
            : "SELECT r.* FROM old_rows r UNION ALL SELECT r.* FROM new_rows r"
      const bump = tree(
        `SELECT simetra.rights_bump(${ORG}, s.scope) FROM (SELECT DISTINCT r.org_id AS scope FROM (${rows}) r) s`
      )
      for (const [table, label, fn] of [
        [
          "org_member",
          `simetra_rights_members_${op}`,
          `simetra_rights_members_${op}`,
        ],
        [
          "member_region",
          `simetra_rights_relation_${op}`,
          "simetra_rights_relation",
        ],
      ] as const) {
        expect(triggerOf(domain, table, label).tree, label).toEqual(
          tree(
            `CREATE TRIGGER ${table}_${label} AFTER ${operation} ON public.${table} ${TRANSITION[operation]} FOR EACH STATEMENT EXECUTE FUNCTION public.${table}_${fn}()`
          )
        )
        const found = bumps(fnOf(domain, table, fn).sql)
        expect(
          found.some((b) => isDeepStrictEqual(b, bump)),
          label
        ).toBe(true)
      }
    }
  })

  it("bumps the global row for an unscoped relation dimension", async () => {
    const dimension = (id: number, name: string, target: string) => ({
      id: uuid(id),
      name,
      physicalName: `${name}_id`,
      type: "Ref",
      ref: ref("Catalog", target),
    })
    const result = await compileRights(
      singleTenantRights({
        "project.meta.json": {
          accessDimensions: [
            {
              id: uuid(6960),
              name: "project",
              target: ref("Catalog", "Project"),
              values: {
                relation: {
                  object: ref("InformationRegister", "UserProject"),
                  subject: "user",
                  value: "project",
                },
              },
            },
          ],
        },
        "information-registers/UserProject/UserProject.meta.json": {
          id: uuid(6961),
          kind: "InformationRegister",
          name: "UserProject",
          physicalName: "user_project",
          kindLabel: "user_project",
          scope: "none",
          dimensions: [
            dimension(6962, "user", "Users"),
            dimension(6963, "project", "Project"),
          ],
        },
      })
    )
    expectClean(result)
    expect(
      bumps(
        fnOf(result.model!, "user_project", "simetra_rights_relation").sql
      )[0]
    ).toEqual(
      tree(
        `SELECT simetra.rights_bump(${ZERO}, s.scope) FROM (SELECT DISTINCT ${ZERO} AS scope FROM (SELECT r.* FROM new_rows r) r) s`
      )
    )
  })

  it("puts no triggers on an adopted CustomTable relation", async () => {
    const column = (id: number, name: string, physicalName: string) => ({
      id: uuid(id),
      name,
      physicalName,
      type: "UUID",
      notNull: true,
    })
    const fk = (name: string, field: string, target: string) => ({
      name,
      columns: [field],
      references: { object: ref("Catalog", target), columns: ["ref"] },
    })
    const result = await compileRights(
      policyDomain(writeRoles(), {
        [MEMBER_REGION_FILE]: null,
        "custom-tables/MemberRegion/MemberRegion.meta.json": {
          id: MEMBER_REGION_ID,
          kind: "CustomTable",
          name: "MemberRegion",
          physicalName: "member_region",
          scope: "org",
          scopeColumn: "orgId",
          columns: [
            column(6033, "orgId", "org_id"),
            column(6031, "member", "member_id"),
            column(6032, "region", "region_id"),
          ],
          foreignKeys: [
            fk("member_region_member_fk", "member", "OrgMember"),
            fk("member_region_region_fk", "region", "Region"),
          ],
        },
        [PROJECT_FILE]: {
          accessDimensions: [
            {
              ...regionDimension(),
              values: {
                relation: {
                  object: ref("CustomTable", "MemberRegion"),
                  subject: "member",
                  value: "region",
                },
              },
            },
          ],
        },
      })
    )
    expectClean(result)
    const relation = result.model!.contracts.accessDimensions.flatMap((d) =>
      "relation" in d.values ? [d.values.relation.table.name] : []
    )
    expect(relation).toEqual(["member_region"])
    expect(
      guards(result.model!).filter((u) => u.identity.includes("member_region"))
    ).toEqual([])
  })

  it("refuses TRUNCATE on every guarded table, without a maintenance branch", () => {
    const tables = [
      ...CATALOG_TABLES.map((t) => t.table),
      "org_member",
      "users",
      "member_region",
    ]
    for (const table of tables) {
      expect(
        triggerOf(domain, table, "simetra_rights_truncate").tree,
        table
      ).toEqual(
        tree(
          `CREATE TRIGGER ${table}_simetra_rights_truncate BEFORE TRUNCATE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION public.${table}_simetra_rights_truncate()`
        )
      )
      // Тіло — лише відмова: після TRUNCATE ні журнал, ні носіїв не обчислити.
      expect(
        bodyShape(fnOf(domain, table, "simetra_rights_truncate").sql),
        table
      ).toEqual(
        bodyShape(
          expectedFunction(
            `public.${table}_simetra_rights_truncate`,
            `BEGIN\n${refusal("rights-context", table)}\nRETURN NULL;\nEND`
          )
        )
      )
    }
  })

  it("maintenance mode requires a non-API login role", () => {
    const logins = PROVIDER_LOGIN_ROLES.supabase.map((r) => `'${r}'`).join(", ")
    const oracle = expr(
      `coalesce(current_setting('simetra.rights_maintenance', true) = 'on', false) AND session_user::text <> ALL (ARRAY[${logins}]::text[])`
    )
    expect(expr(maintenanceSql("supabase"))).toEqual(oracle)
    // Кожна гілка режиму — той самий вираз: тригери не мають власних варіантів.
    let branches = 0
    for (const fn of guards(domain).filter((u) => u.class === "function")) {
      for (const s of bodyShape(fn.sql)) {
        for (const e of s.expressions) {
          const settings = nodes(e.tree, "FuncCall").filter((call) =>
            isDeepStrictEqual((call as { funcname: unknown }).funcname, [
              { String: { sval: "current_setting" } },
            ])
          )
          if (settings.length === 0) continue
          expect(contains(e.tree, oracle), fn.identity).toBe(true)
          branches += 1
        }
      }
    }
    expect(branches).toBeGreaterThanOrEqual(CATALOG_TABLES.length)
  })

  it("defines guard functions as closed SECURITY DEFINER plpgsql with no EXECUTE grant", () => {
    const options = (t: unknown) =>
      (
        t as {
          CreateFunctionStmt: { options: { DefElem: { defname: string } }[] }
        }
      ).CreateFunctionStmt.options.filter((o) => o.DefElem.defname !== "as")
    const closed = options(
      tree(
        "CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' SET row_security = off AS $$ BEGIN RETURN NULL; END $$"
      )
    )
    const functions = guards(domain).filter((u) => u.class === "function")
    expect(functions.length).toBeGreaterThan(0)
    for (const fn of functions) {
      expect(routineLanguage(fn.tree as never), fn.identity).toBe("plpgsql")
      expect(hasEmptySearchPath(fn.tree as never), fn.identity).toBe(true)
      expect(options(fn.tree), fn.identity).toEqual(closed)
    }
    for (const grant of guards(domain).filter((u) => u.class === "grant")) {
      expect(grant.identity.startsWith("grant:revoke:"), grant.identity).toBe(
        true
      )
    }
  })

  it("reads only qualified relations", () => {
    for (const fn of guards(domain).filter((u) => u.class === "function")) {
      const relations = relationsOf(
        bodyShape(fn.sql).map((s) => s.expressions.map((e) => e.tree))
      ).filter((r) => r.relname !== "new_rows" && r.relname !== "old_rows")
      for (const relation of relations) {
        expect(
          relation.schemaname,
          `${fn.identity} ${relation.relname}`
        ).toBeDefined()
      }
    }
  })
})
