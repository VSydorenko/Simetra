import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import { compile } from "simetra/compiler"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import type { RightsContract } from "../contracts"
import { RIGHTS_FUNCTIONS } from "../rights/functions"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { unitCalls, unitRelations } from "../sql/dependencies"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { withoutLocations, type SqlUnit } from "../sql/units"
import { kitchenSink } from "./fixtures/kitchen-sink"
import {
  EVERYONE_ID,
  GLOBAL_ASSIGNMENTS_FILE,
  GLOBAL_ROLES_FILE,
  GRANT_FILE,
  ORG_ADMIN_ID,
  ORG_ASSIGNMENTS_FILE,
  ORG_ROLES_FILE,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_FILE,
  PROJECT_ID,
  PROJECT_LEAD_ID,
  SET_FILE,
  SUPPORT_ID,
  TASK_FILE,
  USERS_FILE,
  adoptedMembership,
  compileRights,
  globalGrantsSource,
  grant,
  grantTable,
  grantsSource,
  membersSource,
  objects,
  rightsFiles,
  singleTenantRights,
  without,
  withRoles,
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

const DATA = [
  RIGHTS_FUNCTIONS.projection,
  RIGHTS_FUNCTIONS.requires,
  RIGHTS_FUNCTIONS.domain,
  RIGHTS_FUNCTIONS.roles,
].map((fn) => fn.name)

const SIGNATURES = [
  "function:simetra.has_right(text,text,text,uuid)",
  "function:simetra.rights_any(text,text)",
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
]

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

  it("renders no rights functions without users, even with roles and an adopted source", async () => {
    // Р2a1-30: `current_user_id` дає лише шар «Користувачів», а прийняте
    // джерело прав до 2d не дає — компіляція чиста, функцій прав немає.
    const result = await compileRights(
      withRoles(
        adoptedMembership(),
        {
          [PROJECT_FILE]: {
            membershipSources: [membersSource()],
            assignmentSources: [grantsSource(), globalGrantsSource()],
          },
          [GRANT_FILE]: grantTable(),
          [TASK_FILE]: { trackAuthor: false },
        },
        without(
          USERS_FILE,
          ORG_ROLES_FILE,
          ORG_ASSIGNMENTS_FILE,
          GLOBAL_ROLES_FILE,
          GLOBAL_ASSIGNMENTS_FILE
        )
      )
    )
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    expect(result.model!.contracts.roles).not.toEqual([])
    expect(rightsUnits(result.model!)).toEqual([])
  })

  it("declares every rights function with its signature, shape and grants", () => {
    expect(functionIdentities(model)).toEqual(SIGNATURES)
    const api = PROVIDER_API_ROLES.supabase
    const setRoles = [api.user, api.service, PLATFORM_ROLES.command].sort()
    const { granted, revoked } = executeGrantees(model)
    for (const unit of rightsUnits(model).filter(
      (u) => u.class === "function"
    )) {
      const data = DATA.includes(unit.name)
      expect(routineLanguage(unit.tree as never), unit.name).toBe("sql")
      expect(hasEmptySearchPath(unit.tree as never), unit.name).toBe(true)
      expect(createOf(unit).sql_body, unit.name).toBeUndefined()
      expect(option(unit, "volatility")?.String?.sval, unit.name).toBe(
        data ? "immutable" : "stable"
      )
      expect(option(unit, "security")?.Boolean?.boolval, unit.name).toBe(
        data ? undefined : true
      )
      expect(granted.get(unit.name) ?? [], unit.name).toEqual(
        data ? [] : setRoles
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

  it("matches the scope kind of a container explicitly", () => {
    // Скоуп без виду нічого не означає (Р2a1-26): контейнер зіставляється з
    // видом довідника призначень, а не лише через рівень зберігання архетипу.
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
    expect(notDistinct).toContainEqual(["k.scope_kind_id", "t.storage_id"])
    expect(notDistinct).toContainEqual(["k.scope", "t.scope"])
  })

  it("renders rights functions for a project without scope kinds", async () => {
    const single = await compiled(singleTenantRights())
    expect(functionIdentities(single)).toEqual(SIGNATURES)
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
    // Членство читає лише `rights_my_scopes` (Р2a1-25).
    const readers = rightsUnits(model)
      .filter((unit) =>
        unitRelations(unit, parse).some(
          (r) => r.schema === "public" && r.name === "org_member"
        )
      )
      .map((unit) => unit.name)
    expect(readers).toEqual([RIGHTS_FUNCTIONS.myScopes.name])
  })
})
