import { SchemaFrontendError } from "@supabase/pg-delta"
import { describe, expect, it } from "vitest"
import { seedFailure } from "../pg-delta/adapter"

/**
 * Збій засіву копії: відмовою стає лише впізнаний збій, решта — виняток, щоб
 * збій з'єднання чи помилка програми не ховалися за відмовою доказу.
 */
describe("seedFailure", () => {
  it("turns the engine's action cycle into engine.clone-failed", () => {
    const failure = seedFailure(
      new Error(
        'dependency cycle among 3 actions — this is a rule/emission bug, fix the rule (guardrail 4):\n  DROP FUNCTION "app"."f"()'
      )
    )
    expect(failure).toHaveLength(1)
    expect(failure![0]).toMatchObject({
      code: "engine.clone-failed",
      severity: "error",
      engineCode: "seed_failed",
    })
    expect(failure![0]!.params.detail).toMatch(
      /^preparing the copy failed: dependency cycle among 3 actions/
    )
  })

  it("keeps a rejected seed as engine.clone-failed", () => {
    const failure = seedFailure(new SchemaFrontendError("seed rejected"))
    expect(failure?.map((d) => [d.code, d.params.detail])).toEqual([
      ["engine.clone-failed", "preparing the copy failed: seed rejected"],
    ])
  })

  it("leaves any other error to be rethrown", () => {
    expect(
      seedFailure(new Error("Connection terminated unexpectedly"))
    ).toBeUndefined()
    // Текст циклу не на початку повідомлення — не запобіжник двигуна
    expect(
      seedFailure(new Error("wrapped: dependency cycle among 3 actions"))
    ).toBeUndefined()
    expect(seedFailure("dependency cycle among 3 actions")).toBeUndefined()
  })
})
