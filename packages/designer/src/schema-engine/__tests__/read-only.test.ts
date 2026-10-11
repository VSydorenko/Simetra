import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import { beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import { guard, vetTargetQuery } from "../read-only"

/**
 * Сторож рішення 14.1 плану П3-1: гарантія «лише читання» живе в транзакції,
 * а не в з'єднанні. За пулером у режимі транзакцій сесійне налаштування
 * губиться або осідає на чужому backend, тож у коді його не має бути зовсім,
 * а кожен сирий запит до пулу в двигуні — лише через спільний хелпер.
 */

const SRC = resolve(__dirname, "../..")
const ENGINE = resolve(__dirname, "..")

/** Файли коду теки без тестів. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      return entry.name === "__tests__" ? [] : sources(path)
    return /\.tsx?$/.test(entry.name) ? [path] : []
  })
}

function offenders(dir: string, pattern: RegExp): string[] {
  return sources(dir)
    .filter((path) => pattern.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path))
}

describe("target reads carry no session state", () => {
  // Сторож запитів сам називає `default_transaction_read_only`, щоб
  // відмовити на ньому, тож шукається встановлення, а не ім'я
  it("no session-level read-only switch or connect hook in the designer", () => {
    expect(
      offenders(
        SRC,
        /set\s+(?:session\s+)?default_transaction_read_only|default_transaction_read_only\s*(?:=|to\b)|onConnect|\breadOnlyPool\b/i
      )
    ).toEqual([])
  })

  // Із типовим параметром теж: `pool.query<Row>(…)` — той самий сирий запит
  it("raw pool queries in the engine go only through the read-only helper", () => {
    expect(
      offenders(ENGINE, /pool\.query\s*[<(]/i).filter(
        (path) => path !== join("schema-engine", "read-only.ts")
      )
    ).toEqual([])
  })

  // Пул цілі — лише сторожовий; пул, що пише, — тінь адаптера й раннер
  // Рахується кількість, а не файли: другий пул у дозволеному файлі теж
  // мусить провалити перевірку
  it("pools are created only by the guard, the shadow and the apply runner", () => {
    const counts: Record<string, number> = {}
    for (const path of sources(SRC)) {
      const n = readFileSync(path, "utf8").match(/new pg\.Pool\(/g)?.length
      if (n) counts[relative(SRC, path)] = n
    }
    expect(counts).toEqual({
      [join("schema-engine", "apply-database.ts")]: 1,
      [join("schema-engine", "pg-delta", "adapter.ts")]: 1,
      [join("schema-engine", "read-only.ts")]: 1,
    })
  })
})

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
})

const vet = (text: string, inTransaction = false) =>
  vetTargetQuery(text, inTransaction, parse)
const refused = (text: string, inTransaction = false) => {
  const r = vet(text, inTransaction)
  return r.ok ? undefined : r.reason
}

describe("vetTargetQuery", () => {
  it("passes pg-delta's opening batch as is", () => {
    const batch = [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET LOCAL search_path TO 'pg_catalog'",
      "SET LOCAL statement_timeout = 30000",
      "SELECT current_setting('server_version') AS version, current_setting('server_version_num')::int AS num",
    ].join(";\n")
    expect(vet(batch)).toEqual({ ok: true, text: batch, inTransaction: true })
    const worker = [
      "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      "SET TRANSACTION SNAPSHOT '00000003-0000001B-1'",
      "SET LOCAL search_path TO 'pg_catalog'",
      "SELECT set_config('jit', 'off', true) WHERE has_parameter_privilege(current_user, 'jit', 'SET')",
    ].join(";\n")
    expect(vet(worker)).toMatchObject({ ok: true, text: worker })
  })

  it("makes a transaction without an access mode read-only", () => {
    expect(vet("BEGIN")).toEqual({
      ok: true,
      text: "BEGIN READ ONLY",
      inTransaction: true,
    })
    expect(
      vet("START TRANSACTION ISOLATION LEVEL SERIALIZABLE -- why")
    ).toMatchObject({
      text: "START TRANSACTION READ ONLY ISOLATION LEVEL SERIALIZABLE -- why",
    })
    expect(vet("BEGIN; SET LOCAL search_path TO app")).toMatchObject({
      text: "BEGIN READ ONLY; SET LOCAL search_path TO app",
    })
    // Відкрита транзакція свій режим уже має
    expect(vet("BEGIN", true)).toMatchObject({ ok: true, text: "BEGIN" })
  })

  it("refuses statements outside the transaction", () => {
    expect(refused("select 1")).toMatch(/outside a read-only transaction/)
    expect(refused("SAVEPOINT a")).toMatch(/outside/)
    expect(refused("COMMIT; INSERT INTO app.t VALUES (1)", true)).toMatch(
      /outside/
    )
    expect(refused("BEGIN READ ONLY; COMMIT; select 1")).toMatch(/outside/)
    expect(vet("select 1", true)).toMatchObject({
      ok: true,
      inTransaction: true,
    })
    expect(vet("BEGIN READ ONLY; select 1; COMMIT")).toMatchObject({
      ok: true,
      inTransaction: false,
    })
  })

  it("refuses a read-write transaction", () => {
    for (const text of [
      "BEGIN READ WRITE",
      "START TRANSACTION READ WRITE",
      "BEGIN; SET TRANSACTION READ WRITE",
      "BEGIN READ ONLY, READ WRITE",
      "BEGIN READ ONLY READ WRITE",
      "START TRANSACTION READ ONLY, ISOLATION LEVEL SERIALIZABLE, READ WRITE",
      "BEGIN READ ONLY; SET TRANSACTION READ ONLY, READ WRITE",
      "BEGIN; SET TRANSACTION READ ONLY, READ WRITE",
    ])
      expect(refused(text), text).toMatch(/must stay read-only/)
    for (const text of [
      "SET TRANSACTION READ WRITE",
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE",
      "SET LOCAL transaction_read_only = off",
      "SET LOCAL default_transaction_read_only = off",
      "SET transaction_read_only TO on",
      'SET LOCAL "Transaction_Read_Only" = off',
      'SET LOCAL "DEFAULT_Transaction_Read_Only" = off',
      'SET "Transaction_Read_Only" TO on',
      'RESET "Transaction_Read_Only"',
      'RESET "Default_Transaction_Read_Only"',
    ])
      expect(refused(text, true), text).toMatch(/must stay read-only/)
    expect(vet("SET TRANSACTION READ ONLY", true)).toMatchObject({ ok: true })
  })

  it("refuses session state", () => {
    for (const text of [
      "SET search_path TO app",
      "SET SESSION statement_timeout = 0",
      "RESET search_path",
      "RESET ALL",
      "SET SESSION CHARACTERISTICS AS TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    ])
      expect(refused(text, true), text).toMatch(/session-level SET or RESET/)
    expect(vet("SET LOCAL ROLE postgres", true)).toMatchObject({ ok: true })
  })

  it("refuses chaining and two-phase transactions", () => {
    expect(refused("COMMIT AND CHAIN", true)).toMatch(/AND CHAIN/)
    expect(refused("ROLLBACK AND CHAIN", true)).toMatch(/AND CHAIN/)
    expect(refused("PREPARE TRANSACTION 'x'", true)).toMatch(/refused/)
    expect(vet("ROLLBACK TO SAVEPOINT a", true)).toMatchObject({
      ok: true,
      inTransaction: true,
    })
  })

  it("refuses what does not parse", () => {
    expect(refused("BEGIN READ ONLY; selec 1")).toMatch(/does not parse/)
  })
})

describe("guard", () => {
  /** Клієнт-пустушка: відповідає за сценарієм, текст запитів запам'ятовує. */
  function fakeClient(failOn: string[]) {
    const sent: string[] = []
    const client = {
      query(...args: unknown[]) {
        const text = args[0] as string
        sent.push(text)
        const fail = failOn.includes(text)
        const callback = args[args.length - 1]
        if (typeof callback === "function") {
          callback(fail ? new Error("server") : null, { rows: [] })
          return undefined
        }
        return fail ? Promise.reject(new Error("server")) : Promise.resolve({})
      },
    }
    return { client: client as unknown as pg.PoolClient, sent }
  }

  it("treats the transaction as closed after a failed statement", async () => {
    const { client, sent } = fakeClient(["BEGIN READ ONLY"])
    const guarded = guard(client, parse)
    await expect(guarded.query("BEGIN")).rejects.toThrow("server")
    await expect(guarded.query("select 1")).rejects.toThrow(
      /outside a read-only transaction/
    )
    expect(sent).toEqual(["BEGIN READ ONLY"])
  })

  it("treats the transaction as closed after a failed callback statement", async () => {
    const { client } = fakeClient(["BEGIN READ ONLY"])
    const guarded = guard(client, parse)
    const query = guarded.query as unknown as (
      text: string,
      callback: (error: Error | null) => void
    ) => void
    await new Promise<void>((done) => query("BEGIN", () => done()))
    await expect(guarded.query("select 1")).rejects.toThrow(/outside/)
  })

  it("reports a refusal to the callback and returns undefined", async () => {
    const { client, sent } = fakeClient([])
    const guarded = guard(client, parse)
    const query = guarded.query as unknown as (
      text: string,
      callback: (error: Error | null) => void
    ) => unknown
    let returned: unknown = "unset"
    const error = await new Promise<Error | null>((done) => {
      returned = query("select 1", done)
    })
    expect(returned).toBeUndefined()
    expect(error?.message).toMatch(/outside a read-only transaction/)
    expect(sent).toEqual([])
  })
})
