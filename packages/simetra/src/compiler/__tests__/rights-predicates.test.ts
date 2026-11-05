import { beforeAll, describe, expect, it } from "vitest"
import type { CompiledModel } from "simetra/compiler"
import { compile } from "simetra/compiler"
import { mainTableOf, type ProjectionExtent } from "../contracts"
import {
  COMMAND_ACTION,
  renderCondition,
  rightsPredicates,
  type PredicateDml,
  type RightsCondition,
  type RightsPredicate,
} from "../rights/predicates"
import { loadSqlParser, type SqlParser } from "../sql/parse"
import { kitchenSink } from "./fixtures/kitchen-sink"
import {
  ANNOUNCEMENT_FILE,
  COMMENT_FILE,
  ANNOUNCEMENT_ID,
  ORG_KIND_ID,
  PROJECT_FILE,
  PROJECT_ID,
  REGION_DIMENSION_ID,
  TASK_FILE,
  TASK_ID,
  policyDomain,
  regionDimension,
  rootCreationDomain,
  singleTenantRights,
  unscopedDimension,
  withRoles,
} from "./fixtures/rights"
import { uuid } from "./helpers"

const COMMENT_ID = uuid(6050)
const DMLS: readonly PredicateDml[] = ["select", "insert", "update", "delete"]

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

/** `Task` з усіма формами носіїв: учасник і «Користувачі», вимір, контейнер. */
const allCarriers = () =>
  withRoles({
    [PROJECT_FILE]: { accessDimensions: [regionDimension()] },
    [TASK_FILE]: {
      ownership: ["assignee", "createdBy"],
      access: [{ attribute: "region", dimension: "region" }],
      containerBinding: "project",
    },
  })

/**
 * `TaskComment` з носіями лише через шлях `task`: власність, вимір і
 * прив'язка до контейнера.
 */
