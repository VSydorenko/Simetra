import { randomUUID } from "node:crypto"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import { SWEEP_MARGIN_MS, sweepExpired } from "../src/server/agent-oauth/store"
import { startStand, type Stand } from "./agent-oauth-helpers"

/**
 * Прибирання сховища сервера авторизації за строком (спека П4-F §5.4): що
 * видаляється, що лишається, і запас годинника (рішення архітекторки). Рядки
 * ставляться прямо в таблиці: правило прибирання — про рядки, а не про потоки
 * OAuth. Відмову порту після прибирання перевіряє `agent-entry.db.test.ts`.
 * Рівень DB: правило — це `DELETE … LIMIT … FOR UPDATE SKIP LOCKED`, яке
 * виконує й блокує лише Postgres (зокрема два прибирання одночасно).
 */
let stand: Stand
let userId: string

beforeAll(async () => {
  stand = await startStand("aosweep")
  userId = (await stand.signUp()).userId
}, 180_000)
afterAll(() => stand?.close(), 60_000)
beforeEach(async () => {
  await stand.pool.query("DELETE FROM agent_oauth.models")
  await stand.pool.query("DELETE FROM agent_oauth.agent_grants")
})

const NOW = new Date("2026-11-26T12:00:00Z")
const MIN = 60_000
const ago = (ms: number) => new Date(NOW.getTime() - ms)
const later = (ms: number) => new Date(NOW.getTime() + ms)

async function model(
  id: string,
  o: { expiresAt: Date | null; grantId?: string; model?: string }
): Promise<void> {
  await stand.pool.query(
    `INSERT INTO agent_oauth.models (model, id_hash, grant_id, payload, expires_at)
     VALUES ($1, $2, $3, '{}', $4)`,
    [o.model ?? "AccessToken", id, o.grantId ?? null, o.expiresAt]
  )
}

async function grant(
  grantId: string,
  o: { expiresAt: Date; revokedAt?: Date }
): Promise<void> {
  await stand.pool.query(
    `INSERT INTO agent_oauth.agent_grants (grant_id, user_id, client_id, created_at, last_used_at, expires_at, revoked_at)
     VALUES ($1, $2, 'https://client.test/cimd.json', $3, $3, $4, $5)`,
    [grantId, userId, ago(MIN), o.expiresAt, o.revokedAt ?? null]
  )
}

async function modelIds(): Promise<string[]> {
  const { rows } = await stand.pool.query(
    "SELECT id_hash FROM agent_oauth.models ORDER BY id_hash"
  )
  return (rows as { id_hash: string }[]).map((r) => r.id_hash)
}

async function grantIds(): Promise<string[]> {
  const { rows } = await stand.pool.query(
    "SELECT grant_id FROM agent_oauth.agent_grants ORDER BY grant_id"
  )
  return (rows as { grant_id: string }[]).map((r) => r.grant_id)
}

