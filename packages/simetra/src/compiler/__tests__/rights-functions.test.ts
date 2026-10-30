import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel, CompileResult } from "simetra/compiler"
import { compile } from "simetra/compiler"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import type {
  QualifiedName,
  RightsContract,
  SourceConditionContract,
} from "../contracts"
import { compareStrings } from "../diagnostics"
import {
  RIGHTS_FUNCTIONS,
  hasRightsFunctions,
  hasVisibleUsers,
  sourceConditions,
} from "../rights/functions"
import { sha256HexSync } from "../sha256"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { unitCalls, unitRelations } from "../sql/dependencies"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { withoutLocations, type SqlUnit } from "../sql/units"
import { kitchenSink } from "./fixtures/kitchen-sink"
import {
  ADOPTED_LEAD_KEY,
  ADOPTED_SUPPORT_KEY,
  EVERYONE_ID,
  GLOBAL_GRANTS_SOURCE_ID,
  GRANTS_SOURCE_ID,
  GRANT_FILE,
  ORG_ADMIN_ID,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  POLY_GRANTS_SOURCE_ID,
  POLY_GRANT_FILE,
  PROJECT_FILE,
  PROJECT_ID,
  PROJECT_LEAD_ID,
  ROLE_FILE,
  SET_FILE,
  SUPPORT_ID,
  TASK_FILE,
  TEAM_KIND_ID,
  USERS_FILE,
  activeGrants,
  adoptedSourcesDomain,
  compileRights,
  compiledPolicyDomain,
  grant,
  grantTable,
  grantsSource,
  membersSource,
  objects,
  polyColumns,
  polyGrantTable,
  polymorphicGrantsDomain,
  rightsFiles,
  role,
  secondScopeKind,
  singleTenantRights,
  unscopedDimension,
  withRoles,
  withoutUsers,
  type Layer,
} from "./fixtures/rights"
import { uuid } from "./helpers"

const REASSIGN_ID = uuid(6300)
const ESCALATE_ID = uuid(6301)
const TASK = objects(["Document", "Task"])

/**
 * Права для рендеру: `Task` з власністю й кастомною дією `reassign`,
 * `TaskReaders` — `read@any` на `Task`, `TaskEditors` — `update@own`.
 */
const BASE: Layer = {
  [TASK_FILE]: {
    ownership: ["assignee"],
    customActions: [{ id: REASSIGN_ID, name: "reassign" }],
  },
  [USERS_FILE]: { ownership: ["ref"] },
  [SET_FILE("TaskReaders")]: { grants: [grant(TASK, ["read"], "any")] },
  [SET_FILE("TaskEditors")]: { grants: [grant(TASK, ["update"], "own")] },
}

type Value = string | null

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compileRights(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

const rightsUnits = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "rights")

function functionUnit(model: CompiledModel, name: string): SqlUnit {
  const found = rightsUnits(model).filter(
    (u) => u.class === "function" && u.name === name
  )
  expect(found).toHaveLength(1)
  return found[0]!
}

interface CreateFunction {
  options?: {
    DefElem?: {
      defname?: string
      arg?: {
        String?: { sval?: string }
        Boolean?: { boolval?: boolean }
        List?: { items?: { String?: { sval?: string } }[] }
      }
    }
  }[]
  sql_body?: unknown
}

const createOf = (unit: SqlUnit) =>
  (unit.tree as { CreateFunctionStmt: CreateFunction }).CreateFunctionStmt

const option = (unit: SqlUnit, name: string) =>
  createOf(unit).options?.find((o) => o.DefElem?.defname === name)?.DefElem?.arg

/** Дерево тіла функції без позицій — для порівняння з очікуваним SQL. */
function bodyTree(unit: SqlUnit): unknown {
  const text = option(unit, "as")?.List?.items?.[0]?.String?.sval
  expect(text).toBeDefined()
  const parsed = parse(text!)
  if (!parsed.ok) throw new Error(`body does not parse: ${unit.identity}`)
  expect(parsed.statements).toHaveLength(1)
  return withoutLocations(parsed.statements[0]!.stmt)
}

/** Вузли дерева з ключем `key`, у порядку обходу. */
function nodes(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((item) => nodes(item, key))
  if (typeof value !== "object" || value === null) return []
  const node = value as Record<string, unknown>
  return [
    ...(key in node ? [node[key]] : []),
    ...Object.values(node).flatMap((child) => nodes(child, key)),
  ]
}

/** Стала `VALUES`: `'x'::тип` чи `NULL::тип`. */
function constant(node: unknown): Value {
  const cast = (node as { TypeCast?: { arg: unknown } }).TypeCast
  if (cast !== undefined) return constant(cast.arg)
  const value = (
    node as { A_Const: { isnull?: boolean; sval?: { sval: string } } }
  ).A_Const
  return value.isnull === true ? null : value.sval!.sval
}

/** Рядки `VALUES` тіла функції даних як кортежі. */
function valuesRows(model: CompiledModel, name: string): Value[][] {
  const lists = nodes(bodyTree(functionUnit(model, name)), "valuesLists")
  expect(lists).toHaveLength(1)
  return (lists[0] as { List: { items: unknown[] } }[]).map((row) =>
    row.List.items.map(constant)
  )
}

/** Порівняння `<колонка> <оператор> '<стала>'` у дереві тіла. */
function comparisons(unit: SqlUnit): [string, string, Value][] {
  return nodes(bodyTree(unit), "A_Expr").flatMap((expr) => {
    const { name, lexpr, rexpr } = expr as {
      name: { String: { sval: string } }[]
      lexpr?: { ColumnRef?: { fields: { String?: { sval: string } }[] } }
      rexpr?: unknown
    }
    const column = lexpr?.ColumnRef?.fields.at(-1)?.String?.sval
    const isConstant =
      typeof rexpr === "object" && rexpr !== null && "A_Const" in rexpr
    if (column === undefined || !isConstant) return []
    return [[name[0]!.String.sval, column, constant(rexpr)]]
  })
}

/** Гранти й відкликання `EXECUTE` функцій прав: ім'я → отримувачі. */
function executeGrantees(model: CompiledModel): {
  granted: Map<string, string[]>
  revoked: Map<string, string[]>
} {
  const granted = new Map<string, string[]>()
  const revoked = new Map<string, string[]>()
  for (const unit of rightsUnits(model)) {
    const grant = (
      unit.tree as {
        GrantStmt?: {
          is_grant?: boolean
          objects: {
            ObjectWithArgs: { objname: { String: { sval: string } }[] }
          }[]
          grantees: { RoleSpec: { roletype: string; rolename?: string } }[]
        }
      }
    ).GrantStmt
    if (grant === undefined) continue
    const fn = grant.objects[0]!.ObjectWithArgs.objname.at(-1)!.String.sval
    const target = grant.is_grant === true ? granted : revoked
    for (const { RoleSpec } of grant.grantees) {
      const role =
        RoleSpec.roletype === "ROLESPEC_PUBLIC" ? "PUBLIC" : RoleSpec.rolename!
      target.set(fn, [...(target.get(fn) ?? []), role].sort())
    }
  }
  return { granted, revoked }
}

/**
 * Кожне читання таблиці членства в `rights_visible_users`: з'єднання з
 * `rights_my_scopes()` за видом скоупу (стала) і за скоупом рядка членства.
 */
function membershipJoins(
  model: CompiledModel
): { scopeKind: Value; scope: string }[] {
  const column = (node: unknown) =>
    (
      node as { ColumnRef?: { fields: { String?: { sval: string } }[] } }
    ).ColumnRef?.fields
      .map((f) => f.String?.sval)
      .join(".")
  const tree = bodyTree(functionUnit(model, RIGHTS_FUNCTIONS.visibleUsers.name))
  return nodes(tree, "JoinExpr").map((join) => {
    const { larg, rarg, quals } = join as {
      larg: { RangeVar?: { schemaname: string; relname: string } }
      rarg: { RangeFunction?: unknown }
      quals: { BoolExpr: { boolop: string; args: unknown[] } }
    }
    expect(larg.RangeVar).toBeDefined()
    expect(unitCallsOf(rarg)).toEqual([
      `${RIGHTS_FUNCTIONS.myScopes.schema}.${RIGHTS_FUNCTIONS.myScopes.name}`,
    ])
    expect(quals.BoolExpr.boolop).toBe("AND_EXPR")
    const pairs = quals.BoolExpr.args.map((arg) => {
      const { lexpr, rexpr } = (
        arg as { A_Expr: { lexpr: unknown; rexpr: unknown } }
      ).A_Expr
      return [column(lexpr), rexpr] as const
    })
    expect(pairs.map(([left]) => left)).toEqual(["s.scope_kind_id", "s.scope"])
    return {
      scopeKind: constant(pairs[0]![1]),
      scope: column(pairs[1]![1])!,
    }
  })
}

/** Імена функцій у піддереві. */
function unitCallsOf(node: unknown): string[] {
  return nodes(node, "FuncCall").map((call) =>
    (call as { funcname: { String: { sval: string } }[] }).funcname
      .map((n) => n.String.sval)
      .join(".")
  )
}

