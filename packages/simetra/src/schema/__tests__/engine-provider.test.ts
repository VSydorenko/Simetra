import { describe, expect, it } from "vitest"
import {
  renderProviderSeed,
  SUPABASE_BASE_EXTENSIONS,
  SUPABASE_EXTENSIONS,
  SUPABASE_SCHEMAS,
} from "../engine/provider/supabase"
import { UNMANAGED_SCHEMAS } from "../render/desired-state"

/**
 * Пресет провайдера узгоджений із рендером бажаного стану. Рівність пресету
 * політиці закріпленого двигуна тримає контрактний тест адаптера в
 * @simetra/designer (`schema-engine/__tests__/engine-policy.test.ts`).
 */
describe("provider preset matches the desired-state render", () => {
  it("schemas the render does not create are provider schemas", () => {
    // `public` існує в кожній базі Postgres — не схема провайдера
    for (const schema of UNMANAGED_SCHEMAS)
      if (schema !== "public")
        expect(SUPABASE_SCHEMAS, `render skips ${schema}`).toContain(schema)
  })
})

describe("provider base state", () => {
  it("base extensions are excluded from the boundary", () => {
    for (const ext of SUPABASE_BASE_EXTENSIONS)
      expect(SUPABASE_EXTENSIONS).toContain(ext.name)
  })

  it("provider seed grants the public preset and creates base extensions", () => {
    expect(renderProviderSeed()).toBe(
      "GRANT USAGE ON SCHEMA public TO PUBLIC, postgres, anon, authenticated, service_role;\n" +
        "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;\n" +
        'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;\n' +
        "CREATE EXTENSION IF NOT EXISTS pg_stat_statements WITH SCHEMA extensions;\n"
    )
  })
})
