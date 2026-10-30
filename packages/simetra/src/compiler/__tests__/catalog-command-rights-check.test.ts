import { beforeAll, describe, expect, it, vi } from "vitest"
import type { CompileResult, CompiledModel } from "simetra/compiler"
import type { PhysicalTable } from "simetra/model"
import { accessPolicyNames, tenantBoundary } from "../access-units"
import {
  rightsCheck,
  rightsCheckPredicates,
} from "../catalog-command/rights-check"
import { mainTableOf, type RightsContract } from "../contracts"
import { loadShapeParsers, tree } from "./fixtures/sql-shape"
import {
  COMMENT_TABLE,
  TASK_ID,
  TICKET_TABLE,
  commandCoreLayer,
  compileRights,
  policyDomain,
  singleTenantRights,
} from "./fixtures/rights"

// Порожній перелік предикатів будівник прав не дає (обсяг `any` є завжди),
// тож fail-closed гілку `rightsCheck` відкриває лише підміна будівника.
const builder = vi.hoisted(() => ({ empty: false }))
vi.mock("../rights/predicates", async (importOriginal) => {
  const original = await importOriginal<typeof import("../rights/predicates")>()
  return {
    ...original,
    rightsPredicates: (
      ...args: Parameters<typeof original.rightsPredicates>
    ) => (builder.empty ? [] : original.rightsPredicates(...args)),
  }
})

async function compiled(
  result: CompileResult | Promise<CompileResult>
): Promise<CompiledModel> {
  const { model, diagnostics } = await result
  expect(diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return model!
}

/** Вираз зі списку вибірки: так розбирається умова поза оператором. */
const expression = (sql: string): unknown =>
  (
    tree(`SELECT ${sql}`) as {
      SelectStmt: { targetList: { ResTarget: { val: unknown } }[] }
    }
  ).SelectStmt.targetList[0]!.ResTarget.val

/** `v_new."col"` → `"col"`: дерево умови ядра стає деревом умови політики. */
function unqualified(value: unknown, row: string): unknown {
  if (Array.isArray(value)) return value.map((v) => unqualified(v, row))
  if (value === null || typeof value !== "object") return value
  const record = value as Record<string, unknown>
  const fields = (record.ColumnRef as { fields?: unknown[] } | undefined)
    ?.fields
  if (
    fields?.length === 2 &&
    (fields[0] as { String?: { sval?: string } }).String?.sval === row
  ) {
    return {
      ColumnRef: { ...(record.ColumnRef as object), fields: [fields[1]] },
    }
  }
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, unqualified(v, row)])
  )
}

/** Кон'юнкти виразу: аргументи `AND` чи сам вираз, коли він один. */
function conjuncts(value: unknown): unknown[] {
  const bool = (value as { BoolExpr?: { boolop: string; args: unknown[] } })
    .BoolExpr
  return bool?.boolop === "AND_EXPR" ? bool.args : [value]
}

/** Порівнюваний без порядку список: перестановка предикатів не дефект. */
const sorted = (lists: unknown[][]) =>
  lists.map((l) => l.map((c) => JSON.stringify(c)).sort()).sort()

function policyOf(model: CompiledModel, name: string) {
  const found = model.sqlUnits.filter(
    (u) => u.class === "policy" && u.name === name
  )
  expect(found.map((u) => u.name)).toEqual([name])
  return found[0]!.sql
}

const policyClauses = (sql: string) =>
  (tree(sql) as { CreatePolicyStmt: { qual?: unknown; with_check?: unknown } })
    .CreatePolicyStmt

function objectOf(model: CompiledModel, table: string) {
  const access = model.contracts.access.find((a) => a.table.name === table)!
  const contract: RightsContract = model.contracts.rights.find(
    (c) => c.objectId === access.rights!.objectId
  )!
  const main: PhysicalTable = mainTableOf(model.physical, contract.objectId)!
  return { access, contract, main }
}

beforeAll(loadShapeParsers)