const DATA = [
  RIGHTS_FUNCTIONS.projection,
  RIGHTS_FUNCTIONS.requires,
  RIGHTS_FUNCTIONS.domain,
  RIGHTS_FUNCTIONS.roles,
  RIGHTS_FUNCTIONS.sourceKeys,
  RIGHTS_FUNCTIONS.fullAccessRoles,
  RIGHTS_FUNCTIONS.projectionVersion,
].map((fn) => fn.name)

const SIGNATURES = [
  "function:simetra.has_right(text,text,text,uuid)",
  "function:simetra.rights_any(text,text)",
  "function:simetra.rights_bump(uuid,uuid)",
  "function:simetra.rights_full_access_roles()",
  "function:simetra.rights_projection_version()",
  "function:simetra.rights_role_grants(text,uuid,uuid,jsonb)",
  "function:simetra.rights_versions()",
  "function:simetra.rights_container(text,text,text,uuid)",
  "function:simetra.rights_dim(text,text,uuid)",
  "function:simetra.rights_dimension_values(uuid)",
  "function:simetra.rights_domain()",
  "function:simetra.rights_mine()",
  "function:simetra.rights_my_members(uuid)",
  "function:simetra.rights_my_scopes()",
  "function:simetra.rights_own(text,text)",
  "function:simetra.rights_projection()",
  "function:simetra.rights_requires()",
  "function:simetra.rights_roles()",
  "function:simetra.rights_source_keys()",
  "function:simetra.rights_visible_users()",
  "function:simetra.rights_scopes_of(uuid)",
  "function:simetra.rights_detail_of(uuid)",
  "function:simetra.rights_members_of(uuid,uuid)",
  "function:simetra.rights_dimension_values_of(uuid,uuid)",
  "function:simetra.rights_scope_set_of(uuid,uuid)",
  "function:simetra.rights_visible_users_of(uuid)",
  "function:simetra.rights_member(uuid,uuid,uuid)",
  "function:simetra.rights_who(text,text,uuid,uuid)",
  "function:simetra.rights_journal_of(uuid,uuid,int4)",
].sort()

/** Без довідника членства «Користувачів» не обмежує видимість (Р2a2-18). */
const WITHOUT_MEMBERSHIP = SIGNATURES.filter(
  (s) =>
    s !== "function:simetra.rights_visible_users()" &&
    s !== "function:simetra.rights_visible_users_of(uuid)"
)

/**
 * Варіанти аналізу (Р2d2-2): кличуть їх лише функції аналізу від власника,
 * тож без `SECURITY DEFINER` і без `EXECUTE`.
 */
const VARIANTS = [
  RIGHTS_FUNCTIONS.scopesOf,
  RIGHTS_FUNCTIONS.detailOf,
  RIGHTS_FUNCTIONS.membersOf,
  RIGHTS_FUNCTIONS.dimensionValuesOf,
  RIGHTS_FUNCTIONS.scopeSetOf,
  RIGHTS_FUNCTIONS.visibleUsersOf,
].map((fn) => fn.name)

/** Функції аналізу (Р2d2-1): `EXECUTE` — без сервісної ролі. */
const ANALYSIS = [
  RIGHTS_FUNCTIONS.member,
  RIGHTS_FUNCTIONS.who,
  RIGHTS_FUNCTIONS.journalOf,
].map((fn) => fn.name)

const functionIdentities = (model: CompiledModel) =>
  rightsUnits(model)
    .filter((u) => u.class === "function")
    .map((u) => u.identity)
    .sort()

