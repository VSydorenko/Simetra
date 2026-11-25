import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import http from "node:http"
import type { IncomingMessage, ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import pg from "pg"
import { vi } from "vitest"
import { ensurePostgresCluster, type PostgresClusterSet } from "simetra/schema"
import { toFetchHandler } from "srvx/node"
import { createApplyDatabase } from "../../../designer/src/schema-engine"
import {
  dropTaggedCluster,
  prepareStackIdentity,
  roleUrl,
  setTestPasswords,
  taggedClusterSet,
  testSuperuserUrl,
} from "../../../simetra/test/support"
import { authSchemaOptions, withAuthOptions } from "../scripts/auth-options.mjs"
import { migrateAgentOauth } from "../scripts/db-setup-steps.mjs"
import { withAgentOauth } from "../src/server/agent-oauth/mount"
import {
  createAgentOauthProvider,
  type AgentOauthOptions,
} from "../src/server/agent-oauth/provider"
import { insertAgentGrant } from "../src/server/agent-oauth/store"
import { agentOauthKeyEnv } from "./agent-oauth-keys"

/**
 * Стенд сервера авторизації агентів на тегованій базі прогону: кластер
 * профілю `postgres` (схема `agent_oauth` власника auth), міграція Better
 * Auth, крок DDL `agent_oauth` від ролі auth, сервер документів CIMD.
 * Згода — тимчасова підкладка тесту (`consentShim`), доки API взаємодії
 * (задача 5) не дасть `connectAgent`.
 */
export const ORIGIN = "https://app.test"
export const RESOURCE = `${ORIGIN}/mcp`
const SECRET = "simetra-agent-oauth-test-secret-0123456789"
const DAY_MS = 86_400_000

function withDatabaseName(dsn: string, database: string): string {
  const url = new URL(dsn)
  url.pathname = `/${database}`
  return url.toString()
}

export const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/cimd/${name}.json`, import.meta.url),
      "utf8"
    )
  ) as Record<string, unknown>

type App = (request: Request) => Promise<Response>
type Provider = ReturnType<typeof createAgentOauthProvider>

export interface Stand {
  set: PostgresClusterSet
  /** Пул ролі auth — той самий, що й у робочого процесу (`getAuthPool`). */
  pool: pg.Pool
  admin: pg.Pool
  keys: NonNullable<AgentOauthOptions["keys"]>
  docs: Map<string, string>
  hits: Map<string, number>
  /** Транспорт-підміна: `https://host/path` → локальний сервер документів. */
  substituteFetch: typeof fetch
  provider(o?: Partial<AgentOauthOptions>): Provider
  app(provider: Provider): App
  user(): Promise<string>
  close(): Promise<void>
}

