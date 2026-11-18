import { describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import { PLATFORM_SCHEMA, PLATFORM_STATE_TABLES } from "simetra/model"
import { policyDomain, profileLayer } from "../../../simetra/test/support"
import { query, withModelTarget } from "./support/db"

/**
 * Правило 1 (спека прав §6.1) судить некваліфіковану ціль DML тіла за
 * відомими таблицями схеми `simetra`: таблицями знімка й стану застосування
 * (`PLATFORM_STATE_TABLES`). Відношення схеми, якого ці переліки не знають,
 * некваліфіковане ім'я пройшло б повз правило, тож нове відношення платформи
 * без запису в знімку чи в переліку стану — червоний тест. Подання, у яке
 * Postgres не пише (`pg_relation_is_updatable`), ціллю DML не буває.
 */
describe("relations of the platform schema", () => {
  it("are tables of the snapshot or of the apply state", async () => {
    const result = await compile(policyDomain(profileLayer()))
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const model = result.model!
    const known = new Set<string>([
      ...PLATFORM_STATE_TABLES,
      ...model.physical.tables
        .filter((t) => t.schema === PLATFORM_SCHEMA)
        .map((t) => t.name),
    ])
    const live = await withModelTarget(model, (url) =>
      query<{ name: string }>(
        url,
        `SELECT c.relname AS name
         FROM pg_class c
         WHERE c.relnamespace = $1::regnamespace
           AND (c.relkind IN ('r', 'p', 'f')
             OR (c.relkind = 'v' AND pg_relation_is_updatable(c.oid, true) > 0))`,
        [PLATFORM_SCHEMA]
      )
    )
    expect(live.length).toBeGreaterThan(0)
    expect(
      live
        .map((r) => r.name)
        .filter((name) => !known.has(name))
        .sort()
    ).toEqual([])
  })
})
