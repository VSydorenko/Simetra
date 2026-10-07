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
  it("takes the provider from the project database", async () => {
    const scope = await scopeOf("")
    expect(scope.scope.provider).toBe("supabase")
  })

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