export async function startStand(tag: string): Promise<Stand> {
  // Монтування читає канонічне походження з оточення, як у робочому процесі
  vi.stubEnv("SIMETRA_APP_ORIGIN", ORIGIN)
  const set = taggedClusterSet(tag)
  const url = testSuperuserUrl()
  const result = await ensurePostgresCluster(
    createApplyDatabase({ readOnly: false }),
    {
      maintenance: { url: withDatabaseName(url, "postgres") },
      target: { url: withDatabaseName(url, set.database) },
      template: { url: withDatabaseName(url, set.template) },
    },
    set
  )
  if (!result.ok)
    throw new Error(`roles refused: ${result.error.map((d) => d.code)}`)
  await setTestPasswords(set)
  const authUrl = roleUrl(set, set.auth)
  const options = (pool: pg.Pool) =>
    authSchemaOptions(pool, { origin: ORIGIN, secret: SECRET, signUp: true })
  await prepareStackIdentity({
    authUrl,
    auth: set.auth,
    migrate: async (u) => {
      const pool = new pg.Pool({ connectionString: withAuthOptions(u) })
      try {
        await (await getMigrations(options(pool))).runMigrations()
      } finally {
        await pool.end()
      }
    },
  })
  // Крок db-setup від ролі auth; другий запуск доводить ідемпотентність
  await migrateAgentOauth(authUrl)
  await migrateAgentOauth(authUrl)
  const pool = new pg.Pool({ connectionString: withAuthOptions(authUrl) })
  const admin = new pg.Pool({
    connectionString: withDatabaseName(testSuperuserUrl(), set.database),
  })
  const auth = betterAuth(options(pool))

  const docs = new Map<string, string>()
  const hits = new Map<string, number>()
  const docServer = http.createServer((req, res) => {
    const path = req.url ?? ""
    hits.set(path, (hits.get(path) ?? 0) + 1)
    const body = docs.get(path)
    res.statusCode = body === undefined ? 404 : 200
    res.setHeader("content-type", "application/json")
    res.end(body ?? "{}")
  })
  await new Promise<void>((r) => docServer.listen(0, "127.0.0.1", r))
  const docPort = (docServer.address() as AddressInfo).port
  const substituteFetch = (async (input: string | URL | Request) => {
    const u = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    )
    return fetch(`http://127.0.0.1:${docPort}/${u.host}${u.pathname}`)
  }) as typeof fetch

  const env = await agentOauthKeyEnv()
  const keys = {
    cookieKeys: JSON.parse(env.cookieKeys) as string[],
    signingKey: JSON.parse(env.signingKey),
  }

  let seq = 0
  return {
    set,
    pool,
    admin,
    keys,
    docs,
    hits,
    substituteFetch,
    provider: (o = {}) =>
      createAgentOauthProvider({
        origin: ORIGIN,
        pool,
        keys,
        fetch: substituteFetch,
        ...o,
      }),
    app: (provider) => {
      const consent = consentShim(provider, pool)
      return withAgentOauth(
        async (request: Request) =>
          /^\/agent\/connect\/[^/]+$/.test(new URL(request.url).pathname)
            ? consent(request)
            : new Response("not found", { status: 404 }),
        async () => toFetchHandler(provider.callback())
      )
    },
    user: async () => {
      const email = `u${++seq}-${randomBytes(4).toString("hex")}@example.test`
      const r = await auth.api.signUpEmail({
        body: {
          email,
          password: randomBytes(12).toString("base64url"),
          name: "T",
        },
      })
      return r.user.id
    },
    close: async () => {
      docServer.close()
      await pool.end()
      await admin.end()
      await dropTaggedCluster(set)
    },
  }
}

/**
 * Тимчасова згода тесту на сторінці взаємодії: взаємодія — за cookie
 * (`interactionDetails`), грант — для `x-test-user` з тенантом
 * `x-test-tenant`. Справжній міст входу й API взаємодії — задача 5.
 */
function consentShim(provider: Provider, pool: pg.Pool) {
  const handle = toFetchHandler(
    async (req: IncomingMessage, res: ServerResponse) => {
      const details = await provider.interactionDetails(req, res)
      const accountId = String(req.headers["x-test-user"])
      const tenant = req.headers["x-test-tenant"]
      const clientId = String(details.params.client_id)
      const grant = new provider.Grant({ accountId, clientId })
      grant.addOIDCScope("offline_access")
      grant.addResourceScope(String(details.params.resource), "mcp")
      const grantId = await grant.save()
      await insertAgentGrant(pool, {
        grantId,
        userId: accountId,
        clientId,
        tenant: typeof tenant === "string" ? tenant : null,
        expiresAt: new Date(Date.now() + 365 * DAY_MS),
      })
      const redirectTo = await provider.interactionResult(
        req,
        res,
        { login: { accountId }, consent: { grantId } },
        { mergeWithLastSubmission: false }
      )
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ redirectTo, grantId }))
    }
  )
  // Підкладка поза шляхами сервера авторизації: проксі-заголовки ставить вона сама
  return (request: Request) => {
    const headers = new Headers(request.headers)
    headers.set("x-forwarded-proto", "https")
    headers.set("host", "app.test")
    return handle(new Request(request, { headers }))
  }
}

/** Cookie-jar з `Path`: браузер шле cookie лише на шлях, для якого її поставлено. */
export class Jar {
  private readonly map = new Map<string, { value: string; path: string }>()
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";")
      const eq = pair!.indexOf("=")
      const name = pair!.slice(0, eq).trim()
      const value = pair!.slice(eq + 1).trim()
      const path =
        attrs
          .map((a) => a.trim())
          .find((a) => a.toLowerCase().startsWith("path="))
          ?.slice(5) ?? "/"
      if (value === "" || /expires=Thu, 01 Jan 1970/i.test(line))
        this.map.delete(name)
      else this.map.set(name, { value, path })
    }
  }
  header(url: string): string {
    const { pathname } = new URL(url, ORIGIN)
    return [...this.map]
      .filter(
        ([, c]) =>
          pathname === c.path ||
          pathname.startsWith(`${c.path.replace(/\/$/, "")}/`)
      )
      .map(([k, c]) => `${k}=${c.value}`)
      .join("; ")
  }
}

