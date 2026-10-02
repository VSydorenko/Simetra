import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  compareWithDesired,
  createPgDeltaEngine,
  engineScope,
  renderDesiredState,
  type EngineScope,
} from "simetra/schema"
import {
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../test/db/connection"
import {
  customTable,
  metaFiles,
  project,
} from "../../compiler/__tests__/helpers"
import { boundaryViolations } from "./fixtures/engine-boundary"

/**
 * Порівняння бази з бажаним станом через тінь (план E2a, задача 6). Ціль —
 * база стеку, яку тести лише читають; пише порт тільки в тінь.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

const scopeOf = (...schemas: string[]): EngineScope => ({
  schemas,
  provider: "supabase",
})

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

describe("compareWithDesired", () => {
  it("no shadow is left behind", async () => {
    // Лічильник до/після перевіряє `afterEach`; тут — успіх, а нижче — помилка
    const ok = await compareWithDesired(
      engine,
      stack,
      "create schema app; create table app.t (id int primary key);",
      scopeOf("app")
    )
    expect(ok.status).toBe("compared")
    expect(await shadowDatabaseCount()).toBe(shadowsBefore)

    const failed = await compareWithDesired(
      engine,
      stack,
      "create table app.nowhere (id int);",
      scopeOf("app")
    )
    expect(failed.status).toBe("shadow-failed")
    expect(await shadowDatabaseCount()).toBe(shadowsBefore)
  })

  it("broken desired sql is shadow-failed", async () => {
    const result = await compareWithDesired(
      engine,
      stack,
      "create schema app; create table app.t (id int references app.missing (id));",
      scopeOf("app")
    )
    expect(result.status).toBe("shadow-failed")
    if (result.status !== "shadow-failed") return
    expect(result.diagnostics.length).toBeGreaterThan(0)
    for (const d of result.diagnostics) {
      expect(d.code).toBe("engine.shadow-load-failed")
      expect(d.severity).toBe("error")
    }
    expect(result.diagnostics.map((d) => d.message).join("\n")).toContain(
      'relation "app.missing" does not exist'
    )
  })

  it("plan stays inside the scope", async () => {
    // Межа береться з моделі, а бажаний стан — із її рендера: об'єкти
    // застосунку в чужих схемах (політика, тригер) у плані дозволені, а
    // внутрішні об'єкти провайдера й некеровані схеми — ні
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project({ defaultSchema: "app" }),
        "custom-tables/Note/Note.meta.json": customTable("Note"),
        "sql/app/units.sql": [
          "CREATE FUNCTION app.on_user() RETURNS trigger LANGUAGE plpgsql",
          "  AS $$ BEGIN RETURN NEW; END $$;",
          "CREATE TRIGGER app_on_user AFTER INSERT ON auth.users",
          "  FOR EACH ROW EXECUTE FUNCTION app.on_user();",
          "CREATE POLICY app_read ON storage.objects FOR SELECT TO authenticated",
          "  USING (bucket_id = 'app');",
          "",
        ].join("\n"),
      })
    )
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    )
    const model = compiled.model!
    const scope = engineScope(model)
    const result = await compareWithDesired(
      engine,
      stack,
      renderDesiredState(model).sql,
      scope
    )
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    const produced = result.plan.actions.flatMap((a) => a.produces)
    expect(produced).toContain("table:app.note")
    expect(produced).toContain("policy:storage.objects.app_read")
    expect(produced).toContain("trigger:auth.users.app_on_user")
    expect(boundaryViolations(result.plan.actions, scope)).toEqual([])
    expect(result.empty).toBe(false)
    expect(result.differences.map((d) => d.path)).toContain("tables.app.note")
  })

  it("foreign key to auth.users deploys in the shadow", async () => {
    const result = await compareWithDesired(
      engine,
      stack,
      `create schema app;
       create table app.profile (
         id uuid primary key,
         user_id uuid not null references auth.users (id)
       );`,
      scopeOf("app")
    )
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    expect(result.desired.model.tables.map((t) => t.name)).toEqual(["profile"])
    expect(result.desired.model.tables[0]?.foreignKeys).toHaveLength(1)
    expect(result.plan.actions.flatMap((a) => a.produces)).toContain(
      "table:app.profile"
    )
  })

  it("an empty comparison is empty only without differences", async () => {
    const result = await compareWithDesired(
      engine,
      stack,
      "select 1;",
      scopeOf("app")
    )
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    expect(result.differences).toEqual([])
    expect(result.empty).toBe(true)
  })
})
