import { probeUnmodeledIdentitiesPinned } from "@supabase/pg-delta"
import pg from "pg"
import { compile } from "simetra/compiler"
import {
  desiredForApply,
  executePlan,
  readFingerprint,
  type ApplyDesired,
  type CatalogFingerprint,
  type ExecutablePlan,
  type PlanStep,
} from "simetra/schema"
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import { readCensus } from "../census-read"
import { readExtensionComments } from "../extension-comments"
import { readOnlyQuery, readOnlyTransactionPool } from "../read-only"
import { readRoutineVolatility } from "../routine-volatility"
import {
  catalog,
  metaFiles,
  project,
  shadowDatabaseCount,
  testDatabaseUrl,
} from "../../../../simetra/test/support"

/**
 * Читання цілі без сесійного стану (план П3-1, рішення 14.1): кожен запит до
 * цілі — у транзакції `READ ONLY`, і після читання з'єднання лишається таким,
 * яким було. Ціль — окрема база від `withDesiredShadow`; база стеку лише
 * читається.
 */

const engine = createPgDeltaEngine()
const stack = { url: testDatabaseUrl() }
const OUTSIDE = "target query outside a read-only transaction"

/**
 * Пулер локального стеку в режимі транзакцій (рішення 14.5). Без змінної
 * перевірки через пулер пропускаються: пулер вмикає конфіг стеку, а рядок
 * підключення з обліковими даними в коді не живе.
 */
const POOLER_URL = process.env.SIMETRA_TEST_POOLER_URL

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

async function other<R extends Record<string, unknown>>(
  url: string,
  sql: string
): Promise<R[]> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    return (await client.query<R>(sql)).rows
  } finally {
    await client.end()
  }
}

/** Ціль: бажаний стан застосування моделі плюс `setup`; базу прибирає порт. */
async function inTarget<T>(
  setup: string,
  fn: (url: string) => Promise<T>
): Promise<T> {
  const outcome = await engine.withDesiredShadow(
    { target: stack },
    desired.sql,
    desired.scope,
    async (target) => {
      await other(target.url, setup)
      return fn(target.url)
    }
  )
  if (outcome.status !== "loaded")
    throw new Error(
      `target did not load: ${outcome.diagnostics.map((d) => d.message).join("; ")}`
    )
  return outcome.value
}

interface Session extends Record<string, unknown> {
  pid: number
  readOnly: string
  searchPath: string
  major: number
}

/** Сесійні налаштування, які могло б лишити читання, і backend, що їх несе. */
const sessionOf = (pool: pg.Pool): Promise<Session> =>
  readOnlyQuery(
    pool,
    async (client) =>
      (
        await client.query<Session>(
          `select pg_backend_pid() as pid,
                  current_setting('default_transaction_read_only') as "readOnly",
                  current_setting('search_path') as "searchPath",
                  current_setting('server_version_num')::int / 10000 as major`
        )
      ).rows[0]!
  )

