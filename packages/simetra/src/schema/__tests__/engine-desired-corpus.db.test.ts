import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { compile, type CompiledModel } from "simetra/compiler"
import {
  compareWithDesired,
  createPgDeltaEngine,
  engineScope,
  renderDesiredState,
  type DesiredComparison,
  type EngineDiagnostic,
  type EngineScope,
} from "simetra/schema"
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../test/db/connection"
import { readReferenceDomain } from "../../compiler/__tests__/fixtures/reference-domain"
import { customTables, FIXTURES } from "./fixtures/e1-fixtures"

/**
 * Звірка розгорнутого бажаного стану через порт: ціль — тінь із рендером
 * моделі, бажаний стан — той самий рендер. Порожній результат на корпусі
 * доводить, що порт не бачить різниці там, де її немає; мутації цілі —
 * що «порожньо» не тихе там, де вона є (спека П2 §9).
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

async function compiled(files: Map<string, string>): Promise<CompiledModel> {
  const result = await compile(files)
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return result.model!
}

/**
 * Розгортає `targetSql` у тінь-ціль і порівнює її з `desiredSql` у вкладеній
 * тіні: обидві бази створює й прибирає порт, стек лише читається.
 */
async function reconcile(
  targetSql: string,
  desiredSql: string,
  scope: EngineScope,
  scopeDiagnostics: readonly EngineDiagnostic[] = []
): Promise<Extract<DesiredComparison, { status: "compared" }>> {
  const outcome = await engine.withDesiredShadow(
    stack,
    targetSql,
    scope,
    (target) =>
      compareWithDesired(engine, target, desiredSql, scope, scopeDiagnostics)
  )
  expect(outcome.status === "loaded" ? [] : outcome.diagnostics).toEqual([])
  if (outcome.status !== "loaded") throw new Error("target did not load")
  const comparison = outcome.value
  expect(
    comparison.status === "compared" ? [] : comparison.diagnostics
  ).toEqual([])
  if (comparison.status !== "compared")
    throw new Error("desired state did not load")
  return comparison
}

/** Рендер, розгорнутий як є, звіряється з собою порожньо. */
async function expectDeployedRenderIsEmpty(files: Map<string, string>) {
  const model = await compiled(files)
  const sql = renderDesiredState(model).sql
  const { scope, diagnostics } = engineScope(model)
  const result = await reconcile(sql, sql, scope, diagnostics)
  // Спершу — що саме не порожнє, а не голе `false`
  expect({
    actions: result.plan.actions.map((a) => a.sql),
    differences: result.differences,
    errors: result.diagnostics.filter((d) => d.severity === "error"),
  }).toEqual({ actions: [], differences: [], errors: [] })
  expect(result.empty).toBe(true)
}

/** Заміна рівно одного входження: мутація, що нічого не змінила, — дефект тесту. */
function replaced(sql: string, from: string, to: string): string {
  const parts = sql.split(from)
  if (parts.length !== 2)
    throw new Error(`expected one occurrence of ${JSON.stringify(from)}`)
  return parts.join(to)
}

/** Ідентичності об'єктів, яких торкаються дії плану. */
function planTargets(result: DesiredComparison & { status: "compared" }) {
  return result.plan.actions.flatMap((a) => [
    ...a.produces,
    ...a.consumes,
    ...a.destroys,
  ])
}

describe("deployed desired state reconciles empty through the port", () => {
  for (const [name, fixture] of FIXTURES) {
    it(name, async () => {
      await expectDeployedRenderIsEmpty(fixture())
    })
  }

  it("reference domain", async () => {
    await expectDeployedRenderIsEmpty(readReferenceDomain())
  })
})

