import { describe, expect, it } from "vitest"
import {
  PROVIDER_EVENT_SOURCES,
  PROVIDER_IDENTITY_SOURCES,
} from "simetra/model"
import { onSurface } from "../engine/desired"

/**
 * Пресет джерел подій — T0, поверхня тригерів — T2: T1 не імпортує T2, тож
 * збіг двох фактів провайдера доводить цей тест, а не компілятор. Підписка
 * на таблицю поза поверхнею дала б тригер, який межа керування вважає чужим.
 */
describe("provider event sources", () => {
  it("every supabase event source lies on the trigger surface", () => {
    expect(PROVIDER_EVENT_SOURCES.supabase.length).toBeGreaterThan(0)
    for (const source of PROVIDER_EVENT_SOURCES.supabase) {
      expect(
        onSurface("trigger", { schema: source.schema, object: source.table }),
        `${source.schema}.${source.table}`
      ).toBe(true)
    }
  })

  it("the supabase identity source lies on the trigger surface", () => {
    // Провізія — тригер на таблиці облікових записів: поза поверхнею межа
    // керування вважала б його чужим.
    const { table } = PROVIDER_IDENTITY_SOURCES.supabase
    expect(
      onSurface("trigger", { schema: table.schema, object: table.name })
    ).toBe(true)
  })
})
