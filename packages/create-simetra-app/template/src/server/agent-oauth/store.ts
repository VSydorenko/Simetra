// Portions copied from munin-mcp (https://github.com/VSydorenko/munin-mcp, gateway/src/oauth/adapter.ts, gateway/src/oauth/revoke.ts)
// Copyright 2026 Volodymyr Sydorenko
// Licensed under Apache-2.0. Modified: Kysely replaced by pg over the Better Auth pool, tables moved to the agent_oauth schema, grant_activity replaced by agent_grants (revoked_at instead of deletion), every timestamp comes from the JS clock, pairing, script keys, audit and events removed.
import { createHash } from "node:crypto"
import type { Pool } from "pg"
import { errors, type ProviderAdapter } from "oidc-provider"

export type AdapterPayload = Record<string, unknown>

/** Точки втручання тестів (у робочому процесі порожні). */
export interface AdapterHooks {
  /** Перед погашенням запису: тест гонки тримає тут запити, доки обидва не пройдуть `find`. */
  beforeConsume?: (model: string, id: string) => Promise<void>
}

// Як у бібліотеки за замовчуванням (`clockTolerance`): запис живе на стільки довше за свій `exp`
const CLOCK_TOLERANCE_SEC = 15

const str = (v: unknown): string | null => (typeof v === "string" ? v : null)

// Стовпець `grant_id` потрібен `revokeByGrantId`; у `Grant` власний id і є grant_id
const GRANT_ID: Record<
  string,
  (id: string, p: AdapterPayload) => string | null
> = {
  Session: () => null,
  Interaction: () => null,
  AuthorizationCode: (_id, p) => str(p.grantId),
  AccessToken: (_id, p) => str(p.grantId),
  RefreshToken: (_id, p) => str(p.grantId),
  Grant: (id) => id,
  // Клієнтів у сховищі немає (CIMD без DCR): бібліотека лише питає `find`
  Client: () => null,
}

// У сховищі лише хеш ключа: сам id — токен чи код
const hashId = (id: string): string =>
  createHash("sha256").update(id, "utf8").digest("hex")

/**
 * Відкликання гранту — одна функція (спека П4-F §5.4), одна транзакція: записи
 * гранту (сам `Grant`, токени, коди) і позначка в `agent_grants`. Ідемпотентне.
 * Кличуть програна гонка адаптера, екран підключених клієнтів і повторна
 * авторизація трійки.
 */
export async function revokeGrant(pool: Pool, grantId: string): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await client.query("DELETE FROM agent_oauth.models WHERE grant_id = $1", [
      grantId,
    ])
    await client.query(
      "UPDATE agent_oauth.agent_grants SET revoked_at = $2 WHERE grant_id = $1 AND revoked_at IS NULL",
      [grantId, new Date()]
    )
    await client.query("COMMIT")
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Слухач `grant.revoked` (повторне вживання, `/revoke`): записи гранту бібліотека вже видалила, лишається рядок. */
export async function markGrantRevoked(
  pool: Pool,
  grantId: string
): Promise<void> {
  await pool.query(
    "UPDATE agent_oauth.agent_grants SET revoked_at = $2 WHERE grant_id = $1 AND revoked_at IS NULL",
    [grantId, new Date()]
  )
}

/** Рядок гранту → тенант; строк — абсолютна межа гранту (365 днів від створення). */
export async function insertAgentGrant(
  pool: Pool,
  g: {
    grantId: string
    userId: string
    clientId: string
    tenant: string | null
    expiresAt: Date
  }
): Promise<void> {
  const now = new Date()
  await pool.query(
    `INSERT INTO agent_oauth.agent_grants (grant_id, user_id, client_id, tenant, created_at, last_used_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $5, $6)`,
    [g.grantId, g.userId, g.clientId, g.tenant, now, g.expiresAt]
  )
}

/** Тенант гранту для закріплення в токені (`extraTokenClaims`). */
export async function grantTenant(
  pool: Pool,
  grantId: string
): Promise<string | null> {
  const { rows } = await pool.query(
    "SELECT tenant FROM agent_oauth.agent_grants WHERE grant_id = $1",
    [grantId]
  )
  return (rows[0] as { tenant: string | null } | undefined)?.tenant ?? null
}

type Row = {
  payload: AdapterPayload
  consumed_at: Date | null
  expires_at: Date | null
}

