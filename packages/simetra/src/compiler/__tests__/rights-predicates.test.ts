import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import { compile } from "simetra/compiler"
import { mainTableOf, type ProjectionExtent } from "../contracts"
import {
  renderCondition,
  rightsPredicates,
  type RightsCondition,
  type RightsPredicate,
} from "../rights/predicates"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { kitchenSink } from "./fixtures/kitchen-sink"
import {
  ANNOUNCEMENT_FILE,
  ANNOUNCEMENT_ID,
  ORG_KIND_ID,
  PROJECT_FILE,
  PROJECT_ID,
  REGION_DIMENSION_ID,
  TASK_FILE,
  TASK_ID,
  regionDimension,
  singleTenantRights,
  withRoles,
} from "./fixtures/rights"

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

/** `Task` з усіма носіями 1a: учасник і «Користувачі», вимір, контейнер. */
const allCarriers = () =>
  withRoles({
    [PROJECT_FILE]: { accessDimensions: [regionDimension()] },
    [TASK_FILE]: {
      ownership: ["assignee", "createdBy"],
      access: [{ attribute: "region", dimension: "region" }],
      containerBinding: "project",
    },
  })

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

function predicatesOf(
  model: CompiledModel,
  objectId: string,
  action: string
): RightsPredicate[] {
  const contract = model.contracts.rights.find((c) => c.objectId === objectId)!
  return rightsPredicates(
    contract,
    action,
    mainTableOf(model.physical, objectId)!
  )
}

const grantDependent = (condition: RightsCondition) =>
  condition.kind === "boolean" ||
  (condition.kind === "column" && condition.grantDependent)

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

interface SubLink {
  subLinkType: string
  subselect: unknown
}

/** Умова в `WHERE` запиту до таблиці — так її побачить політика. */
function whereOf(table: string, condition: string): Record<string, unknown> {
  const parsed = parse(`SELECT 1 FROM ${table} WHERE ${condition}`)
  if (!parsed.ok) throw new Error(`does not parse: ${condition}`)
  expect(parsed.statements).toHaveLength(1)
  const select = (
    parsed.statements[0]!.stmt as {
      SelectStmt: { whereClause: Record<string, unknown> }
    }
  ).SelectStmt
  return select.whereClause
}

/**
 * Форма відрендереної умови за §5.4: `column` — `<колонка> = ANY
 * (ARRAY(SELECT …))`, `currentUser` — `<колонка> = (SELECT …)`, `boolean` —
 * голий скалярний підзапит. Повертає підзапити умови.
 */
function shapeOf(table: string, condition: RightsCondition): SubLink[] {
  const where = whereOf(table, renderCondition(condition))
  if (condition.kind === "boolean") {
    const link = where.SubLink as SubLink
    expect(link.subLinkType).toBe("EXPR_SUBLINK")
    return [link]
  }
  const expr = where.A_Expr as {
    kind: string
    name: { String: { sval: string } }[]
    lexpr: { ColumnRef: { fields: { String: { sval: string } }[] } }
    rexpr: Record<string, unknown>
  }
  expect(expr.name.map((n) => n.String.sval)).toEqual(["="])
  expect(expr.lexpr.ColumnRef.fields.map((f) => f.String.sval)).toEqual([
    condition.column,
  ])
  if (condition.kind === "column") {
    expect(expr.kind).toBe("AEXPR_OP_ANY")
    const link = expr.rexpr.SubLink as SubLink
    expect(link.subLinkType).toBe("ARRAY_SUBLINK")
    return [link]
  }
  expect(expr.kind).toBe("AEXPR_OP")
  const link = expr.rexpr.SubLink as SubLink
  expect(link.subLinkType).toBe("EXPR_SUBLINK")
  return [link]
}