const viaCarriers = () =>
  withRoles({
    [PROJECT_FILE]: { accessDimensions: [regionDimension()] },
    [TASK_FILE]: { containerBinding: "project" },
    [COMMENT_FILE]: {
      ownership: [["task", "assignee"]],
      access: [{ ref: ["task", "region"], dimension: "region" }],
      containerBinding: ["task", "project"],
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
  action: string | typeof COMMAND_ACTION,
  dml: PredicateDml = "select"
): RightsPredicate[] {
  const contract = model.contracts.rights.find((c) => c.objectId === objectId)!
  const main = mainTableOf(model.physical, objectId)!
  return rightsPredicates(contract, action, main, main, dml)
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
  // Модель на кейс, а не п'ять компіляцій в одному `it`: під паралельним
  // навантаженням `pnpm test` один кейс інакше впирався в таймаут. Кожна
  // модель — з очікуваними формами таблиць, тож випадна форма не ховається
  // за іншою моделлю.
  it.each<[string, () => Map<string, string>, string[]]>([
    ["kitchenSink", kitchenSink, ["derived", "main", "path", "section"]],
    ["allCarriers", allCarriers, ["main", "section"]],
    ["singleTenantRights", singleTenantRights, ["main", "section"]],
    ["viaCarriers", viaCarriers, ["main", "path", "section"]],
    [
      "policyDomain",
      () => policyDomain(),
      ["derived", "main", "path", "section"],
    ],
    [
      "rootCreationDomain",
      rootCreationDomain,
      ["derived", "main", "path", "section"],
    ],
  ])(
    "every predicate of %s keeps at most one grant-dependent set (§5.4)",
    async (_name, files, expectedShapes) => {
      // Правило — на кожній таблиці, на яку лягає політика прав: основній,
      // ТЧ (копії носіїв), з носієм шляху (копія шляху) і похідній таблиці
      // регістра.
      const model = await compiled(files())
      let checked = 0
      const shapes = new Set<string>()
      for (const contract of model.contracts.rights) {
        const main = mainTableOf(model.physical, contract.objectId)!
        const tables = model.contracts.access
          .filter((a) => a.rights?.objectId === contract.objectId)
          .map((a) =>
            model.physical.tables.find(
              (t) => t.schema === a.table.schema && t.name === a.table.name
            )!
          )
        for (const table of tables) {
          const names = new Set(table.columns.map((c) => c.name))
          // Дія контексту команди — під тим самим правилом.
          const actions: (string | typeof COMMAND_ACTION)[] = [
            ...contract.actions.map((a) => a.action),
            COMMAND_ACTION,
          ]
          for (const [action, dml] of actions.flatMap((a) =>
            DMLS.map((d) => [a, d] as const)
          )) {
            for (const predicate of rightsPredicates(
              contract,
              action,
              table,
              main,
              dml
            )) {
              shapes.add(
                table.origin.tabularSectionId !== undefined
                  ? "section"
                  : table.origin.part !== undefined
                    ? "derived"
                    : table.columns.some(
                          (c) =>
                            c.name === predicate.carrier &&
                            c.origin.copyOf !== undefined
                        )
                      ? "path"
                      : "main"
              )
              // Рівно одна множина з гранту: без неї предикат відкрив би рядок
              // без жодного права, з двома — декартів добуток (§5.4).
              expect(predicate.conditions.filter(grantDependent)).toHaveLength(
                1
              )
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
      expect([...shapes].sort()).toEqual(expectedShapes)
    }
  )

  it("the command action renders the context action, uncorrelated", async () => {
    // дію бере вираз контексту, а обсяги й носії — спільний набір
    // обсягів об'єкта, тож предикати збігаються з предикатами `update`
    // аж до першого аргументу функцій прав.
    const model = await compiled(policyDomain())
    const command = predicatesOf(model, TASK_ID, COMMAND_ACTION)
    const update = predicatesOf(model, TASK_ID, "update")
    expect(command.map((p) => [p.extent, p.carrier])).toEqual(
      update.map((p) => [p.extent, p.carrier])
    )
    expect(command.length).toBeGreaterThan(1)
    const context = "(SELECT simetra.command_action())"
    command.forEach((predicate, i) => {
      expect(predicate.conditions.map((c) => renderCondition(c))).toEqual(
        update[i]!.conditions.map((condition) =>
          renderCondition(condition).replaceAll("('update', ", `(${context}, `)
        )
      )
    })
    expect(
      command
        .flatMap((p) => p.conditions.map((c) => renderCondition(c)))
        .join(" ")
    ).not.toContain("'update'")
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
    [
      "a dimension of an unscoped object",
      unscopedDimension,
      TASK_ID,
      "read",
      { extent: { dimensionId: REGION_DIMENSION_ID }, carrier: "region_id" },
      [
        `region_id = ANY (ARRAY(SELECT simetra.rights_dimension_values(${dim})))`,
        `(SELECT simetra.has_right('read', 'task', 'dimension', ${dim}))`,
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
    expect(found[0]!.conditions.map((c) => renderCondition(c))).toEqual(
      expected
    )
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

  // Носій шляху дає предикат на своїй копії в основній таблиці — власність,
  // вимір і прив'язка до контейнера.
  it("a via carrier gives its predicate on the path copy", async () => {
    const model = await compiled(viaCarriers())
    const comment = model.contracts.rights.find(
      (c) => c.objectId === COMMENT_ID
    )!
    expect(comment.ownership[0]!.via).toBeDefined()
    expect(comment.access[0]!.carrier.via).toBeDefined()
    expect(comment.binding!.carrier.via).toBeDefined()
    expect(comment.actions[0]!.extents.map((e) => e.form)).toEqual([
      "any",
      "own",
      "dimension",
    ])
    const predicates = predicatesOf(model, COMMENT_ID, "read")
    const region = { dimensionId: REGION_DIMENSION_ID }
    const inProject = (inner: ProjectionExtent) => ({
      container: PROJECT_ID,
      inner,
    })
    expect(predicates.map((p) => [p.extent, p.carrier])).toEqual([
      ["any", undefined],
      ["own", "task_id_assignee_id"],
      [region, "task_id_region_id"],
      [inProject("any"), "task_id_project_id"],
      [inProject("own"), "task_id_assignee_id"],
      [inProject(region), "task_id_region_id"],
    ])
    expect(predicates[1]!.conditions.map((c) => renderCondition(c))).toEqual([
      `task_id_assignee_id = ANY (ARRAY(SELECT simetra.rights_my_members('${ORG_KIND_ID}'::uuid)))`,
      "org_id = ANY (ARRAY(SELECT simetra.rights_own('read', 'task_comment')))",
    ])
    expect(predicates[3]!.conditions.map((c) => renderCondition(c))).toEqual([
      "task_id_project_id = ANY (ARRAY(SELECT simetra.rights_container('read', 'task_comment', 'any', NULL)))",
    ])
  })
})

describe("root insert is boolean", () => {
  // Новий корінь ще не має скоупу серед моїх: `INSERT` кореня судить право
  // створення булевою формою (спека прав §5.2, Р-A6-11), а не множиною скоупів.
  let model: CompiledModel
  beforeAll(async () => {
    model = await compiled(rootCreationDomain())
  })

  const of = (
    label: string,
    action: string | typeof COMMAND_ACTION,
    dml: PredicateDml
  ) => {
    const contract = model.contracts.rights.find((c) => c.kindLabel === label)!
    expect(contract.root).toBe(true)
    const main = mainTableOf(model.physical, contract.objectId)!
    return rightsPredicates(contract, action, main, main, dml)
  }
  const hasRight = (label: string, extent: string) => ({
    kind: "boolean",
    expression: `simetra.has_right('create', '${label}', '${extent}', NULL)`,
  })

  // Дія — літерал `'create'` за будь-якої дії виклику: `has_right` рахує й
  // рядки рівня скоупу будь-якого тенанта, тож із `command_action()` вставка
  // під контекстом `update` пройшла б для власника `update` чужого кореня.
  it.each<[string, string, string | typeof COMMAND_ACTION, RightsPredicate[]]>([
    [
      "own by the author only on the self-service root",
      "organization",
      COMMAND_ACTION,
      [
        { extent: "any", conditions: [hasRight("organization", "any")] },
        {
          extent: "own",
          carrier: "created_by_id",
          conditions: [
            { kind: "currentUser", column: "created_by_id" },
            hasRight("organization", "own"),
          ],
        },
      ] as RightsPredicate[],
    ],
    [
      "the core action gives the same predicates",
      "organization",
      "create",
      [
        { extent: "any", conditions: [hasRight("organization", "any")] },
        {
          extent: "own",
          carrier: "created_by_id",
          conditions: [
            { kind: "currentUser", column: "created_by_id" },
            hasRight("organization", "own"),
          ],
        },
      ] as RightsPredicate[],
    ],
    [
      "any on the operator root",
      "branch",
      COMMAND_ACTION,
      [
        { extent: "any", conditions: [hasRight("branch", "any")] },
      ] as RightsPredicate[],
    ],
  ])("%s", (_, label, action, expected) => {
    expect(of(label, action, "insert")).toEqual(expected)
  })

  it.each<PredicateDml>(["update", "delete"])(
    "the root keeps the column form for %s",
    (dml) => {
      const predicates = of("organization", COMMAND_ACTION, dml)
      expect(predicates).toEqual(of("organization", COMMAND_ACTION, "select"))
      // Обсяги кореня — `any` і `own` за обома власниками, кожен на скоупі `id`.
      expect(predicates.map((p) => [p.extent, p.carrier])).toEqual([
        ["any", undefined],
        ["own", "created_by_id"],
        ["own", "owner_id"],
      ])
      for (const predicate of predicates) {
        expect(predicate.conditions.at(-1)).toMatchObject({
          kind: "column",
          column: "id",
          grantDependent: true,
        })
      }
    }
  )

  it("a section of the root keeps the column form for insert", () => {
    const contract = model.contracts.rights.find(
      (c) => c.kindLabel === "organization"
    )!
    const main = mainTableOf(model.physical, contract.objectId)!
    const sites = model.physical.tables.find(
      (t) => t.name === "organization_sites"
    )!
    const predicates = rightsPredicates(
      contract,
      "update",
      sites,
      main,
      "insert"
    )
    expect(predicates).toEqual(
      rightsPredicates(contract, "update", sites, main, "select")
    )
    expect(
      predicates.every((p) =>
        p.conditions.some(
          (c) => c.kind === "column" && c.column === "parent_id"
        )
      )
    ).toBe(true)
  })
})
