import { describe, expect, it } from "vitest"
import { catalogCoverageGaps } from "./fingerprint-coverage.support"

/**
 * Контракт покриття відбитка (платформна спека §6.2): кожне поле моделі
 * закріпленого двигуна має секцію відбитка чи виняток із причиною, і мапа не
 * тримає полів, яких модель уже не має. Нове поле альфи pg-delta валить тест.
 */

describe("fingerprint coverage of the engine model", () => {
  it("maps every engine property to a section or an exception", async () => {
    // Мітка безпеки без постачальника не має екземпляра, тож контракт
    // справедливо називає її види застарілими: це точний очікуваний набір
    // профілю, а не послаблення. Варіант із міткою `pgsodium` — у
    // `fingerprint-coverage.supabase.db.test.ts`
    expect(await catalogCoverageGaps("")).toEqual(["stale kind securityLabel"])
  })
})
