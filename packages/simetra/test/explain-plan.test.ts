import { describe, expect, it } from "vitest"
import { RIGHTS_FUNCTIONS } from "../src/compiler/rights/functions"
import { repeatedCteScans } from "./db/explain-plan"

/*
 * Правило циклів гейта плану (М37) — над синтетичними планами: реальний план
 * гейта дає лише ту форму, яку обрав планувальник, тож заборонені форми
 * (цикл над CTE скоупів, підплан на шляху) доводить лише штучне дерево.
 */

const CONSTANTS = new Set(
  [
    RIGHTS_FUNCTIONS.projection,
    RIGHTS_FUNCTIONS.requires,
    RIGHTS_FUNCTIONS.domain,
  ].map((f) => f.name)
)

/** Цикли внутрішньої сторони. */
const LOOPS = 18

const leaf = (type: string, extra: Record<string, unknown>) => ({
  "Node Type": type,
  "Actual Loops": 1,
  ...extra,
})

/**
 * `Nested Loop`, внутрішня сторона — `CTE Scan on held` з `LOOPS` циклами,
 * зовнішня — `rights_projection` під фільтром `rights_requires` (форма плану
 * пари) і CTE з `outer`, кожен через хеш-з'єднання зі сталою. `parent` —
 * відношення самого циклу до батька `Result`.
 */
function loopPlan(outer: string[], parent = "Outer"): unknown {
  const outerSide = outer.reduce<Record<string, unknown>>(
    (side, cte) => ({
      "Node Type": "Hash Join",
      "Parent Relationship": "Outer",
      "Actual Loops": 1,
      Plans: [
        { ...side, "Parent Relationship": "Outer" },
        {
          "Node Type": "Hash",
          "Parent Relationship": "Inner",
          "Actual Loops": 1,
          Plans: [
            leaf("CTE Scan", {
              "CTE Name": cte,
              "Parent Relationship": "Outer",
            }),
          ],
        },
      ],
    }),
    leaf("Function Scan", {
      "Function Name": RIGHTS_FUNCTIONS.projection.name,
      "Parent Relationship": "Outer",
    })
  )
  return {
    Plan: {
      "Node Type": "Result",
      "Actual Loops": 1,
      Plans: [
        {
          "Node Type": "Nested Loop",
          "Parent Relationship": parent,
          "Actual Loops": 1,
          Plans: [
            leaf("Function Scan", {
              "Function Name": RIGHTS_FUNCTIONS.requires.name,
              "Parent Relationship": "InitPlan",
            }),
            outerSide,
            leaf("CTE Scan", {
              "CTE Name": "held",
              "Parent Relationship": "Inner",
              "Actual Loops": LOOPS,
            }),
          ],
        },
      ],
    },
  }
}

const repeated = [{ cte: "held", loops: LOOPS }]

describe("repeatedCteScans with constant loops", () => {
  it.each([
    ["a loop over constants is allowed", loopPlan([]), []],
    ["a loop over held is not constant", loopPlan(["held"]), repeated],
    [
      "a loop over my_scopes is not constant",
      loopPlan(["my_scopes"]),
      repeated,
    ],
    [
      "a SubPlan on the path is not constant",
      loopPlan([], "SubPlan"),
      repeated,
    ],
  ])("%s", (_, plan, expected) => {
    expect(repeatedCteScans(plan, CONSTANTS)).toEqual(expected)
  })

  it("without constants every repeated read counts", () => {
    expect(repeatedCteScans(loopPlan([]))).toEqual(repeated)
  })
})
