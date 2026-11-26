// Portions copied from munin-mcp (https://github.com/VSydorenko/munin-mcp, gateway/src/oauth/login.ts, gateway/src/oauth/grants.ts)
// Copyright 2026 Volodymyr Sydorenko
// Licensed under Apache-2.0. Modified: the pairing login is replaced by the Better Auth session bridge; functions over Request instead of screens; a CSRF token bound to the interaction; the tenant of the grant and re-authorisation of the (client, user, tenant) triple; grants are listed and revoked from agent_grants for the session user only; no pair state machine.
// API взаємодії сервера авторизації агентів для екранів F5 (спека П4-F
// §5.4, Р-F4-12). Сервер авторизації передає той, хто монтує сторінку.
import { createHmac, timingSafeEqual } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import type Provider from "oidc-provider"
import { errors, type InteractionModel } from "oidc-provider"
import type { Pool } from "pg"
import { toFetchHandler } from "srvx/node"
import type { AppClaims } from "../auth"
import { pinnedToOrigin } from "./mount"
import { agentConnectUid } from "./paths"
import { GRANT_TTL_SECONDS, insertAgentGrant, revokeGrant } from "./store"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AgentInteractionOptions {
  provider: Provider
  /** Пул ролі auth (`getAuthPool()`): `agent_oauth` і `better_auth`. */
  pool: Pool
  /** Канонічне походження застосунку (`appOrigin()`). */
  origin: string
  /** Ключі cookie сервера авторизації: перший підписує токен CSRF, будь-який його перевіряє. */
  cookieKeys: readonly string[]
  /** Сесія Better Auth за заголовками запиту (`verifySession`). */
  verifySession: (headers: Headers) => Promise<AppClaims | null>
  /** Застосунок має види скоупу (Р-F4-4): тоді грант без тенанта неможливий. */
  requiresTenant: boolean
}

/** Дані екрана згоди; ідентичність клієнта — хости, а не те, що він каже про себе. */
export interface AgentInteractionView {
  uid: string
  clientId: string
  /** Хост документа CIMD (`client_id`). */
  clientHost: string
  /** Хост `redirect_uri` цього запиту. */
  redirectUriHost: string
  /** Вказано клієнтом: екран показує ці поля з такою позначкою, як неперевірені. */
  clientProvided: { name?: string; clientUri?: string; logoUri?: string }
  requiresTenant: boolean
  /** Токен CSRF: `submitConsent` і `abortInteraction` вимагають його. */
  csrf: string
}

export interface AgentGrantView {
  grantId: string
  clientId: string
  clientHost: string
  tenant: string | null
  lastUsedAt: Date
  createdAt: Date
  expiresAt: Date
}

export type InteractionOutcome<T> =
  { ok: true; value: T } | { ok: false; response: Response }

function refusal(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "no-store" } }
  )
}

const refused = <T>(status: number, error: string): InteractionOutcome<T> => ({
  ok: false,
  response: refusal(status, error),
})

const hostOf = (url: unknown): string =>
  typeof url === "string" ? (URL.parse(url)?.host ?? "") : ""

/** Токен CSRF — HMAC ключем cookie від `uid` і `jti` взаємодії (Р-F4-12). */
function csrfToken(key: string, interaction: InteractionModel): string {
  return createHmac("sha256", key)
    .update(`${interaction.uid}.${interaction.jti}`)
    .digest("base64url")
}

