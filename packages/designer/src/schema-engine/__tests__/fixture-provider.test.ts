import { describe, expect, it } from "vitest"
import { scopeOf } from "./fixtures/engine-boundary"
import { classFixtures } from "./fixtures/round-trip-classes"

/**
 * Спільні фікстури рушія з літералами провайдера (рішення Р7 плану ПГ-2b):
 * без аргументу — `supabase`, з `"postgres"` — дані профілю `postgres`.
 */
describe("provider of the engine fixtures", () => {
  it("scopeOf: supabase by default, postgres when asked", () => {
    expect(scopeOf("app")).toEqual({ schemas: ["app"], provider: "supabase" })
    expect(scopeOf()).toEqual({ schemas: [], provider: "supabase" })
    expect(scopeOf("app", "postgres")).toEqual({
      schemas: ["app"],
      provider: "postgres",
    })
  })

  it("class fixtures of postgres carry no Supabase role, identity or owner", () => {
    const text = JSON.stringify(
      classFixtures("postgres").map((f) => [f.sql, f.expected])
    )
    // Ключі проєкції (`anon:`) — лише мітки, не ролі
    expect(text).not.toMatch(
      /\b(authenticated|anon|service_role)\b(?!":)|\bauth\.|\/postgres\b|"postgres"|ROLE postgres\b/
    )
    expect(text).toContain("simetra_anon=r/simetra_owner")
    expect(text).toContain('better_auth.\\"user\\"')
  })

  it("the Supabase preset classes exist only on supabase", () => {
    const names = (p?: "postgres") => classFixtures(p).map((f) => f.name)
    const preset = "public schema ACL differs from the provider preset"
    expect(names()).toContain(preset)
    expect(names("postgres")).not.toContain(preset)
    expect(names("postgres")).toEqual(
      names().filter(
        (n) =>
          n !== preset &&
          n !== "a preset grantee with one privilege swapped for another"
      )
    )
  })
})