describe("rights functions", () => {
  let model: CompiledModel
  beforeAll(async () => {
    model = await compiled(withRoles(BASE))
  })

  it("renders no rights functions without roles", async () => {
    expect(rightsUnits(await compiled(rightsFiles()))).toEqual([])
  })

  it("renders rights functions without users from an adopted membership source", async () => {
    // Р2d1-6, Р2d1-7: поточного користувача дає `sub`, тож функції прав є, а
    // межі «Користувачів» без самих «Користувачів» немає.
    const sourced = await compiled(adoptedSourcesDomain(withoutUsers()))
    expect(sourced.contracts.users).toBeUndefined()
    expect(functionIdentities(sourced)).toEqual(WITHOUT_MEMBERSHIP)
  })

  it("declares every rights function with its signature, shape and grants", () => {
    expect(functionIdentities(model)).toEqual(SIGNATURES)
    const api = PROVIDER_API_ROLES.supabase
    const setRoles = [api.user, api.service, PLATFORM_ROLES.command].sort()
    const analysisRoles = [api.user, PLATFORM_ROLES.command].sort()
    const { granted, revoked } = executeGrantees(model)
    for (const unit of rightsUnits(model).filter(
      (u) => u.class === "function"
    )) {
      const data = DATA.includes(unit.name)
      expect(routineLanguage(unit.tree as never), unit.name).toBe(
        unit.name === "rights_bump" ? "plpgsql" : "sql"
      )
      expect(hasEmptySearchPath(unit.tree as never), unit.name).toBe(true)
      expect(createOf(unit).sql_body, unit.name).toBeUndefined()
      expect(option(unit, "volatility")?.String?.sval, unit.name).toBe(
        data ? "immutable" : unit.name === "rights_bump" ? "volatile" : "stable"
      )
      const variant = VARIANTS.includes(unit.name)
      expect(option(unit, "security")?.Boolean?.boolval, unit.name).toBe(
        data || variant || unit.name === "rights_role_grants" ? undefined : true
      )
      expect(granted.get(unit.name) ?? [], unit.name).toEqual(
        unit.name === "rights_projection_version"
          ? setRoles
          : ANALYSIS.includes(unit.name)
            ? analysisRoles
            : data ||
                variant ||
                unit.name === "rights_bump" ||
                unit.name === "rights_role_grants"
              ? []
              : setRoles
      )
      expect(revoked.get(unit.name), unit.name).toContain("PUBLIC")
    }
  })

  describe("rights_projection", () => {
    const rowsOf = (role: string) =>
      valuesRows(model, RIGHTS_FUNCTIONS.projection.name).filter(
        ([id]) => id === role
      )

    it("expands an archetype through its included sets", () => {
      // Породження `any → own` уже зробив компілятор.
      expect(rowsOf(ORG_MEMBER_ROLE_ID)).toEqual([
        [ORG_MEMBER_ROLE_ID, "task", "read", "any", null],
        [ORG_MEMBER_ROLE_ID, "task", "read", "own", null],
        [ORG_MEMBER_ROLE_ID, "task", "update", "own", null],
      ])
    })

    it("expands fullAccess into every action of its level on every extent", () => {
      const rows = rowsOf(ORG_ADMIN_ID).map((row) => row.slice(1).join(" "))
      const scoped = model.contracts.rights.filter(
        (c) => c.kindLabel === "task" || c.kindLabel === "task_comment"
      )
      for (const contract of scoped) {
        for (const { action, extents } of contract.actions) {
          for (const extent of extents) {
            expect(rows).toContain(
              `${contract.kindLabel} ${action} ${extent.form} `
            )
          }
        }
      }
      // Кастомна дія — за UUID (Рх18); нескоуплені об'єкти — лише `read`.
      expect(rows).toContain(`task ${REASSIGN_ID} any `)
      expect(rows).toContain("announcement read any ")
      expect(rows).toContain("users read any ")
      expect(rows).not.toContain("announcement create any ")
      // Розгортання — не селектор: адмін бачить довідники прав свого рівня,
      // а глобальних не бачить (Р2a1-8, Р2a1-20).
      expect(rows).toContain("org_roles read any ")
      expect(rows).toContain("org_role_assignments read any ")
      expect(rows.filter((r) => r.startsWith("global_"))).toEqual([])
    })
  })

  it("pins the storage level of every archetype", async () => {
    const rows = valuesRows(model, RIGHTS_FUNCTIONS.roles.name)
    expect(rows).toEqual([
      [ORG_ADMIN_ID, "scope", ORG_KIND_ID, "scope", ORG_KIND_ID],
      [ORG_MEMBER_ROLE_ID, "scope", ORG_KIND_ID, "scope", ORG_KIND_ID],
      [PROJECT_LEAD_ID, "container", PROJECT_ID, "scope", ORG_KIND_ID],
      [SUPPORT_ID, "global", null, "global", null],
      [EVERYONE_ID, "everyUser", null, null, null],
    ])
    // Рівень, покритий прийнятим джерелом, рядком довідника не вмикається
    // (Р2a1-24).
    const sourced = await compiled(
      withRoles(BASE, {
        [PROJECT_FILE]: { assignmentSources: [grantsSource()] },
        [GRANT_FILE]: grantTable(),
      })
    )
    expect(
      valuesRows(sourced, RIGHTS_FUNCTIONS.roles.name).find(
        ([id]) => id === PROJECT_LEAD_ID
      )
    ).toEqual([PROJECT_LEAD_ID, "container", PROJECT_ID, null, null])
  })

  it("renders requires and the level domain from the same rules as expandRole", () => {
    const requires = valuesRows(model, RIGHTS_FUNCTIONS.requires.name)
    expect(requires).toContainEqual(["task", "update", "read"])
    expect(requires).toContainEqual(["task", "post", "update"])
    const domain = valuesRows(model, RIGHTS_FUNCTIONS.domain.name)
    const of = (level: string, levelId: Value) =>
      domain
        .filter(([l, id]) => l === level && id === levelId)
        .map((row) => row.slice(2).join(" "))
    const org = of("scope", ORG_KIND_ID)
    expect(org).toContain("task create any ")
    expect(org).not.toContain("announcement create any ")
    expect(org.filter((r) => r.startsWith("global_role_assignments"))).toEqual(
      []
    )
    const everyUser = of("everyUser", null)
    expect(everyUser).not.toEqual([])
    expect(everyUser.filter((r) => r.includes(" any "))).toEqual([])
  })

  it("closes requires in exactly two passes", () => {
    const ctes = nodes(
      bodyTree(functionUnit(model, RIGHTS_FUNCTIONS.mine.name)),
      "CommonTableExpr"
    ).map((cte) => (cte as { ctename: string }).ctename)
    expect(ctes.filter((name) => name.startsWith("closure"))).toEqual([
      "closure_1",
      "closure_2",
    ])
  })

  it.each([
    ["kitchen sink", () => compile(kitchenSink())],
    [
      "a custom action requiring a derived chain",
      () =>
        compileRights(
          withRoles(BASE, {
            [TASK_FILE]: {
              customActions: [
                { id: ESCALATE_ID, name: "escalate", requires: ["unpost"] },
              ],
            },
          })
        ),
    ],
  ])(
    "the requires of every action are transitively closed: %s",
    async (_, build) => {
      // Якір доказу двох проходів замикання (Р2a1-11).
      const result = await build()
      const rights: RightsContract[] = result.model!.contracts.rights
      expect(rights.length).toBeGreaterThan(0)
      for (const contract of rights) {
        const byKey = new Map(contract.actions.map((a) => [a.action, a]))
        for (const action of contract.actions) {
          for (const required of action.requires) {
            for (const transitive of byKey.get(required)!.requires) {
              expect(
                action.requires,
                `${contract.kindLabel}.${action.name}`
              ).toContain(transitive)
            }
          }
        }
      }
      if (!result.model!.contracts.roles.length) return
      expect(valuesRows(result.model!, RIGHTS_FUNCTIONS.requires.name)).toEqual(
        rights.flatMap((c) =>
          c.actions.flatMap((a) =>
            a.requires.map((required) => [c.kindLabel, a.action, required])
          )
        )
      )
    }
  )

  it.each([
    [
      RIGHTS_FUNCTIONS.any.name,
      ["=", "level", "scope"],
      ["=", "extent", "any"],
    ],
    [
      RIGHTS_FUNCTIONS.own.name,
      ["=", "level", "scope"],
      ["=", "extent", "own"],
    ],
    [
      RIGHTS_FUNCTIONS.dim.name,
      ["=", "level", "scope"],
      ["=", "extent", "dimension"],
    ],
    [RIGHTS_FUNCTIONS.container.name, ["=", "level", "container"], undefined],
    [RIGHTS_FUNCTIONS.hasRight.name, ["<>", "level", "container"], undefined],
  ])("%s reads only the rows of its level", (name, level, extent) => {
    // По одному запобіжнику рівня на функцію (Р2a1-19).
    const found = comparisons(functionUnit(model, name))
    expect(found).toContainEqual(level)
    if (extent !== undefined) expect(found).toContainEqual(extent)
  })

  it("held compares the container kind with the row scope kind, not the storage", () => {
    // Скоуп без виду нічого не означає (Р2a1-26): контейнер зіставляється з
    // видом скоупу рядка призначення, а не лише через рівень зберігання
    // архетипу. `storage_id` рядка джерела — id джерела (Р2d1-4), тож вид
    // несе окрема колонка; рядок довідника дає в неї свій `storage_id`.
    for (const arm of unionArms(cteQuery(model, "assignments"))) {
      expect(target(arm, "scope_kind_id")).toEqual(target(arm, "storage_id"))
    }
    const columns = (node: unknown) =>
      (
        node as { ColumnRef?: { fields: { String?: { sval: string } }[] } }
      ).ColumnRef?.fields
        .map((f) => f.String?.sval)
        .join(".")
    const notDistinct = nodes(
      bodyTree(functionUnit(model, RIGHTS_FUNCTIONS.mine.name)),
      "A_Expr"
    )
      .map((expr) => expr as { kind: string; lexpr: unknown; rexpr: unknown })
      .filter((expr) => expr.kind === "AEXPR_NOT_DISTINCT")
      .map((expr) => [columns(expr.lexpr), columns(expr.rexpr)])
    expect(notDistinct).toContainEqual(["k.scope_kind_id", "t.scope_kind_id"])
    expect(notDistinct).not.toContainEqual(["k.scope_kind_id", "t.storage_id"])
    expect(notDistinct).toContainEqual(["k.scope", "t.scope"])
  })

  it("renders rights functions for a project without scope kinds", async () => {
    const single = await compiled(singleTenantRights())
    expect(functionIdentities(single)).toEqual(WITHOUT_MEMBERSHIP)
    const empty = parse(
      "SELECT NULL::uuid AS scope_kind_id, NULL::uuid AS scope, NULL::uuid AS member WHERE false"
    )
    if (!empty.ok) throw new Error("expected SQL does not parse")
    expect(
      bodyTree(functionUnit(single, RIGHTS_FUNCTIONS.myScopes.name))
    ).toEqual(withoutLocations(empty.statements[0]!.stmt))
    expect(
      comparisons(functionUnit(single, RIGHTS_FUNCTIONS.hasRight.name))
    ).toContainEqual(["<>", "level", "container"])
  })

  it("reads every catalog it needs only through qualified relations", () => {
    const mine = functionUnit(model, RIGHTS_FUNCTIONS.mine.name)
    const relations = unitRelations(mine, parse).map(
      (r) => `${r.schema}.${r.name}`
    )
    for (const table of [
      "org_role_assignments",
      "org_roles",
      "org_roles_delta",
      "global_role_assignments",
      "global_roles",
      "global_roles_delta",
      "project",
    ]) {
      expect(relations).toContain(`public.${table}`)
    }
    const calls = unitCalls(mine, parse).map((c) => `${c.schema}.${c.name}`)
    for (const fn of [
      RIGHTS_FUNCTIONS.myScopes,
      RIGHTS_FUNCTIONS.projection,
      RIGHTS_FUNCTIONS.domain,
      RIGHTS_FUNCTIONS.requires,
      RIGHTS_FUNCTIONS.roles,
    ]) {
      expect(calls).toContain(`${fn.schema}.${fn.name}`)
    }
    // Таблиці членства згадують лише шаблон «моїх скоупів» і межа
    // «Користувачів» — остання лише в з'єднанні з «моїми скоупами»
    // (Р2a1-25, Р2a2-18) — разом з їхніми варіантами аналізу (Р2d2-2), шаблон
    // функції множини членства й функції аналізу (учасники скоупу запиту під
    // гейтом): мої скоупи обчислює одне місце.
    const readers = rightsUnits(model)
      .filter((unit) =>
        unitRelations(unit, parse).some(
          (r) => r.schema === "public" && r.name === "org_member"
        )
      )
      .map((unit) => unit.name)
      .sort()
    expect(readers).toEqual(
      [
        RIGHTS_FUNCTIONS.myScopes,
        RIGHTS_FUNCTIONS.scopesOf,
        RIGHTS_FUNCTIONS.visibleUsers,
        RIGHTS_FUNCTIONS.visibleUsersOf,
        RIGHTS_FUNCTIONS.scopeSetOf,
        RIGHTS_FUNCTIONS.member,
        RIGHTS_FUNCTIONS.who,
      ]
        .map((fn) => fn.name)
        .sort()
    )
    expect(membershipJoins(model)).toEqual([
      { scopeKind: ORG_KIND_ID, scope: "m.org_id" },
    ])
  })

  it("renders the visible users set", () => {
    const unit = functionUnit(model, RIGHTS_FUNCTIONS.visibleUsers.name)
    expect(unit.identity).toBe("function:simetra.rights_visible_users()")
    expect(option(unit, "volatility")?.String?.sval).toBe("stable")
    expect(option(unit, "security")?.Boolean?.boolval).toBe(true)
    expect(hasEmptySearchPath(unit.tree as never)).toBe(true)
    const api = PROVIDER_API_ROLES.supabase
    expect(executeGrantees(model).granted.get(unit.name)).toEqual(
      [api.user, api.service, PLATFORM_ROLES.command].sort()
    )
    const calls = unitCalls(unit, parse).map((c) => `${c.schema}.${c.name}`)
    expect(calls).toContain("simetra.current_user_id")
    expect(calls).toContain(
      `${RIGHTS_FUNCTIONS.myScopes.schema}.${RIGHTS_FUNCTIONS.myScopes.name}`
    )
  })

  it("reads the members of every scope kind only in my scopes of that kind", async () => {
    // Р2a1-26: учасники довідника членства виду K — лише за рядками
    // `rights_my_scopes()` з `scope_kind_id = K`, інакше учасник іншого виду
    // з тим самим значенням скоупу відкрив би чужих користувачів.
    const two = await compiled(withRoles(BASE, secondScopeKind()))
    expect(membershipJoins(two)).toEqual([
      { scopeKind: ORG_KIND_ID, scope: "m.org_id" },
      { scopeKind: TEAM_KIND_ID, scope: "m.team_id" },
    ])
  })
})