describe("a mutated target is never silently empty", () => {
  // Фікстура `CustomTable` має все, що мутують тести: CHECK, частковий
  // індекс, функцію множини скоупу й таблицю з кількома колонками
  let render = ""
  let scope: EngineScope = { schemas: [], provider: "supabase" }
  beforeEach(async () => {
    const model = await compiled(customTables())
    render = renderDesiredState(model).sql
    scope = engineScope(model).scope
  })

  it("extra index", async () => {
    const result = await reconcile(
      `${render}\nCREATE INDEX audit_extra_idx ON app.audit (email);\n`,
      render,
      scope
    )
    expect(result.empty).toBe(false)
    expect(result.differences).toContainEqual(
      expect.objectContaining({
        path: "tables.app.audit.indexes.audit_extra_idx",
        kind: "missing",
      })
    )
    expect(planTargets(result).join("\n")).toContain("audit_extra_idx")
  })

  it("missing column", async () => {
    const result = await reconcile(
      `${render}\nALTER TABLE app.ledger DROP COLUMN name;\n`,
      render,
      scope
    )
    expect(result.empty).toBe(false)
    expect(result.differences).toContainEqual(
      expect.objectContaining({
        path: "tables.app.ledger.columns.name",
        kind: "extra",
      })
    )
  })

  it("reordered columns: the engine plan is empty, the models are not", async () => {
    const result = await reconcile(
      replaced(
        render,
        "  id uuid NOT NULL,\n  name text,\n",
        "  name text,\n  id uuid NOT NULL,\n"
      ),
      render,
      scope
    )
    // Двигун не бачить порядку колонок: без рівності моделей звірка була б
    // тихо порожньою
    expect(result.plan.empty).toBe(true)
    expect(result.differences).toEqual([
      expect.objectContaining({
        path: "tables.app.ledger.columns",
        kind: "order",
      }),
    ])
    expect(result.empty).toBe(false)
  })

  it("changed function body", async () => {
    const result = await reconcile(
      `${render}\nCREATE OR REPLACE FUNCTION app.org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid LIMIT 0 $$;\n`,
      render,
      scope
    )
    expect(result.empty).toBe(false)
    expect(result.differences.map((d) => d.path)).toContain(
      "units.function:app.org_ids()"
    )
    expect(planTargets(result).join("\n")).toContain("app.org_ids")
  })

  it("changed check expression", async () => {
    const result = await reconcile(
      replaced(render, "CHECK (amount >= 0)", "CHECK (amount >= 1)"),
      render,
      scope
    )
    expect(result.empty).toBe(false)
    expect(result.differences).toContainEqual(
      expect.objectContaining({
        path: "tables.app.audit.checks.audit_amount_check",
        kind: "changed",
      })
    )
    expect(planTargets(result).join("\n")).toContain("audit_amount_check")
  })

  it("changed partial index predicate", async () => {
    const result = await reconcile(
      replaced(
        render,
        "INCLUDE (amount) WHERE email IS NOT NULL;",
        "INCLUDE (amount) WHERE email <> '';"
      ),
      render,
      scope
    )
    expect(result.empty).toBe(false)
    expect(result.differences).toContainEqual(
      expect.objectContaining({
        path: "tables.app.audit.indexes.audit_email_lower_idx",
        kind: "changed",
      })
    )
    expect(planTargets(result).join("\n")).toContain("audit_email_lower_idx")
  })
})

describe("materialized view population is compared between the database and the shadow", () => {
  const scope: EngineScope = { schemas: ["app"], provider: "supabase" }
  const view = (populate: "WITH DATA" | "WITH NO DATA") => `
    CREATE SCHEMA app;
    CREATE TABLE app.doc (id int PRIMARY KEY);
    CREATE MATERIALIZED VIEW app.totals AS SELECT count(*) AS n FROM app.doc ${populate};
  `

  it("equally unpopulated on both sides is empty", async () => {
    const result = await reconcile(
      view("WITH NO DATA"),
      view("WITH NO DATA"),
      scope
    )
    expect(result.target.unpopulated).toEqual(["materializedView:app.totals"])
    expect(result.differences).toEqual([])
    expect(result.empty).toBe(true)
  })

  it("a different population state is a difference of the view", async () => {
    const result = await reconcile(
      view("WITH NO DATA"),
      view("WITH DATA"),
      scope
    )
    // Двигун стану заповнення не бачить: без порівняння звірка була б тихо
    // порожньою
    expect(result.plan.empty).toBe(true)
    expect(result.differences).toEqual([
      {
        path: "units.materializedView:app.totals",
        kind: "changed",
        detail:
          "materialized view is not populated in the database, populated in the desired state",
      },
    ])
    expect(result.empty).toBe(false)
  })
})
