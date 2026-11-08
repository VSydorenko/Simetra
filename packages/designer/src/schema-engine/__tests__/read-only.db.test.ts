import {
  probeUnmodeledIdentitiesPinned,
  resolveProfile,
} from "@supabase/pg-delta"
import { describe, expect, it } from "vitest"
import { createPgDeltaEngine } from ".."
import { readCensus } from "../census-read"
import { scopeProfile } from "../pg-delta/policy"
import { readExtensionComments } from "../extension-comments"
import { readOnlyQuery, readOnlyTransactionPool } from "../read-only"
import { readRoutineVolatility } from "../routine-volatility"
import {
  desired,
  inTarget,
  sessionOf,
  useApplyDesired,
} from "./read-only.support"

/**
 * Читання цілі без сесійного стану (спека designer §3.2): кожен запит до
 * цілі — у транзакції `READ ONLY`, і після читання з'єднання лишається таким,
 * яким було. Ціль — окрема база від `withDesiredShadow`; база стеку лише
 * читається. Спільна підготовка — `read-only.support.ts`; пулер Supavisor —
 * `read-only.supabase.db.test.ts`.
 */

const engine = createPgDeltaEngine()
const OUTSIDE = "target query outside a read-only transaction"

useApplyDesired()

describe("readOnlyTransactionPool", () => {
  it("refuses a statement outside a read-only transaction", async () => {
    await inTarget("select 1", async (url) => {
      const pool = readOnlyTransactionPool(url)
      try {
        const client = await pool.connect()
        try {
          await expect(client.query("select 1")).rejects.toThrow(OUTSIDE)
          await expect(client.query("BEGIN READ WRITE")).rejects.toThrow(
            /must stay read-only/
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
          // Обхід: транзакцію не перемкнути на запис
          await expect(
            client.query("SET LOCAL transaction_read_only = off")
          ).rejects.toThrow(/must stay read-only/)
          await expect(
            client.query("SET TRANSACTION READ WRITE")
          ).rejects.toThrow(/must stay read-only/)
          await expect(
            client.query("create table app.intruder (id int)")
          ).rejects.toMatchObject({ code: "25006" })
          await client.query("ROLLBACK")
          await expect(
            client.query("COMMIT; create table app.intruder (id int)")
          ).rejects.toThrow(OUTSIDE)
          await client.query("BEGIN; SET LOCAL search_path TO app")
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
      // Усі читання адаптера — на одному пулі: сесійний стан лишився б на
      // його backend, а `pid` доводить, що backend той самий. Витяг двигуна
      // йде тим самим шляхом, що в адаптері (`resolveProfile` → `extract`)
      const pool = readOnlyTransactionPool(url)
      try {
        const before = await sessionOf(pool)
        expect(before.readOnly).toBe("off")
        const profile = await resolveProfile(
          pool,
          scopeProfile(desired.scope),
          { redactSecrets: true }
        )
        await profile.extract(pool, { redactSecrets: true })
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