/** Запит CTE `name` тіла `rights_mine`. */
function cteQuery(model: CompiledModel, name: string): unknown {
  const found = nodes(
    bodyTree(functionUnit(model, RIGHTS_FUNCTIONS.mine.name)),
    "CommonTableExpr"
  ).filter((cte) => (cte as { ctename: string }).ctename === name)
  expect(found).toHaveLength(1)
  return withoutLocations((found[0] as { ctequery: unknown }).ctequery)
}

interface Select {
  op?: string
  larg?: Select
  rarg?: Select
  targetList?: { ResTarget: { name?: string; val: unknown } }[]
}

const selectOf = (node: unknown): Select =>
  (node as { SelectStmt?: Select }).SelectStmt ?? (node as Select)

/** Гілки `UNION ALL` запиту зліва направо. */
function unionArms(node: unknown): Select[] {
  const select = selectOf(node)
  if (select.op === undefined || select.op === "SETOP_NONE") return [select]
  return [...unionArms(select.larg), ...unionArms(select.rarg)]
}

/** Вираз цілі `name` гілки. */
function target(arm: Select, name: string): unknown {
  return arm.targetList?.find((t) => t.ResTarget.name === name)?.ResTarget.val
}

/** Очікуваний SQL як дерево без позицій. */
function tree(sql: string): unknown {
  const parsed = parse(sql)
  if (!parsed.ok) throw new Error(`expected SQL does not parse: ${sql}`)
  expect(parsed.statements).toHaveLength(1)
  return withoutLocations(parsed.statements[0]!.stmt)
}

/** Гілка `assignments` рядків джерела `sourceId` (за сталою `storage_id`). */
function sourceArm(model: CompiledModel, sourceId: string): Select {
  const arms = unionArms(cteQuery(model, "assignments")).filter((arm) => {
    const storageId = target(arm, "storage_id")
    return storageId !== undefined && constant(storageId) === sourceId
  })
  expect(arms).toHaveLength(1)
  return arms[0]!
}

const CURRENT = "(SELECT simetra.current_user_id())"

describe("rights functions over adopted sources", () => {
  let model: CompiledModel
  beforeAll(async () => {
    model = await compiled(adoptedSourcesDomain())
  })

  it("my scopes include an adopted membership source, active rows only", async () => {
    // Р2d1-3: та сама форма, що гілка довідника членства; `IS TRUE` —
    // `NULL` в активності членства не дає.
    const branch = (active: string) =>
      tree(
        `SELECT '${ORG_KIND_ID}'::uuid AS scope_kind_id, s.org_id AS scope, s.id AS member FROM public.membership s WHERE s.user_id IS NOT NULL AND s.user_id = ${CURRENT}${active}`
      )
    expect(
      bodyTree(functionUnit(model, RIGHTS_FUNCTIONS.myScopes.name))
    ).toEqual(branch(" AND s.is_active IS TRUE"))
    const always = await compiled(
      adoptedSourcesDomain({
        [PROJECT_FILE]: {
          membershipSources: [
            membersSource({ columns: { scope: "orgId", user: "userId" } }),
          ],
        },
      })
    )
    expect(
      bodyTree(functionUnit(always, RIGHTS_FUNCTIONS.myScopes.name))
    ).toEqual(branch(""))
  })

  it("source keys are a data function of the role keys", () => {
    const unit = functionUnit(model, RIGHTS_FUNCTIONS.sourceKeys.name)
    expect(option(unit, "volatility")?.String?.sval).toBe("immutable")
    expect(option(unit, "security")).toBeUndefined()
    expect(
      executeGrantees(model).granted.get(RIGHTS_FUNCTIONS.sourceKeys.name)
    ).toBeUndefined()
    expect(valuesRows(model, RIGHTS_FUNCTIONS.sourceKeys.name)).toEqual([
      [GRANTS_SOURCE_ID, ADOPTED_LEAD_KEY, PROJECT_LEAD_ID],
      [GLOBAL_GRANTS_SOURCE_ID, ADOPTED_SUPPORT_KEY, SUPPORT_ID],
    ])
  })

  it("an assignment source joins the key and is typed by kind", async () => {
    // Р2d1-4: невідомий ключ — нуль рядків (внутрішнє з'єднання); учасник
    // контейнерного джерела — лише мій учасник виду скоупу контейнера.
    const keys = (id: string) =>
      `JOIN simetra.rights_source_keys() k ON k.source_id = '${id}'::uuid AND k.key = src.role_key`
    expect(sourceArm(model, GRANTS_SOURCE_ID)).toEqual(
      selectOf(
        tree(
          `SELECT 'source'::text AS storage, '${GRANTS_SOURCE_ID}'::uuid AS storage_id, s.scope AS scope, src.project_id AS container, NULL::uuid AS custom_role, k.role_id AS archetype, '${ORG_KIND_ID}'::uuid AS scope_kind_id, 'container'::text AS source_level, '${PROJECT_ID}'::uuid AS source_level_id FROM public.role_grant src ${keys(GRANTS_SOURCE_ID)} JOIN my_scopes s ON s.scope_kind_id = '${ORG_KIND_ID}'::uuid AND s.member = src.member_id`
        )
      )
    )
    expect(sourceArm(model, GLOBAL_GRANTS_SOURCE_ID)).toEqual(
      selectOf(
        tree(
          `SELECT 'source'::text AS storage, '${GLOBAL_GRANTS_SOURCE_ID}'::uuid AS storage_id, NULL::uuid AS scope, NULL::uuid AS container, NULL::uuid AS custom_role, k.role_id AS archetype, NULL::uuid AS scope_kind_id, 'global'::text AS source_level, NULL::uuid AS source_level_id FROM public.global_grant src ${keys(GLOBAL_GRANTS_SOURCE_ID)} WHERE src.member_id = ${CURRENT}`
        )
      )
    )
    // Контейнер без виду скоупу (однотенантний `Project`): учасник — я сам,
    // скоупу й виду немає, контейнер — колонка джерела.
    const single = await compiled(
      singleTenantRights({
        [PROJECT_FILE]: { assignmentSources: [grantsSource()] },
        [GRANT_FILE]: grantTable(),
        [ROLE_FILE("ProjectLead")]: {
          sourceKeys: [{ source: "grants", key: ADOPTED_LEAD_KEY }],
        },
        [ROLE_FILE("Support")]: role(SUPPORT_ID, "Support", "global"),
      })
    )
    expect(sourceArm(single, GRANTS_SOURCE_ID)).toEqual(
      selectOf(
        tree(
          `SELECT 'source'::text AS storage, '${GRANTS_SOURCE_ID}'::uuid AS storage_id, NULL::uuid AS scope, src.project_id AS container, NULL::uuid AS custom_role, k.role_id AS archetype, NULL::uuid AS scope_kind_id, 'container'::text AS source_level, '${PROJECT_ID}'::uuid AS source_level_id FROM public.role_grant src ${keys(GRANTS_SOURCE_ID)} WHERE src.member_id = ${CURRENT}`
        )
      )
    )
  })

  it("an assignment source with an active column reads active rows only", async () => {
    // `IS TRUE`: `NULL` в активності призначення прав не дає (fail-closed).
    const active = await compiled(adoptedSourcesDomain(activeGrants()))
    expect(sourceArm(active, GRANTS_SOURCE_ID)).toEqual(
      selectOf(
        tree(
          `SELECT 'source'::text AS storage, '${GRANTS_SOURCE_ID}'::uuid AS storage_id, s.scope AS scope, src.project_id AS container, NULL::uuid AS custom_role, k.role_id AS archetype, '${ORG_KIND_ID}'::uuid AS scope_kind_id, 'container'::text AS source_level, '${PROJECT_ID}'::uuid AS source_level_id FROM public.role_grant src JOIN simetra.rights_source_keys() k ON k.source_id = '${GRANTS_SOURCE_ID}'::uuid AND k.key = src.role_key JOIN my_scopes s ON s.scope_kind_id = '${ORG_KIND_ID}'::uuid AND s.member = src.member_id WHERE src.is_active IS TRUE`
        )
      )
    )
  })

  it("a source row passes only for a role of the source level", () => {
    // Р2d1-4: рівень зберігання ролей, покритих джерелом, — `NULL`
    // (Р2a1-12), тож рядок джерела типізує рівень джерела — стала генератора.
    const columns =
      "x.storage, x.storage_id, x.scope, x.container, x.custom_role, x.archetype, x.scope_kind_id, r.level, r.level_id"
    expect(cteQuery(model, "typed")).toEqual(
      tree(
        `SELECT ${columns} FROM assignments x JOIN simetra.rights_roles() r ON r.role_id = x.archetype AND r.storage = x.storage AND r.storage_id IS NOT DISTINCT FROM x.storage_id UNION ALL SELECT ${columns} FROM assignments x JOIN simetra.rights_roles() r ON r.role_id = x.archetype AND r.level = x.source_level AND r.level_id IS NOT DISTINCT FROM x.source_level_id WHERE x.storage = 'source'`
      )
    )
  })

  it("visible users include an adopted membership", () => {
    // Р2d1-8: учасники джерела — лише за моїми скоупами того самого виду й
    // з тією самою умовою активності, що «мої скоупи».
    expect(
      bodyTree(functionUnit(model, RIGHTS_FUNCTIONS.visibleUsers.name))
    ).toEqual(
      tree(
        `SELECT ${CURRENT} WHERE ${CURRENT} IS NOT NULL UNION SELECT m.user_id FROM public.membership m JOIN simetra.rights_my_scopes() s ON s.scope_kind_id = '${ORG_KIND_ID}'::uuid AND s.scope = m.org_id WHERE m.user_id IS NOT NULL AND m.is_active IS TRUE`
      )
    )
  })

  it("a membership where narrows my scopes and visible users", async () => {
    // Р2d1-15: умова рядків членства — та сама в «моїх скоупах» і в межі
    // «Користувачів».
    const narrowed = await compiled(
      adoptedSourcesDomain({
        [PROJECT_FILE]: {
          membershipSources: [
            membersSource({
              where: [
                { column: "userId", isNull: false },
                { column: "isActive", equals: true },
              ],
            }),
          ],
        },
      })
    )
    expect(
      bodyTree(functionUnit(narrowed, RIGHTS_FUNCTIONS.myScopes.name))
    ).toEqual(
      tree(
        `SELECT '${ORG_KIND_ID}'::uuid AS scope_kind_id, s.org_id AS scope, s.id AS member FROM public.membership s WHERE s.user_id IS NOT NULL AND s.user_id = ${CURRENT} AND s.is_active IS TRUE AND s.user_id IS NOT NULL AND s.is_active = TRUE`
      )
    )
    expect(
      bodyTree(functionUnit(narrowed, RIGHTS_FUNCTIONS.visibleUsers.name))
    ).toEqual(
      tree(
        `SELECT ${CURRENT} WHERE ${CURRENT} IS NOT NULL UNION SELECT m.user_id FROM public.membership m JOIN simetra.rights_my_scopes() s ON s.scope_kind_id = '${ORG_KIND_ID}'::uuid AND s.scope = m.org_id WHERE m.user_id IS NOT NULL AND m.is_active IS TRUE AND m.user_id IS NOT NULL AND m.is_active = TRUE`
      )
    )
  })

  it.each([
    ["roles, users and a membership catalog", "catalog", true, true, true],
    ["roles, users and a membership source", "source", true, true, true],
    [
      "roles and a membership source without users",
      "source",
      false,
      true,
      false,
    ],
    ["roles without users or a membership source", "none", false, false, false],
  ] as const)(
    "%s: rights functions and the users boundary",
    async (_, membership, users, rights, visible) => {
      // Р2d1-7: одне місце правди для генератора функцій і політик.
      const base = (await compiled(withRoles(BASE))).contracts
      const contracts = {
        roles: base.roles,
        users: users ? base.users : undefined,
        membership: membership === "catalog" ? base.membership : [],
        membershipSources:
          membership === "source" ? model.contracts.membershipSources : [],
      }
      expect(contracts.roles).not.toEqual([])
      expect(hasRightsFunctions(contracts, "supabase")).toBe(rights)
      expect(hasVisibleUsers(contracts, "supabase")).toBe(visible)
    }
  )
})

