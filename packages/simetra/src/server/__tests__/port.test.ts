import { describe, expect, it } from "vitest"
import { fromPgPool, normalizeError, type PgPoolLike } from "../port"

function fakePool() {
  const calls: unknown[] = []
  const pool: PgPoolLike = {
    async connect() {
      calls.push("connect")
      return {
        async query(config) {
          calls.push({ query: config })
          return { rows: [{ r: "x" }], command: "SELECT", rowCount: 1 }
        },
        release(destroy) {
          calls.push({ release: destroy })
        },
      }
    },
  }
  return { pool, calls }
}

describe("fromPgPool", () => {
  it("passes text and values without a statement name", async () => {
    const { pool, calls } = fakePool()
    const client = await fromPgPool(pool).connect()
    expect(await client.query("SELECT $1::text AS r", ["a"])).toEqual({
      rows: [{ r: "x" }],
      command: "SELECT",
    })
    await client.query("BEGIN")
    client.release()
    client.release(true)
    expect(calls).toEqual([
      "connect",
      { query: { text: "SELECT $1::text AS r", values: ["a"] } },
      { query: { text: "BEGIN", values: [] } },
      { release: undefined },
      { release: true },
    ])
  })
})

describe("normalizeError", () => {
  it.each([
    ["a broken connection (class 08)", { code: "08006", message: "m" }, true],
    ["an administrator shutdown", { code: "57P01", message: "m" }, true],
    ["a crash shutdown", { code: "57P02", message: "m" }, true],
    ["a server that cannot connect now", { code: "57P03", message: "m" }, true],
    ["an error without a code", new Error("Connection terminated"), true],
    ["a Node network code", { code: "ECONNRESET", message: "m" }, true],
    ["a query cancel (57014)", { code: "57014", message: "m" }, false],
    ["a raised exception", { code: "P0001", message: "m" }, false],
  ])("connectionLost for %s", (_, error, lost) => {
    expect(normalizeError(error).connectionLost).toBe(lost)
  })

  it("keeps the driver fields of a raised exception", () => {
    const error = Object.assign(new Error("command.conflict"), {
      code: "P0001",
      detail: "version",
      hint: "7",
      severity: "ERROR",
      constraint: undefined,
    })
    expect(normalizeError(error)).toEqual({
      code: "P0001",
      message: "command.conflict",
      detail: "version",
      hint: "7",
      connectionLost: false,
    })
  })

  it("keeps constraint, table and column", () => {
    expect(
      normalizeError({
        code: "23502",
        message: "null value",
        table: "ticket",
        column: "code",
        constraint: "ticket_code_not_null",
      })
    ).toEqual({
      code: "23502",
      message: "null value",
      constraint: "ticket_code_not_null",
      table: "ticket",
      column: "code",
      connectionLost: false,
    })
  })

  it("drops a non-SQLSTATE code and survives a thrown string", () => {
    expect(normalizeError({ code: "ECONNREFUSED", message: "m" })).toEqual({
      message: "m",
      connectionLost: true,
    })
    expect(normalizeError("boom")).toEqual({
      message: "boom",
      connectionLost: true,
    })
  })
})
