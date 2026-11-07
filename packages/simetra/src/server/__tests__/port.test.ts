import { describe, expect, it } from "vitest"
import { fromPgPool, normalizeError, type PgPoolLike } from "../port"

type ErrorListener = (error: Error) => void

function fakePool() {
  const calls: unknown[] = []
  // Емітер події `error` клієнта: лише те, що читає порт.
  const listeners = new Set<ErrorListener>()
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
        on(_event, listener) {
          listeners.add(listener)
        },
        removeListener(_event, listener) {
          listeners.delete(listener)
        },
      }
    },
  }
  // Як `EventEmitter`: подія `error` без слухача кидає з `emit`, тобто з процесу.
  const emitError = (error: Error) => {
    if (listeners.size === 0) throw error
    for (const listener of listeners) listener(error)
  }
  return { pool, calls, listeners, emitError }
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
    const types = expect.objectContaining({
      getTypeParser: expect.any(Function),
    })
    expect(calls).toEqual([
      "connect",
      { query: { text: "SELECT $1::text AS r", values: ["a"], types } },
      { query: { text: "BEGIN", values: [], types } },
      { release: undefined },
      { release: true },
    ])
  })

  // Парсери типів host-а не діють: рантайм читає текст Postgres, як є.
  it("reads every column as Postgres text", async () => {
    const { pool, calls } = fakePool()
    await (await fromPgPool(pool).connect()).query("SELECT 1")
    const { types } = (calls[1] as { query: { types: RawTypes } }).query
    for (const oid of [16, 20, 25, 1700, 3802]) {
      expect(types.getTypeParser(oid, "text")("t")).toBe("t")
    }
  })
})

// pg-pool знімає свого слухача простою при видачі: `FATAL` простоюючого
// клієнта (`idle_in_transaction_session_timeout`) без слухача порту валив би
// процес, а наступний запит `pg` відхилив би без SQLSTATE.
describe("fromPgPool error listener", () => {
  const fatal = () =>
    Object.assign(new Error("terminating connection"), { code: "25P03" })

  it("keeps the first error event and rejects the next query with it", async () => {
    const { pool, calls, emitError } = fakePool()
    const client = await fromPgPool(pool).connect()
    await client.query("SELECT 1")
    const first = fatal()
    expect(() => emitError(first)).not.toThrow()
    emitError(new Error("Connection terminated unexpectedly"))
    await expect(client.query("ROLLBACK")).rejects.toBe(first)
    await expect(client.query("ROLLBACK")).rejects.toMatchObject({
      code: "25P03",
    })
    // Мертвому з'єднанню запит не надсилається.
    expect(calls).toEqual(["connect", { query: expect.anything() }])
  })

  it.each([undefined, true])(
    "release(%s) removes the listener",
    async (destroy) => {
      const { pool, listeners } = fakePool()
      const client = await fromPgPool(pool).connect()
      expect(listeners.size).toBe(1)
      client.release(destroy)
      expect(listeners.size).toBe(0)
    }
  )
})

type RawTypes = {
  getTypeParser: (oid: number, format: string) => (value: string) => unknown
}

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

  it("never throws, whatever was thrown", () => {
    const revoked = Proxy.revocable({}, {})
    revoked.revoke()
    const throwing = Object.defineProperty({}, "code", {
      get() {
        throw new Error("getter")
      },
    })
    expect(normalizeError(Object.create(null))).toEqual({
      message: "unknown error",
      connectionLost: true,
    })
    expect(normalizeError(revoked.proxy)).toEqual({
      message: "unknown error",
      connectionLost: true,
    })
    expect(normalizeError(throwing)).toEqual({
      message: "[object Object]",
      connectionLost: true,
    })
    expect(normalizeError(undefined)).toEqual({
      message: "undefined",
      connectionLost: true,
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
