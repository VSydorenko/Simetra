import { describe, expect, it } from "vitest"
import type { CatalogModel, CatalogUnit } from "simetra/model"
import {
  compareWithDesired,
  type DbConnection,
  type EngineAction,
  type EngineDiagnostic,
  type EnginePlan,
  type EngineScope,
  type Extracted,
  type SchemaEngine,
  type ShadowOutcome,
} from "simetra/schema"

/**
 * Звірка з бажаним станом поверх порту, без бази: фейковий двигун віддає
 * підготовлені витяги, план і результат тіні. Тест фіксує наявну поведінку
 * `compareWithDesired` — двигун переїхав у designer, а звірка лишилася в T2.
 */

const TARGET: DbConnection = { url: "postgres://target" }
const SHADOW: DbConnection = { url: "postgres://shadow" }
const SCOPE: EngineScope = { schemas: ["app"], provider: "supabase" }
const EMPTY_PLAN: EnginePlan = { actions: [], empty: true }

const VIEW: CatalogUnit = {
  class: "materializedView",
  identity: "materializedView:app.totals",
  schema: "app",
  name: "totals",
  sql: "create materialized view app.totals as select 1",
}

function model(units: CatalogUnit[] = []): CatalogModel {
  return { tables: [], enumTypes: [], units }
}

function extracted(overrides: Partial<Extracted> = {}): Extracted {
  return {
    model: model(),
    catalog: { engine: "fake" },
    diagnostics: [],
    unpopulated: [],
    ...overrides,
  }
}

function diagnostic(
  code: EngineDiagnostic["code"],
  severity: EngineDiagnostic["severity"],
  object: string
): EngineDiagnostic {
  return { code, severity, message: `${code} on ${object}`, object }
}

const ACTION: EngineAction = {
  sql: "create table app.note (id uuid)",
  verb: "create",
  produces: ["table:app.note"],
  consumes: ["schema:app"],
  destroys: [],
  transactionality: "transactional",
  lockClass: "AccessExclusiveLock",
  dataLoss: false,
  rewriteRisk: false,
}

interface Fake {
  target?: Extracted
  desired?: Extracted
  plan?: EnginePlan
  /** Діагностики, які тінь повертає разом із результатом. */
  shadowDiagnostics?: EngineDiagnostic[]
  /** Тінь не завантажилась: колбек не викликається. */
  shadowFailed?: EngineDiagnostic[]
}

function fakeEngine(fake: Fake): SchemaEngine {
  return {
    async extract(db) {
      return db.url === SHADOW.url
        ? (fake.desired ?? extracted())
        : (fake.target ?? extracted())
    },
    plan() {
      throw new Error("compareWithDesired takes the plan from the shadow")
    },
    async withDesiredShadow<T>(
      target: DbConnection,
      _desiredSql: string,
      _scope: EngineScope,
      fn: (shadow: DbConnection, plan: EnginePlan) => Promise<T>
    ): Promise<ShadowOutcome<T>> {
      expect(target).toBe(TARGET)
      if (fake.shadowFailed !== undefined)
        return { status: "shadow-failed", diagnostics: fake.shadowFailed }
      return {
        status: "loaded",
        value: await fn(SHADOW, fake.plan ?? EMPTY_PLAN),
        diagnostics: fake.shadowDiagnostics ?? [],
      }
    },
  }
}

const compare = (fake: Fake, scopeDiagnostics: EngineDiagnostic[] = []) =>
  compareWithDesired(
    fakeEngine(fake),
    TARGET,
    "-- desired",
    SCOPE,
    scopeDiagnostics
  )

describe("compareWithDesired", () => {
  it("is empty when the plan is empty and models and population match", async () => {
    const both = extracted({
      model: model([VIEW]),
      unpopulated: [VIEW.identity],
    })
    const result = await compare({ target: both, desired: both })
    expect(result).toMatchObject({
      status: "compared",
      plan: EMPTY_PLAN,
      differences: [],
      diagnostics: [],
      empty: true,
    })
  })

  it("reports differences when the engine plan has actions", async () => {
    const plan: EnginePlan = { actions: [ACTION], empty: false }
    const result = await compare({ plan })
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    expect(result.plan.actions).toEqual([ACTION])
    expect(result.empty).toBe(false)
  })

  it("reports model and population differences even with an empty plan", async () => {
    const result = await compare({
      target: extracted({
        model: model([VIEW]),
        unpopulated: [VIEW.identity],
      }),
      desired: extracted({ model: model([VIEW]) }),
    })
    expect(result).toMatchObject({
      status: "compared",
      empty: false,
      differences: [
        {
          path: `units.${VIEW.identity}`,
          kind: "changed",
          detail:
            "materialized view is not populated in the database, populated in the desired state",
        },
      ],
    })
  })

  it("is not empty when scope diagnostics carry an error", async () => {
    const outOfScope = diagnostic(
      "engine.out-of-scope",
      "error",
      "table:auth.profile"
    )
    const result = await compare({}, [outOfScope])
    expect(result).toMatchObject({
      status: "compared",
      differences: [],
      diagnostics: [outOfScope],
      empty: false,
    })
  })

  it("stays empty when diagnostics are only warnings", async () => {
    const warning = diagnostic(
      "engine.unmodeled-class",
      "warning",
      "accessMethod"
    )
    const result = await compare({
      target: extracted({ diagnostics: [warning] }),
    })
    expect(result).toMatchObject({ diagnostics: [warning], empty: true })
  })

  it("merges scope, census and engine diagnostics into one list", async () => {
    const scope = diagnostic("engine.out-of-scope", "error", "scope")
    const shadow = diagnostic("engine.unmodeled-drift", "error", "shadow")
    const census = diagnostic("engine.census-mismatch", "error", "census")
    const desired = diagnostic("engine.unrepresentable", "error", "desired")
    const result = await compare(
      {
        shadowDiagnostics: [shadow],
        // Одна діагностика з обох боків (перепис цілі й тіні) — один запис
        target: extracted({ diagnostics: [census] }),
        desired: extracted({ diagnostics: [census, desired] }),
      },
      [scope]
    )
    expect(result.diagnostics).toEqual([scope, shadow, census, desired])
  })

  it("is not empty when the shadow failed to load", async () => {
    const scope = diagnostic("engine.out-of-scope", "error", "scope")
    const failed = diagnostic(
      "engine.shadow-load-failed",
      "error",
      "desired.sql"
    )
    const result = await compare({ shadowFailed: [failed] }, [scope])
    expect(result).toEqual({
      status: "shadow-failed",
      diagnostics: [scope, failed],
    })
  })
})
