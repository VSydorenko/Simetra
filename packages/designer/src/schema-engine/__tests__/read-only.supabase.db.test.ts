import {
  executePlan,
  readFingerprint,
  readLedgerHead,
  readProviderLocks,
  readServerFacts,
  readSessionSearchPath,
  PROVIDER_LOCKS,
  type CatalogFingerprint,
  type ExecutablePlan,
  type PlanStep,
} from "simetra/schema"
import { describe, expect, it } from "vitest"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import { readOnlyTransactionPool } from "../read-only"
import { testPoolerUrl } from "../../../../simetra/test/support"
import { query } from "../../__tests__/support/db"
import {
  desired,
  inTarget,
  sessionOf,
  useApplyDesired,
} from "./read-only.support"

/**
 * Застосування й читання цілі через пулер Supavisor у режимі транзакцій:
 * після читання з'єднання пулера лишається таким, яким було. Спільна
 * підготовка — `read-only.support.ts`.
 */

const engine = createPgDeltaEngine()

useApplyDesired()

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
  origin: "engine",
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
  produced: [],
  destroyed: [],
  consumed: [],
  dataLoss: false,
  rewriteRisk: false,
  guards: [],
}

/**
 * Пулер стеку в режимі транзакцій: `[db.pooler]` увімкнено в
 * `supabase/config.toml`, тож недоступний пулер — червоний тест, не пропуск.
 */
describe("transaction-mode pooler", () => {
  const pooler = testPoolerUrl()

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
        role: "postgres",
        ...(await createApplyDatabase({ readOnly: true }).transaction(
          { url },
          "rollback",
          async (tx) => ({
            server: await readServerFacts(tx),
            ledgerHead: await readLedgerHead(tx),
          })
        )),
        locks: [],
        implicitLocks: [],
        providerLocks: await createApplyDatabase({
          readOnly: true,
        }).transaction({ url }, "rollback", (tx) =>
          readProviderLocks(tx, "postgres", PROVIDER_LOCKS.supabase)
        ),
        foreignKeys: { subjects: [], live: [] },
        preamble: [],
        revalidationSearchPath: await createApplyDatabase({
          readOnly: true,
        }).transaction({ url }, "rollback", readSessionSearchPath),
        plpgsqlCheck: "unavailable",
        platformFunctions: [],
        desiredInvalid: [],
        promotion: null,
        environment: { defaultPrivileges: [] },
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
        await query(url, "select snapshot_hash, plan_hash from simetra.marker")
      ).toEqual([{ snapshot_hash: "1".repeat(64), plan_hash: "c".repeat(64) }])
      expect(
        await query(url, "select plan_hash, to_hash from simetra.ledger")
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
      const fresh = await query<{ on: string }>(
        target,
        "select current_setting('default_transaction_read_only') as on"
      )
      expect(fresh).toEqual([{ on: "off" }])
    })
  })
})
