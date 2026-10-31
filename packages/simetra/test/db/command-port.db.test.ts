import { afterAll, describe, expect, it } from "vitest"
import pg from "pg"
import { ID, sample } from "../../src/server/__tests__/fixtures"
import { fromPgPool, normalizeError } from "../../src/server/port"
import { decodeRow } from "../../src/server/decode"
import { testDatabaseUrl } from "./connection"

/**
 * Контракт порту команд (рішення Р19): що рядок ядра доходить до `decodeRow`
 * незмінним за будь-яких парсерів типів `pg` host-а і за будь-яких
 * `bytea_output`/`TimeZone` сесії пулу, вирішують Postgres і драйвер — unit-фейк
 * цього не доводить. Таблиць не треба: рядок у формі ядра будується з літералів
 * (`to_jsonb(row) || <numeric/bigint текстом>`, як `rowJson` генератора ядра).
 */

// Типи, які `pg` за замовчуванням розбирає (чи host перевизначив би).
const PARSED_OIDS = new Set([
  17, // bytea
  20, // int8
  114, // json
  1016, // int8[]
  1082, // date
  1184, // timestamptz
  1231, // numeric[]
  1700, // numeric
  3802, // jsonb
])

// Сесія пулу навмисно не та, що потрібна ядру: `escape` дав би інший `bytea`,
// пояс сесії — інший запис моменту; крок 2 транзакції ставить свої локально.
const SESSION = "-c bytea_output=escape -c TimeZone=Asia/Tokyo"

const pools = [
  new pg.Pool({ connectionString: testDatabaseUrl(), options: SESSION }),
  new pg.Pool({
    connectionString: testDatabaseUrl(),
    options: SESSION,
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        PARSED_OIDS.has(oid)
          ? (value: string) => ({ custom: value })
          : pg.types.getTypeParser(
              oid,
              format
            )) as typeof pg.types.getTypeParser,
    },
  }),
]

afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()))
})

const STEP_2 =
  "SELECT set_config('TimeZone', 'UTC', true), set_config('bytea_output', 'hex', true)"

const ROW = `SELECT (to_jsonb(r) || jsonb_build_object(
    'version', r.version::text,
    'amount_col', r.amount_col::text,
    'big_col', r.big_col::text,
    'bigs_col', r.bigs_col::text[]))::text AS r
  FROM (SELECT
    $1::uuid AS id,
    7::bigint AS version,
    '12345678901234567890.0123456789'::numeric(30,10) AS amount_col,
    9007199254740993::bigint AS big_col,
    '{1,9007199254740993}'::bigint[] AS bigs_col,
    '{"a": [1, "x", null, {"b": true}]}'::jsonb AS payload_col,
    '\\x00ff'::bytea AS blob_col,
    '2026-10-31 10:00:00+02'::timestamptz AS at_col,
    '2026-02-28'::date AS day_col,
    '{1,NULL,3}'::integer[] AS tags_col,
    'open'::text AS status_col) r`

describe("CommandDatabase over pg.Pool", () => {
  it.each(pools.map((p, i) => [i === 0 ? "default" : "custom", p] as const))(
    "a core row decodes the same with %s type parsers",
    async (_, pool) => {
      const client = await fromPgPool(pool).connect()
      try {
        await client.query("BEGIN")
        // Без кроку 2 — форма сесії: доводить, що крок 2 щось змінює.
        const session = await client.query(ROW, [ID])
        expect(decodeRow(sample, session.rows[0]!.r as string)).toMatchObject({
          blob: "\\000\\377",
          at: "2026-10-31T17:00:00+09:00",
        })
        await client.query(STEP_2)
        const { rows, command } = await client.query(ROW, [ID])
        expect(command).toBe("SELECT")
        expect(typeof rows[0]!.r).toBe("string")
        expect(decodeRow(sample, rows[0]!.r as string)).toEqual({
          ref: ID,
          version: 7,
          amount: "12345678901234567890.0123456789",
          big: 9007199254740993n,
          bigs: [1n, 9007199254740993n],
          payload: { a: [1, "x", null, { b: true }] },
          blob: "\\x00ff",
          at: "2026-10-31T08:00:00+00:00",
          day: "2026-02-28",
          tags: [1, null, 3],
          status: "Open",
        })
        expect((await client.query("COMMIT")).command).toBe("COMMIT")
      } finally {
        client.release()
      }
    }
  )

  it("RAISE … USING DETAIL, HINT reaches normalizeError", async () => {
    const client = await fromPgPool(pools[0]!).connect()
    let thrown: unknown
    try {
      await client.query(
        `DO $$ BEGIN RAISE EXCEPTION 'command.conflict' USING ERRCODE = 'P0001', DETAIL = 'version', HINT = '7'; END $$`
      )
    } catch (error) {
      thrown = error
    } finally {
      client.release()
    }
    expect(normalizeError(thrown)).toEqual({
      code: "P0001",
      message: "command.conflict",
      detail: "version",
      hint: "7",
      connectionLost: false,
    })
  })
})