/**
 * Адаптер `oidc-provider` на `pg`. Строк записів оцінюється в JS (`Date.now()`
 * у `find`), а не в SQL: так само рахує бібліотека, а тест керує годинником
 * через `Date` (Р-F4-11).
 */
export function createPgAdapter(pool: Pool, hooks: AdapterHooks = {}) {
  return (model: string): ProviderAdapter => {
    const grantOf = GRANT_ID[model]
    if (grantOf === undefined) {
      throw new Error(`agent oauth adapter: model ${model} is not supported`)
    }
    const noStore = model === "Client"
    const live = (r: Row | undefined): Row | undefined =>
      r?.expires_at != null && r.expires_at.getTime() <= Date.now()
        ? undefined
        : r
    const load = (
      id: string,
      r: Row | undefined
    ): AdapterPayload | undefined => {
      if (r === undefined) return undefined
      const out: AdapterPayload = { ...r.payload, jti: id }
      if (r.consumed_at !== null)
        out.consumed = Math.floor(r.consumed_at.getTime() / 1000)
      return out
    }
    return {
      async upsert(id, payload, expiresIn) {
        if (noStore)
          throw new Error("agent oauth adapter: Client is not stored")
        const rest = { ...payload }
        delete rest.jti
        const expiresAt =
          typeof expiresIn === "number"
            ? new Date(Date.now() + (expiresIn + CLOCK_TOLERANCE_SEC) * 1000)
            : null
        await pool.query(
          `INSERT INTO agent_oauth.models (model, id_hash, grant_id, uid, payload, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (model, id_hash) DO UPDATE
             SET grant_id = EXCLUDED.grant_id, uid = EXCLUDED.uid,
                 payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at`,
          [
            model,
            hashId(id),
            grantOf(id, payload),
            // Бібліотека шукає за `uid` лише сесію (`Session.findByUid`)
            model === "Session" ? str(payload.uid) : null,
            JSON.stringify(rest),
            expiresAt,
          ]
        )
      },
      async find(id) {
        if (noStore) return undefined
        const { rows } = await pool.query(
          "SELECT payload, consumed_at, expires_at FROM agent_oauth.models WHERE model = $1 AND id_hash = $2",
          [model, hashId(id)]
        )
        return load(id, live(rows[0] as Row | undefined))
      },
      async findByUid(uid) {
        const { rows } = await pool.query(
          "SELECT payload, consumed_at, expires_at FROM agent_oauth.models WHERE model = $1 AND uid = $2",
          [model, uid]
        )
        const r = live(rows[0] as Row | undefined)
        // Id сесії (cookie) у сховищі лише хешем: `jti` сесії не відновлюється
        return r && { ...r.payload }
      },
      findByUserCode() {
        return Promise.reject(
          new Error("agent oauth adapter: device flow is off")
        )
      },
      async consume(id) {
        if (hooks.beforeConsume !== undefined)
          await hooks.beforeConsume(model, id)
        const idHash = hashId(id)
        // Атомарно: лише перший паралельний запит бачить `consumed_at IS NULL`.
        // Бібліотека перевіряє вживання читанням до запису, тож без цього
        // паралельний повтор украденого токена дав би два ланцюжки
        const done = await pool.query(
          "UPDATE agent_oauth.models SET consumed_at = $3 WHERE model = $1 AND id_hash = $2 AND consumed_at IS NULL",
          [model, idHash, new Date()]
        )
        if (done.rowCount === 1) return
        // Уже погашено, зокрема паралельним запитом: повтор відкликає грант
        // цього запису — лише його, не інші гранти того самого клієнта
        const { rows } = await pool.query(
          "SELECT grant_id FROM agent_oauth.models WHERE model = $1 AND id_hash = $2",
          [model, idHash]
        )
        const grantId = (rows[0] as { grant_id: string | null } | undefined)
          ?.grant_id
        if (grantId != null) await revokeGrant(pool, grantId)
        throw new errors.InvalidGrant(`${model} already consumed`)
      },
      async destroy(id) {
        if (noStore) return
        await pool.query(
          "DELETE FROM agent_oauth.models WHERE model = $1 AND id_hash = $2",
          [model, hashId(id)]
        )
      },
      async revokeByGrantId(grantId) {
        await pool.query(
          "DELETE FROM agent_oauth.models WHERE model = $1 AND grant_id = $2",
          [model, grantId]
        )
      },
    }
  }
}
