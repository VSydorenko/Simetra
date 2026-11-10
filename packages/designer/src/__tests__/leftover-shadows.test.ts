import { describe, expect, it, vi } from "vitest"
import {
  expectNoLeftoverShadows,
  recordDropFailures,
  recordProvision,
} from "./support/shadows"

/**
 * Облік тіней називає причину сироти, яку повідомило прибирання двигуна
 * (`DROP`, що не вдався). Стек замінює підмінений `pg`: тінь «лишилась», а
 * `DROP` обліку вдається.
 */
vi.mock("pg", () => {
  class Client {
    async connect(): Promise<void> {}
    async query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }> {
      if (sql.startsWith("select datname"))
        return { rows: (params[0] as string[]).map((name) => ({ name })) }
      return { rows: [] }
    }
    async end(): Promise<void> {}
  }
  return { default: { Client } }
})

describe("leftover shadow accounting", () => {
  it("names the engine's failed drop next to the leftover", async () => {
    await recordProvision(Promise.resolve({ name: "pgdelta_shadow_a" }))
    await recordProvision(Promise.resolve({ name: "pgdelta_shadow_b" }))
    const shadow = recordDropFailures({
      cleanup: () =>
        Promise.resolve({ shadow: "pgdelta_shadow_a", sqlstate: "55006" }),
    })
    expect(await shadow.cleanup()).toEqual({
      shadow: "pgdelta_shadow_a",
      sqlstate: "55006",
    })
    await expect(expectNoLeftoverShadows()).rejects.toThrow(
      "Shadow databases this test file left behind: pgdelta_shadow_a (engine drop failed: SQLSTATE 55006), pgdelta_shadow_b; dropped"
    )
  })
})
