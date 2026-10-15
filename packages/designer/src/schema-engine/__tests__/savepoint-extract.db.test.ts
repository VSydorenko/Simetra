import pg from "pg"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { compile } from "simetra/compiler"
import {
  ApplyConnectionLost,
  desiredForApply,
  type ApplyDesired,
  type ApplyTransaction,
  type EngineCatalog,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import { extractOnTransactionClient } from "../pg-delta/adapter"
import {
  catalog,
  metaFiles,
  project,
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../../simetra/test/support"

/**
 * Витяг двигуна в транзакції застосування (рішення 8 плану П3-2b-1, спайк
 * С5 як тест): двигун бачить незакомічені зміни транзакції, нічого в ній не
 * лишає, а транзакція придатна далі. Ціль і бажана база — окремі бази від
 * `withDesiredShadow`; база стеку лише читається.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const apply = createApplyDatabase({ readOnly: false })

/** Стан цілі до транзакції. */
const BEFORE = `
  create table app.account (id int primary key, a text);
  create function app.answer() returns int language sql as 'select 1';
`
/** Бажаний стан: колонку перейменовано, тіло функції інше. */
const AFTER = `
  create table app.account (id int primary key, b text);
  create function app.answer() returns int language sql as 'select 2';
`
/** Зміна транзакції, що веде `BEFORE` до `AFTER`. */
const CHANGE = [
  "ALTER TABLE app.account RENAME COLUMN a TO b",
  "CREATE OR REPLACE FUNCTION app.answer() RETURNS int LANGUAGE sql AS 'select 2'",
]

let desired: ApplyDesired

beforeAll(async () => {
  const compiled = await compile(
    metaFiles({
      "project.meta.json": project({ defaultSchema: "app" }),
      "catalogs/Party/Party.meta.json": catalog("Party"),
    })
  )
  expect(compiled.diagnostics).toEqual([])
  desired = await desiredForApply(compiled.model!)
})

let shadowsBefore = 0
beforeEach(async () => {
  shadowsBefore = await shadowDatabaseCount()
})
afterEach(async () => {
  expect(await shadowDatabaseCount()).toBe(shadowsBefore)
})

async function other(url: string, sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

/** База з бажаним станом застосування моделі плюс `setup`; базу прибирає порт. */
async function inDatabase<T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    desired.sql,
    desired.scope,
    async (db) => {
      await other(db.url, setup)
      return fn(db.url)
    }
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `database did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

/** Каталог двигуна бажаної бази. */
const desiredCatalog = (): Promise<EngineCatalog> =>
  inDatabase(
    AFTER,
    async (url) => (await engine.extract({ url }, desired.scope)).catalog
  )

/**
 * Стан транзакції, який витяг не мусить змінити: її ідентифікатор,
 * налаштування, тимчасові об'єкти, prepared statements і замки сесії.
 */
async function transactionState(tx: ApplyTransaction): Promise<unknown> {
  const [row] = await tx.query(
    `SELECT pg_catalog.txid_current_if_assigned()::text AS txid,
            pg_catalog.current_setting('search_path') AS search_path,
            pg_catalog.current_setting('statement_timeout') AS statement_timeout,
            pg_catalog.current_setting('transaction_isolation') AS isolation,
            (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class
              WHERE relnamespace = pg_catalog.pg_my_temp_schema())::int AS temp,
            (SELECT pg_catalog.count(*)
               FROM pg_catalog.pg_prepared_statements)::int AS prepared`
  )
  const locks = await tx.query(
    `SELECT locktype, coalesce(relation::regclass::text, '') AS relation,
            coalesce(transactionid::text, '') AS xid, mode, granted
       FROM pg_catalog.pg_locks
      WHERE pid = pg_catalog.pg_backend_pid() AND locktype <> 'virtualxid'
      ORDER BY 1, 2, 3, 4`
  )
  return { ...row, locks }
}

/** Транзакція на клієнті пулу, як у порті; наприкінці — `ROLLBACK`. */
async function onTransactionClient<T>(
  url: string,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  pool.on("error", () => {})
  try {
    const client = await pool.connect()
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
      const value = await fn(client)
      await client.query("ROLLBACK")
      return value
    } finally {
      client.release(true)
    }
  } finally {
    await pool.end()
  }
}

describe("ApplyTransaction.extract", () => {
  it("extracts the uncommitted catalog without leaving a trace", async () => {
    const wanted = await desiredCatalog()
    await inDatabase(BEFORE, async (url) => {
      await apply.transaction({ url }, "rollback", async (tx) => {
        for (const sql of CHANGE) await tx.query(sql)
        // Налаштування раннера, які `SET LOCAL` двигуна не мусить пережити
        await tx.query(
          "SELECT pg_catalog.set_config('search_path', 'app, public', true), pg_catalog.set_config('statement_timeout', '123456', true)"
        )
        const before = await transactionState(tx)
        const extracted = await tx.extract(desired.scope)
        expect(await transactionState(tx)).toEqual(before)
        expect(before).toMatchObject({
          search_path: "app, public",
          statement_timeout: "123456ms",
          temp: 0,
          prepared: 0,
        })
        expect(
          engine.plan(extracted.catalog, wanted, desired.scope).actions
        ).toEqual([])
      })
      const columns = await createApplyDatabase({ readOnly: true }).transaction(
        { url },
        "rollback",
        (tx) =>
          tx.query<{ name: string }>(
            "SELECT attname AS name FROM pg_catalog.pg_attribute WHERE attrelid = 'app.account'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum"
          )
      )
      expect(columns.map((c) => c.name)).toEqual(["id", "a"])
    })
  })

  it("keeps the transaction usable", { timeout: 60_000 }, async () => {
    await inDatabase(BEFORE, async (url) => {
      await apply.transaction({ url }, "commit", async (tx) => {
        await tx.query(CHANGE[0]!)
        await tx.extract(desired.scope)
        await tx.query("ALTER TABLE app.account ADD COLUMN z int")
      })
      const columns = await createApplyDatabase({ readOnly: true }).transaction(
        { url },
        "rollback",
        (tx) =>
          tx.query<{ name: string }>(
            "SELECT attname AS name FROM pg_catalog.pg_attribute WHERE attrelid = 'app.account'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum"
          )
      )
      expect(columns.map((c) => c.name)).toEqual(["id", "b", "z"])
    })
  })

  // Літерал — фактична послідовність pg-delta 1.0.0-alpha.56 разом із
  // читаннями `readOnlyQuery` адаптера. Зміна двигуна ламає тест навмисно:
  // нове керування транзакцією мусить пройти через рішення архітектора, а не
  // через розширення сторожа
  it("rewrites exactly the engine's control statements", async () => {
    await inDatabase(BEFORE, async (url) => {
      const trace: string[] = []
      await onTransactionClient(url, (client) =>
        extractOnTransactionClient(client, desired.scope, trace)
      )
      expect(trace).toEqual(TRACE)
    })
  })

  it("marks the connection lost when it drops during the extract", async () => {
    await inDatabase(BEFORE, async (url) => {
      const error = await apply
        .transaction({ url }, "commit", async (tx) => {
          const [row] = await tx.query<{ pid: number }>(
            "SELECT pg_catalog.pg_backend_pid() AS pid"
          )
          const killer = new pg.Client({ connectionString: url })
          await killer.connect()
          try {
            const extracting = tx.extract(desired.scope)
            // Обрив просять, коли backend уже виконує оператор витягу, а не
            // до нього: тоді зустрічаються саме запит у польоті й обрив
            const deadline = Date.now() + 30_000
            for (;;) {
              if (Date.now() > deadline)
                throw new Error("the backend never became active in 30 s")
              const { rows } = await killer.query(
                "SELECT 1 FROM pg_catalog.pg_stat_activity WHERE pid = $1 AND state = 'active'",
                [row!.pid]
              )
              if (rows.length > 0) break
              await new Promise((r) => setTimeout(r, 1))
            }
            await killer.query("SELECT pg_catalog.pg_terminate_backend($1)", [
              row!.pid,
            ])
            // Обрив має прийти саме з витягу, а не з `COMMIT` після нього
            await expect(extracting).rejects.toBeInstanceOf(ApplyConnectionLost)
          } finally {
            await killer.end()
          }
        })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(ApplyConnectionLost)
    })
  })

  it("closes the savepoint when the engine fails inside it", async () => {
    await inDatabase(BEFORE, async (url) => {
      // Ін'єкція: після відкривального пакета двигуна (з його `SET LOCAL
      // search_path`) кожне закриття падає ще до сервера, тож точку
      // збереження лишає відкритою сам двигун, і закрити її мусить обгортка
      const trace: string[] = []
      let engineOpened = false
      trace.push = (...entries: string[]) => {
        if (entries.some((e) => e.startsWith(ENGINE_BATCH[0]!)))
          engineOpened = true
        else if (
          engineOpened &&
          entries.some((e) => /^(?:COMMIT|ROLLBACK) →/.test(e))
        )
          throw new Error("injected close failure")
        return Array.prototype.push.apply(trace, entries)
      }
      const after = await onTransactionClient(url, async (client) => {
        await client.query(
          "SELECT pg_catalog.set_config('search_path', 'app, public', true)"
        )
        await expect(
          extractOnTransactionClient(client, desired.scope, trace)
        ).rejects.toThrow("injected close failure")
        // `SET LOCAL search_path` двигуна відкочено разом із точкою
        return (
          await client.query<{ path: string }>(
            "SELECT pg_catalog.current_setting('search_path') AS path"
          )
        ).rows[0]!.path
      })
      expect(engineOpened).toBe(true)
      expect(after).toBe("app, public")
    })
  })
})

const OPEN = "SAVEPOINT simetra_extract"
const CLOSE =
  "ROLLBACK TO SAVEPOINT simetra_extract; RELEASE SAVEPOINT simetra_extract"
/** Одне читання `readOnlyQuery` (профіль двигуна чи адаптер). */
const READ = [
  `BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY → ${OPEN}`,
  `COMMIT → ${CLOSE}`,
]
/** Відкривальний пакет витягу pg-delta: замінено лише `BEGIN`. */
const ENGINE_BATCH = [
  "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
  "SET LOCAL search_path TO 'pg_catalog'",
  "SELECT current_setting('server_version') AS version, current_setting('server_version_num')::int AS num",
]
const TRACE: string[] = [
  // `resolveProfile` до витягу
  ...READ,
  ...READ,
  // Витяг двигуна: власна транзакція на клієнті з `connect`
  `${ENGINE_BATCH.join(";\n")} → ${[OPEN, ...ENGINE_BATCH.slice(1)].join(";\n")}`,
  `COMMIT → ${CLOSE}`,
  // Читання профілю двигуна й адаптера після витягу (роль, коментарі
  // розширень, волатильність, перепис)
  ...Array.from({ length: 7 }, () => READ).flat(),
]
