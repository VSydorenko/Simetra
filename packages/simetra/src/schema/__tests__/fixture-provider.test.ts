import { describe, expect, it } from "vitest"
import {
  rightsFiles,
  singleTenantRights,
} from "../../compiler/__tests__/fixtures/rights"
import { customTables, FIXTURES, movementQuery } from "./fixtures/e1-fixtures"

/**
 * Спільні фікстури з літералами провайдера (рішення Р7 плану ПГ-2b): без
 * аргументу — `supabase`, тож unit-тести не змінюються; з `"postgres"` —
 * дані профілю `postgres`, які передає DB-тест цього стека.
 */
const providerOf = (files: Map<string, string>): unknown =>
  (
    JSON.parse(files.get("project.meta.json")!) as {
      database: { provider: unknown }
    }
  ).database.provider

describe("provider of the shared fixtures", () => {
  it.each([
    ["rightsFiles", (p?: "postgres") => rightsFiles({}, p)],
    ["singleTenantRights", (p?: "postgres") => singleTenantRights({}, p)],
    ...FIXTURES,
  ] as [string, (p?: "postgres") => Map<string, string>][])(
    "%s: supabase by default, postgres when asked",
    (_, fixture) => {
      expect(providerOf(fixture())).toBe("supabase")
      expect(providerOf(fixture("postgres"))).toBe("postgres")
    }
  )

  it("custom tables refer to the identity table of the profile", () => {
    const fk = (files: Map<string, string>) =>
      (
        JSON.parse(files.get("custom-tables/Audit/Audit.meta.json")!) as {
          foreignKeys: { name: string; references: unknown }[]
        }
      ).foreignKeys.find((k) => k.name === "audit_user_fk")?.references
    expect(fk(customTables())).toEqual({
      external: { schema: "auth", table: "users", columns: ["id"] },
    })
    expect(fk(customTables("postgres"))).toEqual({
      external: { schema: "better_auth", table: "user", columns: ["id"] },
    })
  })

  it("the scope function reads sub without the Supabase function on postgres", () => {
    const sql = (files: Map<string, string>) =>
      [...files.values()].find((text) => text.includes("app.user_ids()"))!
    expect(sql(movementQuery())).toContain("auth.uid()")
    expect(sql(movementQuery("postgres"))).not.toContain("auth.")
    expect(sql(movementQuery("postgres"))).toContain("->> 'sub'")
  })
})
