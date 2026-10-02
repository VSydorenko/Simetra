import { describe, expect, it } from "vitest"
import { SUPABASE_SCHEMAS } from "../engine/provider/supabase"
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
