import { beforeAll, describe, expect, it } from "vitest"
import type { CompileResult, CompiledModel } from "simetra/compiler"
import { rightsCheck } from "../catalog-command/rights-check"
import { HIERARCHY_LOCK_SPACE } from "../hierarchy-units"
import { executeGrants } from "../sql/execute-grants"
import { hasEmptySearchPath } from "../sql/closed-forms"
import {
  adminRoles,
  commandCoreLayer,
  compileRights,
  compiledPolicyDomain,
  objects,
  policyDomain,
  scopeRootCarrier,
  writeRoles,
  type Layer,
} from "./fixtures/rights"
import { snakeCaseTwin } from "./fixtures/snake-case"
import { bodyShape, loadShapeParsers, nodes, tree } from "./fixtures/sql-shape"
import { uuid } from "./helpers"

let domain: CompiledModel
beforeAll(async () => {
  await loadShapeParsers()
  domain = await compiled(
    compileRights(
      policyDomain(
        writeRoles(),
        adminRoles(),
        commandCoreLayer(),
        scopeRootCarrier()
      )
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

const MARK = "(uuid,int8,bool)"
const DELETE = "(uuid,int8)"
const unitOf = (model: CompiledModel, identity: string) =>
  model.sqlUnits.find((u) => u.identity === `function:public.${identity}`)
const sqlOf = (model: CompiledModel, identity: string) => {
  const unit = unitOf(model, identity)
  expect(unit, identity).toBeDefined()
  return unit!.sql
}
const markSql = (model: CompiledModel, table: string) =>
  sqlOf(model, `${table}_mark_deletion${MARK}`)
const deleteSql = (model: CompiledModel, table: string) =>
  sqlOf(model, `${table}_delete${DELETE}`)

type Shape = ReturnType<typeof bodyShape>
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const at = (shape: Shape, type: string, sql: string, from = 0) =>
  shape.findIndex(
    (s, i) =>
      i >= from && s.type === type && same(s.expressions[0]?.tree, tree(sql))
  )
const ifAt = (shape: Shape, condition: string, from = 0) =>
  at(shape, "if", `SELECT ${condition}`, from)
const mainOf = (model: CompiledModel, table: string) =>
  model.physical.tables.find((t) => t.name === table)!
const rightsOf = (model: CompiledModel, table: string) =>
  model.contracts.rights.find(
    (r) => r.objectId === mainOf(model, table).origin.objectId
  )!
const context = (action: string, label: string) =>
  `(SELECT simetra.command_action()) IS DISTINCT FROM '${action}' OR (SELECT simetra.command_root('${label}')) IS DISTINCT FROM p_id`
const rightsIf = (
  model: CompiledModel,
  table: string,
  action: string,
  row: "v_old" | "v_new"
) =>
  `(${rightsCheck(rightsOf(model, table), action, mainOf(model, table), row)}) IS NOT TRUE`
const forUpdate = (table: string) =>
  `SELECT * FROM public.${table} r WHERE r.id = p_id FOR UPDATE`
const lock = (table: string) =>
  `SELECT pg_advisory_xact_lock(${HIERARCHY_LOCK_SPACE}, 'public.${table}'::regclass::oid::int)`
/** `DETAIL` відмови оператора `raise` — рядкові константи його опцій. */
const raiseDetail = (s: Shape[number]) =>
  s.expressions.flatMap((e) =>
    nodes(e.tree, "sval").map((v) => (v as { sval: string }).sval)
  )
/** Порядок: усі знайдені, строго зростають. */
function expectOrder(order: number[]) {
  expect(
    order.every((i) => i >= 0),
    JSON.stringify(order)
  ).toBe(true)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  expect(new Set(order).size).toBe(order.length)
}

describe("<t>_mark_deletion", () => {
  /** Індекси кроків позначки за деревами операторів. */
  function markSteps(model: CompiledModel, table: string, action: string) {
    const shape = bodyShape(markSql(model, table))
    const update = at(
      shape,
      "execsql",
      `UPDATE public.${table} SET deletion_mark = p_mark WHERE id = p_id RETURNING *`
    )
    return {
      shape,
      mark: ifAt(shape, "p_mark IS NULL"),
      version0: ifAt(shape, "p_expected_version IS NULL"),
      ctx: ifAt(shape, context(action, table)),
      locked: at(shape, "execsql", forUpdate(table)),
      version: ifAt(shape, "v_old.version IS DISTINCT FROM p_expected_version"),
      before: ifAt(shape, rightsIf(model, table, action, "v_old")),
      assign: shape.findIndex(
        (s) =>
          s.type === "assign" &&
          s.target?.variable.startsWith("v_new") === true &&
          same(s.expressions[0]?.tree, tree("SELECT p_mark"))
      ),
      after: ifAt(shape, rightsIf(model, table, action, "v_new")),
      predefined: ifAt(shape, "v_old.predefined_name IS NOT NULL"),
      update,
    }
  }

  it("порядок: NULL-входи → контекст → замок → версія → право «до» → позначка → право «після» → предвизначений → UPDATE → GET DIAGNOSTICS → рядок", () => {
    const s = markSteps(domain, "ticket", "markDeletion")
    expectOrder([
      s.mark,
      s.version0,
      s.ctx,
      s.locked,
      s.version,
      s.before,
      s.assign,
      s.after,
      s.predefined,
      s.update,
    ])
    expect(s.shape[s.locked]!.target).toEqual({ variable: "v_old" })
    expect(
      nodes(s.shape[s.locked]!.expressions[0]!.tree, "lockingClause")
    ).not.toEqual([])
    expect(s.shape[s.update + 1]).toMatchObject({
      type: "getdiag",
      target: { variable: "v_count" },
    })
    expect(ifAt(s.shape, "v_count = 0", s.update + 2)).toBe(s.update + 2)
    // Рядок дає сам `UPDATE` (Ф10): повторного читання після нього немає.
    expect(s.shape[s.update]!.target).toEqual({ variable: "v_row" })
    expect(s.shape.filter((x) => x.target?.variable === "v_row")).toHaveLength(
      1
    )
    // Автор зміни — поточний користувач, як у `save`.
    expect(
      s.shape.find(
        (x) =>
          x.type === "assign" &&
          same(
            x.expressions[0]?.tree,
            tree("SELECT (SELECT simetra.current_user_id())")
          )
      )
    ).toBeDefined()
    // Відмови входу називають параметр.
    expect(raiseDetail(s.shape[s.mark + 1]!)).toContain("p_mark")
    expect(raiseDetail(s.shape[s.version0 + 1]!)).toContain(
      "p_expected_version"
    )
  })

  // Інакше відмова без права розкривала б, що рядок предвизначений (Рт4).
  it("предвизначений — після обох перевірок права, відмова 'predefined'", () => {
    const s = markSteps(domain, "ticket", "markDeletion")
    expect(s.predefined).toBeGreaterThan(s.after)
    expect(s.after).toBeGreaterThan(s.before)
    expect(raiseDetail(s.shape[s.predefined + 1]!)).toEqual(
      expect.arrayContaining(["command.invalid", "predefined"])
    )
  })

  it("RETURNING лише в UPDATE; посилань на рядок не шукає (Рт12)", () => {
    const shape = bodyShape(markSql(domain, "ticket"))
    expect(
      nodes(
        shape.map((s) => s.expressions.map((e) => e.tree)),
        "returningList"
      )
    ).toHaveLength(1)
    // Відношення тіла — лише сама таблиця (плюс джерела копій, яких
    // у `ticket` через автора немає).
    const relations = new Set(
      nodes(
        shape.map((s) => s.expressions.map((e) => e.tree)),
        "RangeVar"
      ).map((r) => (r as { relname: string }).relname)
    )
    expect([...relations]).toEqual(["ticket"])
  })

  describe("обробник beforeWrite присвоює parent_id — замок до FOR UPDATE", () => {
    const handler = (body: string) =>
      `CREATE FUNCTION public.ticket_parent() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN ${body} RETURN NEW; END $$;`
    const subscription: Layer = {
      "event-subscriptions/TicketParent/TicketParent.meta.json": {
        id: uuid(6945),
        kind: "EventSubscription",
        name: "TicketParent",
        physicalName: "ticket_parent",
        sources: objects(["Catalog", "Ticket"]),
        event: "beforeWrite",
        handler: { schema: "public", name: "ticket_parent" },
      },
    }
    it.each([
      ["присвоює", "NEW.parent_id := NULL;", true],
      ["не присвоює", "NEW.description := 'x';", false],
    ])("обробник %s parent_id", async (_, body, always) => {
      const model = await compiled(
        compiledPolicyDomain(
          { "sql/public/ticket-parent.sql": handler(body) },
          [commandCoreLayer(), subscription]
        )
      )
      const shape = bodyShape(markSql(model, "ticket"))
      const locked = at(shape, "perform", lock("ticket"))
      if (always) {
        expect(locked).toBe(ifAt(shape, context("markDeletion", "ticket")) + 2)
        expect(locked).toBeLessThan(at(shape, "execsql", forUpdate("ticket")))
      } else {
        expect(locked).toBe(-1)
      }
    })
  })
})

describe("<t>_delete", () => {
  it("порядок: контекст → замок → версія → право «до» → DELETE → GET DIAGNOSTICS → ключ і версія", () => {
    const table = "org_role_assignments"
    const shape = bodyShape(deleteSql(domain, table))
    const remove = at(
      shape,
      "execsql",
      `DELETE FROM public.${table} WHERE id = p_id`
    )
    const order = [
      // Без версії — `command.invalid`, а не конфлікт, як у позначці.
      ifAt(shape, "p_expected_version IS NULL"),
      ifAt(shape, context("administerRights", table)),
      at(shape, "execsql", forUpdate(table)),
      ifAt(shape, "v_old.version IS DISTINCT FROM p_expected_version"),
      ifAt(shape, rightsIf(domain, table, "administerRights", "v_old")),
      remove,
    ]
    expectOrder(order)
    expect(shape[remove + 1]).toMatchObject({
      type: "getdiag",
      target: { variable: "v_count" },
    })
    expect(ifAt(shape, "v_count = 0", remove + 2)).toBe(remove + 2)
    expect(shape[remove + 4]!.type).toBe("return")
    expect(shape[remove + 4]!.expressions[0]!.tree).toEqual(
      tree(
        "SELECT jsonb_build_object('id', p_id, 'version', v_old.version::text)::text"
      )
    )
    expect(shape).toHaveLength(remove + 5)
  })

  it("гранти: EXECUTE лише command", () => {
    const owner = mainOf(domain, "org_role_assignments").origin.objectId
    expect(
      domain.sqlUnits
        .filter(
          (u) =>
            u.class === "grant" &&
            u.generator === "catalogCommand" &&
            u.ownerObjectId === owner &&
            u.identity.includes("_delete(")
        )
        .map((u) => JSON.stringify(u.tree))
        .sort()
    ).toEqual(
      executeGrants(
        "public.org_role_assignments_delete(uuid, bigint)",
        ["command"],
        "supabase"
      )
        .map((sql) => JSON.stringify(tree(sql)))
        .sort()
    )
  })
})

describe("функції за роллю довідника", () => {
  it.each([
    ["звичайний довідник", "ticket", true, false],
    ["«Ролі»", "org_roles", true, false],
    ["«Призначення»", "org_role_assignments", true, true],
    ["«Користувачі»", "users", false, false],
    ["корінь скоупу", "organization", true, false],
  ])("%s: mark_deletion %s, delete %s", (_, table, mark, remove) => {
    expect(unitOf(domain, `${table}_save(jsonb,int8)`)).toBeDefined()
    expect(unitOf(domain, `${table}_mark_deletion${MARK}`) !== undefined).toBe(
      mark
    )
    expect(unitOf(domain, `${table}_delete${DELETE}`) !== undefined).toBe(
      remove
    )
  })

  it("«Користувачі»: save лише зі зміною — створення відмовляє 'create'", () => {
    const shape = bodyShape(sqlOf(domain, "users_save(jsonb,int8)"))
    const branches = shape
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s }) =>
          s.type === "if" &&
          same(
            s.expressions[0]?.tree,
            tree("SELECT p_expected_version IS NULL")
          )
      )
    // Перша — перевірка входу, друга — гілка створення.
    const create = branches[1]!.i
    expect(shape[create + 1]!.type).toBe("raise")
    expect(raiseDetail(shape[create + 1]!)).toEqual(
      expect.arrayContaining(["command.invalid", "create"])
    )
    // `INSERT` шапки немає (ТЧ «Користувачів» вставляються й на зміні).
    expect(
      (
        nodes(
          shape.map((s) => s.expressions.map((e) => e.tree)),
          "InsertStmt"
        ) as { relation: { relname: string } }[]
      ).map((i) => i.relation.relname)
    ).not.toContain("users")
  })

  it.each([
    ["«Ролі»", "org_roles", "mark"],
    ["«Призначення»", "org_role_assignments", "mark"],
    ["«Призначення»", "org_role_assignments", "delete"],
  ] as const)(
    "%s (%s, %s): дія контексту — літерал 'administerRights'",
    (_, table, fn) => {
      const shape = bodyShape(
        fn === "mark" ? markSql(domain, table) : deleteSql(domain, table)
      )
      expect(ifAt(shape, context("administerRights", table))).toBeGreaterThan(
        -1
      )
      expect(
        ifAt(shape, rightsIf(domain, table, "administerRights", "v_old"))
      ).toBeGreaterThan(-1)
    }
  )

  it.each([
    ["ticket", "mark"],
    ["org_role_assignments", "mark"],
    ["org_role_assignments", "delete"],
  ] as const)("%s %s: кожна перевірка — NULL-безпечна", (table, fn) => {
    const shape = bodyShape(
      fn === "mark" ? markSql(domain, table) : deleteSql(domain, table)
    )
    const conditions = shape
      .filter((s) => s.type === "if")
      .map((s) => s.expressions[0]!.tree)
    const contexts = conditions.filter((c) =>
      nodes(c, "funcname").some((f) =>
        JSON.stringify(f).includes("command_action")
      )
    )
    expect(contexts).toHaveLength(1)
    expect(
      nodes(contexts[0], "A_Expr").map((e) => (e as { kind: string }).kind)
    ).toEqual(["AEXPR_DISTINCT", "AEXPR_DISTINCT"])
    const rights = conditions.filter((c) =>
      nodes(c, "funcname").some((f) => JSON.stringify(f).includes("rights_"))
    )
    expect(rights).toHaveLength(fn === "mark" ? 2 : 1)
    for (const c of rights) {
      expect(
        (nodes(c, "targetList") as { ResTarget: { val: unknown } }[][])[0]![0]!
          .ResTarget.val
      ).toMatchObject({ BooleanTest: { booltesttype: "IS_NOT_TRUE" } })
    }
  })

  it.each([
    ["ticket", "mark"],
    ["org_role_assignments", "delete"],
  ] as const)(
    "%s %s: SECURITY INVOKER, search_path = '', без EXECUTE у тілі",
    (table, fn) => {
      const unit = unitOf(
        domain,
        fn === "mark"
          ? `${table}_mark_deletion${MARK}`
          : `${table}_delete${DELETE}`
      )!
      const create = (
        unit.tree as {
          CreateFunctionStmt: {
            options: { DefElem: { defname: string; arg?: unknown } }[]
          }
        }
      ).CreateFunctionStmt
      expect(
        create.options.find((o) => o.DefElem.defname === "security")?.DefElem
          .arg
      ).toEqual({ Boolean: { boolval: false } })
      expect(hasEmptySearchPath(unit.tree as never)).toBe(true)
      expect(
        bodyShape(unit.sql).filter((s) => s.type === "dynexecute")
      ).toEqual([])
    }
  )
})

// Колонку позначки ядро бере за `origin` (Р-A2-5): у snake_case-проєкті
// літерал логічного імені її б не знайшов.
describe("обидва стилі: колонка позначки за origin", () => {
  const files = () => policyDomain(writeRoles(), commandCoreLayer())
  it.each([
    ["camelCase", () => files()],
    ["snake_case", () => snakeCaseTwin(files())],
  ] as const)("%s", async (attributeCase, f) => {
    const model = await compiled(compileRights(f()))
    expect(model.project.naming.attributeCase).toBe(attributeCase)
    const shape = bodyShape(markSql(model, "ticket"))
    expect(
      at(
        shape,
        "execsql",
        "UPDATE public.ticket SET deletion_mark = p_mark WHERE id = p_id RETURNING *"
      )
    ).toBeGreaterThan(0)
    expect(
      shape.find(
        (s) =>
          s.type === "assign" &&
          same(s.expressions[0]?.tree, tree("SELECT p_mark"))
      )
    ).toBeDefined()
  })
})