describe("the expiry sweep of the authorization server store", () => {
  it("deletes records past their expiry and the margin; live records stay", async () => {
    await model("expired", { expiresAt: ago(SWEEP_MARGIN_MS + MIN) })
    // Строк минув, але в межах запасу: годинник іншого екземпляра може
    // відставати, і для нього запис ще живий
    await model("in-margin", { expiresAt: ago(MIN) })
    await model("live", { expiresAt: later(MIN) })
    await model("no-expiry", { expiresAt: null })
    expect(await sweepExpired(stand.pool, { now: NOW })).toEqual({
      models: 1,
      grants: 0,
    })
    expect(await modelIds()).toEqual(["in-margin", "live", "no-expiry"])
  }, 60_000)

  it("deletes a revoked or expired grant with every record of it; a live grant stays", async () => {
    const revoked = `revoked-${randomUUID()}`
    const expired = `expired-${randomUUID()}`
    const inMargin = `margin-${randomUUID()}`
    const live = `live-${randomUUID()}`
    await grant(revoked, { expiresAt: later(MIN), revokedAt: ago(MIN) })
    await grant(expired, { expiresAt: ago(SWEEP_MARGIN_MS + MIN) })
    await grant(inMargin, { expiresAt: ago(MIN) })
    await grant(live, { expiresAt: later(MIN) })
    for (const g of [revoked, expired, inMargin, live]) {
      // Записи самі ще живі: прибирає їх кінець гранту, а не власний строк
      await model(`${g}-grant`, {
        model: "Grant",
        grantId: g,
        expiresAt: later(MIN),
      })
      await model(`${g}-rt`, {
        model: "RefreshToken",
        grantId: g,
        expiresAt: later(MIN),
      })
    }
    expect(await sweepExpired(stand.pool, { now: NOW })).toEqual({
      models: 4,
      grants: 2,
    })
    expect(await grantIds()).toEqual([inMargin, live].sort())
    expect(await modelIds()).toEqual(
      [
        `${inMargin}-grant`,
        `${inMargin}-rt`,
        `${live}-grant`,
        `${live}-rt`,
      ].sort()
    )
  }, 60_000)

  it("walks in batches until a short batch and is idempotent", async () => {
    for (let i = 0; i < 7; i++)
      await model(`m${i}`, { expiresAt: ago(SWEEP_MARGIN_MS + MIN) })
    for (let i = 0; i < 5; i++)
      await grant(`g${i}`, { expiresAt: ago(SWEEP_MARGIN_MS + MIN) })
    await model("live", { expiresAt: later(MIN) })
    // Повна межа кроку (рівно `batch` рядків) теж не зупиняє цикл
    expect(await sweepExpired(stand.pool, { now: NOW, batch: 1 })).toEqual({
      models: 7,
      grants: 5,
    })
    expect(await modelIds()).toEqual(["live"])
    expect(await grantIds()).toEqual([])
    expect(await sweepExpired(stand.pool, { now: NOW, batch: 1 })).toEqual({
      models: 0,
      grants: 0,
    })
  }, 60_000)

  it("two sweeps at once delete each row once", async () => {
    for (let i = 0; i < 20; i++)
      await model(`m${i}`, { expiresAt: ago(SWEEP_MARGIN_MS + MIN) })
    const results = await Promise.all([
      sweepExpired(stand.pool, { now: NOW, batch: 3 }),
      sweepExpired(stand.pool, { now: NOW, batch: 3 }),
    ])
    // Прогін, що пропустив рядки під блокуванням іншого (`SKIP LOCKED`),
    // може скінчитися раніше; наступний тік добирає залишок
    const rest = await sweepExpired(stand.pool, { now: NOW, batch: 3 })
    expect(
      results[0]!.models + results[1]!.models + rest.models,
      "every row is counted by exactly one sweep"
    ).toBe(20)
    expect(await modelIds()).toEqual([])
  }, 60_000)

  // Порядок блокувань відкликання: записи гранту, потім його рядок. Прибирання,
  // що чекає на записи, рядка ще не тримає — тож відкликання доходить до
  // рядка без очікування, і взаємного блокування (40P01) немає
  it("a sweep waiting on a revocation holds no lock on the grant row", async () => {
    const g = `racing-${randomUUID()}`
    await grant(g, { expiresAt: ago(SWEEP_MARGIN_MS + MIN) })
    await model(`${g}-rt`, {
      model: "RefreshToken",
      grantId: g,
      expiresAt: later(MIN),
    })
    const revoke = await stand.pool.connect()
    try {
      await revoke.query("BEGIN")
      // Перший крок `revokeGrant`: записи гранту під блокуванням до кінця транзакції
      await revoke.query("DELETE FROM agent_oauth.models WHERE grant_id = $1", [
        g,
      ])
      const sweep = sweepExpired(stand.pool, { now: NOW })
      await vi.waitFor(
        async () => {
          const { rows } = await stand.admin.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
          )
          expect((rows[0] as { n: number }).n).toBeGreaterThan(0)
        },
        { timeout: 10_000 }
      )
      // `NOWAIT`: рядок, узятий прибиранням, дав би 55P03 замість очікування
      await revoke.query(
        "SELECT 1 FROM agent_oauth.agent_grants WHERE grant_id = $1 FOR UPDATE NOWAIT",
        [g]
      )
      await revoke.query(
        "UPDATE agent_oauth.agent_grants SET revoked_at = $2 WHERE grant_id = $1",
        [g, NOW]
      )
      await revoke.query("COMMIT")
      expect(await sweep).toEqual({ models: 0, grants: 1 })
    } finally {
      await revoke.query("ROLLBACK").catch(() => {})
      revoke.release()
    }
    expect(await grantIds()).toEqual([])
    expect(await modelIds()).toEqual([])
  }, 60_000)
})
