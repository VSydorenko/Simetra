import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { engineScope } from "simetra/schema"
import {
  acceptDebt,
  customTable,
  metaFiles,
  project,
} from "../../compiler/__tests__/helpers"

/**
 * Межа керування й діагностика межі читають одну структуровану ціль одиниці
 * (план E2b, рішення 9): об'єкт моделі, який фільтр двигуна виключає з обох
 * боків звірки, — гучна помилка, а не тихе «порожньо».
 */

async function scopeOf(sql: string, files: Record<string, unknown> = {}) {
  // Предмет — межа керування за цілями одиниць, а не ратчет: увесь борг
  // фікстури прийнято.
  const result = await compile(
    await acceptDebt(
      metaFiles({
        "project.meta.json": project({ defaultSchema: "app" }),
        "custom-tables/Note/Note.meta.json": customTable("Note"),
        "sql/app/units.sql": sql,
        ...files,
      })
    )
  )
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
  return engineScope(result.model!)
}

async function outOfScope(
  sql: string,
  files: Record<string, unknown> = {}
): Promise<string[]> {
  const { diagnostics } = await scopeOf(sql, files)
  for (const d of diagnostics) {
    expect(d.code).toBe("engine.out-of-scope")
    expect(d.severity).toBe("error")
  }
  return diagnostics.map((d) => d.message)
}

const OUTSIDE =
  "lies outside the boundary the schema engine compares, so a comparison would never see it"

describe("the boundary takes the target of a unit", () => {
  it("grant target schema joins the scope", async () => {
    // Без цілі гранту `reports` не потрапляла в межу, і фільтр двигуна мовчки
    // виключав грант з обох боків звірки
    const { scope, diagnostics } = await scopeOf(
      "GRANT SELECT ON reports.t TO authenticated;\n"
    )
    expect(diagnostics).toEqual([])
    expect(scope.schemas).toEqual(["app", "reports"])
  })

  it("policy on storage.objects is in scope", async () => {
    const { scope, diagnostics } = await scopeOf(
      "CREATE POLICY app_read ON storage.objects FOR SELECT TO authenticated USING (true);\n"
    )
    expect(diagnostics).toEqual([])
    expect(scope.schemas).toEqual(["app"])
  })

  it("comment on a policy on storage.objects gives no diagnostic", async () => {
    // Правило двигуна `supabase.user-policy-surface-comment`: коментар на
    // політиці застосунку на таблиці поверхні — у межі
    expect(
      await outOfScope(
        [
          "CREATE POLICY app_read ON storage.objects FOR SELECT TO authenticated USING (true);",
          "COMMENT ON POLICY app_read ON storage.objects IS 'Read own files';",
          "",
        ].join("\n")
      )
    ).toEqual([])
  })

  it("ADP IN SCHEMA app gives no diagnostic", async () => {
    expect(
      await outOfScope(
        "ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO anon;\n"
      )
    ).toEqual([])
  })
})

describe("engine.out-of-scope", () => {
  it("grant on a provider table is out of scope", async () => {
    expect(
      await outOfScope("GRANT SELECT ON auth.users TO authenticated;\n")
    ).toEqual([
      `grant:grant:table:auth.users:authenticated:select ${OUTSIDE}: schema auth belongs to the provider`,
    ])
  })

  it("comment on auth.users is out of scope", async () => {
    expect(
      await outOfScope("COMMENT ON TABLE auth.users IS 'Users';\n")
    ).toEqual([
      `comment:table:auth.users ${OUTSIDE}: schema auth belongs to the provider`,
    ])
  })

  it("comment on a column of a provider table is out of scope", async () => {
    expect(
      await outOfScope("COMMENT ON COLUMN storage.objects.name IS 'Name';\n")
    ).toEqual([
      `comment:column:storage.objects.name ${OUTSIDE}: schema storage belongs to the provider`,
    ])
  })

  it("policy on storage.migrations is out of scope", async () => {
    expect(
      await outOfScope(
        "CREATE POLICY app_read ON storage.migrations FOR SELECT USING (true);\n"
      )
    ).toEqual([
      `policy:storage.migrations.app_read ${OUTSIDE}: the provider lets the application own policies only on its surface tables, and storage.migrations is not one of them`,
    ])
  })

  it("trigger on auth.users with a function in extensions is out of scope", async () => {
    expect(
      await outOfScope(
        [
          "CREATE TRIGGER app_on_user AFTER INSERT ON auth.users",
          "  FOR EACH ROW EXECUTE FUNCTION extensions.on_user();",
          "",
        ].join("\n")
      )
    ).toEqual([
      `trigger:auth.users.app_on_user ${OUTSIDE}: the trigger calls a function in the provider schema extensions, so the provider preset treats it as the provider's own`,
    ])
  })

  it("a function in the provider schema extensions", async () => {
    expect(
      await outOfScope(
        "CREATE FUNCTION extensions.app_hash(text) RETURNS text LANGUAGE sql AS $$ SELECT $1 $$;\n"
      )
    ).toEqual([
      `function:extensions.app_hash(text) ${OUTSIDE}: schema extensions belongs to the provider`,
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
      `table:auth.profile ${OUTSIDE}: schema auth belongs to the provider`,
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
      `extension:pg_graphql ${OUTSIDE}: the provider installs this extension itself`,
    ])
  })
})
