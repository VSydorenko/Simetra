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
  testProvider,
} from "../../../../simetra/test/support"
import { leftoverShadows } from "../../__tests__/support/shadows"
import { scopeOf } from "./fixtures/engine-boundary"

/**
 * Порівняння бази з бажаним станом через тінь (спека П2 §9). Ціль —
 * база стеку, яку тести лише читають; пише порт тільки в тінь. Об'єкти
 * застосунку на поверхнях провайдера й шар користувачів —
 * `engine-desired.supabase.db.test.ts`.
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
      scopeOf("app", testProvider()),
      []
    )
    expect(ok.status).toBe("compared")
    expect(await leftoverShadows()).toEqual([])

    const failed = await compareWithDesired(
      engine,
      { target: stack },
      "create table app.nowhere (id int);",
      scopeOf("app", testProvider()),
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
      scopeOf("app", testProvider()),
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
        "project.meta.json": project({
          defaultSchema: "app",
          database: { provider: testProvider() },
        }),
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

  it("a model without the users catalog still has simetra in the boundary", async () => {
    // Прийнята таблиця, а не довідник: шару користувачів немає, але
    // послідовність версій рядків видається завжди й лежить у `simetra`
    const compiled = await compile(
      metaFiles({
        "project.meta.json": project({
          database: { provider: testProvider() },
        }),
        "custom-tables/Party/Party.meta.json": customTable("Party"),
      })
    )
    expect(compiled.diagnostics).toEqual([])
    const { scope, diagnostics } = await engineScope(compiled.model!)
    expect(diagnostics).toEqual([])
    expect(scope.schemas).toContain("simetra")
  })

  it("an empty comparison is empty only without differences", async () => {
    const result = await compareWithDesired(
      engine,
      { target: stack },
      "select 1;",
      scopeOf("app", testProvider()),
      []
    )
    expect(result.status).toBe("compared")
    if (result.status !== "compared") return
    expect(result.differences).toEqual([])
    expect(result.empty).toBe(true)
  })

  it("the engine's unmodeled kind is not repeated for a class the census names", async () => {
    const result = await compareWithDesired(
      engine,
      { target: stack },
      `create schema app;
       create type app.pair as (a int, b int);
       create cast (app.pair as text) with inout;`,
      scopeOf("app", testProvider()),
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
