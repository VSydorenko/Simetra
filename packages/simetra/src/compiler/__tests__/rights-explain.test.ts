import { beforeAll, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import { PLATFORM_ROLES, PROVIDER_API_ROLES } from "simetra/model"
import { compareStrings } from "../diagnostics"
import { buildExplainUnits } from "../rights/explain-units"
import { RIGHTS_FUNCTIONS } from "../rights/functions"
import { hasEmptySearchPath, routineLanguage } from "../sql/closed-forms"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { withoutLocations, type SqlUnit } from "../sql/units"
import {
  BULLETIN_TABLE,
  HOURS_TABLES,
  ORG_KIND_ID,
  PROJECT_FILE,
  REGION_DIMENSION_ID,
  TASK_FILE,
  adoptedSourcesDomain,
  compiledPolicyDomain,
  globalConstant,
  policyDomain,
  regionDimension,
  writeRoles,
} from "./fixtures/rights"

const F = RIGHTS_FUNCTIONS
const FN = F.explain.name
const P = (name: string) => `${FN}.${name}`
const ZERO = "00000000-0000-0000-0000-000000000000"
const CURRENT = "(SELECT simetra.current_user_id())"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

function compiled(result: Awaited<ReturnType<typeof compile>>): CompiledModel {
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

const explainUnits = (model: CompiledModel) =>
  model.sqlUnits.filter((u) => u.generator === "rightsExplain")

function explainFunction(model: CompiledModel): SqlUnit {
  const found = explainUnits(model).filter((u) => u.class === "function")
  expect(found).toHaveLength(1)
  return found[0]!
}

interface Select {
  op?: string
  larg?: Select
  rarg?: Select
  targetList?: { ResTarget: { name?: string; val: unknown } }[]
  fromClause?: unknown[]
  whereClause?: unknown
}

const selectOf = (node: unknown): Select =>
  (node as { SelectStmt?: Select }).SelectStmt ?? (node as Select)

/** Гілки `UNION ALL` запиту зліва направо. */
function unionArms(node: unknown): Select[] {
  const select = selectOf(node)
  if (select.op === undefined || select.op === "SETOP_NONE") return [select]
  return [...unionArms(select.larg), ...unionArms(select.rarg)]
}

function tree(sql: string): unknown {
  const parsed = parse(sql)
  if (!parsed.ok) throw new Error(`expected SQL does not parse: ${sql}`)
  expect(parsed.statements).toHaveLength(1)
  return withoutLocations(parsed.statements[0]!.stmt)
}

const exprTree = (sql: string): unknown =>
  selectOf(tree(`SELECT ${sql}`)).targetList![0]!.ResTarget.val

/** Дерево тіла функції без позицій. */
function bodyTree(unit: SqlUnit): unknown {
  const create = (
    unit.tree as {
      CreateFunctionStmt: {
        options: {
          DefElem: {
            defname: string
            arg: { List?: { items: { String: { sval: string } }[] } }
          }
        }[]
      }
    }
  ).CreateFunctionStmt
  const body = create.options.find((o) => o.DefElem.defname === "as")!.DefElem
    .arg.List!.items[0]!.String.sval
  return tree(body)
}

/** Кон'юнкти умови `WHERE`. */
function conjuncts(where: unknown): unknown[] {
  const bool = (where as { BoolExpr?: { boolop: string; args: unknown[] } })
    .BoolExpr
  return bool?.boolop === "AND_EXPR" ? bool.args : [where]
}

/** Гілка об'єкта з міткою `label` — за першим кон'юнктом її `WHERE`. */
function branchOf(model: CompiledModel, label: string): Select | undefined {
  const label_ = exprTree(`${P("p_object")} = '${label}'`)
  const found = unionArms(bodyTree(explainFunction(model))).filter(
    (arm) =>
      JSON.stringify(conjuncts(arm.whereClause)[0]) === JSON.stringify(label_)
  )
  expect(found.length).toBeLessThanOrEqual(1)
  return found[0]
}

/** Мітки об'єктів, для яких тіло має гілку. */
const branchLabels = (model: CompiledModel) =>
  unionArms(bodyTree(explainFunction(model))).map((arm) => {
    const first = conjuncts(arm.whereClause)[0] as {
      A_Expr: { rexpr: { A_Const: { sval: { sval: string } } } }
    }
    return first.A_Expr.rexpr.A_Const.sval.sval
  })

/** Таблиця гілки — `FROM <таблиця> r`. */
const tableOf = (branch: Select) =>
  (
    branch.fromClause![0] as {
      JoinExpr: { larg: { RangeVar: { relname: string } } }
    }
  ).JoinExpr.larg.RangeVar.relname

/**
 * Вираз рядка пояснення для викликача: `p_user` → поточний користувач,
 * права `granted` → `caller_granted`. Підстановка — на дереві.
 */
function asCaller(node: unknown): unknown {
  const userRef = JSON.stringify(exprTree(P("p_user")))
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk)
    if (typeof value !== "object" || value === null) return value
    if (JSON.stringify(value) === userRef) return exprTree(CURRENT)
    const node = value as Record<string, unknown>
    if (node.relname === "granted")
      return { ...node, relname: "caller_granted" }
    return Object.fromEntries(
      Object.entries(node).map(([key, child]) => [key, walk(child)])
    )
  }
  return walk(node)
}

