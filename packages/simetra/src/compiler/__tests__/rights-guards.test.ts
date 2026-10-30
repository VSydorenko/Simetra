import { isDeepStrictEqual } from "node:util"
import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import {
  PLATFORM_LOGIN_ROLES,
  PROVIDER_LOGIN_ROLES,
  type AttributeCase,
} from "simetra/model"
import { buildRightsGuardUnits, maintenanceSql } from "../rights/guard-units"
import { ZERO_UUID } from "../rights/functions"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { loadSqlParser } from "../sql/parse"
import type { SqlUnit } from "../sql/units"
import {
  MEMBER_REGION_FILE,
  MEMBER_REGION_ID,
  ORG_KIND_ID,
  PROJECT_FILE,
  PROJECT_ID,
  adoptedMembership,
  compileRights,
  membersSource,
  policyDomain,
  regionDimension,
  singleTenantRights,
  withRoles,
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
import { snakeCaseTwin } from "./fixtures/snake-case"

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

  it("checks the context first, then bumps the version, journals and queues", () => {
    for (const { table } of CATALOG_TABLES) {
      expect(steps(fnOf(domain, table, "simetra_rights").sql), table).toEqual([
        "context",
        ...OPERATIONS.flatMap(() => ["bump", "journal", "queue"]),
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
      references: { object: ref("Catalog", target), key: "ref" },
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

  it("maintenance mode trusts only the owner login, never a provider login", () => {
    // Вхід власника функцій прав поза входами провайдера (спека прав §7);
    // порядок масиву — порядок переліку провайдера.
    const logins = PROVIDER_LOGIN_ROLES.supabase.map((r) => `'${r}'`).join(", ")
    const oracle = expr(
      `coalesce(current_setting('simetra.rights_maintenance', true) = 'on', false) AND session_user = current_user AND session_user::text <> ALL (ARRAY[${logins}]::text[])`
    )
    expect(expr(maintenanceSql("supabase"))).toEqual(oracle)
    // Рантайм не власник функцій прав, тож у переліку виразу його немає.
    const names = nodes(
      nodes(expr(maintenanceSql("supabase")), "A_ArrayExpr"),
      "sval"
    ).filter((v) => typeof v === "string")
    expect(names).not.toContain(PLATFORM_LOGIN_ROLES.runtime)
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

type Select = {
  op: string
  larg?: Select
  rarg?: Select
  targetList: { ResTarget: { name?: string; val: unknown } }[]
  distinctClause?: unknown
  sortClause?: unknown
  fromClause: { RangeSubselect: { subquery: { SelectStmt: Select } } }[]
}

interface QueueInsert {
  InsertStmt: {
    cols: { ResTarget: { name: string } }[]
    selectStmt: { SelectStmt: Select }
    onConflictClause: unknown
  }
}

/** Вставки черги тіла. */
const queueInserts = (sql: string) =>
  bodyShape(sql)
    .map((s) => s.expressions[0]?.tree)
    .filter((t) => insertInto(t) === "rights_tx_pending")
    .map((t) => (t as QueueInsert).InsertStmt)

/** Гілки `UNION ALL` як окремі SELECT. */
const arms = (select: Select): Select[] =>
  select.op === "SETOP_NONE"
    ? [select]
    : [...arms(select.larg!), ...arms(select.rarg!)]

/** Ключі черги: (kind, key, scope_kind_id) кожної гілки. */
const queueKeys = (insert: QueueInsert["InsertStmt"]) =>
  arms(
    insert.selectStmt.SelectStmt.fromClause[0]!.RangeSubselect.subquery
      .SelectStmt
  ).map((arm) => arm.targetList.slice(0, 3).map((t) => t.ResTarget.val))

/** DETAIL відмови оператора `raise`. */
const detailOf = (s: ReturnType<typeof bodyShape>[number]) =>
  s.expressions[2]?.tree

const CHECK = "function:simetra.rights_tx_check()"

/** Вузли `EXCEPT` дерева: ліва вибірка — набір «після», права — «до». */
function excepts(hay: unknown): { larg: unknown; rarg: unknown }[] {
  if (Array.isArray(hay)) return hay.flatMap(excepts)
  if (typeof hay !== "object" || hay === null) return []
  const node = hay as { op?: unknown; larg?: unknown; rarg?: unknown }
  const own =
    node.op === "SETOP_EXCEPT" ? [{ larg: node.larg, rarg: node.rarg }] : []
  return [...own, ...Object.values(hay).flatMap(excepts)]
}

/** Дерева всіх виразів тіла функції. */
const bodyTrees = (sql: string) =>
  bodyShape(sql).map((s) => s.expressions.map((e) => e.tree))

/** Імена функцій, які кличе дерево. */
const callsIn = (hay: unknown) =>
  nodes(hay, "FuncCall").flatMap((call) =>
    (call as { funcname: { String: { sval: string } }[] }).funcname.map(
      (n) => n.String.sval
    )
  )

/** Умови відмов `escalation`: оператор перед кожним `raise` з цим DETAIL. */
const escalationConditions = (body: ReturnType<typeof bodyShape>) =>
  body.flatMap((s, i) =>
    s.type === "raise" &&
    isDeepStrictEqual(detailOf(s), tree("SELECT 'escalation'"))
      ? [body[i - 1]!.expressions[0]!.tree]
      : []
  )

/**
 * Усе покриття цілком, а не фрагмент: зникнення будь-якої умови гілки рівня
 * (як-от `s.scope = g.scope` — права в іншому тенанті) змінює дерево.
 */
const covered = (storage: string) =>
  expr(
    `NOT EXISTS (SELECT 1 FROM simetra.rights_tx_actor s WHERE s.xid = v_pending.xid AND ((g.level = 'global' AND s.level = 'global') OR (g.level = 'scope' AND s.level = 'scope' AND s.level_id = g.level_id AND s.scope = g.scope) OR (g.level = 'container' AND ((s.level = 'scope' AND s.level_id = ${storage} AND s.scope = g.scope) OR (s.level = 'container' AND s.level_id = g.level_id AND s.container = g.container)))) AND (s.full_access OR (s.object = g.object AND s.action = g.action AND (s.extent = 'any' OR (s.extent = g.extent AND s.dimension_id IS NOT DISTINCT FROM g.dimension_id)))))`
  )

describe("rights guard transaction check", () => {
  it("takes the actor snapshot before the first command write of the transaction", () => {
    const tables = [...CATALOG_TABLES.map((t) => t.table), "org_member"]
    const body = bodyShape(
      fnOf(domain, "org_roles", "simetra_rights_snapshot").sql
    )
    for (const table of tables) {
      expect(
        triggerOf(domain, table, "simetra_rights_snapshot").tree,
        table
      ).toEqual(
        tree(
          `CREATE TRIGGER ${table}_simetra_rights_snapshot BEFORE INSERT OR UPDATE OR DELETE ON public.${table} FOR EACH STATEMENT EXECUTE FUNCTION public.${table}_simetra_rights_snapshot()`
        )
      )
      // Знімок один для всіх таблиць: перша таблиця транзакції — будь-яка.
      expect(
        bodyShape(fnOf(domain, table, "simetra_rights_snapshot").sql),
        table
      ).toEqual(body)
    }
    // Оператори режиму обслуговування й без контексту знімка не беруть.
    expect(body[2]!.expressions[0]!.tree).toEqual(
      tree(`SELECT v_action IS NULL OR (${maintenanceSql("supabase")})`)
    )
    expect(body[3]!.type).toBe("return")
    const taken = body.findIndex((s) =>
      s.expressions.some((e) =>
        isDeepStrictEqual(
          e.tree,
          tree(
            "SELECT EXISTS (SELECT 1 FROM simetra.rights_tx_actor WHERE xid = txid_current())"
          )
        )
      )
    )
    const inserts = body
      .map((s, i) => [i, insertInto(s.expressions[0]?.tree)] as const)
      .filter(([, target]) => target === "rights_tx_actor")
      .map(([i]) => i)
    expect(taken).toBeGreaterThan(0)
    // Узятий знімок не переписується: вставки — лише після перевірки.
    expect(inserts.length).toBeGreaterThan(1)
    expect(inserts.every((i) => i > taken)).toBe(true)
    // Знімок — права актора з rights_mine() на мить першого запису.
    expect(funcNames(inserts.map((i) => body[i]!))).toContain("rights_mine")
  })

  it("refuses a second actor in the same transaction", () => {
    const body = bodyShape(
      fnOf(domain, "org_roles", "simetra_rights_snapshot").sql
    )
    const other = body.findIndex((s) =>
      s.expressions.some((e) =>
        isDeepStrictEqual(
          e.tree,
          tree(
            "SELECT EXISTS (SELECT 1 FROM simetra.rights_tx_actor WHERE xid = txid_current() AND actor IS DISTINCT FROM v_actor)"
          )
        )
      )
    )
    expect(other).toBeGreaterThan(0)
    expect(body[other + 1]!.type).toBe("raise")
    expect(detailOf(body[other + 1]!)).toEqual(tree("SELECT 'rights-context'"))
  })

  it("queues every key of a statement in one INSERT together with the actor key", () => {
    const conflict = (
      tree(
        "INSERT INTO simetra.rights_tx_pending (xid, kind, key, scope_kind_id, scope, maintenance) SELECT 1 ON CONFLICT (xid, kind, scope_kind_id, key) DO UPDATE SET maintenance = rights_tx_pending.maintenance AND excluded.maintenance"
      ) as QueueInsert
    ).InsertStmt.onConflictClause
    const actor = [expr("'actor'::text"), expr(ZERO), expr(ZERO)]
    const functions = [
      ...CATALOG_TABLES.map((t) => fnOf(domain, t.table, "simetra_rights")),
      ...OPERATIONS.map((o) =>
        fnOf(domain, "org_member", `simetra_rights_members_${o.toLowerCase()}`)
      ),
    ]
    for (const fn of functions) {
      const inserts = queueInserts(fn.sql)
      // По одній вставці на гілку події.
      expect(inserts.length, fn.identity).toBe(
        fn.identity.includes("members") ? 1 : OPERATIONS.length
      )
      for (const insert of inserts) {
        expect(insert.onConflictClause, fn.identity).toEqual(conflict)
        expect(
          queueKeys(insert).some((key) => isDeepStrictEqual(key, actor)),
          fn.identity
        ).toBe(true)
      }
    }
  })

  it("deduplicates the statement's keys by primary key, preferring the new image", () => {
    const oracle = tree(
      "SELECT DISTINCT ON (k.kind, k.scope_kind_id, k.key) 1 FROM t k ORDER BY k.kind, k.scope_kind_id, k.key, k.image"
    ) as { SelectStmt: Select }
    for (const { table } of CATALOG_TABLES) {
      const [, update] = queueInserts(fnOf(domain, table, "simetra_rights").sql)
      const select = update!.selectStmt.SelectStmt
      expect(select.distinctClause, table).toEqual(
        oracle.SelectStmt.distinctClause
      )
      expect(select.sortClause, table).toEqual(oracle.SelectStmt.sortClause)
      // Новий образ — 0, старий — 1: при перенесенні в інший скоуп лишається новий.
      for (const [image, source] of [
        [0, "n.*, 0 AS image FROM new_rows n"],
        [1, "o.*, 1 AS image FROM old_rows o"],
      ] as const) {
        expect(
          contains(
            select,
            (tree(`SELECT ${source}`) as { SelectStmt: unknown }).SelectStmt
          ),
          `${table} ${image}`
        ).toBe(true)
      }
    }
  })

  it("keys the queue by storage level and the journal image by relation", () => {
    const check = unit(domain, CHECK)
    const checkTrees = bodyTrees(check.sql)
    for (const config of CATALOG_TABLES) {
      const level = config.table.startsWith("org_") ? ORG : ZERO
      const [insert] = queueInserts(
        fnOf(domain, config.table, "simetra_rights").sql
      )
      const own = config.table.endsWith("_assignments")
        ? [
            [expr("'assignment'::text"), expr("r.id"), expr(level)],
            [expr("'role'::text"), expr("r.custom_role"), expr(level)],
          ]
        : [
            [
              expr("'role'::text"),
              expr("parent" in config ? "r.parent_id" : "r.id"),
              expr(level),
            ],
          ]
      expect(queueKeys(insert!).slice(0, own.length), config.table).toEqual(own)
      // Перший образ — найменший seq рядка цієї таблиці серед командних
      // записів; рядок без запису в журналі — живий. Рядки ключа й дельти
      // ролі звужуються до `to_jsonb`: гілка журналу — за ключем
      // рядка, а для дельти, що шукається за власником, — уся транзакція.
      const journal = `simetra.rights_journal j WHERE j.xid = v_pending.xid AND j.reason = 'command' AND j.relation = 'public.${config.table}'`
      const select = (sql: string) =>
        (tree(sql) as { SelectStmt: unknown }).SelectStmt
      const [column, value] =
        "parent" in config
          ? ["parent_id", "(r.doc ->> 'id')::uuid"]
          : ["id", "v_pending.key"]
      for (const sql of [
        `SELECT DISTINCT ON (j.row_id) j.before AS doc FROM ${journal}${"parent" in config ? "" : ` AND j.row_id = ${value}`} ORDER BY j.row_id, j.seq`,
        `SELECT 1 FROM ${journal} AND j.row_id = l.id`,
        `SELECT to_jsonb(l) AS doc FROM public.${config.table} l WHERE l.${column} = ${value}`,
      ])
        expect(
          contains(checkTrees, select(sql)),
          `${config.table}: ${sql}`
        ).toBe(true)
      expect(
        journalInserts(fnOf(domain, config.table, "simetra_rights").sql)[0]!
          .values.relation,
        config.table
      ).toEqual(expr(`'public.${config.table}'`))
    }
    // Рядок ключа шукається в таблицях рівня його scope_kind_id.
    const levels = bodyShape(check.sql)
      .filter((s) => s.type === "if" && s.depth === 1)
      .map((s) => s.expressions[0]!.tree)
    for (const level of [ORG, ZERO]) {
      expect(levels).toContainEqual(
        tree(`SELECT v_pending.scope_kind_id = ${level}`)
      )
    }
  })

  it("checks the queue on COMMIT through a deferred constraint trigger", () => {
    expect(
      unit(domain, "trigger:simetra.rights_tx_pending.rights_tx_pending_check")
        .tree
    ).toEqual(
      tree(
        "CREATE CONSTRAINT TRIGGER rights_tx_pending_check AFTER INSERT ON simetra.rights_tx_pending DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION simetra.rights_tx_check()"
      )
    )
    // Подія несе першу версію рядка: злиття ON CONFLICT перечитується.
    const body = bodyShape(unit(domain, CHECK).sql)
    expect(body[1]!.expressions[0]!.tree).toEqual(
      tree(
        "SELECT * FROM simetra.rights_tx_pending p WHERE p.xid = NEW.xid AND p.kind = NEW.kind AND p.scope_kind_id = NEW.scope_kind_id AND p.key = NEW.key FOR UPDATE"
      )
    )
  })

  it("removes its queue row and, when none is left, the actor snapshot", () => {
    const body = bodyShape(unit(domain, CHECK).sql)
    expect(body.slice(-4).map((s) => [s.type, s.depth])).toEqual([
      ["execsql", 1],
      ["if", 1],
      ["execsql", 2],
      ["return", 1],
    ])
    const [own, none, snapshot] = body
      .slice(-4)
      .map((s) => s.expressions[0]!.tree)
    expect(own).toEqual(
      tree(
        "DELETE FROM simetra.rights_tx_pending p WHERE p.xid = v_pending.xid AND p.kind = v_pending.kind AND p.scope_kind_id = v_pending.scope_kind_id AND p.key = v_pending.key"
      )
    )
    expect(none).toEqual(
      tree(
        "SELECT NOT EXISTS (SELECT 1 FROM simetra.rights_tx_pending WHERE xid = v_pending.xid)"
      )
    )
    expect(snapshot).toEqual(
      tree("DELETE FROM simetra.rights_tx_actor WHERE xid = v_pending.xid")
    )
  })

  it("refuses an increment not covered by the actor's snapshot", () => {
    const body = bodyShape(unit(domain, CHECK).sql)
    const all = escalationConditions(body)
    // Гілка ключа `actor` — окремий тест; тут роль і призначення на кожному
    // з двох рівнів.
    const escalations = all.filter((c) => !callsIn(c).includes("rights_mine"))
    expect(all).toHaveLength(5)
    expect(escalations).toHaveLength(4)
    for (const condition of escalations) {
      const and = (
        condition as {
          SelectStmt: {
            targetList: {
              ResTarget: { val: { BoolExpr: { args: unknown[] } } }
            }[]
          }
        }
      ).SelectStmt.targetList[0]!.ResTarget.val.BoolExpr.args
      // Режим обслуговування пропускає лише ⊆.
      expect(and[0]).toEqual(expr("NOT v_pending.maintenance"))
      expect(nodes(condition, "op")).toContain("SETOP_EXCEPT")
      // Покриття — знімок на початок транзакції, а не поточні права.
      expect(relationsOf(condition).map((r) => r.relname)).toContain(
        "rights_tx_actor"
      )
    }
    const holding = (oracle: unknown) =>
      escalations.filter((c) => contains(c, oracle)).length
    expect(holding(covered(ORG))).toBe(2)
    expect(holding(covered("NULL::uuid"))).toBe(2)
    // Приріст ролі — тим самим замиканням, що rights_mine (rights_role_grants).
    expect(funcNames(body)).toContain("rights_role_grants")
  })

  // спека прав §7: права актора ростуть і без ключа ролі чи призначення
  // (самоприйняття запрошеного рядка з призначеннями), тож ключ `actor`
  // судить увесь приріст rights_mine() тим самим покриттям знімком.
  it("checks the actor's own increment on the actor key against the snapshot", () => {
    const body = bodyShape(unit(domain, CHECK).sql)
    const branch = body.findIndex(
      (s) =>
        s.type === "if" &&
        s.depth === 1 &&
        isDeepStrictEqual(
          s.expressions[0]!.tree,
          tree("SELECT v_pending.kind = 'actor'")
        )
    )
    expect(branch).toBeGreaterThan(0)
    const inside = body.slice(branch + 1).findIndex((s) => s.depth <= 1)
    const own = body.slice(
      branch + 1,
      inside === -1 ? undefined : branch + 1 + inside
    )
    // Інший актор на COMMIT — відмова до порівняння: rights_mine() дав би
    // права за чужими claims.
    expect(own[0]!.expressions[0]!.tree).toEqual(
      tree(
        "SELECT NOT v_pending.maintenance AND EXISTS (SELECT 1 FROM simetra.rights_tx_actor WHERE xid = v_pending.xid AND actor IS DISTINCT FROM simetra.current_user_id())"
      )
    )
    expect(own[1]!.type).toBe("raise")
    expect(detailOf(own[1]!)).toEqual(tree("SELECT 'rights-context'"))
    const [condition, ...rest] = escalationConditions(own)
    expect(rest).toEqual([])
    const [except, ...others] = excepts(condition)
    expect(others).toEqual([])
    const columns =
      "object, action, extent, dimension_id, level, level_id, scope, container"
    // «Після» — поточні права, «до» — лише рядки прав знімка цієї транзакції.
    expect(except!.larg).toEqual(
      select(`SELECT ${columns} FROM simetra.rights_mine()`)
    )
    expect(except!.rarg).toEqual(
      select(
        `SELECT ${columns} FROM simetra.rights_tx_actor WHERE xid = v_pending.xid AND NOT full_access AND level IS NOT NULL`
      )
    )
    // Покриття — та сама форма, що в довідників; вид скоупу контейнера —
    // за контейнером, і читає воно знімок, а не rights_mine().
    expect(
      contains(
        condition,
        covered(
          `CASE g.level_id WHEN '${PROJECT_ID}'::uuid THEN ${ORG} ELSE NULL::uuid END`
        )
      )
    ).toBe(true)
    expect(callsIn(condition).filter((name) => name === "rights_mine")).toEqual(
      ["rights_mine"]
    )
  })

  it("compares an assignment with its earlier image only for the same subject, container and scope", () => {
    const check = bodyTrees(unit(domain, CHECK).sql)
    for (const field of ["subject", "container", "org_id"]) {
      expect(
        contains(
          check,
          expr(
            `(b.doc ->> '${field}') IS NOT DISTINCT FROM (a.doc ->> '${field}')`
          )
        ),
        field
      ).toBe(true)
    }
  })

  // спека прав §7: зняття позначки — повний приріст. Без фільтра позначеного рядка
  // «до» й «після» дали б ту саму множину, і порожній приріст пройшов би.
  it("grant sets leave out a marked role, a marked assignment and its marked custom role", () => {
    const check = bodyTrees(unit(domain, CHECK).sql)
    // Набори «після» й «до» стоять в одному операторі `(after) EXCEPT (before)`:
    // фільтр перевіряється окремо на кожному боці, інакше втрата його на
    // боці «до» лишається непомітною.
    const sides = (where: string) => {
      const filter = expr(where)
      return excepts(check)
        .filter((e) => contains(e.larg, filter) || contains(e.rarg, filter))
        .map((e) => [contains(e.larg, filter), contains(e.rarg, filter)])
    }
    for (const scope of [
      "(r.doc ->> 'org_id')::uuid = v_pending.scope",
      "TRUE",
    ])
      expect(
        sides(
          `r.doc IS NOT NULL AND (r.doc ->> 'id')::uuid = v_pending.key AND ${scope} AND NOT (r.doc ->> 'deletion_mark')::boolean`
        ),
        scope
      ).toEqual([[true, true]])
    for (const scope of [
      "(a.doc ->> 'org_id')::uuid = v_pending.scope",
      "TRUE",
    ])
      expect(
        sides(
          `a.doc IS NOT NULL AND (a.doc ->> 'id')::uuid = v_pending.key AND ${scope} AND NOT (a.doc ->> 'deletion_mark')::boolean AND ((a.doc ->> 'custom_role')::uuid IS NULL OR (r.doc IS NOT NULL AND NOT (r.doc ->> 'deletion_mark')::boolean))`
        ),
        scope
      ).toEqual([[true, true]])
  })

  it("refuses marking a custom role in use, in maintenance mode too", () => {
    const body = bodyShape(unit(domain, CHECK).sql)
    const inUse = body.flatMap((s, i) =>
      s.type === "raise" &&
      isDeepStrictEqual(detailOf(s), tree("SELECT 'role-in-use'"))
        ? [body[i - 1]!.expressions[0]!.tree]
        : []
    )
    expect(inUse).toEqual([
      tree(
        "SELECT EXISTS (SELECT 1 FROM public.global_roles r WHERE r.id = v_pending.key AND TRUE AND r.deletion_mark) AND EXISTS (SELECT 1 FROM public.global_role_assignments a WHERE a.custom_role = v_pending.key AND TRUE AND NOT a.deletion_mark)"
      ),
      tree(
        "SELECT EXISTS (SELECT 1 FROM public.org_roles r WHERE r.id = v_pending.key AND r.org_id = v_pending.scope AND r.deletion_mark) AND EXISTS (SELECT 1 FROM public.org_role_assignments a WHERE a.custom_role = v_pending.key AND a.org_id = v_pending.scope AND NOT a.deletion_mark)"
      ),
    ])
    // Перевірка лише ключа `role`: перша гілка розвилки за видом ключа.
    const kinds = body.filter(
      (s) =>
        s.type === "if" &&
        s.expressions.length >= 2 &&
        contains(s.expressions[0]!.tree, expr("v_pending.kind = 'role'"))
    )
    expect(kinds).toHaveLength(2)
  })
})

/** Вибірка як вузол `SelectStmt` — для порівняння з гілкою `UNION ALL`. */
const select = (sql: string) => (tree(sql) as { SelectStmt: Select }).SelectStmt

/** Гілки ключа `holders` вставки черги. */
const holdersArms = (insert: QueueInsert["InsertStmt"]) =>
  arms(
    insert.selectStmt.SelectStmt.fromClause[0]!.RangeSubselect.subquery
      .SelectStmt
  ).filter((arm) =>
    isDeepStrictEqual(arm.targetList[0]!.ResTarget.val, expr("'holders'::text"))
  )

/** Найближчий попередній оператор на рівень вище — обгортка `IF` оператора `i`. */
function enclosing(body: ReturnType<typeof bodyShape>, i: number) {
  for (let j = i - 1; j >= 0; j--)
    if (body[j]!.depth === body[i]!.depth - 1) return body[j]!
  throw new Error(`no enclosing statement for ${i}`)
}

/**
 * Перевірки останнього носія: умова підрахунку й обгортка, що її тримає, —
 * у порядку рівнів тіла перевірки.
 */
function holderChecks(sql: string) {
  const body = bodyShape(sql)
  return body.flatMap((s, i) => {
    if (
      s.type !== "raise" ||
      !isDeepStrictEqual(detailOf(s), tree("SELECT 'last-full-access'"))
    )
      return []
    const count = enclosing(body, i)
    return [
      {
        count: count.expressions[0]!.tree,
        wrapper: enclosing(body, body.indexOf(count)).expressions.map(
          (e) => e.tree
        ),
      },
    ]
  })
}

/** Підрахунок дієвих носіїв рівня: `join` — шлях від призначення до користувача. */
const holderCount = (
  assignments: string,
  scope: string,
  actor: string,
  join: string,
  storage: string
) =>
  tree(
    `SELECT NOT EXISTS (SELECT 1 FROM (SELECT h.scope, h.actor FROM (SELECT ${scope} AS scope, ${actor} AS actor, a.archetype AS archetype FROM public.${assignments} a ${join} WHERE a.custom_role IS NULL AND NOT a.deletion_mark AND ${actor} IS NOT NULL) h JOIN simetra.rights_full_access_roles() f ON f.role_id = h.archetype AND f.storage_id IS NOT DISTINCT FROM ${storage}) h WHERE h.scope = v_pending.scope)`
  )

const VALID_USER = "JOIN public.users u ON u.id = m.user_id AND NOT u.invalid"
const GLOBAL_COUNT = () =>
  holderCount(
    "global_role_assignments",
    ZERO,
    "a.subject",
    "JOIN public.users u ON u.id = a.subject AND NOT u.invalid",
    "NULL::uuid"
  )
const ORG_COUNT = () =>
  holderCount(
    "org_role_assignments",
    "a.org_id",
    "m.user_id",
    `JOIN public.org_member m ON m.id = a.subject AND m.org_id = a.org_id ${VALID_USER}`,
    ORG
  )
const ROOT = () =>
  tree(
    "SELECT EXISTS (SELECT 1 FROM public.organization root WHERE root.id = v_pending.scope)"
  )

/** Гілка розвилки за видом ключа — обгортка перевірки без кореня. */
const HOLDERS_KIND = () => tree("SELECT v_pending.kind = 'holders'")

/** Генератор над власним знімком: варіанти, яких не дає жоден фікстурний проєкт. */
async function guardsOver(
  model: CompiledModel,
  contracts: Partial<CompiledModel["contracts"]>,
  physical: CompiledModel["physical"] = model.physical,
  attributeCase: AttributeCase = "camelCase"
) {
  return buildRightsGuardUnits(
    { ...model.contracts, ...contracts },
    physical,
    [],
    attributeCase,
    "supabase",
    unit(model, CHECK).module,
    await loadSqlParser()
  )
}

const checkOf = (units: readonly SqlUnit[]) =>
  units.find((u) => u.identity === CHECK)!.sql

describe("rights guard last full-access holder", () => {
  it.each([
    { table: "org_role_assignments", level: ORG, storage: ORG },
    { table: "global_role_assignments", level: ZERO, storage: "NULL::uuid" },
  ])(
    "queues the scope of a changed direct fullAccess assignment from its old image ($table)",
    ({ table, level, storage }) => {
      const scope = table.startsWith("org_") ? "r.org_id" : ZERO
      const [insert, update, remove] = queueInserts(
        fnOf(domain, table, "simetra_rights").sql
      )
      // Ключ — сам скоуп старого образу: рядок, перенесений з A в B,
      // ставить ключ A окремо від ключів інших скоупів (С3), а новий образ
      // носія не прибирає — ключа від нього немає.
      const oracle = select(
        `SELECT 'holders'::text, ${scope}, ${level}, ${scope}, 1 FROM old_rows r WHERE r.custom_role IS NULL AND EXISTS (SELECT 1 FROM simetra.rights_full_access_roles() f WHERE f.role_id = r.archetype AND f.storage_id IS NOT DISTINCT FROM ${storage})`
      )
      expect(holdersArms(insert!)).toEqual([])
      expect(holdersArms(update!)).toEqual([oracle])
      expect(holdersArms(remove!)).toEqual([oracle])
    }
  )

  it("queues the old scope when a membership row loses its filled user", () => {
    const inserts = OPERATIONS.map(
      (o) =>
        queueInserts(
          fnOf(
            domain,
            "org_member",
            `simetra_rights_members_${o.toLowerCase()}`
          ).sql
        )[0]!
    )
    expect(inserts.map((insert) => holdersArms(insert))).toEqual([
      [],
      [
        select(
          `SELECT 'holders'::text AS kind, o.org_id AS key, ${ORG} AS scope_kind_id, o.org_id AS scope, 1 AS image FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE o.user_id IS NOT NULL AND o.user_id IS DISTINCT FROM n.user_id`
        ),
      ],
      // Видалення членства з призначеннями відхиляє FK `subject`.
      [],
    ])
  })

  it("counts effective holders on COMMIT, skipping a scope whose root is gone", () => {
    expect(holderChecks(unit(domain, CHECK).sql)).toEqual([
      // Глобальний рівень кореня не має — підрахунок безумовний.
      {
        count: GLOBAL_COUNT(),
        wrapper: expect.arrayContaining([HOLDERS_KIND()]),
      },
      { count: ORG_COUNT(), wrapper: [ROOT()] },
    ])
    // Підрахунок — лише на COMMIT: оператор бачив би проміжний стан.
    for (const fn of guards(domain).filter((u) => u.identity !== CHECK))
      expect(fn.sql, fn.identity).not.toContain("last-full-access")
  })

  it("counts adopted membership through the source columns", async () => {
    const result = await compileRights(
      withRoles(adoptedMembership(), {
        [PROJECT_FILE]: { membershipSources: [membersSource()] },
      })
    )
    // Прийняте джерело членства пишеться повз команди — це попередження.
    expectClean(result, { allow: ["rights.adopted-source-writes"] })
    const [, org] = holderChecks(unit(result.model!, CHECK).sql)
    expect(org!.count).toEqual(
      holderCount(
        "org_role_assignments",
        "a.org_id",
        "m.user_id",
        `JOIN public.membership m ON m.id = a.subject AND m.org_id = a.org_id AND m.is_active IS TRUE ${VALID_USER}`,
        ORG
      )
    )
    // Без «Користувачів» умови дійсності немає: користувача дає джерело.
    const [global, orgWithoutUsers] = holderChecks(
      checkOf(await guardsOver(result.model!, { users: undefined }))
    )
    expect(global!.count).toEqual(
      holderCount(
        "global_role_assignments",
        ZERO,
        "a.subject",
        "",
        "NULL::uuid"
      )
    )
    expect(orgWithoutUsers!.count).toEqual(
      holderCount(
        "org_role_assignments",
        "a.org_id",
        "m.user_id",
        "JOIN public.membership m ON m.id = a.subject AND m.org_id = a.org_id AND m.is_active IS TRUE",
        ORG
      )
    )
  })

  it("has no root exception when the scope column has no foreign key to the root", async () => {
    const physical = {
      ...domain.physical,
      tables: domain.physical.tables.map((table) =>
        table.name === "org_role_assignments"
          ? {
              ...table,
              foreignKeys: table.foreignKeys.filter(
                (fk) => fk.references.table !== "organization"
              ),
            }
          : table
      ),
    }
    const [, org] = holderChecks(
      checkOf(await guardsOver(domain, {}, physical))
    )
    expect(org).toEqual({
      count: ORG_COUNT(),
      wrapper: expect.arrayContaining([HOLDERS_KIND()]),
    })
  })
})

/** Умова `IF`, за якою стоїть відмова `rights-context`, — кожна в тілі. */
function contextRefusals(sql: string): unknown[] {
  const body = bodyShape(sql)
  return body.flatMap((s, i) =>
    s.type === "raise" &&
    isDeepStrictEqual(detailOf(s), tree("SELECT 'rights-context'"))
      ? [enclosing(body, i).expressions[0]!.tree]
      : []
  )
}

const membersFn = (operation: Operation) =>
  fnOf(
    domain,
    "org_member",
    `simetra_rights_members_${operation.toLowerCase()}`
  )

const usersFn = (operation: "INSERT" | "UPDATE") =>
  fnOf(domain, "users", `simetra_rights_users_${operation.toLowerCase()}`)

describe("rights guards of membership and users outside commands", () => {
  it("refuses reinserting an id that rights rows still reference, in maintenance mode too", () => {
    // Без умови режиму: FK `NO ACTION` перевіряється в кінці оператора, і
    // `DELETE … RETURNING` + `INSERT` змінив би носія без ключа `holders`.
    expect(contextRefusals(membersFn("INSERT").sql)).toEqual([
      tree(
        "SELECT EXISTS (SELECT 1 FROM new_rows n WHERE EXISTS (SELECT 1 FROM public.org_role_assignments a WHERE a.subject = n.id AND a.org_id = n.org_id))"
      ),
    ])
    expect(contextRefusals(usersFn("INSERT").sql)).toEqual([
      tree(
        "SELECT EXISTS (SELECT 1 FROM new_rows n WHERE EXISTS (SELECT 1 FROM public.org_member m WHERE m.user_id = n.id) OR EXISTS (SELECT 1 FROM public.global_role_assignments a WHERE a.subject = n.id))"
      ),
    ])
    expect(
      triggerOf(domain, "users", "simetra_rights_users_insert").tree
    ).toEqual(
      tree(
        "CREATE TRIGGER users_simetra_rights_users_insert AFTER INSERT ON public.users REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION public.users_simetra_rights_users_insert()"
      )
    )
  })

  it("refuses changing a membership user outside a command, except self-acceptance", () => {
    // Порівняння за ключем рядка; і заповнений, і порожній користувач
    // незмінні, крім заповнення порожнього рядка собою, поки ще не учасник.
    // Самоприйняття — `IS NOT DISTINCT FROM`: власник без claims має
    // `current_user_id()` NULL, і `=` пропустив би заповнення будь-ким.
    expect(contextRefusals(membersFn("UPDATE").sql)).toEqual([
      tree(
        "SELECT v_action IS NULL AND NOT v_maintenance AND EXISTS (SELECT 1 FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE o.user_id IS DISTINCT FROM n.user_id AND NOT (o.user_id IS NULL AND n.user_id IS NOT DISTINCT FROM simetra.current_user_id() AND NOT EXISTS (SELECT 1 FROM public.org_member other WHERE other.org_id = n.org_id AND other.user_id = n.user_id AND other.id <> n.id)))"
      ),
    ])
    expect(contextRefusals(membersFn("DELETE").sql)).toEqual([])
  })

  it("refuses reactivating a user or changing its kind outside a command, allowing invalidation", () => {
    expect(contextRefusals(usersFn("UPDATE").sql)).toEqual([
      tree(
        "SELECT v_action IS NULL AND NOT v_maintenance AND EXISTS (SELECT 1 FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE o.user_kind IS DISTINCT FROM n.user_kind OR (o.invalid IS DISTINCT FROM n.invalid AND NOT (o.invalid = false AND n.invalid = true)))"
      ),
    ])
  })

  it("finds the user kind by its styled name in a snake_case project", async () => {
    // Близнюк у snake_case: `origin.standard` несе ім'я в стилі
    // проєкту (спека П4 §6.8), тож літерал `userKind` не знайшов би `user_kind`.
    const snake = await compileRights(snakeCaseTwin(policyDomain(writeRoles())))
    expectClean(snake)
    const sql = (model: CompiledModel) =>
      model.sqlUnits
        .filter((u) => u.generator === "rightsGuards")
        .map((u) => [u.identity, u.sql])
    expect(sql(snake.model!)).toEqual(sql(domain))
  })

  it("bumps the global version once per users statement that really changes validity or kind", () => {
    const update = usersFn("UPDATE")
    const body = bodyShape(update.sql)
    const performs = body.flatMap((s, i) =>
      s.type === "perform" && funcNames([s]).includes("rights_bump") ? [i] : []
    )
    expect(performs.map((i) => body[i]!.expressions[0]!.tree)).toEqual([
      tree(`SELECT simetra.rights_bump(${ZERO}, ${ZERO})`),
    ])
    // Лише за справжньої зміни хоч одного рядка, і в будь-якому режимі.
    expect(enclosing(body, performs[0]!).expressions[0]!.tree).toEqual(
      tree(
        "SELECT EXISTS (SELECT 1 FROM old_rows o JOIN new_rows n ON n.id = o.id WHERE o.invalid IS DISTINCT FROM n.invalid OR o.user_kind IS DISTINCT FROM n.user_kind)"
      )
    )
    expect(update.requires).toContainEqual({
      type: "unit",
      identity: "function:simetra.rights_bump(uuid,uuid)",
    })
    // Новий користувач прав не має — вставка версії не підвищує.
    expect(funcNames(bodyShape(usersFn("INSERT").sql))).not.toContain(
      "rights_bump"
    )
  })
})
