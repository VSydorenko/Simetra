import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { engineScope } from "simetra/schema"
import {
  customTable,
  metaFiles,
  project,
} from "../../compiler/__tests__/helpers"

/** Межа керування з моделі (план E2a, задача 6): рішення плану 3. */

async function scopeOf(
  sql: string,
  defaultSchema = "app",
  files: Record<string, unknown> = {}
) {
  const result = await compile(
    metaFiles({
      "project.meta.json": project({ defaultSchema }),
      "custom-tables/Note/Note.meta.json": customTable("Note"),
      "sql/app/units.sql": sql,
      ...files,
    })
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return engineScope(result.model!)
}

describe("engineScope", () => {
  it("takes the default schema and the schemas of tables and units", async () => {
    const scope = await scopeOf(
      "CREATE VIEW reports.note_view AS SELECT id FROM app.note;\n"
    )
    expect(scope).toEqual({
      scope: { schemas: ["app", "reports"], provider: "supabase" },
      diagnostics: [],
    })
  })

  it("does not make a provider schema managed because of a provider object", async () => {
    const scope = await scopeOf(
      [
        "CREATE FUNCTION app.on_user() RETURNS trigger LANGUAGE plpgsql",
        "  AS $$ BEGIN RETURN NEW; END $$;",
        "CREATE TRIGGER app_on_user AFTER INSERT ON auth.users",
        "  FOR EACH ROW EXECUTE FUNCTION app.on_user();",
        "CREATE POLICY app_read ON storage.objects FOR SELECT TO authenticated USING (true);",
        "GRANT SELECT ON app.note TO authenticated;",
        "",
      ].join("\n")
    )
    // Політика й тригер на таблицях провайдера — поверхня пресету, у межі
    expect(scope).toEqual({
      scope: { schemas: ["app"], provider: "supabase" },
      diagnostics: [],
    })
  })
})

/**
 * Об'єкт моделі, який фільтр двигуна виключає з обох боків звірки, — гучна
 * помилка, а не тихе «порожньо».
 */
describe("engine.out-of-scope", () => {
  async function outOfScope(
    sql: string,
    files: Record<string, unknown> = {}
  ): Promise<string[]> {
    const { diagnostics } = await scopeOf(sql, "app", files)
    for (const d of diagnostics) {
      expect(d.code).toBe("engine.out-of-scope")
      expect(d.severity).toBe("error")
    }
    return diagnostics.map((d) => d.message)
  }

  it("a function in the provider schema extensions", async () => {
    expect(
      await outOfScope(
        "CREATE FUNCTION extensions.app_hash(text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;\n"
      )
    ).toEqual([
      "function:extensions.app_hash(text) lies outside the boundary the schema engine compares, so a comparison would never see it: schema extensions belongs to the provider",
    ])
  })

  it("a table in auth", async () => {
    expect(
      await outOfScope("", {
        "custom-tables/Profile/Profile.meta.json": customTable("Profile", {
          schema: "auth",
        }),
      })
    ).toEqual([
      "table:auth.profile lies outside the boundary the schema engine compares, so a comparison would never see it: schema auth belongs to the provider",
    ])
  })

  it("global default privileges", async () => {
    const [message, ...rest] = await outOfScope(
      "ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO anon;\n"
    )
    expect(rest).toEqual([])
    expect(message).toMatch(/^defaultPrivileges:/)
    expect(message).toContain(
      "default privileges without IN SCHEMA belong to no managed schema"
    )
  })

  it("a provider extension", async () => {
    expect(
      await outOfScope("CREATE EXTENSION IF NOT EXISTS pg_graphql;\n")
    ).toEqual([
      "extension:pg_graphql lies outside the boundary the schema engine compares, so a comparison would never see it: the provider installs this extension itself",
    ])
  })
})