interface Row {
  policy: string
  kind: string
  extent: string | null
  hasRight: unknown
  carrierMatch: unknown
  roles: unknown
}

/** Стала цілі: `'x'::text` чи `NULL::text`. */
function constant(node: unknown): string | null {
  const cast = (node as { TypeCast?: { arg: unknown } }).TypeCast
  if (cast !== undefined) return constant(cast.arg)
  const value = (
    node as { A_Const: { isnull?: boolean; sval?: { sval: string } } }
  ).A_Const
  return value.isnull === true ? null : value.sval!.sval
}

/** Рядки пояснення гілки — гілки підзапиту `CROSS JOIN LATERAL (…) e`. */
function rowsOf(branch: Select): Row[] {
  // Гілка повертає лише колонки рядків пояснення, а не колонки рядка об'єкта.
  expect(branch.targetList).toEqual(
    selectOf(
      tree(
        "SELECT e.policy, e.kind, e.extent, e.has_right, e.carrier_match, e.roles"
      )
    ).targetList
  )
  const join = (branch.fromClause![0] as { JoinExpr: { rarg: unknown } })
    .JoinExpr
  const lateral = (
    join.rarg as { RangeSubselect: { lateral: boolean; subquery: unknown } }
  ).RangeSubselect
  expect(lateral.lateral).toBe(true)
  return unionArms(lateral.subquery).map((arm) => {
    const value = (name: string) =>
      arm.targetList!.find((t) => t.ResTarget.name === name)!.ResTarget.val
    expect(arm.targetList!.map((t) => t.ResTarget.name)).toEqual([
      "policy",
      "kind",
      "extent",
      "has_right",
      "carrier_match",
      "roles",
    ])
    return {
      policy: constant(value("policy"))!,
      kind: constant(value("kind"))!,
      extent: constant(value("extent")),
      hasRight: value("has_right"),
      carrierMatch: value("carrier_match"),
      roles: value("roles"),
    }
  })
}

function rowNamed(rows: Row[], policy: string): Row {
  const found = rows.filter((r) => r.policy === policy)
  expect(found).toHaveLength(1)
  return found[0]!
}

/**
 * Політики `SELECT` таблиці, які застосовуються до ролі запиту користувача:
 * (ім'я, `permissive`/`restrictive`) — те, що пояснення мусить назвати.
 */
function selectPolicies(model: CompiledModel, table: string): string[][] {
  const user = PROVIDER_API_ROLES.supabase.user
  return model.sqlUnits
    .filter((u) => u.generator === "access" && u.class === "policy")
    .map(
      (u) =>
        (
          u.tree as {
            CreatePolicyStmt: {
              policy_name: string
              table: { relname: string }
              cmd_name: string
              permissive?: boolean
              roles: { RoleSpec: { rolename?: string } }[]
            }
          }
        ).CreatePolicyStmt
    )
    .filter(
      (p) =>
        p.table.relname === table &&
        p.cmd_name === "select" &&
        p.roles.some((r) => r.RoleSpec.rolename === user)
    )
    .map((p) => [
      p.policy_name,
      p.permissive === true ? "permissive" : "restrictive",
    ])
    .sort((a, b) => compareStrings(a.join(), b.join()))
}