function csrfValid(
  keys: readonly string[],
  interaction: InteractionModel,
  presented: unknown
): boolean {
  if (typeof presented !== "string") return false
  const given = Buffer.from(presented)
  return keys.some((key) => {
    const expected = Buffer.from(csrfToken(key, interaction))
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}

// Повторна авторизація трійки (клієнт, користувач, тенант) відкликає
// попередні гранти; «без тенанта» — теж значення трійки, звідси `IS NOT DISTINCT FROM`.
// Лише старші за власний (`created_at`, за рівності — `grant_id`): дві згоди
// трійки одночасно інакше відкликали б одна одну; так лишається новіша, без блокувань
export async function revokeTriple(
  pool: Pool,
  grantId: string,
  userId: string,
  clientId: string,
  tenant: string | null
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT g.grant_id
     FROM agent_oauth.agent_grants g
     JOIN agent_oauth.agent_grants own ON own.grant_id = $4
     WHERE g.user_id = $1 AND g.client_id = $2 AND g.tenant IS NOT DISTINCT FROM $3::uuid
       AND g.revoked_at IS NULL
       AND (g.created_at, g.grant_id) < (own.created_at, own.grant_id)`,
    [userId, clientId, tenant, grantId]
  )
  for (const row of rows as { grant_id: string }[])
    await revokeGrant(pool, row.grant_id)
}

export function createAgentInteraction(o: AgentInteractionOptions) {
  const { provider, pool } = o

  /**
   * Взаємодія — лише за cookie цього браузера (`interactionDetails`), і лише
   * на її власній сторінці: cookie має шлях `/agent/connect/<uid>`, а `uid`
   * шляху мусить бути тим самим. Інакше — відмова, а взаємодію не зачеплено.
   */
  async function withInteraction(
    request: Request,
    act: (
      interaction: InteractionModel,
      req: IncomingMessage,
      res: ServerResponse
    ) => Promise<Response>
  ): Promise<Response> {
    const uid = agentConnectUid(new URL(request.url).pathname)
    if (uid === undefined) return refusal(404, "interaction_not_found")
    const underInteraction = async (
      req: IncomingMessage,
      res: ServerResponse
    ): Promise<Response> => {
      let interaction: InteractionModel
      try {
        interaction = await provider.interactionDetails(req, res)
      } catch (e) {
        if (e instanceof errors.SessionNotFound)
          return refusal(404, "interaction_not_found")
        throw e
      }
      if (interaction.uid !== uid) return refusal(404, "interaction_not_found")
      return act(interaction, req, res)
    }
    // Бібліотеці потрібні лише cookie: тіло вже прочитав маршрут сторінки
    const bare = pinnedToOrigin(
      new Request(request.url, {
        method: request.method,
        headers: request.headers,
      }),
      o.origin
    )
    let out: Response | undefined
    let failure: { error: unknown } | undefined
    const handled = await toFetchHandler(
      async (req: IncomingMessage, res: ServerResponse) => {
        // Жоден виняток не виходить у srvx: його `fetchNodeHandler` пише в
        // stderr увесь запит разом із cookie взаємодії й сесії Better Auth
        try {
          out = await underInteraction(req, res)
        } catch (error) {
          failure = { error }
        }
        // Відповідь `act` без запису бібліотеки: Node-відповідь лише закривається
        if (!res.writableEnded) res.end()
      }
    )(bare)
    if (failure !== undefined) throw failure.error
    if (out === undefined) throw new Error("agent interaction: no outcome")
    // `Set-Cookie` бібліотеки (взаємодія, `resume`) переходить у відповідь
    if (out.status !== 303) return out
    const headers = new Headers(out.headers)
    for (const cookie of handled.headers.getSetCookie())
      headers.append("set-cookie", cookie)
    return new Response(null, { status: 303, headers })
  }

  const redirect = (location: string): Response =>
    new Response(null, {
      status: 303,
      headers: { location, "cache-control": "no-store" },
    })

  // Неповернутий результат попередньої згоди цієї взаємодії: його грант
  // клієнт ще не отримав і вже не отримає — відкликаємо, щоб не висів у списку
  async function dropPendingGrant(interaction: InteractionModel) {
    const pending = interaction.result?.consent?.grantId
    if (pending !== undefined) await revokeGrant(pool, pending)
  }

  /** Дані для екрана згоди. */
  async function interactionDetails(
    request: Request
  ): Promise<InteractionOutcome<AgentInteractionView>> {
    let view: AgentInteractionView | undefined
    const response = await withInteraction(request, async (interaction) => {
      const clientId = String(interaction.params.client_id ?? "")
      const client = await provider.Client.find(clientId)
      if (client === undefined) return refusal(400, "invalid_client")
      view = {
        uid: interaction.uid,
        clientId,
        clientHost: hostOf(clientId),
        redirectUriHost: hostOf(interaction.params.redirect_uri),
        clientProvided: {
          ...(client.clientName === undefined
            ? {}
            : { name: client.clientName }),
          ...(client.clientUri === undefined
            ? {}
            : { clientUri: client.clientUri }),
          ...(client.logoUri === undefined ? {} : { logoUri: client.logoUri }),
        },
        requiresTenant: o.requiresTenant,
        csrf: csrfToken(o.cookieKeys[0]!, interaction),
      }
      return new Response(null, { status: 204 })
    })
    return view === undefined
      ? { ok: false, response }
      : { ok: true, value: view }
  }

  /**
   * Згода: новий грант для користувача поточної сесії Better Auth запиту
   * (не попередньої особи взаємодії) і переспрямування на `resume`. Будь-яка
   * відмова лишає взаємодію як є: підроблений POST не обриває чужого входу.
   */
  async function submitConsent(
    request: Request,
    input: { tenant?: string | null; csrf: string }
  ): Promise<Response> {
    return withInteraction(request, async (interaction, req, res) => {
      if (!csrfValid(o.cookieKeys, interaction, input.csrf))
        return refusal(403, "invalid_csrf")
      const claims = await o.verifySession(request.headers)
      if (claims === null || claims.is_anonymous)
        return refusal(401, "sign_in_required")
      const tenant = input.tenant ?? null
      if (tenant === null && o.requiresTenant)
        return refusal(400, "tenant_required")
      if (tenant !== null && !o.requiresTenant)
        return refusal(400, "tenant_not_allowed")
      if (tenant !== null && !UUID.test(tenant))
        return refusal(400, "invalid_tenant")
      const clientId = interaction.params.client_id
      const resource = interaction.params.resource
      if (typeof clientId !== "string" || typeof resource !== "string")
        return refusal(400, "invalid_request")

      await dropPendingGrant(interaction)
      const accountId = claims.sub
      const grant = new provider.Grant({ accountId, clientId })
      grant.addOIDCScope("offline_access")
      grant.addResourceScope(resource, "mcp")
      const grantId = await grant.save()
      let returnTo: string
      try {
        await insertAgentGrant(pool, {
          grantId,
          userId: accountId,
          clientId,
          tenant,
          expiresAt: new Date(Date.now() + GRANT_TTL_SECONDS * 1000),
        })
        returnTo = await provider.interactionResult(
          req,
          res,
          { login: { accountId }, consent: { grantId } },
          { mergeWithLastSubmission: false }
        )
        await revokeTriple(pool, grantId, accountId, clientId, tenant)
      } catch (e) {
        // Грант не дійшов до клієнта: відкат тією ж функцією відкликання
        await revokeGrant(pool, grantId)
        throw e
      }
      return redirect(returnTo)
    })
  }

  /** Відмова від підключення: клієнт отримує `access_denied`. */
  async function abortInteraction(
    request: Request,
    input: { csrf: string }
  ): Promise<Response> {
    return withInteraction(request, async (interaction, req, res) => {
      if (!csrfValid(o.cookieKeys, interaction, input.csrf))
        return refusal(403, "invalid_csrf")
      await dropPendingGrant(interaction)
      const returnTo = await provider.interactionResult(
        req,
        res,
        {
          error: "access_denied",
          error_description: "The user declined the connection",
        },
        { mergeWithLastSubmission: false }
      )
      return redirect(returnTo)
    })
  }

  async function sessionUser(request: Request): Promise<string | undefined> {
    const claims = await o.verifySession(request.headers)
    return claims === null || claims.is_anonymous ? undefined : claims.sub
  }

  /**
   * Підключення користувача сесії: не відкликані, не прострочені й з `Grant`,
   * що ще є в сховищі. Строки — годинник JS, як в адаптера (Р-F4-11).
   */
  async function listAgentGrants(
    request: Request
  ): Promise<InteractionOutcome<AgentGrantView[]>> {
    const userId = await sessionUser(request)
    if (userId === undefined) return refused(401, "sign_in_required")
    const { rows } = await pool.query(
      `SELECT g.grant_id, g.client_id, g.tenant, g.last_used_at, g.created_at, g.expires_at
       FROM agent_oauth.agent_grants g
       WHERE g.user_id = $1 AND g.revoked_at IS NULL AND g.expires_at > $2
         AND EXISTS (
           SELECT 1 FROM agent_oauth.models m
           WHERE m.model = 'Grant' AND m.grant_id = g.grant_id
             AND (m.expires_at IS NULL OR m.expires_at > $2))
       ORDER BY g.created_at DESC, g.grant_id`,
      [userId, new Date()]
    )
    type Row = {
      grant_id: string
      client_id: string
      tenant: string | null
      last_used_at: Date
      created_at: Date
      expires_at: Date
    }
    return {
      ok: true,
      value: (rows as Row[]).map((r) => ({
        grantId: r.grant_id,
        clientId: r.client_id,
        clientHost: hostOf(r.client_id),
        tenant: r.tenant,
        lastUsedAt: r.last_used_at,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      })),
    }
  }

  /** Відкликання власного гранту; чужий і відсутній — однакова відмова. */
  async function revokeAgentGrant(
    request: Request,
    grantId: string
  ): Promise<InteractionOutcome<void>> {
    const userId = await sessionUser(request)
    if (userId === undefined) return refused(401, "sign_in_required")
    const { rowCount } = await pool.query(
      "SELECT 1 FROM agent_oauth.agent_grants WHERE grant_id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [grantId, userId]
    )
    if (rowCount !== 1) return refused(404, "grant_not_found")
    await revokeGrant(pool, grantId)
    return { ok: true, value: undefined }
  }

  return {
    interactionDetails,
    submitConsent,
    abortInteraction,
    listAgentGrants,
    revokeAgentGrant,
  }
}

export type AgentInteraction = ReturnType<typeof createAgentInteraction>