describe("rights functions over a polymorphic adopted source", () => {
  let model: CompiledModel
  beforeAll(async () => {
    model = await compiled(polymorphicGrantsDomain())
  })

  /** Гілка джерела `polyGrants` з кон'юнктом скоупу рядка чи без нього. */
  const polyArm = (rowScope: string) =>
    selectOf(
      tree(
        `SELECT 'source'::text AS storage, '${POLY_GRANTS_SOURCE_ID}'::uuid AS storage_id, s.scope AS scope, NULL::uuid AS container, NULL::uuid AS custom_role, k.role_id AS archetype, '${ORG_KIND_ID}'::uuid AS scope_kind_id, 'scope'::text AS source_level, '${ORG_KIND_ID}'::uuid AS source_level_id FROM public.poly_grants src JOIN public.source_roles sr ON sr.id = src.role_id AND sr.org_id IS NULL JOIN simetra.rights_source_keys() k ON k.source_id = '${POLY_GRANTS_SOURCE_ID}'::uuid AND k.key = sr.key JOIN my_scopes s ON s.scope_kind_id = '${ORG_KIND_ID}'::uuid AND s.member = src.member_id${rowScope} WHERE src.scope_type = 'org'`
      )
    )

  it("a polymorphic source filters rows, checks the row scope and joins the role table", () => {
    // R1: скоуп рядка — скоуп учасника; R1': рядок іншого рівня відсікає
    // `where`; R2: кастомну роль із ключем системної — умова ролі.
    expect(sourceArm(model, POLY_GRANTS_SOURCE_ID)).toEqual(
      polyArm(" AND s.scope = src.scope_id")
    )
  })

  it("the row scope column defaults to the table scope column", async () => {
    const scoped = await compiled(
      polymorphicGrantsDomain(
        { polyGrants: { columns: polyColumns({ scope: undefined }) } },
        {
          [POLY_GRANT_FILE]: polyGrantTable({
            scope: "org",
            scopeColumn: "scopeId",
          }),
        }
      )
    )
    expect(sourceArm(scoped, POLY_GRANTS_SOURCE_ID)).toEqual(
      polyArm(" AND s.scope = src.scope_id")
    )
    // Явний `null` — скоуп з учасника: кон'юнкта скоупу рядка немає.
    const fromMember = await compiled(
      polymorphicGrantsDomain({
        polyGrants: { columns: polyColumns({ scope: null }) },
      })
    )
    expect(sourceArm(fromMember, POLY_GRANTS_SOURCE_ID)).toEqual(polyArm(""))
    // Контейнерний рівень колонки скоупу рядка не має.
    expect(sourceArm(model, GRANTS_SOURCE_ID)).toEqual(
      selectOf(
        tree(
          `SELECT 'source'::text AS storage, '${GRANTS_SOURCE_ID}'::uuid AS storage_id, s.scope AS scope, src.project_id AS container, NULL::uuid AS custom_role, k.role_id AS archetype, '${ORG_KIND_ID}'::uuid AS scope_kind_id, 'container'::text AS source_level, '${PROJECT_ID}'::uuid AS source_level_id FROM public.role_grant src JOIN simetra.rights_source_keys() k ON k.source_id = '${GRANTS_SOURCE_ID}'::uuid AND k.key = src.role_key JOIN my_scopes s ON s.scope_kind_id = '${ORG_KIND_ID}'::uuid AND s.member = src.member_id`
        )
      )
    )
  })

  it.each<[string, SourceConditionContract, string]>([
    [
      "text with a quote",
      { column: "c", equals: "o'k", type: "text" },
      "src.c = 'o''k'",
    ],
    [
      "uuid",
      { column: "c", equals: ORG_KIND_ID, type: "uuid" },
      `src.c = '${ORG_KIND_ID}'::uuid`,
    ],
    ["boolean", { column: "c", equals: true, type: "boolean" }, "src.c = TRUE"],
    [
      "boolean false",
      { column: "c", equals: false, type: "boolean" },
      "src.c = FALSE",
    ],
    ["integer", { column: "c", equals: 7, type: "integer" }, "src.c = 7"],
    ["not null", { column: "c", isNull: false }, "src.c IS NOT NULL"],
    ["null", { column: "c", isNull: true }, "src.c IS NULL"],
  ])("sourceConditions renders %s", (_, condition, sql) => {
    expect(sourceConditions("src", [condition])).toEqual([sql])
  })

  it("sourceConditions of an empty where is empty", () => {
    expect(sourceConditions("src", [])).toEqual([])
  })
})