const explained = (rows: Row[]) =>
  rows
    .map((r) => [r.policy, r.kind])
    .sort((a, b) => compareStrings(a.join(), b.join()))

/** Права `p_user` у формі предиката: той самий фільтр у `has_right` і `roles`. */
const granted = (filter: string) => ({
  hasRight: exprTree(`EXISTS (SELECT 1 FROM granted g WHERE ${filter})`),
  roles: exprTree(
    `ARRAY(SELECT DISTINCT x.role FROM granted g CROSS JOIN LATERAL (VALUES (g.role_id), (g.custom_role)) AS x(role) WHERE ${filter} AND x.role IS NOT NULL ORDER BY x.role)`
  ),
})

const right = (label: string, extent: string, dimension = "NULL") =>
  `g.object = '${label}' AND g.action = 'read' AND g.extent = '${extent}' AND g.dimension_id IS NOT DISTINCT FROM ${dimension}`

/** Значення колонки рядка ∈ множини `set` — строго TRUE чи FALSE. */
const member = (set: string, column: string) =>
  `EXISTS (SELECT 1 FROM ${set} AS v(value) WHERE v.value = r.${column})`

const REGION = `'${REGION_DIMENSION_ID}'::uuid`
const NO_ROLES_SQL = "'{}'::uuid[]"

let NO_ROLES: unknown
let TRUE: unknown
beforeAll(() => {
  NO_ROLES = exprTree(NO_ROLES_SQL)
  TRUE = exprTree("TRUE")
})

