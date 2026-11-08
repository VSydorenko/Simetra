import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  compareWithDesired,
  engineScope,
  renderDesiredState,
} from "simetra/schema"
import { createPgDeltaEngine } from ".."
import {
  testDatabaseUrl,
  acceptDebt,
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
} from "../../../../simetra/test/support"
import { boundaryViolations, scopeOf } from "./fixtures/engine-boundary"

/**
 * Порівняння з бажаним станом на стеку Supabase: об'єкти застосунку на
 * поверхнях провайдера (`auth.users`, `storage.objects`) у плані, FK на
 * таблицю провайдера в тіні й шар користувачів із тригерами провізії на
 * `auth.users`.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

describe("compareWithDesired", () => {
  it("plan stays inside the scope", async () => {
    // Межа береться з моделі, а бажаний стан — із її рендера: об'єкти
    // застосунку в чужих схемах (політика, тригер) у плані дозволені, а
    // внутрішні об'єкти провайдера й некеровані схеми — ні. Предмет — межа,
    // а не ратчет: увесь борг фікстури прийнято.
    const compiled = await compile(
      await acceptDebt(
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
    )
    expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual(
      []
    )
    const model = compiled.model!
    const { scope, diagnostics } = await engineScope(model)
    expect(diagnostics).toEqual([])
    const result = await compareWithDesired(
      engine,
      { target: stack },
      renderDesiredState(model).sql,
      scope,
      diagnostics
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
      { target: stack },
      `create schema app;
       create table app.profile (
         id uuid primary key,
         user_id uuid not null references auth.users (id)
       );`,
      scopeOf("app"),
      []
    )
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    expect(result.desired.model.tables.map((t) => t.name)).toEqual(["profile"])
    expect(result.desired.model.tables[0]?.foreignKeys).toHaveLength(1)
    expect(result.plan.actions.flatMap((a) => a.produces)).toContain(
      "table:app.profile"
    )
  })

  it("a deployed platform layer reconciles with no difference", async () => {
    // Шар `simetra` — частина моделі з «Користувачами» (спека користувачів
    // §3): межа звірки бачить схему сама, а розгорнутий шар — функції,
    // тригери на `auth.users`, гранти, відкладений FK — не дає дрейфу
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Users/Users.meta.json": catalog("Users", {
          role: "users",
          scope: "none",
          attributes: [
            attribute("locale", {
              type: "String",
              length: 5,
              required: true,
              defaultValue: "uk",
            }),
          ],
        }),
      })
    )
    expect(compiled.diagnostics).toEqual([])
    const model = compiled.model!
    const { scope, diagnostics } = await engineScope(model)
    expect(diagnostics).toEqual([])
    expect(scope.schemas).toContain("simetra")
    const desired = renderDesiredState(model).sql
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      desired,
      scope,
      (target) =>
        compareWithDesired(engine, { target }, desired, scope, diagnostics)
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    const result = outcome.value
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    expect(
      result.desired.model.tables
        .filter((t) => t.schema === "simetra")
        .map((t) => t.name)
    ).toEqual(["identities"])
    // Одиниці шару справді порівняно, а не відкинуто з обох боків: кожна
    // згенерована одиниця є в моделі тіні й жодна не «нерепрезентовна».
    // `REVOKE` — відсутність привілею, тож у каталозі одиницею не читається
    const layer = model.sqlUnits
      .filter((u) => u.generator === "platformLayer")
      .map((u) => u.identity)
      .filter((identity) => !identity.startsWith("grant:revoke:"))
    expect(layer.length).toBeGreaterThan(0)
    const read = new Set(result.desired.model.units.map((u) => u.identity))
    expect(layer.filter((identity) => !read.has(identity))).toEqual([])
    expect(result.diagnostics).toEqual([])
    expect(result.differences).toEqual([])
    expect(result.plan.empty).toBe(true)
    expect(result.empty).toBe(true)
  })
})