describe("rights administration functions", () => {
  it("provides internal grants and version functions with closed privileges", async () => {
    const model = await compiled(withRoles())
    const { granted, revoked } = executeGrantees(model)
    const publicRoles = [
      PROVIDER_API_ROLES.supabase.user,
      PROVIDER_API_ROLES.supabase.service,
      PLATFORM_ROLES.command,
    ].sort()
    for (const [name, language, volatility, definer, visible] of [
      ["rights_role_grants", "sql", "stable", false, false],
      ["rights_full_access_roles", "sql", "immutable", false, false],
      ["rights_bump", "plpgsql", "volatile", true, false],
      ["rights_versions", "sql", "stable", true, true],
      ["rights_projection_version", "sql", "immutable", false, true],
    ] as const) {
      const unit = functionUnit(model, name)
      expect(routineLanguage(unit.tree as never)).toBe(language)
      expect(hasEmptySearchPath(unit.tree as never)).toBe(true)
      expect(option(unit, "volatility")?.String?.sval ?? "volatile").toBe(
        volatility
      )
      expect(option(unit, "security")?.Boolean?.boolval === true).toBe(definer)
      expect(granted.get(name) ?? []).toEqual(visible ? publicRoles : [])
      expect(revoked.get(name)).toContain("PUBLIC")
    }
    expect(valuesRows(model, "rights_full_access_roles")).toEqual([
      [ORG_ADMIN_ID, "scope", ORG_KIND_ID],
    ])
  })

  it("changes projection version with grants but not a metadata file rename", async () => {
    const files = withRoles()
    const renamed = new Map(files)
    const old = ROLE_FILE("OrgAdmin")
    renamed.set(
      ROLE_FILE("RenamedAdminFile"),
      JSON.stringify({
        ...JSON.parse(renamed.get(old)!),
        name: "RenamedAdminFile",
      })
    )
    renamed.delete(old)
    const version = (model: CompiledModel) =>
      bodyTree(functionUnit(model, "rights_projection_version"))
    const before = version(await compiled(files))
    const model = await compiled(files)
    const hash = sha256HexSync(
      rightsUnits(model)
        .filter(
          (unit) => !unit.sql.includes(RIGHTS_FUNCTIONS.projectionVersion.name)
        )
        .sort((a, b) => compareStrings(a.identity, b.identity))
        .map((unit) => unit.sql)
        .join("\n")
    )
    expect(nodes(before, "A_Const")).toContainEqual({ sval: { sval: hash } })
    expect(version(await compiled(renamed))).toEqual(before)
    expect(
      version(
        await compiled(
          withRoles({
            [SET_FILE("TaskReaders")]: {
              grants: [grant(TASK, ["read"], "own")],
            },
            [TASK_FILE]: { ownership: ["assignee"] },
          })
        )
      )
    ).not.toEqual(before)
  })

  it("uses the same requirement closure for role definitions and held roles", async () => {
    const model = await compiled(withRoles())
    const closures = (name: string) =>
      nodes(bodyTree(functionUnit(model, name)), "CommonTableExpr").filter(
        (node) => (node as { ctename: string }).ctename.startsWith("closure_")
      )
    expect(closures("rights_mine")).toHaveLength(2)
    expect(closures("rights_role_grants")).toEqual(closures("rights_mine"))
  })
})

/**
 * Фікстури шаблону прав (Р2d2-2, Р2d2-11): разом вони мають
 * обидві форми гілки зв'язку виміру, функцію множини членства, прийняті й
 * поліморфні джерела, два види скоупу й однотенантний проєкт.
 */
const TEMPLATE_FIXTURES: [string, () => Promise<CompileResult>][] = [
  ["base", () => compileRights(withRoles(BASE))],
  ["policy-domain", () => compiledPolicyDomain({})],
  ["adopted-sources", () => compileRights(adoptedSourcesDomain())],
  ["polymorphic-grants", () => compileRights(polymorphicGrantsDomain())],
  ["two-scope-kinds", () => compileRights(withRoles(BASE, secondScopeKind()))],
  ["single-tenant", () => compileRights(singleTenantRights())],
  ["user-dimension", () => compileRights(unscopedDimension())],
  ["kitchen-sink", () => compile(kitchenSink())],
]

/** Дерево виразу SQL без позицій. */
function exprTree(sql: string): unknown {
  return selectOf(tree(`SELECT ${sql}`)).targetList![0]!.ResTarget.val
}

/** Канонічний текст дерева — ключі впорядковано, як у `toEqual`. */
const canonical = (node: unknown): string =>
  JSON.stringify(node, (_, value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([a], [b]) => compareStrings(a, b))
        )
      : value
  )

const sameTree = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/**
 * Переписує дерево зверху вниз: вузол, який `rule` замінив, далі не
 * обходиться. Підстановка — на дереві, а не в тексті SQL.
 */
function rewrite(node: unknown, rule: (node: unknown) => unknown): unknown {
  const replaced = rule(node)
  if (replaced !== undefined) return replaced
  if (Array.isArray(node)) return node.map((item) => rewrite(item, rule))
  if (typeof node !== "object" || node === null) return node
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [key, rewrite(value, rule)])
  )
}

interface CallNode {
  FuncCall: { funcname: { String: { sval: string } }[]; args?: unknown[] }
}

const callName = (node: unknown) =>
  (node as Partial<CallNode>).FuncCall?.funcname
    .map((n) => n.String.sval)
    .join(".")

/** Виклик з іншим ім'ям функції й аргументами `args(старі)`. */
function renamed(
  node: unknown,
  fn: { schema: string; name: string },
  args: (old: unknown[]) => unknown[]
): unknown {
  const { FuncCall } = node as CallNode
  const next = args(FuncCall.args ?? [])
  const rest = { ...FuncCall }
  delete rest.args
  return {
    FuncCall: {
      ...rest,
      funcname: [
        { String: { sval: fn.schema } },
        { String: { sval: fn.name } },
      ],
      ...(next.length === 0 ? {} : { args: next }),
    },
  }
}

/**
 * Користувач варіанта `fn` (Р2d2-2): дійсний — як у `current_user_id()`;
 * без «Користувачів» — аргумент як є.
 */
function variantUser(model: CompiledModel, fn: string): string {
  const users = model.contracts.users
  if (users === undefined) return `${fn}.p_user`
  const key = `u.${users.keyColumn}`
  return `(SELECT ${key} FROM ${users.table.schema}.${users.table.name} u WHERE ${key} = ${fn}.p_user AND NOT u.${users.invalidColumn})`
}

const F = RIGHTS_FUNCTIONS
const qualifiedName = (fn: { schema: string; name: string }) =>
  `${fn.schema}.${fn.name}`

/**
 * Відповідність Р2d2-2: поточний користувач → дійсний `p_user`, функції
 * множини поточного користувача → їхні варіанти з `p_user`, параметри
 * функції `from` → параметри варіанта.
 */
function toVariant(
  model: CompiledModel,
  variant: { name: string },
  from?: { name: string }
): (node: unknown) => unknown {
  const current = exprTree(CURRENT)
  const user = exprTree(variantUser(model, variant.name))
  const p = exprTree(`${variant.name}.p_user`)
  return (node) => {
    if (sameTree(node, current)) return user
    const name = callName(node)
    if (name === qualifiedName(F.myScopes))
      return renamed(node, F.scopesOf, () => [p])
    if (name === qualifiedName(F.myMembers))
      return renamed(node, F.membersOf, (args) => [p, ...args])
    const fields = (
      node as { ColumnRef?: { fields: { String?: { sval: string } }[] } }
    ).ColumnRef?.fields
    if (
      from !== undefined &&
      fields?.length === 2 &&
      fields[0]!.String?.sval === from.name
    ) {
      return {
        ColumnRef: {
          fields: [{ String: { sval: variant.name } }, fields[1]],
        },
      }
    }
    return undefined
  }
}

/** Відповідність Р2d2-2 у зворотний бік — для `rights_detail_of`. */
function toCurrent(
  model: CompiledModel,
  variant: { name: string }
): (node: unknown) => unknown {
  const current = exprTree(CURRENT)
  const user = exprTree(variantUser(model, variant.name))
  const p = exprTree(`${variant.name}.p_user`)
  return (node) => {
    if (sameTree(node, user)) return current
    // Лише виклик саме з `p_user`: інакше підміна аргументу (сталий NULL,
    // колонка) зійшлася б із `rights_mine` і тест її не помітив би.
    if (callName(node) === qualifiedName(F.scopesOf)) {
      const args = (node as CallNode).FuncCall.args ?? []
      return args.length === 1 && sameTree(args[0], p)
        ? renamed(node, F.myScopes, () => [])
        : undefined
    }
    return undefined
  }
}

const ORIGIN = ["role_id", "custom_role", "via"]

/**
 * Тіло `rights_detail_of` без колонок походження: `via` — з кожного списку
 * цілей CTE, а `role_id`, `custom_role`, `via` — з гілок вихідного запиту.
 */
function withoutOrigin(detail: unknown): unknown {
  const isVia = (t: { ResTarget: { name?: string; val: unknown } }) => {
    const fields = (
      t.ResTarget.val as {
        ColumnRef?: { fields: { String?: { sval: string } }[] }
      }
    ).ColumnRef?.fields
    return (
      t.ResTarget.name === "via" ||
      (t.ResTarget.name === undefined && fields?.at(-1)?.String?.sval === "via")
    )
  }
  const strip = (node: unknown): unknown =>
    rewrite(node, (child) => {
      if (typeof child !== "object" || child === null) return undefined
      if (!("targetList" in child)) return undefined
      const { targetList, ...rest } = child as Select
      return {
        ...(strip(rest) as object),
        targetList: targetList!.filter((t) => !isVia(t)),
      }
    })
  const top = selectOf(strip(detail))
  const arm = (select: Select | undefined): Select => ({
    ...select,
    targetList: select!.targetList!.filter(
      (t) => !ORIGIN.includes(t.ResTarget.name ?? "")
    ),
  })
  return { SelectStmt: { ...top, larg: arm(top.larg), rarg: arm(top.rarg) } }
}