describe("rightsCheck", () => {
  let model: CompiledModel
  beforeAll(async () => {
    model = await compiled(compileRights(policyDomain(commandCoreLayer())))
  })

  // Мітки політик кореневої родини. `Ticket` — прямі носії власності й
  // виміру, кожен обсяг ще й у контейнері прив'язки; `TaskComment` — носій
  // власності через шлях `task.assignee` (копія в основній таблиці).
  it.each([
    [
      TICKET_TABLE,
      [
        "any",
        "own",
        "region",
        "in_project_any",
        "in_project_own",
        "in_project_region",
      ],
    ],
    [COMMENT_TABLE, ["any", "own"]],
  ])(
    "дерево в дерево: предикати ядра = предикати політик запису кореневої родини (%s)",
    (table, expectedLabels) => {
      const { contract, main } = objectOf(model, table)
      const names = accessPolicyNames(main)
      const prefix = expression(
        `id = (SELECT simetra.command_root('${contract.kindLabel}'))`
      )
      const policies = expectedLabels.map((label) => {
        // Дія контексту в політиці — вираз `command_action()`; ядро
        // підставляє літерал своєї дії, контекст звірено раніше (спека П4 §6.6).
        const sql = policyOf(
          model,
          names.write("update", "root", label)
        ).replaceAll("(SELECT simetra.command_action())", "'update'")
        const { qual, with_check } = policyClauses(sql)
        expect(with_check).toEqual(qual)
        const [family, ...rest] = conjuncts(qual)
        expect(family).toEqual(prefix)
        return rest
      })
      const core = rightsCheckPredicates(contract, "update", main, "v_new").map(
        (p) => conjuncts(unqualified(expression(p), "v_new"))
      )
      expect(core).toHaveLength(expectedLabels.length)
      expect(sorted(core)).toEqual(sorted(policies))
    }
  )

  it("перевірка — OR предикатів над змінною рядка", () => {
    const { contract, main } = objectOf(model, TICKET_TABLE)
    const predicates = rightsCheckPredicates(contract, "update", main, "v_old")
    expect(expression(rightsCheck(contract, "update", main, "v_old"))).toEqual({
      BoolExpr: {
        boolop: "OR_EXPR",
        args: predicates.map((p) => expression(p)),
      },
    })
    // Кваліфіковано кожну колонку: голе ім'я в plpgsql читало б не той рядок.
    for (const p of predicates) {
      expect(unqualified(expression(p), "v_old")).not.toEqual(expression(p))
    }
  })

  it("межа тенанта ядра = check політики scope_insert", () => {
    const { access, main } = objectOf(model, TICKET_TABLE)
    const { with_check } = policyClauses(
      policyOf(model, accessPolicyNames(main).scopeInsert)
    )
    const boundary = expression(tenantBoundary(access.scope!, "v_new"))
    expect(unqualified(boundary, "v_new")).toEqual(with_check)
    expect(boundary).not.toEqual(with_check)
  })
})

describe("rightsCheck without scope", () => {
  it("нескоуплений об'єкт — has_right", async () => {
    const model = await compiled(compileRights(singleTenantRights()))
    const contract = model.contracts.rights.find((c) => c.objectId === TASK_ID)!
    const main = mainTableOf(model.physical, TASK_ID)!
    expect(
      rightsCheckPredicates(contract, "read", main, "v_new").map((p) =>
        expression(p)
      )
    ).toEqual(
      [
        "(SELECT simetra.has_right('read', 'task', 'any', NULL))",
        `v_new.project_id = ANY (ARRAY(SELECT simetra.rights_container('read', 'task', 'any', NULL)))`,
      ].map((p) => expression(p))
    )
  })

  it("без предикатів — false", async () => {
    const model = await compiled(compileRights(singleTenantRights()))
    const contract = model.contracts.rights.find((c) => c.objectId === TASK_ID)!
    const main = mainTableOf(model.physical, TASK_ID)!
    builder.empty = true
    try {
      expect(rightsCheck(contract, "read", main, "v_new")).toBe("false")
    } finally {
      builder.empty = false
    }
  })
})
