import { describe, expect, it } from "vitest"
import { intentStep, planLocks, tableKey, type PlanStep } from "simetra/schema"

/**
 * Блокування плану (рішення 9 плану П3-2a): вихідні імена, режими й
 * детермінований порядок незалежно від порядку кроків.
 */

function engineStep(
  id: string,
  lockClass: string,
  tables: { schema: string; name: string }[]
): PlanStep {
  return {
    id,
    origin: "engine",
    sql: "SELECT 1",
    verb: "alter",
    class: "catalogOnly",
    lockClass,
    transactionality: "transactional",
    newSegmentBefore: false,
    lockedTables: tables,
    produces: [],
    consumes: [],
    destroys: [],
    destroyed: [],
    consumed: [],
    dataLoss: false,
    rewriteRisk: false,
    guards: [],
  }
}

const t = (schema: string, name: string) => ({ schema, name })

describe("planLocks", () => {
  it("locks access-exclusive tables first, then FK targets, each sorted", () => {
    const locks = planLocks({
      steps: [
        engineStep("s1", "accessExclusive", [t("b", "z"), t("a", "y")]),
        // Інші класи беруть своє блокування самі
        engineStep("s2", "share", [t("a", "share")]),
        engineStep("s3", "accessExclusive", [t("a", "x"), t("b", "z")]),
      ],
      newToOld: new Map(),
      foreignKeyTargets: [t("c", "q"), t("a", "p"), t("c", "q")],
    })
    expect(locks).toEqual([
      { schema: "a", name: "x", mode: "accessExclusive" },
      { schema: "a", name: "y", mode: "accessExclusive" },
      { schema: "b", name: "z", mode: "accessExclusive" },
      { schema: "a", name: "p", mode: "shareRowExclusive" },
      { schema: "c", name: "q", mode: "shareRowExclusive" },
    ])
  })

  it("sorts by code units, not by locale", () => {
    const locks = planLocks({
      steps: [
        engineStep("s1", "accessExclusive", [t("app", "b"), t("app", "B")]),
      ],
      newToOld: new Map(),
      foreignKeyTargets: [],
    })
    expect(locks.map((l) => l.name)).toEqual(["B", "b"])
  })

  it("translates new table names back to the old ones for engine steps only", () => {
    // Обмін: нове `a` — старе `b`, і навпаки. Крок наміру вже несе старе
    // ім'я, тож його перекладати не можна
    const newToOld = new Map([
      [tableKey("app", "a"), tableKey("app", "b")],
      [tableKey("app", "b"), tableKey("app", "a")],
      [tableKey("app", "party"), tableKey("app", "parties")],
    ])
    const intent: PlanStep = {
      ...intentStep("ALTER TABLE app.a RENAME TO tmp", [t("app", "a")]),
      id: "s1",
    }
    const locks = planLocks({
      steps: [
        intent,
        engineStep("s2", "accessExclusive", [t("app", "party")]),
        engineStep("s3", "accessExclusive", [t("app", "other")]),
      ],
      newToOld,
      foreignKeyTargets: [],
    })
    expect(locks).toEqual([
      { schema: "app", name: "a", mode: "accessExclusive" },
      { schema: "app", name: "other", mode: "accessExclusive" },
      { schema: "app", name: "parties", mode: "accessExclusive" },
    ])
  })

  it("keeps the stronger mode when a table is in both", () => {
    const locks = planLocks({
      steps: [engineStep("s1", "accessExclusive", [t("app", "t")])],
      newToOld: new Map(),
      foreignKeyTargets: [t("app", "t"), t("app", "u")],
    })
    expect(locks).toEqual([
      { schema: "app", name: "t", mode: "accessExclusive" },
      { schema: "app", name: "u", mode: "shareRowExclusive" },
    ])
  })

  it("locks nothing for a plan without access-exclusive steps", () => {
    expect(
      planLocks({
        steps: [engineStep("s1", "none", [t("app", "t")])],
        newToOld: new Map(),
        foreignKeyTargets: [],
      })
    ).toEqual([])
  })
})