/** Гілка з дослівної функції проєкту: `FROM <функція>(…)`. */
const fromFunction = (arm: Select) =>
  (arm as { fromClause?: { RangeFunction?: unknown }[] }).fromClause?.[0]
    ?.RangeFunction !== undefined

const EMPTY_SET = "SELECT NULL::uuid WHERE false"

const membershipUnit = (model: CompiledModel, name: string): SqlUnit => {
  const found = model.sqlUnits.filter(
    (u) =>
      u.generator === "membership" && u.class === "function" && u.name === name
  )
  expect(found).toHaveLength(1)
  return found[0]!
}

/** Останній кон'юнкт `WHERE` гілки й гілка без нього. */
function splitLastConjunct(arm: Select): [Select, unknown] {
  const where = (arm as { whereClause: { BoolExpr: { args: unknown[] } } })
    .whereClause.BoolExpr
  return [
    {
      ...arm,
      whereClause: { BoolExpr: { ...where, args: where.args.slice(0, -1) } },
    } as Select,
    where.args.at(-1),
  ]
}

const VARIANT_FIXTURES: [string, () => Promise<CompileResult>][] = [
  ...TEMPLATE_FIXTURES,
  [
    "adopted-without-users",
    () => compileRights(adoptedSourcesDomain(withoutUsers())),
  ],
]

describe("rights analysis templates", () => {
  const models = new Map<string, CompiledModel>()
  const modelOf = async (name: string, build: () => Promise<CompileResult>) => {
    if (!models.has(name)) {
      const result = await build()
      expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual(
        []
      )
      models.set(name, result.model!)
    }
    return models.get(name)!
  }

  it.each(VARIANT_FIXTURES)(
    "no _of body reads the current user: %s",
    async (name, build) => {
      const model = await modelOf(name, build)
      // Усе, що рахує щось для поточного користувача, — з моделі, а не
      // переліком: функції прав `SECURITY DEFINER` (функції поточного
      // користувача й аналізу), функції членства, дослівні функції множини
      // скоупу й виміру і сама `current_user_id()`.
      const forbidden = [
        "simetra.current_user_id",
        ...rightsUnits(model)
          .filter(
            (u) =>
              u.class === "function" &&
              option(u, "security")?.Boolean?.boolval === true
          )
          .map((u) => `${u.schema}.${u.name}`),
        ...model.sqlUnits
          .filter((u) => u.generator === "membership" && u.class === "function")
          .map((u) => `${u.schema}.${u.name}`),
        ...model.contracts.access.flatMap((a) =>
          a.scope === undefined ? [] : [qualifiedName(a.scope.setFunction)]
        ),
        ...model.contracts.accessDimensions.flatMap((d) =>
          "function" in d.values ? [qualifiedName(d.values.function)] : []
        ),
      ]
      for (const fn of [F.myScopes, F.myMembers, F.mine, F.visibleUsers]) {
        if (functionIdentities(model).some((i) => i.includes(`.${fn.name}(`)))
          expect(forbidden).toContain(qualifiedName(fn))
      }
      expect(forbidden).toContain(qualifiedName(F.dimensionValues))
      const variants = rightsUnits(model).filter(
        (u) => u.class === "function" && VARIANTS.includes(u.name)
      )
      expect(variants.length).toBeGreaterThanOrEqual(VARIANTS.length - 1)
      for (const unit of variants) {
        const calls = unitCalls(unit, parse).map((c) => `${c.schema}.${c.name}`)
        expect(
          calls.filter((c) => forbidden.includes(c)),
          unit.name
        ).toEqual([])
      }
    }
  )

  it.each(VARIANT_FIXTURES)(
    "each _of variant is the same body with the user argument: %s",
    async (name, build) => {
      const model = await modelOf(name, build)
      const variantOf = (fn: { name: string }, from: { name: string }) =>
        rewrite(
          bodyTree(functionUnit(model, from.name)),
          toVariant(model, fn, from)
        )
      const pairs: [{ name: string }, { name: string }][] = [
        [F.scopesOf, F.myScopes],
        [F.membersOf, F.myMembers],
        ...(model.contracts.users !== undefined &&
        (model.contracts.membership.length > 0 ||
          model.contracts.membershipSources.length > 0)
          ? [
              [F.visibleUsersOf, F.visibleUsers] as [
                QualifiedName,
                QualifiedName,
              ],
            ]
          : []),
      ]
      for (const [fn, from] of pairs) {
        expect(bodyTree(functionUnit(model, fn.name)), fn.name).toEqual(
          variantOf(fn, from)
        )
      }
      // Гілки зв'язку — ті самі; дослівна функція виміру варіанта не має.
      const relations = unionArms(
        variantOf(F.dimensionValuesOf, F.dimensionValues)
      ).filter((arm) => !fromFunction(arm))
      const dimensions = bodyTree(functionUnit(model, F.dimensionValuesOf.name))
      if (relations.length === 0) expect(dimensions).toEqual(tree(EMPTY_SET))
      else expect(unionArms(dimensions)).toEqual(relations)
      // Тіло функції множини членства кожного виду з `membership` плюс умова
      // виду; дослівна функція множини варіанта не має.
      const sets = model.contracts.membership.filter(
        (m) => m.setFunction !== undefined
      )
      const scopeSet = bodyTree(functionUnit(model, F.scopeSetOf.name))
      if (sets.length === 0) {
        expect(scopeSet).toEqual(tree(EMPTY_SET))
        return
      }
      const arms = unionArms(scopeSet).map(splitLastConjunct)
      expect(arms.map(([arm]) => arm)).toEqual(
        sets.map((m) =>
          selectOf(
            rewrite(
              bodyTree(membershipUnit(model, m.setFunction!.name)),
              toVariant(model, F.scopeSetOf)
            )
          )
        )
      )
      expect(arms.map(([, kind]) => kind)).toEqual(
        sets.map((m) =>
          exprTree(
            `${F.scopeSetOf.name}.p_scope_kind = '${m.scopeKindId}'::uuid`
          )
        )
      )
    }
  )

  it.each(VARIANT_FIXTURES)(
    "detail_of projects to mine: %s",
    async (name, build) => {
      // Два згенеровані тіла, а не знімок: походження — лише вихідні колонки.
      const model = await modelOf(name, build)
      expect(
        rewrite(
          withoutOrigin(bodyTree(functionUnit(model, F.detailOf.name))),
          toCurrent(model, F.detailOf)
        )
      ).toEqual(bodyTree(functionUnit(model, F.mine.name)))
    }
  )
})

const ZERO = "00000000-0000-0000-0000-000000000000"

/** Глобальний запит функції аналізу `fn` — нульові вид і скоуп. */
const globalRequest = (fn: string) =>
  `${fn}.p_scope_kind = '${ZERO}'::uuid AND ${fn}.p_scope = '${ZERO}'::uuid`

/**
 * Гейт Р2d2-3 фікстури прав: `administerRights` на довіднику призначень
 * рівня запиту — глобальному чи `org`.
 */
function gate(fn: string, levels: ("global" | "org")[]): string {
  const arms = levels.map((level) =>
    level === "global"
      ? `(${globalRequest(fn)} AND g.level = 'global' AND g.object = 'global_role_assignments')`
      : `(${fn}.p_scope_kind = '${ORG_KIND_ID}'::uuid AND g.level = 'scope' AND g.level_id = '${ORG_KIND_ID}'::uuid AND g.scope = ${fn}.p_scope AND g.object = 'org_role_assignments')`
  )
  return `EXISTS (SELECT 1 FROM simetra.rights_mine() g WHERE g.action = 'administerRights' AND (${arms.join(" OR ")}))`
}

/** Рядки рівня запиту (Р2d2-3): скоуп, контейнер `Project` цього скоупу, глобальні. */
const requestRows = (fn: string, global: string) =>
  `((d.level = 'scope' AND d.level_id = ${fn}.p_scope_kind AND d.scope = ${fn}.p_scope) OR (d.level = 'container' AND CASE d.level_id WHEN '${PROJECT_ID}'::uuid THEN '${ORG_KIND_ID}'::uuid ELSE NULL::uuid END = ${fn}.p_scope_kind AND d.scope = ${fn}.p_scope) OR (${globalRequest(fn)} AND d.level ${global}))`

/** Вихідні колонки функції: ім'я й останнє ім'я типу. */
function tableColumns(unit: SqlUnit): [string, string][] {
  const { parameters } = createOf(unit) as CreateFunction & {
    parameters: {
      FunctionParameter: {
        name: string
        mode: string
        argType: { names: { String: { sval: string } }[] }
      }
    }[]
  }
  return parameters
    .filter((p) => p.FunctionParameter.mode === "FUNC_PARAM_TABLE")
    .map((p) => [
      p.FunctionParameter.name,
      p.FunctionParameter.argType.names.at(-1)!.String.sval,
    ])
}

