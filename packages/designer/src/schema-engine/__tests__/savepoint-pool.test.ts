import { loadSqlParser, type SqlParser } from "simetra/compiler"
import { beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import {
  closeSavepoint,
  savepointPool,
  vetSavepointQuery,
} from "../savepoint-pool"

/**
 * Сторож витягу в транзакції застосування (рішення 8 плану П3-2b-1): двигун
 * відкриває й закриває власну транзакцію, а тут вона вже відкрита, тож
 * `BEGIN` стає точкою збереження, `COMMIT`/`ROLLBACK` — її закриттям, а
 * всередині проходить лише читання. Точка збереження не буває `READ ONLY`,
 * тож гарантію читання тримає сторож.
 */

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const OPEN = "SAVEPOINT simetra_extract"
const CLOSE =
  "ROLLBACK TO SAVEPOINT simetra_extract; RELEASE SAVEPOINT simetra_extract"

const vet = (text: string, inSavepoint = false) =>
  vetSavepointQuery(text, inSavepoint, parse)
const refused = (text: string, inSavepoint = false) => {
  const r = vet(text, inSavepoint)
  return r.ok ? undefined : r.reason
}

describe("vetSavepointQuery", () => {
  it("opens the savepoint in place of any BEGIN", () => {
    for (const text of [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY",
    ])
      expect(vet(text), text).toEqual({
        ok: true,
        text: OPEN,
        inSavepoint: true,
      })
  })

  it("rewrites only the BEGIN of a batch and keeps the rest of the text", () => {
    const batch = [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL search_path TO 'pg_catalog'",
      "SELECT version()",
    ].join(";\n")
    expect(vet(batch)).toEqual({
      ok: true,
      text: `${OPEN};\nSET LOCAL search_path TO 'pg_catalog';\nSELECT version()`,
      inSavepoint: true,
    })
  })

  it("closes the savepoint in place of COMMIT and ROLLBACK", () => {
    for (const text of ["COMMIT", "ROLLBACK"])
      expect(vet(text, true), text).toEqual({
        ok: true,
        text: CLOSE,
        inSavepoint: false,
      })
  })

  it("passes reads, SHOW and SET LOCAL inside the savepoint", () => {
    for (const text of [
      "SELECT 1",
      "WITH x AS (SELECT 1 AS a) SELECT a FROM x",
      "SHOW server_version",
      "SET LOCAL search_path TO 'pg_catalog'",
      "SELECT set_config('jit', 'off', true) WHERE has_parameter_privilege(current_user, 'jit', 'SET')",
    ])
      expect(vet(text, true), text).toEqual({
        ok: true,
        text,
        inSavepoint: true,
      })
  })

  it("refuses anything but BEGIN outside the savepoint", () => {
    for (const text of [
      "SELECT 1",
      "SET LOCAL search_path TO app",
      "COMMIT",
      "BEGIN; COMMIT; SELECT 1",
    ])
      expect(refused(text), text).toMatch(/outside its savepoint/)
  })

  it("refuses session settings and transaction characteristics", () => {
    expect(refused("SET search_path = x", true)).toMatch(/session/)
    expect(refused("RESET search_path", true)).toMatch(/session/)
    for (const text of [
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      "SET TRANSACTION SNAPSHOT '00000003-0000001B-1'",
      "SET LOCAL TRANSACTION READ WRITE",
    ])
      expect(refused(text, true), text).toMatch(/SET TRANSACTION/)
  })

  it("refuses a snapshot export by the function name", () => {
    expect(refused("SELECT pg_export_snapshot() AS id", true)).toMatch(
      /pg_export_snapshot/
    )
    expect(refused("SELECT pg_catalog.PG_EXPORT_SNAPSHOT()", true)).toMatch(
      /pg_export_snapshot/
    )
  })

  // Кожна відмова — за своєю причиною: загальне /refused/ пропустило б
  // відмову з чужої гілки сторожа
  it("refuses writes, row locks and SELECT INTO", () => {
    for (const [text, reason] of [
      ["INSERT INTO app.t VALUES (1)", /statement refused: InsertStmt/],
      ["UPDATE app.t SET a = 1", /statement refused: UpdateStmt/],
      ["CREATE TABLE app.x ()", /statement refused: CreateStmt/],
      ["SELECT * FROM app.t FOR UPDATE", /row locks/],
      ["SELECT * FROM app.t FOR SHARE", /row locks/],
      ["SELECT * FROM (SELECT * FROM app.t FOR UPDATE) s", /row locks/],
      [
        "WITH d AS (DELETE FROM app.t RETURNING *) SELECT * FROM d",
        /data-modifying/,
      ],
      ["SELECT 1 INTO app.copy", /SELECT INTO/],
    ] as const)
      expect(refused(text, true), text).toMatch(reason)
  })

  it("refuses functions whose effect outlives the savepoint or the transaction", () => {
    for (const [text, name] of [
      ["SELECT nextval('app.s')", "nextval"],
      ["SELECT pg_catalog.setval('app.s', 1)", "setval"],
      ["SELECT pg_advisory_lock(1)", "pg_advisory_lock"],
      ["SELECT pg_advisory_lock_shared(1, 2)", "pg_advisory_lock_shared"],
      ["SELECT pg_try_advisory_lock(1)", "pg_try_advisory_lock"],
      [
        "SELECT * FROM (SELECT pg_try_advisory_lock_shared(1)) s",
        "pg_try_advisory_lock_shared",
      ],
    ] as const)
      expect(refused(text, true), text).toBe(
        `extract read refused: ${name}() is not allowed`
      )
  })

  it("passes transaction-scoped advisory locks: the end of the transaction releases them", () => {
    for (const text of [
      "SELECT pg_advisory_xact_lock(1)",
      "SELECT pg_try_advisory_xact_lock_shared(1, 2)",
    ])
      expect(vet(text, true), text).toEqual({
        ok: true,
        text,
        inSavepoint: true,
      })
  })

  it("refuses transaction control other than one BEGIN and its end", () => {
    expect(refused("BEGIN", true)).toMatch(/already open/)
    expect(refused("START TRANSACTION", true)).toMatch(/already open/)
    expect(refused("COMMIT AND CHAIN", true)).toMatch(/AND CHAIN/)
    expect(refused("ROLLBACK AND CHAIN", true)).toMatch(/AND CHAIN/)
    for (const [text, reason] of [
      ["PREPARE q AS SELECT 1", /statement refused: PrepareStmt/],
      ["SAVEPOINT x", /refused: TRANS_STMT_SAVEPOINT/],
      ["RELEASE x", /refused: TRANS_STMT_RELEASE/],
      ["ROLLBACK TO SAVEPOINT x", /refused: TRANS_STMT_ROLLBACK_TO/],
      ["PREPARE TRANSACTION 'x'", /refused: TRANS_STMT_PREPARE/],
    ] as const)
      expect(refused(text, true), text).toMatch(reason)
  })

  it("refuses what does not parse", () => {
    expect(refused("selec 1", true)).toMatch(/does not parse/)
  })
})

describe("savepointPool", () => {
  /** Клієнт-пустушка: відповідає за сценарієм, текст запитів запам'ятовує. */
  function fakeClient(failOn: string[] = []) {
    const sent: string[] = []
    const calls: string[] = []
    const client = {
      query(...args: unknown[]) {
        const query = args[0]
        const text =
          typeof query === "string" ? query : (query as { text: string }).text
        sent.push(text)
        const fail = failOn.includes(text)
        const callback = args[args.length - 1]
        if (typeof callback === "function") {
          callback(fail ? new Error("server") : null, { rows: [] })
          return undefined
        }
        return fail
          ? Promise.reject(new Error("server"))
          : Promise.resolve({ rows: [] })
      },
      on: () => calls.push("on"),
      removeListener: () => calls.push("removeListener"),
      release: () => calls.push("release"),
    }
    return { client: client as unknown as pg.PoolClient, sent, calls }
  }

  it("leaves the transaction client untouched", async () => {
    const fake = fakeClient()
    const query = fake.client.query
    const release = fake.client.release
    const pool = savepointPool(fake.client, parse)
    const client = await pool.connect()
    client.on("error", () => {})
    client.removeListener("error", () => {})
    client.release = () => {}
    client.release()
    await pool.end()
    expect(fake.client.query).toBe(query)
    expect(fake.client.release).toBe(release)
    expect(fake.calls).toEqual([])
  })

  it("rewrites through the callback form of connect and query, with a no-op done", async () => {
    const fake = fakeClient()
    const pool = savepointPool(fake.client, parse)
    const connect = pool.connect as unknown as (
      callback: (
        error: Error | undefined,
        client: pg.PoolClient,
        done: () => void
      ) => void
    ) => void
    const { client, done } = await new Promise<{
      client: pg.PoolClient
      done: () => void
    }>((resolve) => connect((_e, client, done) => resolve({ client, done })))
    done()
    const query = client.query as unknown as (
      text: string,
      callback: (error: Error | null) => void
    ) => unknown
    await new Promise((resolve) => query("BEGIN", resolve))
    const error = await new Promise<Error | null>((resolve) =>
      query("INSERT INTO app.t VALUES (1)", resolve)
    )
    expect(error?.message).toMatch(/refused/)
    expect(fake.sent).toEqual([OPEN])
    expect(fake.calls).toEqual([])
  })

  it("runs pool.query as a read in its own savepoint", async () => {
    const fake = fakeClient()
    const trace: string[] = []
    const pool = savepointPool(fake.client, parse, trace)
    await pool.query("SELECT 1")
    expect(fake.sent).toEqual([OPEN, "SELECT 1", CLOSE])
    expect(trace).toEqual([
      `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY → ${OPEN}`,
      `COMMIT → ${CLOSE}`,
    ])
  })

  it("keeps the savepoint open after a failed statement inside it", async () => {
    const fake = fakeClient(["SELECT 1"])
    const pool = savepointPool(fake.client, parse)
    const client = await pool.connect()
    await client.query("BEGIN")
    await expect(client.query("SELECT 1")).rejects.toThrow("server")
    await client.query("ROLLBACK")
    expect(fake.sent).toEqual([OPEN, "SELECT 1", CLOSE])
    await closeSavepoint(pool)
    expect(fake.sent).toHaveLength(3)
  })

  it("closes a savepoint the engine left open", async () => {
    const fake = fakeClient()
    const pool = savepointPool(fake.client, parse)
    const client = await pool.connect()
    await client.query("BEGIN")
    await closeSavepoint(pool)
    expect(fake.sent).toEqual([OPEN, CLOSE])
    await expect(client.query("SELECT 1")).rejects.toThrow(
      /outside its savepoint/
    )
  })
})
