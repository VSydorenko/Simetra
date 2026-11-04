import { SchemaFrontendError } from "@supabase/pg-delta"
import { describe, expect, it } from "vitest"
import { seedFailure } from "../pg-delta/adapter"

/**
 * Збій засіву копії: відмовою стає лише впізнаний збій, решта — виняток, щоб
 * збій з'єднання чи помилка програми не ховалися за відмовою доказу.
 */
describe("seedFailure", () => {
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
    // Цикл порядку дій двигуна — дефект двигуна, а не відмова доказу
    expect(
      seedFailure(new Error("dependency cycle among 3 actions"))
    ).toBeUndefined()
  })
})