describe("rights analysis functions", () => {
  let model: CompiledModel
  beforeAll(async () => {
    model = await compiled(withRoles(BASE))
  })

  it("rights_member reads only a member of the requested scope, behind the gate", () => {
    // Р2d2-4: учасник — рядок членства виду й скоупу запиту з `id =
    // p_member`; глобальний запит — `p_member` і є користувач. Рядки прав —
    // лише рівня запиту.
    const fn = F.member.name
    expect(bodyTree(functionUnit(model, fn))).toEqual(
      tree(
        `SELECT DISTINCT d.object, d.action, d.extent, d.dimension_id, d.container, d.role_id, d.custom_role, d.via FROM (SELECT m.id AS member, m.user_id AS user_id FROM public.org_member m WHERE ${fn}.p_scope_kind = '${ORG_KIND_ID}'::uuid AND m.org_id = ${fn}.p_scope AND m.id = ${fn}.p_member AND m.user_id IS NOT NULL UNION ALL SELECT ${fn}.p_member AS member, ${fn}.p_member AS user_id WHERE ${globalRequest(fn)}) u CROSS JOIN LATERAL simetra.rights_detail_of(u.user_id) d WHERE ${gate(fn, ["global", "org"])} AND ${requestRows(fn, "IN ('global', 'everyUser')")}`
      )
    )
    expect(tableColumns(functionUnit(model, fn))).toEqual([
      ["object", "text"],
      ["action", "text"],
      ["extent", "text"],
      ["dimension_id", "uuid"],
      ["container", "uuid"],
      ["role_id", "uuid"],
      ["custom_role", "uuid"],
      ["via", "text"],
    ])
  })

  it("rights_who lists the members of the requested scope and the global owners, behind the gate", () => {
    // Р2d2-5: глобальний запит — власники глобальних призначень і рядок ролі
    // «кожного користувача» без користувача й учасника.
    const fn = F.who.name
    const right = `${fn}.p_object`
    const action = `${fn}.p_action`
    const g = gate(fn, ["global", "org"])
    expect(bodyTree(functionUnit(model, fn))).toEqual(
      tree(
        `SELECT u.user_id, u.member, d.role_id, d.custom_role, d.extent, d.dimension_id, d.container FROM (SELECT m.id AS member, m.user_id AS user_id FROM public.org_member m WHERE ${fn}.p_scope_kind = '${ORG_KIND_ID}'::uuid AND m.org_id = ${fn}.p_scope AND m.user_id IS NOT NULL UNION SELECT NULL::uuid AS member, a.subject AS user_id FROM public.global_role_assignments a WHERE ${globalRequest(fn)} AND a.subject IS NOT NULL) u CROSS JOIN LATERAL simetra.rights_detail_of(u.user_id) d WHERE ${g} AND d.object = ${right} AND d.action = ${action} AND ${requestRows(fn, "= 'global'")} UNION SELECT NULL::uuid, NULL::uuid, r.role_id, NULL::uuid, p.extent, p.dimension_id, NULL::uuid FROM simetra.rights_roles() r JOIN simetra.rights_projection() p ON p.role_id = r.role_id WHERE r.level = 'everyUser' AND ${globalRequest(fn)} AND p.object = ${right} AND p.action = ${action} AND ${g}`
      )
    )
    expect(tableColumns(functionUnit(model, fn))).toEqual([
      ["user_id", "uuid"],
      ["member", "uuid"],
      ["role_id", "uuid"],
      ["custom_role", "uuid"],
      ["extent", "text"],
      ["dimension_id", "uuid"],
      ["container", "uuid"],
    ])
  })

  it("rights_journal_of reads the journal of the scope kind and scope pair, newest first, bounded", () => {
    // Р2d2-7: пара (вид, скоуп), а не лише скоуп; від'ємний ліміт — порожньо.
    const fn = F.journalOf.name
    const columns =
      "id, seq, xid, at, scope_kind_id, scope, actor, reason, action, object, relation, operation, row_id, parent_id, before, after"
    expect(bodyTree(functionUnit(model, fn))).toEqual(
      tree(
        `SELECT ${columns
          .split(", ")
          .map((c) => `j.${c}`)
          .join(
            ", "
          )} FROM simetra.rights_journal j WHERE ${gate(fn, ["global", "org"])} AND j.scope_kind_id = ${fn}.p_scope_kind AND j.scope = ${fn}.p_scope ORDER BY j.at DESC, j.seq DESC LIMIT greatest(0, least(${fn}.p_limit, 1000))`
      )
    )
    expect(tableColumns(functionUnit(model, fn)).map(([c]) => c)).toEqual(
      columns.split(", ")
    )
  })

  it("a level covered only by an adopted source has no analysis gate", async () => {
    // Відоме обмеження Р2d2: глобальні призначення дає лише прийняте
    // джерело, довідника призначень глобального рівня немає — гейт лише
    // `org`. Власники глобальних призначень — з рядків джерела.
    const adopted = await compiled(adoptedSourcesDomain())
    const fn = F.who.name
    const body = bodyTree(functionUnit(adopted, fn))
    expect(
      nodes(body, "SubLink").filter((link) =>
        sameTree({ SubLink: link }, exprTree(gate(fn, ["org"])))
      )
    ).toHaveLength(2)
    const candidates = unionArms(
      (nodes(body, "RangeSubselect")[0] as { subquery: unknown }).subquery
    )
    expect(candidates).toEqual(
      [
        `SELECT s.id AS member, s.user_id AS user_id FROM public.membership s WHERE ${fn}.p_scope_kind = '${ORG_KIND_ID}'::uuid AND s.org_id = ${fn}.p_scope AND s.user_id IS NOT NULL AND s.is_active IS TRUE`,
        `SELECT NULL::uuid AS member, src.member_id AS user_id FROM public.global_grant src WHERE ${globalRequest(fn)} AND src.member_id IS NOT NULL`,
      ].map((sql) => selectOf(tree(sql)))
    )
  })

  /** Гілки підзапиту кандидатів (`FROM (…) u`) функції аналізу. */
  const candidatesOf = (body: unknown) =>
    unionArms(
      (nodes(body, "RangeSubselect")[0] as { subquery: unknown }).subquery
    )

  it("an adopted membership source narrows the members of the requested scope by its where", async () => {
    // Р2d2-4, Р2d1-15: рядок іншого рівня поліморфної таблиці членства не
    // стає учасником скоупу запиту — ті самі умови, що в «моїх скоупах».
    const narrowed = await compiled(
      adoptedSourcesDomain({
        [PROJECT_FILE]: {
          membershipSources: [
            membersSource({
              where: [
                { column: "userId", isNull: false },
                { column: "isActive", equals: true },
              ],
            }),
          ],
        },
      })
    )
    const arm = (fn: string, member: string) =>
      selectOf(
        tree(
          `SELECT s.id AS member, s.user_id AS user_id FROM public.membership s WHERE ${fn}.p_scope_kind = '${ORG_KIND_ID}'::uuid AND s.org_id = ${fn}.p_scope${member} AND s.user_id IS NOT NULL AND s.is_active IS TRUE AND s.user_id IS NOT NULL AND s.is_active = TRUE`
        )
      )
    const member = F.member.name
    expect(candidatesOf(bodyTree(functionUnit(narrowed, member)))[0]).toEqual(
      arm(member, ` AND s.id = ${member}.p_member`)
    )
    expect(
      candidatesOf(bodyTree(functionUnit(narrowed, F.who.name)))[0]
    ).toEqual(arm(F.who.name, ""))
  })

  it("the global request sees the rows of a container without a scope kind, a scope request does not", async () => {
    // Призначення контейнера без виду скоупу лежать на глобальному рівні
    // (Р2a1-7): їх показує глобальний запит під глобальним гейтом, а рядок
    // скоупу їх не покриває. Власники — і з глобального довідника.
    const single = await compiled(singleTenantRights())
    const rows = (fn: string, levels: string) =>
      exprTree(
        `((d.level = 'scope' AND d.level_id = ${fn}.p_scope_kind AND d.scope = ${fn}.p_scope) OR (${globalRequest(fn)} AND (d.level ${levels} OR (d.level = 'container' AND d.level_id IN ('${PROJECT_ID}'::uuid)))))`
      )
    const contains = (root: unknown, sub: unknown): boolean =>
      sameTree(root, sub) ||
      (typeof root === "object" &&
        root !== null &&
        Object.values(root).some((child) => contains(child, sub)))
    const member = bodyTree(functionUnit(single, F.member.name))
    expect(
      contains(member, rows(F.member.name, "IN ('global', 'everyUser')"))
    ).toBe(true)
    const who = bodyTree(functionUnit(single, F.who.name))
    expect(contains(who, rows(F.who.name, "= 'global'"))).toBe(true)
    expect(candidatesOf(who)).toEqual([
      selectOf(
        tree(
          `SELECT NULL::uuid AS member, a.subject AS user_id FROM public.global_role_assignments a WHERE ${globalRequest(F.who.name)} AND a.subject IS NOT NULL`
        )
      ),
    ])
  })
})
