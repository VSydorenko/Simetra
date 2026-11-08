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
  attribute,
  catalog,
  customTable,
  metaFiles,
  project,
} from "../../../../simetra/test/support"
import { leftoverShadows } from "../../__tests__/support/shadows"
import { scopeOf } from "./fixtures/engine-boundary"

/**
 * Порівняння бази з бажаним станом через тінь (спека П2 §9). Ціль —
 * база стеку, яку тести лише читають; пише порт тільки в тінь. Об'єкти
 * застосунку на поверхнях провайдера — `engine-desired.supabase.db.test.ts`.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

describe("compareWithDesired", () => {
  it("no shadow is left behind", async () => {
    // Облік провізій файлу: тут — успіх, а нижче — помилка
    const ok = await compareWithDesired(
      engine,
      { target: stack },
      "create schema app; create table app.t (id int primary key);",
      scopeOf("app"),
      []
    )
    expect(ok.status).toBe("compared")
    expect(await leftoverShadows()).toEqual([])

    const failed = await compareWithDesired(
      engine,
      { target: stack },
      "create table app.nowhere (id int);",
      scopeOf("app"),
      []
    )
    expect(failed.status).toBe("shadow-failed")
    expect(await leftoverShadows()).toEqual([])
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
    // Прийнята таблиця, а не довідник: механіка рядка Catalog лежить у
    // `simetra` і ввела б схему в межу без шару (simetra out-of-scope.test.ts).
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project(),
        "custom-tables/Party/Party.meta.json": customTable("Party"),
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
