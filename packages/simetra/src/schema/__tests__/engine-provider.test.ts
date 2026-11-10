import { describe, expect, it } from "vitest"
import { PROVIDER_SCHEMAS } from "simetra/model"
import {
  PROVIDER_BASE_EXTENSIONS,
  PROVIDER_EVENT_TRIGGERS,
  PROVIDER_EXPECTED_BLIND_FUNCTIONS,
  PROVIDER_INSTALLABLE_EXTENSIONS,
  PROVIDER_LOCKS,
  PROVIDER_PUBLIC_SCHEMA_GRANTS,
  PROVIDER_SHADOW_TEMPLATES,
  PROVIDER_SURFACES,
  PROVIDER_SYSTEM_ROLES,
  PROVIDER_UNMANAGED_EXTENSIONS,
  renderProviderSeed,
} from "../engine/provider/presets"
import { UNMANAGED_SCHEMAS } from "../render/desired-state"

/**
 * Пресет провайдера узгоджений із рендером бажаного стану. Рівність пресету
 * політиці закріпленого двигуна тримає контрактний тест адаптера в
 * @simetrajs/designer (`schema-engine/__tests__/engine-policy.test.ts`).
 */
describe("provider preset matches the desired-state render", () => {
  it("schemas the render does not create are provider schemas", () => {
    // `public` існує в кожній базі Postgres — не схема провайдера
    for (const schema of UNMANAGED_SCHEMAS)
      if (schema !== "public")
        expect(PROVIDER_SCHEMAS.supabase, `render skips ${schema}`).toContain(
          schema
        )
  })
})

describe("provider base state", () => {
  it("base extensions are excluded from the boundary", () => {
    for (const ext of PROVIDER_BASE_EXTENSIONS.supabase)
      expect(PROVIDER_UNMANAGED_EXTENSIONS.supabase).toContain(ext.name)
  })

  it("provider seed grants the public preset and creates base extensions", () => {
    expect(renderProviderSeed("supabase")).toBe(
      "GRANT USAGE ON SCHEMA public TO PUBLIC, postgres, anon, authenticated, service_role;\n" +
        "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;\n" +
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;\n' +
        "CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;\n"
    )
  })
})

describe("postgres preset of T2", () => {
  it("unmanaged extensions, event triggers, base state and seed", () => {
    expect(PROVIDER_UNMANAGED_EXTENSIONS.postgres).toEqual([
      "plpgsql",
      "plpgsql_check",
    ])
    expect(PROVIDER_EVENT_TRIGGERS.postgres).toEqual([])
    expect(PROVIDER_PUBLIC_SCHEMA_GRANTS.postgres).toEqual([
      { grantee: "PUBLIC", privileges: ["USAGE"] },
    ])
    expect(PROVIDER_BASE_EXTENSIONS.postgres).toEqual([])
    // Тінь копіюється з шаблону, що базовий стан уже несе
    expect(renderProviderSeed("postgres")).toBe("")
  })

  it("surface is the Better Auth user table, triggers only", () => {
    expect(PROVIDER_SURFACES.postgres).toEqual([
      { schema: "better_auth", table: "user", classes: ["trigger"] },
    ])
  })

  it("has no system roles, locks, installable extensions or blind functions", () => {
    expect(PROVIDER_SYSTEM_ROLES.postgres).toEqual([])
    expect(PROVIDER_LOCKS.postgres).toEqual({ sources: [], services: [] })
    expect(PROVIDER_INSTALLABLE_EXTENSIONS.postgres).toEqual([])
    expect(PROVIDER_EXPECTED_BLIND_FUNCTIONS.postgres).toEqual([])
  })

  it("shadow template: none for supabase, simetra_template for postgres", () => {
    expect(PROVIDER_SHADOW_TEMPLATES).toEqual({
      supabase: null,
      postgres: "simetra_template",
    })
  })
})
