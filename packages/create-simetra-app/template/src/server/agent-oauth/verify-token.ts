// Порт `VerifyAgentToken` шаблону (спека П4-F §5.4, Р-F4-11): у процесі, над
// сховищем сервера авторизації, на кожен запит MCP — без кешу, тож
// відкликання діє з наступного виклику.
import type { Pool } from "pg"
import type Provider from "oidc-provider"
import type { AgentTokenInfo, VerifyAgentToken } from "simetra/model"

export interface VerifyAgentTokenOptions {
  provider: Provider
  /** Пул ролі auth (`getAuthPool()`): `agent_oauth` і `better_auth`. */
  pool: Pool
}

type GrantRow = {
  revoked_at: Date | null
  expires_at: Date
  tenant: string | null
  is_anonymous: boolean | null
}

const asArray = (v: unknown): string[] =>
  typeof v === "string"
    ? [v]
    : Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : []

export function createVerifyAgentToken(
  o: VerifyAgentTokenOptions
): VerifyAgentToken {
  const { provider, pool } = o
  return async (value, resource): Promise<AgentTokenInfo | null> => {
    // Пошук лише серед токенів доступу: токен оновлення чи код як bearer
    // у сховищі `AccessToken` не знаходиться
    const token = await provider.AccessToken.find(value)
    if (token === undefined) return null
    // Бібліотека пропускає запис із допуском годинника (15 с); строк токена —
    // без допуску, тим самим годинником JS
    if (token.isExpired !== false) return null
    // Токен, прив'язаний до ключа (DPoP `jkt`, mTLS `x5t#S256` — `cnf`), як
    // bearer не приймається: перевірки доказу володіння тут немає
    if (token.jkt !== undefined || token["x5t#S256"] !== undefined) return null
    const aud = asArray(token.aud)
    if (!aud.includes(resource)) return null
    const { grantId, accountId, clientId } = token
    if (
      grantId === undefined ||
      accountId === undefined ||
      clientId === undefined
    )
      return null
    const grant = await provider.Grant.find(grantId)
    if (grant === undefined || grant.isExpired) return null
    // Токен мусить належати саме цьому гранту: іншої трійки клієнт/користувач
    // запис гранту не підтверджує
    if (grant.clientId !== clientId || grant.accountId !== accountId)
      return null
    const now = new Date()
    // Рядок гранту з користувачем Better Auth одним запитом: немає
    // користувача — немає й рядка (і FK з каскадом теж його прибирає)
    const { rows } = await pool.query(
      `SELECT g.revoked_at, g.expires_at, g.tenant, u."isAnonymous" AS is_anonymous
       FROM agent_oauth.agent_grants g
       JOIN better_auth."user" u ON u.id = g.user_id
       WHERE g.grant_id = $1 AND g.user_id::text = $2`,
      [grantId, accountId]
    )
    const row = rows[0] as GrantRow | undefined
    if (row === undefined) return null
    if (row.revoked_at !== null) return null
    if (row.expires_at.getTime() <= now.getTime()) return null
    const pin = (token.extra as { pin?: unknown } | undefined)?.pin
    // Закріплення токена — знімок тенанта гранту на видачу; розбіжність із
    // рядком означає, що токен не відповідає гранту
    if ((pin ?? null) !== row.tenant) return null
    await pool.query(
      "UPDATE agent_oauth.agent_grants SET last_used_at = $2 WHERE grant_id = $1",
      [grantId, now]
    )
    return {
      sub: accountId,
      // З запису користувача, а не з гранту: позначка після підключення діє
      isAnonymous: row.is_anonymous === true,
      clientId,
      aud,
      ...(typeof pin === "string" ? { pin } : {}),
    }
  }
}
