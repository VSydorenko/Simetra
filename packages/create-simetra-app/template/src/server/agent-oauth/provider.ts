// Portions copied from munin-mcp (https://github.com/VSydorenko/munin-mcp, gateway/src/oauth/provider.ts)
// Copyright 2026 Volodymyr Sydorenko
// Licensed under Apache-2.0. Modified: removed tokenGate, grant activity, DCR, MCP bases, the redirect allowlist and pino; issuer and resource come from appOrigin(); keys come from the environment; the adapter is Postgres; the account is looked up in Better Auth; the grant tenant is pinned into the token; the error page is in English.
import type { Pool } from "pg"
import Provider, {
  errors,
  interactionPolicy,
  type KoaContextWithOIDC,
  type ProviderAdapter,
  type StoredToken,
} from "oidc-provider"
import { getAuthPool } from "../auth-db"
import { agentOauthKeys, appOrigin, type AgentOauthKeys } from "../config"
import { AGENT_MCP_PATH } from "./paths"
import { providerKeys } from "./keys"
import { safeFetch, withCimdNormalization } from "./safe-fetch"
import { createPgAdapter, grantTenant, markGrantRevoked } from "./store"

const DAY = 86_400

export interface AgentOauthOptions {
  origin: string
  pool: Pool
  /** Типово — ключі середовища (`agentOauthKeys`), у розробці ефемерні. */
  keys?: AgentOauthKeys
  adapter?: (model: string) => ProviderAdapter
  /** Транспорт документів CIMD; типово — власний, із захистом від SSRF. */
  fetch?: typeof fetch
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

// Ідентифікатор користувача Better Auth (`generateId: "uuid"`): інший рядок у
// запит не йде, бо `uuid`-стовпець відповів би помилкою, а не «не знайдено»
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Сторінка взаємодії на кожному `/authorize`; наявний грант не перевикористовується
function alwaysInteractionPolicy() {
  const { Prompt, Check, base } = interactionPolicy
  const policy = base()
  policy.clear()
  policy.add(
    new Prompt(
      { name: "login", requestable: true },
      new Check(
        "always",
        "Agent connection needs an explicit approval",
        (ctx) => !(ctx.oidc.route === "resume" && ctx.oidc.result?.login)
      )
    )
  )
  policy.add(new Prompt({ name: "consent", requestable: true }))
  return policy
}

/** Конфіг `oidc-provider` за спекою П4-F §5.4. */
export function createAgentOauthProvider(o: AgentOauthOptions): Provider {
  const { origin, pool } = o
  const { cookieKeys, jwks } = providerKeys(o.keys)
  const resource = `${origin}${AGENT_MCP_PATH}`
  const provider = new Provider(origin, {
    adapter: o.adapter ?? createPgAdapter(pool),
    fetch: withCimdNormalization(
      o.fetch ?? ((url, init) => safeFetch(url, init))
    ),
    routes: {
      authorization: "/authorize",
      token: "/token",
      revocation: "/revoke",
      jwks: "/jwks",
    },
    // Лише публічні клієнти; компенсація — ротація токена оновлення з
    // відкликанням гранту при повторному вживанні
    clientAuthMethods: ["none"],
    clientDefaults: {
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      // Ключ лише Ed25519; id_token не видається, але метадані клієнта мусять мати допустимий алгоритм
      id_token_signed_response_alg: "EdDSA",
    },
    scopes: ["offline_access", "mcp"],
    responseTypes: ["code"],
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      userinfo: { enabled: false },
      rpInitiatedLogout: { enabled: false },
      registration: { enabled: false },
      revocation: { enabled: true },
      pushedAuthorizationRequests: { enabled: false },
      dPoP: { enabled: false },
      // Ім'я й `ack` — з lib/helpers/features.js 9.12.2 (EXPERIMENTS)
      clientIdMetadataDocument: {
        enabled: true,
        ack: "draft-02",
        allowFetch: (_ctx: unknown, clientId: string) => {
          const u = URL.parse(clientId)
          return (
            !!u &&
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            !clientId.includes("#") &&
            u.pathname !== "/" &&
            u.pathname !== ""
          )
        },
      },
      resourceIndicators: {
        enabled: true,
        // Ресурс у запиті обов'язковий: без нього токен не прив'язаний до MCP
        defaultResource: (
          _ctx: unknown,
          _client: unknown,
          oneOf?: string[]
        ) => {
          if (oneOf) return oneOf
          throw new errors.InvalidTarget("resource indicator is required")
        },
        // Оновлення без `resource` розв'язується в наданий ресурс
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx: unknown, requested: string) => {
          if (requested !== resource) throw new errors.InvalidTarget()
          return {
            scope: "mcp",
            audience: resource,
            accessTokenTTL: 3600,
            accessTokenFormat: "opaque",
          }
        },
      },
    },
    ttl: {
      AuthorizationCode: 60,
      AccessToken: 3600,
      // Сталий строк: кожна ротація дає 30 днів від останнього оновлення
      // (простій); типова функція для публічних клієнтів залишок не подовжує
      RefreshToken: 30 * DAY,
      Interaction: 600,
      Session: 600,
      // Абсолютна межа гранту; після неї — нове підключення
      Grant: 365 * DAY,
    },
    // `/revoke` будь-якого токена відкликає грант, а не лише токен
    revokeGrantPolicy: () => true,
    // Грант — лише той, що видано щойно завершеною взаємодією; із сесії — ніколи
    loadExistingGrant: (ctx: KoaContextWithOIDC) => {
      const grantId =
        ctx.oidc.route === "resume"
          ? ctx.oidc.result?.consent?.grantId
          : undefined
      return grantId ? ctx.oidc.provider.Grant.find(grantId) : undefined
    },
    // Клієнти MCP просять лише scope з PRM, а специфікація MCP не радить
    // оголошувати `offline_access`
    issueRefreshToken: () => true,
    // Завжди: типова політика зупиняє ротацію після року життя токена
    rotateRefreshToken: true,
    // Грант не залежить від сесії Better Auth чи сесії OP
    expiresWithSession: () => false,
    // Тенант гранту — закріплення в токені; порт звіряє його з рядком
    extraTokenClaims: async (_ctx: unknown, token: StoredToken) => {
      const tenant =
        token.grantId === undefined
          ? null
          : await grantTenant(pool, token.grantId)
      return tenant === null ? undefined : { pin: tenant }
    },
    interactions: {
      url: (_ctx: unknown, interaction: { uid: string }) =>
        `/agent/connect/${interaction.uid}`,
      policy: alwaysInteractionPolicy(),
    },
    // Обліковий запис — користувач Better Auth: оновлення токена видаленого
    // користувача — `invalid_grant`
    findAccount: async (_ctx: unknown, sub: string) => {
      if (!UUID.test(sub)) return undefined
      const { rowCount } = await pool.query(
        'SELECT 1 FROM better_auth."user" WHERE id = $1',
        [sub]
      )
      return rowCount === 1
        ? { accountId: sub, claims: () => ({ sub }) }
        : undefined
    },
    // Типова сторінка бібліотеки пише NOTICE у журнал (знахідка 8 F0)
    renderError: (ctx: KoaContextWithOIDC, out: { error?: string }) => {
      ctx.type = "html"
      ctx.set("content-security-policy", "default-src 'none'")
      ctx.body =
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connection failed</title></head><body>' +
        "<h1>The connection could not be started</h1><p>The request from the application is invalid or has expired. " +
        "Start the connection again in the application.</p>" +
        `<p>Error code: <code>${escapeHtml(String(out.error ?? "server_error"))}</code></p></body></html>`
    },
    cookies: { keys: cookieKeys },
    jwks,
  })
  // Заголовки `X-Forwarded-*` ставить лише шар монтування від `appOrigin()`
  // (`mount.ts`): клієнтські він стирає, тож довіряємо тільки своїм
  provider.proxy = true
  provider.use(async (ctx, next) => {
    await next()
    // Ідентичність між входами не переноситься: сесію OP знищуємо одразу
    // після `resume`, тож особа з попереднього входу в тому самому браузері
    // не переходить у новий грант
    if (
      ctx.oidc?.route === "resume" &&
      ctx.oidc.session &&
      !ctx.oidc.session.destroyed
    ) {
      await ctx.oidc.session.destroy()
    }
  })
  // Повторне вживання й `/revoke` лишають рядок `agent_grants` живим без цього слухача
  provider.on("grant.revoked", (_ctx: never, grantId: never) => {
    markGrantRevoked(pool, grantId as string).catch((error: unknown) => {
      console.error(
        "[simetra] agent oauth: failed to mark a revoked grant",
        error
      )
    })
  })
  return provider
}

let singleton: Provider | undefined

/** Сервер авторизації процесу: ліниво, з оточення й пула Better Auth. */
export function agentOauthProvider(): Provider {
  return (singleton ??= createAgentOauthProvider({
    origin: appOrigin(),
    pool: getAuthPool(),
    keys: agentOauthKeys(),
  }))
}