describe("readOnlyTransactionPool", () => {
  it("refuses a statement outside a read-only transaction", async () => {
    await inTarget("select 1", async (url) => {
      const pool = readOnlyTransactionPool(url)
      try {
        const client = await pool.connect()
        try {
          await expect(client.query("select 1")).rejects.toThrow(OUTSIDE)
          await expect(client.query("BEGIN READ WRITE")).rejects.toThrow(
            OUTSIDE
          )
          // Транзакція без режиму доступу отримує `READ ONLY`, а не
          // відмову: так відкриває свою транзакцію двигун
          await client.query("BEGIN")
          const { rows } = await client.query<{ on: string }>(
            "select current_setting('transaction_read_only') as on"
          )
          expect(rows[0]!.on).toBe("on")
          // Сесійний `SET` переживає `COMMIT` — це сесійний стан
          await expect(client.query("SET search_path TO app")).rejects.toThrow(
            /session/
          )
          await client.query("SET LOCAL search_path TO app")
          await client.query("COMMIT")
          await expect(client.query("select 1")).rejects.toThrow(OUTSIDE)
        } finally {
          client.release()
        }
        // `query()` пулу — у своїй транзакції лише для читання
        await expect(
          pool.query("create table app.intruder (id int)")
        ).rejects.toMatchObject({ code: "25006" })
      } finally {
        await pool.end()
      }
    })
  })

  it("allows pg-delta extract", async () => {
    await inTarget("select 1", async (url) => {
      const extracted = await engine.extract({ url }, desired.scope)
      expect(extracted.model.tables.length).toBeGreaterThan(0)
    })
  })

  it("leaves no session state", async () => {
    await inTarget("select 1", async (url) => {
      // Повний шлях `diff` на цілі: план «ціль → бажаний стан» через тінь
      const outcome = await engine.withDesiredShadow(
        { target: { url } },
        desired.sql,
        desired.scope,
        async (_shadow, plan) => plan
      )
      expect(outcome.status).toBe("loaded")
      // Ті самі читання на одному пулі: сесійний стан лишився б на його
      // backend, а `pid` доводить, що backend той самий
      const pool = readOnlyTransactionPool(url)
      try {
        const before = await sessionOf(pool)
        expect(before.readOnly).toBe("off")
        await engine.extract({ url }, desired.scope)
        await probeUnmodeledIdentitiesPinned(pool, before.major)
        await readRoutineVolatility(pool)
        await readExtensionComments(pool)
        await readOnlyQuery(pool, (client) => readCensus(client, desired.scope))
        expect(await sessionOf(pool)).toEqual(before)
      } finally {
        await pool.end()
      }
    })
  })
})

/** Адреса пулера до тієї самої бази, що й `url`. */
function throughPooler(pooler: string, url: string): string {
  const out = new URL(pooler)
  out.pathname = new URL(url).pathname
  return out.toString()
}

const read = (url: string): Promise<CatalogFingerprint> =>
  createApplyDatabase({ readOnly: true }).transaction(
    { url },
    "rollback",
    (tx) => readFingerprint(tx, desired.scope)
  )

const CREATE_N: PlanStep = {
  id: "s1",
  sql: "CREATE TABLE app.n (id int)",
  verb: "create",
  class: "catalogOnly",
  lockClass: "none",
  transactionality: "transactional",
  newSegmentBefore: false,
  lockedTables: [],
  produces: [],
  consumes: [],
  destroys: [],
  dataLoss: false,
  rewriteRisk: false,
}

describe.skipIf(POOLER_URL === undefined)("transaction-mode pooler", () => {
  const pooler = POOLER_URL!

  it("apply through a transaction-mode pooler", async () => {
    const desiredFingerprint = await inTarget(`${CREATE_N.sql};`, read)
    await inTarget("select 1", async (url) => {
      const plan: ExecutablePlan = {
        fromHash: null,
        toHash: "1".repeat(64),
        scope: desired.scope,
        engine: engine.identity,
        steps: [CREATE_N],
        requiredPermissions: [],
        drift: null,
        resultCatalog: { tables: [], enumTypes: [], units: [] },
        targetFingerprint: await read(url),
        desiredFingerprint,
      }
      const outcome = await executePlan(
        createApplyDatabase({ readOnly: false }),
        { url: throughPooler(pooler, url) },
        plan,
        {
          mode: "apply",
          planHash: "c".repeat(64),
          allow: [],
          snapshot: { tables: [] },
          sleep: async () => {},
        }
      )
      expect(outcome).toMatchObject({ status: "committed" })
      expect(
        await other(url, "select snapshot_hash, plan_hash from simetra.marker")
      ).toEqual([{ snapshot_hash: "1".repeat(64), plan_hash: "c".repeat(64) }])
      expect(
        await other(url, "select plan_hash, to_hash from simetra.ledger")
      ).toEqual([{ plan_hash: "c".repeat(64), to_hash: "1".repeat(64) }])
    })
  })

  it("reads through the pooler leave no session state", async () => {
    await inTarget("select 1", async (url) => {
      const target = throughPooler(pooler, url)
      const pool = readOnlyTransactionPool(target)
      try {
        await engine.extract({ url: target }, desired.scope)
        await sessionOf(pool)
      } finally {
        await pool.end()
      }
      const fresh = await other<{ on: string }>(
        target,
        "select current_setting('default_transaction_read_only') as on"
      )
      expect(fresh).toEqual([{ on: "off" }])
    })
  })
})
