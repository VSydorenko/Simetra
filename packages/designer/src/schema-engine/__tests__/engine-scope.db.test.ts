import { describe, expect, it } from "vitest"
import { createPgDeltaEngine } from ".."
import { testDatabaseUrl } from "../../../../simetra/test/support"
import { scopeOf } from "./fixtures/engine-boundary"

/**
 * Порт `SchemaEngine` на живому стеку: extract у межі,
 * чистий plan і тінь бажаного стану з межею керування §6.9. Ціль — база
 * стеку, яку тести лише читають; пише порт тільки в тінь. Межа з поверхнями
 * провайдера й базовий стан тіні — `engine-scope.supabase.db.test.ts`.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }

describe("SchemaEngine on pg-delta", () => {
  it("stack database with no managed schemas extracts an empty model", async () => {
    const extracted = await engine.extract(stack, scopeOf())
    expect(extracted.model).toEqual({ tables: [], enumTypes: [], units: [] })
  })

  it("managed schema is kept", async () => {
    const desired = `
      create schema app;
      create table app.doc (id int primary key, title text not null);
      create text search configuration app.simple_ua (copy = simple);
      create schema other;
      create table other.x (id int);
    `
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      desired,
      scopeOf("app"),
      (shadow) => engine.extract(shadow, scopeOf("app"))
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    // Немодельований клас двигуна в межі — помилка перепису, а
    // `dangling_edge` засіяної тіні (шум засіву) відфільтровано
    const messages = outcome.value.diagnostics.map((d) => d.message)
    expect(
      outcome.value.diagnostics.some(
        (d) =>
          d.code === "engine.unmodeled-class" &&
          d.message.includes("textSearchConfiguration")
      )
    ).toBe(true)
    expect(messages.filter((m) => m.includes("dangling_edge"))).toEqual([])
    expect(outcome.value.model.tables).toEqual([
      {
        schema: "app",
        name: "doc",
        rowLevelSecurity: "off",
        columns: [
          { name: "id", type: "integer", notNull: true },
          { name: "title", type: "text", notNull: true },
        ],
        primaryKey: { name: "doc_pkey", columns: ["id"] },
        uniques: [],
        checks: [],
        foreignKeys: [],
        indexes: [],
      },
    ])
  })

  it("self plan is empty", async () => {
    const scope = scopeOf("app")
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      "create schema app; create table app.doc (id int primary key);",
      scope,
      async (shadow) => {
        const first = await engine.extract(shadow, scope)
        const second = await engine.extract(shadow, scope)
        return {
          same: engine.plan(first.catalog, first.catalog, scope),
          reextracted: engine.plan(first.catalog, second.catalog, scope),
        }
      }
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    expect(outcome.value.same).toMatchObject({
      actions: [],
      empty: true,
      diagnostics: [],
    })
    expect(outcome.value.reextracted).toMatchObject({
      actions: [],
      empty: true,
      diagnostics: [],
    })
  })

  it("unmodeled object in the shadow is reported as drift", async () => {
    // Двигун не моделює text search configuration: план не створить її на
    // цілі, і порт мусить сказати про це, а не віддати мовчазний план
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      `
        create schema app;
        create text search configuration app.simple_ua (copy = simple);
      `,
      scopeOf("app"),
      () => Promise.resolve(null)
    )
    expect(outcome.status).toBe("loaded")
    if (outcome.status !== "loaded") return
    expect(outcome.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "engine.unmodeled-drift",
        severity: "error",
        engineCode: "unmodeled_drift",
      })
    )
    expect(
      outcome.diagnostics.filter((d) => d.engineCode === "dangling_edge")
    ).toEqual([])
  })

  it("desired state that fails to load is shadow-failed", async () => {
    const outcome = await engine.withDesiredShadow(
      { target: stack },
      "create schema app; create table app.t (id int references app.missing (id));",
      scopeOf("app"),
      () => Promise.resolve("unreachable")
    )
    expect(outcome.status).toBe("shadow-failed")
    if (outcome.status !== "shadow-failed") return
    expect(outcome.diagnostics.length).toBeGreaterThan(0)
    for (const d of outcome.diagnostics) {
      expect(d.code).toBe("engine.shadow-load-failed")
      expect(d.severity).toBe("error")
    }
    expect(outcome.diagnostics.map((d) => d.message).join("\n")).toContain(
      'relation "app.missing" does not exist'
    )
  })

  it("shadow is dropped when the callback throws", async () => {
    await expect(
      engine.withDesiredShadow(
        { target: stack },
        "create schema app;",
        scopeOf("app"),
        () => Promise.reject(new Error("callback failed"))
      )
    ).rejects.toThrow("callback failed")
  })
})
