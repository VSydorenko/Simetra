import { describe, expect, it } from "vitest"
import { withRollback } from "./connection"

describe("DB test stack", () => {
  it("provider base state is visible", async () => {
    await withRollback(async (client) => {
      const result = await client.query(
        "SELECT to_regclass('auth.users') IS NOT NULL AS present"
      )
      expect(result.rows[0]).toEqual({ present: true })
    })
  })
})