describe("rights_explain", () => {
  let model: CompiledModel
  beforeAll(async () => {
    model = compiled(await compile(policyDomain()))
  })

  it("is an analysis function: definer, sql, executed by the user and command roles", () => {
    const unit = explainFunction(model)
    expect(unit.identity).toBe(
      "function:simetra.rights_explain(text,uuid,uuid)"
    )
    expect(routineLanguage(unit.tree as never)).toBe("sql")
    expect(hasEmptySearchPath(unit.tree as never)).toBe(true)
    expect(unit.sql).toContain("STABLE SECURITY DEFINER")
    expect(unit.sql).toContain(
      "RETURNS TABLE (policy text, kind text, extent text, has_right boolean, carrier_match boolean, roles uuid[])"
    )
    const grants = explainUnits(model)
      .filter((u) => u.class !== "function")
      .map((u) => u.sql)
      .sort()
    const target = "FUNCTION simetra.rights_explain(text, uuid, uuid)"
    expect(grants).toEqual(
      [
        `REVOKE EXECUTE ON ${target} FROM PUBLIC;`,
        `REVOKE EXECUTE ON ${target} FROM ${PROVIDER_API_ROLES.supabase.anonymous};`,
        `REVOKE EXECUTE ON ${target} FROM ${PROVIDER_API_ROLES.supabase.service};`,
        `GRANT EXECUTE ON ${target} TO ${PROVIDER_API_ROLES.supabase.user};`,
        `GRANT EXECUTE ON ${target} TO ${PLATFORM_ROLES.command};`,
      ].sort()
    )
  })

  it("names every read policy of each explained object's main table, and only them", () => {
    // Р2d2-6: рядок на кожен предикат читання й рядок межі — рівно політики
    // `SELECT` основної таблиці, що діють на роль запиту користувача.
    const labels = branchLabels(model)
    expect(labels).toContain("task")
    expect(labels).toContain("users")
    for (const label of labels) {
      const branch = branchOf(model, label)!
      expect(explained(rowsOf(branch)), label).toEqual(
        selectPolicies(model, tableOf(branch))
      )
    }
  })

  it("a public read object without a rights contract gets its public_read branch", async () => {
    // Р2d2-6: політику `<t>_public_read` `buildAccessUnits` ставить і без
    // контракту прав — її рядок видно кожному, тож і пояснення є. Кожен вид
    // з RLS нині має обсяги прав, тож об'єкт без контракту — ті самі
    // контракти домену без контракту прав `Bulletin`.
    const domain = compiled(await compile(policyDomain(writeRoles())))
    const bulletin = domain.contracts.rights.find(
      (c) => c.kindLabel === BULLETIN_TABLE
    )!
    const units = buildExplainUnits(
      {
        ...domain.contracts,
        rights: domain.contracts.rights.filter((c) => c !== bulletin),
        access: domain.contracts.access.map((a) =>
          a.objectId === bulletin.objectId ? { ...a, rights: undefined } : a
        ),
        kindLabels: new Map(
          domain.contracts.rights.map((c) => [c.objectId, c.kindLabel])
        ),
      },
      domain.physical,
      "supabase",
      domain.project.name,
      parse
    )
    const written = { ...domain, sqlUnits: units }
    const branch = branchOf(written, BULLETIN_TABLE)!
    expect(rowsOf(branch)).toEqual([
      {
        policy: `${BULLETIN_TABLE}_public_read`,
        kind: "permissive",
        extent: null,
        hasRight: TRUE,
        carrierMatch: TRUE,
        roles: NO_ROLES,
      },
    ])
    expect(explained(rowsOf(branch))).toEqual(
      selectPolicies(domain, BULLETIN_TABLE)
    )
    // Гейт лишається (довідник скоуплений — гейт `org` зі скоупом рядка),
    // перевірки членства `p_user` немає; видимість викликачу — `TRUE`.
    expect(conjuncts(branch.whereClause)).toEqual(
      [
        `${P("p_object")} = '${BULLETIN_TABLE}'`,
        `r.id = ${P("p_row")}`,
        `EXISTS (SELECT 1 FROM simetra.rights_mine() g WHERE g.action = 'administerRights' AND (('${ORG_KIND_ID}'::uuid = '${ZERO}'::uuid AND r.org_id = '${ZERO}'::uuid AND g.level = 'global' AND g.object = 'global_role_assignments') OR ('${ORG_KIND_ID}'::uuid = '${ORG_KIND_ID}'::uuid AND g.level = 'scope' AND g.level_id = '${ORG_KIND_ID}'::uuid AND g.scope = r.org_id AND g.object = 'org_role_assignments')))`,
        "(TRUE AND TRUE)",
      ].map(exprTree)
    )
  })

  it("explains only a row the caller sees: the same rows for the current user under the RLS rule", () => {
    // Р2d2-19: та сама побудова рядків, але для `current_user_id()` і його
    // прав (`caller_granted`) — RESTRICTIVE через AND, PERMISSIVE через OR.
    const branch = branchOf(model, "task")!
    const caller = rowsOf(branch).map((r) => ({
      ...r,
      hasRight: asCaller(r.hasRight),
      carrierMatch: asCaller(r.carrierMatch),
    }))
    // `WHERE` складає кон'юнкти через AND, тож межі викликача — окремі
    // кон'юнкти після членства `p_user`, далі OR предикатів.
    const visibility = conjuncts(branch.whereClause).slice(4)
    expect(visibility).toEqual([
      ...caller
        .filter((r) => r.kind === "restrictive")
        .map((r) => r.carrierMatch),
      {
        BoolExpr: {
          boolop: "OR_EXPR",
          args: caller
            .filter((r) => r.kind === "permissive")
            .map((r) => ({
              BoolExpr: {
                boolop: "AND_EXPR",
                args: [r.hasRight, r.carrierMatch],
              },
            })),
        },
      },
    ])
    const text = JSON.stringify(visibility)
    expect(text).not.toContain('"p_user"')
    expect(text).toContain('"current_user_id"')
  })

  it("the task branch: gate of the row's scope, p_user a member of it, the row by key", () => {
    // Р2d2-3: гейт — вид скоупу об'єкта й скоуп рядка; Р2d2-6: `p_user`
    // мусить належати скоупу рядка, інакше порожньо.
    expect(conjuncts(branchOf(model, "task")!.whereClause).slice(0, 4)).toEqual(
      [
        `${P("p_object")} = 'task'`,
        `r.id = ${P("p_row")}`,
        `EXISTS (SELECT 1 FROM simetra.rights_mine() g WHERE g.action = 'administerRights' AND (('${ORG_KIND_ID}'::uuid = '${ZERO}'::uuid AND r.org_id = '${ZERO}'::uuid AND g.level = 'global' AND g.object = 'global_role_assignments') OR ('${ORG_KIND_ID}'::uuid = '${ORG_KIND_ID}'::uuid AND g.level = 'scope' AND g.level_id = '${ORG_KIND_ID}'::uuid AND g.scope = r.org_id AND g.object = 'org_role_assignments')))`,
        `EXISTS (SELECT 1 FROM simetra.rights_scopes_of(${P("p_user")}) s WHERE s.scope_kind_id = '${ORG_KIND_ID}'::uuid AND s.scope = r.org_id)`,
      ].map(exprTree)
    )
  })

  it("the task rows: has_right by the extent form, carrier_match from the _of sets", () => {
    const rows = rowsOf(branchOf(model, "task")!)
    const boundary = rowNamed(rows, "task_scope_read")
    expect(boundary).toEqual({
      policy: "task_scope_read",
      kind: "restrictive",
      extent: null,
      hasRight: TRUE,
      carrierMatch: exprTree(
        member(
          `simetra.rights_scope_set_of(${P("p_user")}, '${ORG_KIND_ID}'::uuid)`,
          "org_id"
        )
      ),
      roles: NO_ROLES,
    })
    const scope = "g.level = 'scope' AND g.scope = r.org_id"
    const container = "g.level = 'container' AND g.container = r.project_id"
    const own = exprTree(
      member(
        `simetra.rights_members_of(${P("p_user")}, '${ORG_KIND_ID}'::uuid)`,
        "assignee_id"
      )
    )
    const region = exprTree(
      member(
        `simetra.rights_dimension_values_of(${P("p_user")}, ${REGION})`,
        "region_id"
      )
    )
    const expected: [string, string, string, unknown][] = [
      ["task_read_any", "any", `${scope} AND ${right("task", "any")}`, TRUE],
      ["task_read_own", "own", `${scope} AND ${right("task", "own")}`, own],
      [
        "task_read_region",
        "dimension",
        `${scope} AND ${right("task", "dimension", REGION)}`,
        region,
      ],
      [
        "task_read_in_project_any",
        "any",
        `${container} AND ${right("task", "any")}`,
        TRUE,
      ],
      [
        "task_read_in_project_own",
        "own",
        `${container} AND ${right("task", "own")}`,
        own,
      ],
      [
        "task_read_in_project_region",
        "dimension",
        `${container} AND ${right("task", "dimension", REGION)}`,
        region,
      ],
    ]
    for (const [policy, extent, filter, carrier] of expected) {
      expect(rowNamed(rows, policy), policy).toEqual({
        policy,
        kind: "permissive",
        extent,
        ...granted(filter),
        carrierMatch: carrier,
      })
    }
  })

  it("the users branch: global gate, visible users boundary, unscoped has_right", () => {
    const users = model.contracts.users!
    const key = users.keyColumn
    const branch = branchOf(model, "users")!
    expect(conjuncts(branch.whereClause).slice(0, 3)).toEqual(
      [
        `${P("p_object")} = 'users'`,
        `r.${key} = ${P("p_row")}`,
        `EXISTS (SELECT 1 FROM simetra.rights_mine() g WHERE g.action = 'administerRights' AND (('${ZERO}'::uuid = '${ZERO}'::uuid AND '${ZERO}'::uuid = '${ZERO}'::uuid AND g.level = 'global' AND g.object = 'global_role_assignments') OR ('${ZERO}'::uuid = '${ORG_KIND_ID}'::uuid AND g.level = 'scope' AND g.level_id = '${ORG_KIND_ID}'::uuid AND g.scope = '${ZERO}'::uuid AND g.object = 'org_role_assignments')))`,
      ].map(exprTree)
    )
    const rows = rowsOf(branch)
    expect(rowNamed(rows, "users_scope_read")).toEqual({
      policy: "users_scope_read",
      kind: "restrictive",
      extent: null,
      hasRight: TRUE,
      carrierMatch: exprTree(
        member(`simetra.rights_visible_users_of(${P("p_user")})`, key)
      ),
      roles: NO_ROLES,
    })
    // Носій на «Користувачів» — сам `p_user`, лише дійсний (як
    // `current_user_id()`); недійсний — FALSE, а не NULL.
    expect(rowNamed(rows, "users_read_own")).toEqual({
      policy: "users_read_own",
      kind: "permissive",
      extent: "own",
      ...granted(`g.level <> 'container' AND ${right("users", "own")}`),
      carrierMatch: exprTree(
        `COALESCE(r.${key} = (SELECT u.${key} FROM public.${users.table.name} u WHERE u.${key} = ${P("p_user")} AND NOT u.${users.invalidColumn}), FALSE)`
      ),
    })
  })

  it("a verbatim dimension function is known only for the current user", async () => {
    // Р2d2-6: множина дослівної функції для іншого користувача невідома —
    // NULL; для себе — та сама функція, що в політиці.
    const verbatim = compiled(
      await compiledPolicyDomain(
        {
          "sql/public/region-ids.sql":
            "CREATE FUNCTION public.region_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT r.id FROM public.region r $$;",
        },
        [
          {
            [PROJECT_FILE]: {
              accessDimensions: [
                {
                  ...regionDimension(),
                  values: { function: { name: "region_ids" } },
                },
              ],
            },
          },
        ]
      )
    )
    expect(
      rowNamed(rowsOf(branchOf(verbatim, "task")!), "task_read_region")
        .carrierMatch
    ).toEqual(
      exprTree(
        `CASE WHEN ${P("p_user")} = ${CURRENT} THEN ${member(`simetra.rights_dimension_values(${REGION})`, "region_id")} ELSE NULL END`
      )
    )
  })

  it("a verbatim scope set function is known only for the current user", async () => {
    const adopted = compiled(await compile(adoptedSourcesDomain()))
    const set = adopted.contracts.access.find((a) => a.table.name === "task")!
      .scope!.setFunction
    expect(
      rowNamed(rowsOf(branchOf(adopted, "task")!), "task_scope_read")
        .carrierMatch
    ).toEqual(
      exprTree(
        `CASE WHEN ${P("p_user")} = ${CURRENT} THEN ${member(`${set.schema}.${set.name}()`, "org_id")} ELSE NULL END`
      )
    )
  })

  it("a public read object: one public_read row, no boundary, no membership check of p_user", async () => {
    // Р2d2-6: рядок `publicRead` видно кожному, тож пояснення фактів
    // `p_user` не розкриває; гейт лишається.
    const open = compiled(
      await compile(
        policyDomain({ [TASK_FILE]: { publicRead: "authenticated" } })
      )
    )
    const branch = branchOf(open, "task")!
    expect(rowsOf(branch)).toEqual([
      {
        policy: "task_public_read",
        kind: "permissive",
        extent: null,
        hasRight: TRUE,
        carrierMatch: TRUE,
        roles: NO_ROLES,
      },
    ])
    const where = conjuncts(branch.whereClause)
    expect(where).toHaveLength(4)
    expect(where[3]).toEqual(exprTree("(TRUE AND TRUE)"))
    expect(JSON.stringify(where)).not.toContain("rights_scopes_of")
  })

  it("registers and constants have no branch", async () => {
    // Без одноколонкового uuid-ключа рядок не названо одним `p_row`.
    expect(branchOf(model, HOURS_TABLES.movements)).toBeUndefined()
    const withConstant = compiled(await compile(policyDomain(globalConstant())))
    const constants = withConstant.contracts.rights.filter(
      (c) => !model.contracts.rights.some((m) => m.objectId === c.objectId)
    )
    expect(constants.length).toBeGreaterThan(0)
    for (const c of constants) {
      expect(branchOf(withConstant, c.kindLabel), c.kindLabel).toBeUndefined()
    }
  })
})
