import { readdirSync, readFileSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { loadSqlParser, type SqlParser } from "simetra/compiler"
import { beforeAll, describe, expect, it } from "vitest"
import { vetTargetQuery } from "../read-only"

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
  it("pools are created only by the guard, the shadow and the apply runner", () => {
    expect(offenders(SRC, /new pg\.Pool\(/)).toEqual(
      [
        join("schema-engine", "apply-database.ts"),
        join("schema-engine", "pg-delta", "adapter.ts"),
        join("schema-engine", "read-only.ts"),
      ].sort()
    )
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
    ])
      expect(refused(text), text).toMatch(/must stay read-only/)
    for (const text of [
      "SET TRANSACTION READ WRITE",
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE, READ WRITE",
      "SET LOCAL transaction_read_only = off",
      "SET LOCAL default_transaction_read_only = off",
      "SET transaction_read_only TO on",
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
