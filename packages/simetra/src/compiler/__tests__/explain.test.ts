import { describe, expect, it } from "vitest"
import { compile, explainFunction, explainObject } from "simetra/compiler"
import { readReferenceDomain } from "./fixtures/reference-domain"
import {
  ORG_MEMBER_ROLE_ID,
  ROLE_FILE,
  SET_FILE,
  TASK_FILE,
  TASK_ID,
  compileRights,
  grant,
  objects,
  rightsFiles,
  withRoles,
} from "./fixtures/rights"
import {
  acceptDebt,
  attribute,
  metaFiles,
  project,
  salesDocument,
  uuid,
} from "./helpers"

async function referenceModel() {
  const result = await compile(readReferenceDomain())
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

describe("explainObject", () => {
  it("explains a document", async () => {
    const e = explainObject(await referenceModel(), {
      kind: "Document",
      name: "ServiceAccrual",
    })!
    expect(e.object).toMatchObject({
      kind: "Document",
      name: "ServiceAccrual",
      scopeKind: "org",
    })
    // Шапка й обидві ТЧ.
    expect(e.tables.map((t) => t.part)).toEqual([
      "main",
      "tabularSection",
      "tabularSection",
    ])
    const main = e.tables[0]!
    expect(main.columns).toContainEqual(
      expect.objectContaining({
        name: "counterparty_id",
        logical: "counterparty",
      })
    )
    expect(main.columns.map((c) => c.standard)).toEqual(
      expect.arrayContaining(["number", "date"])
    )
    expect(main.columns).toContainEqual(
      expect.objectContaining({ name: "org_id", scope: true })
    )
    expect(e.movementQueries).toHaveLength(2)
    expect(e.contracts.length).toBeGreaterThan(0)
  })

  it("explains a register", async () => {
    const model = await referenceModel()
    const e = explainObject(model, {
      kind: "AccumulationRegister",
      name: "PerformerSettlements",
    })!
    expect(e.tables.map((t) => t.part)).toContain("totals")
    const doc = model.objects.find((o) => o.name === "ServiceAccrual")!
    expect(e.referencedBy.length).toBeGreaterThan(0)
    expect(e.referencedBy.some((r) => r.file === doc.file)).toBe(true)
  })

  it("explains an event subscription: no tables, its trigger contract", async () => {
    const model = await referenceModel()
    const e = explainObject(model, {
      kind: "EventSubscription",
      name: "CheckContractStart",
    })!
    expect(e.tables).toEqual([])
    expect(e.contracts).toEqual([
      expect.objectContaining({
        name: "check_contract_start",
        sources: [
          { schema: "app", table: "contract", whenChanged: ["start_date"] },
        ],
        handler: { schema: "app", name: "check_contract_start" },
      }),
    ])
    const contract = explainObject(model, {
      kind: "Catalog",
      name: "Contract",
    })!
    expect(contract.referencedBy).toContainEqual(
      expect.objectContaining({ role: "eventSubscription.source" })
    )
  })

  it("shows the origin of each CHECK of a table", async () => {
    const result = await compile(
      metaFiles({
        "project.meta.json": project(),
        ...salesDocument(
          {},
          {
            attributes: [
              attribute("code", { type: "String", length: 10, required: true }),
            ],
          }
        ),
        "documents/Sale/Sale.sql":
          "ALTER TABLE public.sale ADD CONSTRAINT sale_code_set CHECK (code IS NOT NULL);",
      })
    )
    expect(result.diagnostics).toEqual([])
    const e = explainObject(result.model!, { kind: "Document", name: "Sale" })!
    const checks = e.tables.find((t) => t.part === "main")!.checks
    expect(checks).toContainEqual({
      name: "sale_code_set",
      expression: "code IS NOT NULL",
      origin: "rowRule",
    })
    expect(checks.filter((c) => c.origin === "kind")).not.toEqual([])
  })

  it("shows the rights contract of an object", async () => {
    const result = await compileRights(rightsFiles())
    const e = explainObject(result.model!, { kind: "Document", name: "Task" })!
    expect(e.contracts).toContainEqual(
      expect.objectContaining({ kindLabel: "task", actions: expect.any(Array) })
    )
  })

  it("explains a role with its projection", async () => {
    const TASK = objects(["Document", "Task"])
    const result = await compileRights(
      withRoles({
        [TASK_FILE]: { ownership: ["assignee"] },
        [SET_FILE("TaskReaders")]: { grants: [grant(TASK, ["read"], "any")] },
        [ROLE_FILE("Support")]: {
          grants: [grant(objects(["Catalog", "Users"]), ["read"], "any")],
        },
      })
    )
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const model = result.model!
    const role = explainObject(model, { kind: "Role", name: "OrgMember" })!
    expect(role.tables).toEqual([])
    const roleContract = model.contracts.roles.find(
      (r) => r.roleId === ORG_MEMBER_ROLE_ID
    )!
    const roleRows = model.contracts.rightsProjection.filter(
      (r) => r.roleId === ORG_MEMBER_ROLE_ID
    )
    expect(roleRows).not.toEqual([])
    expect(role.contracts).toEqual([roleContract, ...roleRows])

    const task = explainObject(model, { kind: "Document", name: "Task" })!
    const taskRows = model.contracts.rightsProjection.filter(
      (r) => r.objectId === TASK_ID
    )
    expect(taskRows.map((r) => r.roleId)).toContain(ORG_MEMBER_ROLE_ID)
    // Рядки інших об'єктів (Support → Users) у пояснення задачі не входять.
    expect(
      task.contracts.filter((c) => Object.hasOwn(c as object, "sources"))
    ).toEqual(taskRows)
  })

  it("unknown object", async () => {
    expect(
      explainObject(await referenceModel(), { kind: "Catalog", name: "Nope" })
    ).toBeUndefined()
  })
})

describe("explainFunction", () => {
  const SQL = "sql/public/fns.sql"
  const FUNCTIONS = "sql/public/fns.functions.json"
  const GUARDED =
    "BEGIN PERFORM simetra.rights_require('read', 'task', p_row); END"
  const UNGUARDED = "BEGIN PERFORM 1; END"

  const files = (
    text: string,
    options: { declare?: boolean; extra?: string } = {}
  ) => {
    const all = withRoles()
    all.set(
      SQL,
      `CREATE FUNCTION public.f(p_row uuid) RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$${text}$$;\n${options.extra ?? ""}`
    )
    if (options.declare !== false) {
      all.set(
        FUNCTIONS,
        JSON.stringify({
          functions: [
            {
              id: uuid(7902),
              function: { name: "f" },
              callers: ["user", "service"],
              check: {
                action: "read",
                object: { kind: "Document", name: "Task" },
                row: "p_row",
              },
            },
          ],
        })
      )
    }
    return all
  }
  const explain = async (all: Map<string, string>, name = "f") =>
    explainFunction(await compile(all, { repair: true }), {
      schema: "public",
      name,
    })

  it("a declared function with the guard: callers, roles per provider, the check in words, applied", async () => {
    const e = await explain(files(GUARDED))
    expect(e).toEqual({
      function: { schema: "public", name: "f" },
      callers: ["user", "service"],
      roles: {
        supabase: [
          { caller: "user", role: "authenticated" },
          { caller: "service", role: "service_role" },
        ],
        postgres: [{ caller: "user", role: "simetra_user" }],
      },
      check: "action `read` of Document `Task` on row `p_row`",
      state: "applied",
    })
  })

  it("without the guard the state is not-applied with the reason", async () => {
    expect((await explain(files(UNGUARDED)))?.state).toBe(
      "not-applied (firstStatement)"
    )
  })

  it("an undeclared function is none, callers are not invented from a verbatim grant", async () => {
    // Invoker-функція: definer без декларації — помилка поза класом ремонту.
    const all = withRoles()
    all.set(
      SQL,
      "CREATE FUNCTION public.f(p_row uuid) RETURNS void LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$SELECT 1$$;\nGRANT EXECUTE ON FUNCTION public.f(uuid) TO authenticated;\n"
    )
    const e = await explain(await acceptDebt(all))
    expect(e).toEqual({
      function: { schema: "public", name: "f" },
      state: "none",
    })
    expect(e).not.toHaveProperty("callers")
  })

  it("an unknown function is undefined", async () => {
    expect(await explain(files(GUARDED), "missing")).toBeUndefined()
  })
})
