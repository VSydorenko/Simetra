import { describe, expect, it } from "vitest"
import {
  destroysConnection,
  fromPgPool,
  normalizeError,
  type DatabaseError,
  type PgPoolLike,
} from "../port"

type Listener = (error: Error) => void

/**
 * `query` — відповідь запиту: результат або відмова; `connect` — відмова
 * `pool.connect()`.
 */
function fakePool(
  options: {
    query?: () => Promise<{ rows: Record<string, unknown>[]; command: string }>
    connect?: unknown
  } = {}
) {
  const calls: unknown[] = []
  // Емітер подій `error` і `end` клієнта: лише те, що читає порт.
  const listeners = new Set<Listener>()
  const ends = new Set<() => void>()
  const pool: PgPoolLike = {
    async connect() {
      calls.push("connect")
      if (options.connect !== undefined) throw options.connect
      return {
        async query(config) {
          calls.push({ query: config })
          if (options.query !== undefined) return options.query()
          return { rows: [{ r: "x" }], command: "SELECT", rowCount: 1 }
        },
        release(destroy) {
          calls.push({ release: destroy })
        },
        on(event: "error" | "end", listener: Listener) {
          if (event === "error") listeners.add(listener)
          else ends.add(listener as () => void)
        },
        removeListener(event: "error" | "end", listener: Listener) {
          if (event === "error") listeners.delete(listener)
          else ends.delete(listener as () => void)
        },
      }
    },
  }
  // Як `EventEmitter`: подія `error` без слухача кидає з `emit`, тобто з процесу.
  const emitError = (error: Error) => {
    if (listeners.size === 0) throw error
    for (const listener of listeners) listener(error)
  }
  const emitEnd = () => {
    for (const listener of ends) listener()
  }
  return { pool, calls, listeners, ends, emitError, emitEnd }
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
    "release(%s) removes the listeners",
    async (destroy) => {
      const { pool, listeners, ends } = fakePool()
      const client = await fromPgPool(pool).connect()
      expect([listeners.size, ends.size]).toEqual([1, 1])
      client.release(destroy)
      expect([listeners.size, ends.size]).toEqual([0, 0])
    }
  )
})

// Р11: без SQLSTATE обрив знає лише порт — за подією клієнта до відмови
// запиту чи за відмовою `pool.connect()`; інакше це вада драйвера чи T3.
describe("fromPgPool connection loss without SQLSTATE", () => {
  const terminated = () => new Error("Connection terminated unexpectedly")

  it.each<[string, (pool: ReturnType<typeof fakePool>) => void]>([
    ["an error event", (p) => p.emitError(terminated())],
    ["an end event", (p) => p.emitEnd()],
  ])("a query rejected after %s is a lost connection", async (_, emit) => {
    let fail: (error: Error) => void = () => undefined
    const fake = fakePool({
      query: () => new Promise((_, reject) => (fail = reject)),
    })
    const client = await fromPgPool(fake.pool).connect()
    const query = client.query("SELECT 1")
    // Як `pg`: подія синхронно, відмова запиту — пізніше (`nextTick`).
    await Promise.resolve()
    emit(fake)
    const raw = terminated()
    fail(raw)
    const thrown = await query.catch((error: unknown) => error)
    expect(thrown).toBe(raw)
    expect(normalizeError(thrown).connectionLost).toBe(true)
  })

  it("a query rejected without an event is not a lost connection", async () => {
    const raw = new TypeError("driver bug")
    const { pool } = fakePool({ query: () => Promise.reject(raw) })
    const client = await fromPgPool(pool).connect()
    const thrown = await client.query("SELECT 1").catch((e: unknown) => e)
    expect(thrown).toBe(raw)
    expect(normalizeError(thrown)).toEqual({
      message: "driver bug",
      connectionLost: false,
    })
  })

  it("a query after an error event without SQLSTATE is a lost connection", async () => {
    const fake = fakePool()
    const client = await fromPgPool(fake.pool).connect()
    fake.emitError(terminated())
    const thrown = await client.query("ROLLBACK").catch((e: unknown) => e)
    expect(normalizeError(thrown).connectionLost).toBe(true)
  })

  it("a failed pool.connect() is a lost connection", async () => {
    const raw = new Error("timeout exceeded when trying to connect")
    const { pool } = fakePool({ connect: raw })
    const thrown = await fromPgPool(pool)
      .connect()
      .catch((e: unknown) => e)
    expect(thrown).toBe(raw)
    expect(normalizeError(thrown).connectionLost).toBe(true)
  })
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
    ["an error without a code", new TypeError("driver bug"), false],
    ["a Node network code", { code: "ECONNRESET", message: "m" }, true],
    // `EPIPE` має форму SQLSTATE, але мережевий код — не код бази.
    ["EPIPE", { code: "EPIPE", message: "m" }, true],
    ["a query cancel (57014)", { code: "57014", message: "m" }, false],
    ["a raised exception", { code: "P0001", message: "m" }, false],
  ])("connectionLost for %s", (_, error, lost) => {
    expect(normalizeError(error).connectionLost).toBe(lost)
  })

  it.each([
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "ECONNREFUSED",
    "ECONNABORTED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
  ])(
    "the Node network code %s is a lost connection without SQLSTATE",
    (code) => {
      expect(normalizeError({ code, message: "m" })).toEqual({
        message: "m",
        connectionLost: true,
      })
    }
  )

  // Відмова `connect()` — з'єднання немає, хоч би що кинув порт.
  it("an error without SQLSTATE from connect() is a lost connection", () => {
    expect(normalizeError(new TypeError("x"), true).connectionLost).toBe(true)
  })

  // SQLSTATE вирішує й на `connect()`: відмова бази — не обрив.
  it("a SQLSTATE refusal of connect() keeps its class", () => {
    expect(
      normalizeError({ code: "28P01", message: "m" }, true).connectionLost
    ).toBe(false)
  })

  it.each<[string, Partial<DatabaseError>, boolean]>([
    ["a lost connection", { code: "08006", connectionLost: true }, true],
    ["an error without SQLSTATE", { connectionLost: false }, true],
    ["a database refusal", { code: "P0001", connectionLost: false }, false],
  ])("destroysConnection for %s", (_, fields, destroy) => {
    expect(
      destroysConnection({ message: "m", connectionLost: false, ...fields })
    ).toBe(destroy)
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
      connectionLost: false,
    })
    expect(normalizeError(revoked.proxy)).toEqual({
      message: "unknown error",
      connectionLost: false,
    })
    expect(normalizeError(throwing)).toEqual({
      message: "[object Object]",
      connectionLost: false,
    })
    expect(normalizeError(undefined)).toEqual({
      message: "undefined",
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
      connectionLost: false,
    })
  })
})
