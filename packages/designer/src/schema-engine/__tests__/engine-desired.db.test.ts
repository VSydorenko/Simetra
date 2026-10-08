import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  compareWithDesired,
  engineScope,
  renderDesiredState,
  type EngineScope,
} from "simetra/schema"
import { createPgDeltaEngine } from ".."
import {
  shadowDatabaseCount,
  testDatabaseUrl,
  acceptDebt,
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
} from "../../../../simetra/test/support"
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
      { target: stack },
      "create schema app; create table app.t (id int primary key);",
      scopeOf("app"),
      []
    )
    expect(ok.status).toBe("compared")
    expect(await shadowDatabaseCount()).toBe(shadowsBefore)

    const failed = await compareWithDesired(
      engine,
      { target: stack },
      "create table app.nowhere (id int);",
      scopeOf("app"),
      []
    )
    expect(failed.status).toBe("shadow-failed")
    expect(await shadowDatabaseCount()).toBe(shadowsBefore)
  })

  it("broken desired sql is shadow-failed", async () => {
    const result = await compareWithDesired(
      engine,
      { target: stack },
      "create schema app; create table app.t (id int references app.missing (id));",
      scopeOf("app"),
      []
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

  it("a deployed row rule reconciles with no difference", async () => {
    // База друкує CHECK своїм текстом (`IN` — як `= ANY (ARRAY[…])`), а
    // бажаний стан — канонічним текстом компілятора: звірка через тінь
    // мусить бачити той самий обмеження, а не хибну зміну виразу
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project({ defaultSchema: "app" }),
        "catalogs/Party/Party.meta.json": catalog("Party", {
          schema: "app",
          attributes: [
            attribute("person", { type: "String", length: 20 }),
            attribute("company", { type: "String", length: 20 }),
            attribute("status", { type: "String", length: 10 }),
          ],
        }),
        "catalogs/Party/Party.sql":
          "ALTER TABLE app.party ADD CONSTRAINT party_one_side CHECK (num_nonnulls(person, company) <= 1 AND (status IN ('new', 'done') OR status IS NULL) AND person <> company);",
      })
    )
    expect(compiled.diagnostics).toEqual([])
    const model = compiled.model!
    const { scope, diagnostics } = await engineScope(model)
    expect(diagnostics).toEqual([])
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
        .find((t) => t.name === "party")
        ?.checks.map((c) => c.name)
    ).toContain("party_one_side")
    expect(result.differences).toEqual([])
    expect(result.plan.empty).toBe(true)
    expect(result.empty).toBe(true)
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

  it("a model without the users catalog leaves simetra outside the boundary", async () => {
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project(),
        "catalogs/Party/Party.meta.json": catalog("Party"),
      })
    )
    expect(compiled.diagnostics).toEqual([])
    const { scope, diagnostics } = await engineScope(compiled.model!)
    expect(diagnostics).toEqual([])
    expect(scope.schemas).not.toContain("simetra")
  })

  it("an empty comparison is empty only without differences", async () => {
    const result = await compareWithDesired(
      engine,
      { target: stack },
      "select 1;",
      scopeOf("app"),
      []
    )
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    expect(result.differences).toEqual([])
    expect(result.empty).toBe(true)
  })

  it("objects outside the boundary make the comparison non-empty", async () => {
    // Фільтр двигуна виключає таблицю в `auth` і з цілі, і з тіні: план і
    // моделі порожні, і лише діагностика межі не дає назвати звірку рівною
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project({ defaultSchema: "app" }),
        "custom-tables/Profile/Profile.meta.json": customTable("Profile", {
          schema: "auth",
        }),
      })
    )
    const model = compiled.model!
    const { scope, diagnostics } = await engineScope(model)
    expect(diagnostics.map((d) => d.code)).toEqual(["engine.out-of-scope"])
    const result = await compareWithDesired(
      engine,
      { target: stack },
      renderDesiredState(model).sql,
      scope,
      diagnostics
    )
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    expect(result.plan.empty).toBe(true)
    expect(result.differences).toEqual([])
    expect(result.diagnostics).toContainEqual(diagnostics[0])
    expect(result.empty).toBe(false)
  })

  it("the engine's unmodeled kind is not repeated for a class the census names", async () => {
    const result = await compareWithDesired(
      engine,
      { target: stack },
      `create schema app;
       create type app.pair as (a int, b int);
       create cast (app.pair as text) with inout;`,
      scopeOf("app"),
      []
    )
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    // Перепис тіні називає клас помилкою в межі, тож сигнал двигуна без межі
    // (з плану тіні чи з її extract) вдруге не звучить
    expect(
      result.diagnostics
        .filter((d) => d.code === "engine.unmodeled-class")
        .map((d) => d.message)
    ).toEqual([expect.stringMatching(/ of class cast /)])
    expect(
      result.diagnostics.filter((d) => d.engineCode === "unmodeled_kind")
    ).toEqual([])
  })
})
