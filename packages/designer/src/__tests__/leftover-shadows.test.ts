import { describe, expect, it, vi } from "vitest"
import {
  expectNoLeftoverShadows,
  recordDropFailures,
  recordProvision,
  retryDropOnSuperuserBackend,
  shadowDropRetries,
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

  /** Прибирання, що відповідає `results` по черзі й рахує виклики. */
  const scripted = (
    results: ({ shadow: string; sqlstate?: string } | undefined)[]
  ) => {
    let calls = 0
    return {
      calls: () => calls,
      shadow: {
        cleanup: () =>
          Promise.resolve(results[Math.min(calls++, results.length - 1)]),
      },
    }
  }
  const retriesOf = (name: string) =>
    shadowDropRetries().filter((r) => r.shadow === name)

  it("repeats a drop refused with 42501 and records each retry under the shadow's name", async () => {
    const refused = { shadow: "pgdelta_shadow_r1", sqlstate: "42501" }
    const s = scripted([refused, refused, undefined])
    expect(await retryDropOnSuperuserBackend(s.shadow, 0).cleanup()).toBe(
      undefined
    )
    expect(s.calls()).toBe(3)
    expect(retriesOf("pgdelta_shadow_r1")).toEqual([
      { shadow: "pgdelta_shadow_r1", attempt: 1 },
      { shadow: "pgdelta_shadow_r1", attempt: 2 },
    ])
  })

  it("does not repeat a drop that failed with another SQLSTATE or without one", async () => {
    for (const failure of [
      { shadow: "pgdelta_shadow_r2", sqlstate: "55006" },
      { shadow: "pgdelta_shadow_r2" },
    ]) {
      const s = scripted([failure, undefined])
      expect(await retryDropOnSuperuserBackend(s.shadow, 0).cleanup()).toEqual(
        failure
      )
      expect(s.calls()).toBe(1)
    }
    expect(retriesOf("pgdelta_shadow_r2")).toEqual([])
  })

  it("stops after three retries, returns the 42501 and names the retries next to the leftover", async () => {
    await recordProvision(Promise.resolve({ name: "pgdelta_shadow_r3" }))
    const refused = { shadow: "pgdelta_shadow_r3", sqlstate: "42501" }
    const s = scripted([refused])
    const shadow = recordDropFailures(retryDropOnSuperuserBackend(s.shadow, 0))
    expect(await shadow.cleanup()).toEqual(refused)
    expect(s.calls()).toBe(4)
    expect(retriesOf("pgdelta_shadow_r3").map((r) => r.attempt)).toEqual([
      1, 2, 3,
    ])
    await expect(expectNoLeftoverShadows()).rejects.toThrow(
      "pgdelta_shadow_r3 (engine drop failed: SQLSTATE 42501; drop retried 3 time(s))"
    )
  })
})