describe("rights predicates", () => {
  it("every predicate keeps at most one grant-dependent set (§5.4)", async () => {
    const models = [
      await compiled(kitchenSink()),
      await compiled(allCarriers()),
      await compiled(singleTenantRights()),
    ]
    let checked = 0
    for (const model of models) {
      for (const contract of model.contracts.rights) {
        const table = mainTableOf(model.physical, contract.objectId)!
        const names = new Set(table.columns.map((c) => c.name))
        for (const { action } of contract.actions) {
          for (const predicate of rightsPredicates(contract, action, table)) {
            // Рівно одна множина з гранту: без неї предикат відкрив би рядок
            // без жодного права, з двома — декартів добуток (§5.4).
            expect(predicate.conditions.filter(grantDependent)).toHaveLength(1)
            for (const condition of predicate.conditions) {
              if (condition.kind !== "boolean") {
                expect(names).toContain(condition.column)
              }
              for (const link of shapeOf(table.name, condition)) {
                // Некорельованість: підзапит не посилається на рядок таблиці.
                expect(nodes(link.subselect, "ColumnRef")).toEqual([])
              }
              checked++
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0)
  })

  const any = (extent: ProjectionExtent) => ({ extent })
  const scopeAny =
    "org_id = ANY (ARRAY(SELECT simetra.rights_any('read', 'task')))"
  const dim = `'${REGION_DIMENSION_ID}'::uuid`

  it.each<
    [
      string,
      () => Map<string, string>,
      string,
      string,
      Pick<RightsPredicate, "extent" | "carrier">,
      string[],
    ]
  >([
    [
      "any of a scoped object",
      allCarriers,
      TASK_ID,
      "read",
      any("any"),
      [scopeAny],
    ],
    [
      "own on a member carrier",
      allCarriers,
      TASK_ID,
      "update",
      { extent: "own", carrier: "assignee_id" },
      [
        `assignee_id = ANY (ARRAY(SELECT simetra.rights_my_members('${ORG_KIND_ID}'::uuid)))`,
        "org_id = ANY (ARRAY(SELECT simetra.rights_own('update', 'task')))",
      ],
    ],
    [
      "own on a users carrier",
      allCarriers,
      TASK_ID,
      "read",
      { extent: "own", carrier: "created_by_id" },
      [
        "created_by_id = (SELECT simetra.current_user_id())",
        "org_id = ANY (ARRAY(SELECT simetra.rights_own('read', 'task')))",
      ],
    ],
    [
      "a dimension",
      allCarriers,
      TASK_ID,
      "read",
      { extent: { dimensionId: REGION_DIMENSION_ID }, carrier: "region_id" },
      [
        `region_id = ANY (ARRAY(SELECT simetra.rights_dimension_values(${dim})))`,
        `org_id = ANY (ARRAY(SELECT simetra.rights_dim('read', 'task', ${dim})))`,
      ],
    ],
    [
      "any in a container",
      allCarriers,
      TASK_ID,
      "read",
      {
        extent: { container: PROJECT_ID, inner: "any" },
        carrier: "project_id",
      },
      [
        "project_id = ANY (ARRAY(SELECT simetra.rights_container('read', 'task', 'any', NULL)))",
      ],
    ],
    [
      "a dimension in a container",
      allCarriers,
      TASK_ID,
      "read",
      {
        extent: {
          container: PROJECT_ID,
          inner: { dimensionId: REGION_DIMENSION_ID },
        },
        carrier: "region_id",
      },
      [
        `region_id = ANY (ARRAY(SELECT simetra.rights_dimension_values(${dim})))`,
        `project_id = ANY (ARRAY(SELECT simetra.rights_container('read', 'task', 'dimension', ${dim})))`,
      ],
    ],
    [
      "any of an unscoped object",
      withRoles,
      ANNOUNCEMENT_ID,
      "read",
      any("any"),
      ["(SELECT simetra.has_right('read', 'announcement', 'any', NULL))"],
    ],
    [
      "own of an unscoped object",
      () =>
        withRoles({
          [ANNOUNCEMENT_FILE]: {
            trackAuthor: true,
            ownership: ["createdBy"],
          },
        }),
      ANNOUNCEMENT_ID,
      "read",
      { extent: "own", carrier: "created_by_id" },
      [
        "created_by_id = (SELECT simetra.current_user_id())",
        "(SELECT simetra.has_right('read', 'announcement', 'own', NULL))",
      ],
    ],
  ])("%s", async (_, files, objectId, action, selector, expected) => {
    const predicates = predicatesOf(await compiled(files()), objectId, action)
    const found = predicates.filter(
      (p) =>
        JSON.stringify(p.extent) === JSON.stringify(selector.extent) &&
        p.carrier === selector.carrier
    )
    expect(found).toHaveLength(1)
    expect(found[0]!.conditions.map(renderCondition)).toEqual(expected)
  })

  it("gives one predicate per carrier at the scope and in the container", async () => {
    const predicates = predicatesOf(
      await compiled(allCarriers()),
      TASK_ID,
      "read"
    )
    const region = { dimensionId: REGION_DIMENSION_ID }
    const inProject = (inner: ProjectionExtent) => ({
      container: PROJECT_ID,
      inner,
    })
    expect(predicates.map((p) => [p.extent, p.carrier])).toEqual([
      ["any", undefined],
      ["own", "assignee_id"],
      ["own", "created_by_id"],
      [region, "region_id"],
      [inProject("any"), "project_id"],
      [inProject("own"), "assignee_id"],
      [inProject("own"), "created_by_id"],
      [inProject(region), "region_id"],
    ])
  })
})
