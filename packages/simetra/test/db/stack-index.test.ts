import { describe, expect, it } from "vitest"
import {
  assertSupabaseUnindexed,
  postgresStack,
  stackIndex,
  stackPool,
} from "../../../../scripts/db-stack-index.mjs"

describe("stackIndex", () => {
  it("defaults to 1", () => {
    expect(stackIndex({})).toBe(1)
  })

  it("reads SIMETRA_STACK", () => {
    expect(stackIndex({ SIMETRA_STACK: "4" })).toBe(4)
  })

  it.each(["0", "10", "-1", "1.5", "abc", "", " 2", "01"])(
    "rejects %j and names the variable",
    (value) => {
      expect(() => stackIndex({ SIMETRA_STACK: value })).toThrow(
        /SIMETRA_STACK\b/
      )
    }
  )
})

describe("stackPool", () => {
  it("defaults to 1..9 ascending", () => {
    expect(stackPool({})).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it("keeps the listed order", () => {
    expect(stackPool({ SIMETRA_STACK_POOL: "3, 2" })).toEqual([3, 2])
  })

  it.each(["", "2,", "2,2", "0", "10", "a", "1;2"])(
    "rejects %j and names the variable",
    (value) => {
      expect(() => stackPool({ SIMETRA_STACK_POOL: value })).toThrow(
        /SIMETRA_STACK_POOL/
      )
    }
  )
})

describe("postgresStack", () => {
  it("stack 1 keeps the historical identity", () => {
    expect(postgresStack(1)).toEqual({
      index: 1,
      key: "postgres",
      project: "simetra-pg",
      lockPath: "/tmp/simetra-db-stack-postgres.lock",
      pgPort: 54422,
      garageS3Port: 3900,
      garageAdminPort: 3903,
    })
  })

  it("stack 2 is shifted by 10 ports", () => {
    expect(postgresStack(2)).toEqual({
      index: 2,
      key: "postgres-2",
      project: "simetra-pg-2",
      lockPath: "/tmp/simetra-db-stack-postgres-2.lock",
      pgPort: 54432,
      garageS3Port: 3910,
      garageAdminPort: 3913,
    })
  })

  it("stack 9 ends the range", () => {
    const stack = postgresStack(9)
    expect(stack.pgPort).toBe(54502)
    expect(stack.garageS3Port).toBe(3980)
    expect(stack.garageAdminPort).toBe(3983)
  })

  it("never shares a project, lock or port between stacks", () => {
    const stacks = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(postgresStack)
    for (const field of [
      "key",
      "project",
      "lockPath",
      "pgPort",
      "garageS3Port",
      "garageAdminPort",
    ] as const) {
      expect(new Set(stacks.map((s) => s[field])).size).toBe(9)
    }
  })

  it.each([0, 10, 1.5, Number.NaN])("rejects index %s", (value) => {
    expect(() => postgresStack(value)).toThrow(/Stack index/)
  })
})

describe("assertSupabaseUnindexed", () => {
  it("accepts no selection and stack 1", () => {
    expect(() => assertSupabaseUnindexed({})).not.toThrow()
    expect(() => assertSupabaseUnindexed({ SIMETRA_STACK: "1" })).not.toThrow()
  })

  it("refuses another stack with a pointer to ADR-0117", () => {
    expect(() => assertSupabaseUnindexed({ SIMETRA_STACK: "2" })).toThrow(
      /ADR-0117/
    )
  })

  it("refuses a pool with a pointer to ADR-0117", () => {
    expect(() => assertSupabaseUnindexed({ SIMETRA_STACK_POOL: "1" })).toThrow(
      /ADR-0117/
    )
  })

  it("reports an invalid SIMETRA_STACK as such", () => {
    expect(() => assertSupabaseUnindexed({ SIMETRA_STACK: "x" })).toThrow(
      /SIMETRA_STACK must be/
    )
  })
})