export const pkce = () => {
  const verifier = randomBytes(32).toString("base64url")
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  }
}

export interface Flow {
  jar: Jar
  verifier: string
  uid: string
  clientId: string
  redirectUri: string
}

export function authorizeUrl(
  o: { clientId: string; redirectUri: string; scope?: string },
  challenge: string,
  extra: Record<string, string> = {}
): string {
  return `${ORIGIN}/authorize?${new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st",
    scope: o.scope ?? "mcp offline_access",
    resource: RESOURCE,
    ...extra,
  })}`
}

export async function authorize(
  app: App,
  o: { clientId: string; redirectUri: string; scope?: string }
): Promise<{ res: Response; flow?: Flow }> {
  const { verifier, challenge } = pkce()
  const jar = new Jar()
  const res = await app(
    new Request(authorizeUrl(o, challenge), { redirect: "manual" })
  )
  jar.take(res)
  const m = /^\/agent\/connect\/([\w-]+)$/.exec(
    res.headers.get("location") ?? ""
  )
  if (res.status !== 303 || !m) return { res }
  return { res, flow: { jar, verifier, uid: m[1]!, ...o } }
}

export async function tokenPost(
  app: App,
  form: Record<string, string | string[]>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(form))
    for (const one of [v].flat()) params.append(k, one)
  const res = await app(
    new Request(`${ORIGIN}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    })
  )
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  }
}

export interface Login {
  userId: string
  grantId: string
  code: string
  flow: Flow
  tokens: Record<string, unknown>
}

/** Повний цикл: authorize → згода (підкладка) → resume → обмін коду. */
export async function connect(
  app: App,
  o: {
    clientId: string
    redirectUri: string
    scope?: string
    userId: string
    tenant?: string
    /** Без обміну коду: тест обмінює його сам. */
    noExchange?: boolean
  }
): Promise<Login> {
  const { res, flow } = await authorize(app, o)
  if (flow === undefined)
    throw new Error(`authorize: ${res.status} ${await res.text()}`)
  const consentUrl = `${ORIGIN}/agent/connect/${flow.uid}`
  const c = await app(
    new Request(consentUrl, {
      method: "POST",
      headers: {
        cookie: flow.jar.header(consentUrl),
        "x-test-user": o.userId,
        ...(o.tenant ? { "x-test-tenant": o.tenant } : {}),
      },
    })
  )
  flow.jar.take(c)
  const consent = (await c.json()) as { redirectTo: string; grantId: string }
  const resumeUrl = new URL(consent.redirectTo, ORIGIN).href
  const r = await app(
    new Request(resumeUrl, {
      redirect: "manual",
      headers: { cookie: flow.jar.header(resumeUrl) },
    })
  )
  flow.jar.take(r)
  const callback = new URL(r.headers.get("location") ?? "about:blank")
  const code = callback.searchParams.get("code")
  if (r.status !== 303 || code === null)
    throw new Error(`resume: ${r.status} ${callback.href}`)
  const login = {
    userId: o.userId,
    grantId: consent.grantId,
    code,
    flow,
    tokens: {},
  }
  if (o.noExchange) return login
  const t = await exchange(app, login)
  if (t.status !== 200) throw new Error(`token: ${JSON.stringify(t.body)}`)
  return { ...login, tokens: t.body }
}

export const exchange = (
  app: App,
  login: Pick<Login, "code" | "flow">,
  resource: string | string[] = RESOURCE
) =>
  tokenPost(app, {
    grant_type: "authorization_code",
    code: login.code,
    code_verifier: login.flow.verifier,
    client_id: login.flow.clientId,
    redirect_uri: login.flow.redirectUri,
    resource,
  })

export const refresh = (
  app: App,
  clientId: string,
  refreshToken: string,
  resource: string | string[] | undefined = RESOURCE
) =>
  tokenPost(app, {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    ...(resource === undefined ? {} : { resource }),
  })

export async function grantRow(
  pool: pg.Pool,
  grantId: string
): Promise<{ revoked_at: Date | null; tenant: string | null } | undefined> {
  const { rows } = await pool.query(
    "SELECT revoked_at, tenant FROM agent_oauth.agent_grants WHERE grant_id = $1",
    [grantId]
  )
  return rows[0] as
    { revoked_at: Date | null; tenant: string | null } | undefined
}
