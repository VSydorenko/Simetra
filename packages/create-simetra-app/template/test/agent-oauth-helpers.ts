import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import http from "node:http"
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
import { createVerifySession } from "../src/server/auth"
import {
  createAgentInteraction,
  type AgentInteraction,
  type AgentInteractionOptions,
  type AgentInteractionView,
} from "../src/server/agent-oauth/interaction"
import { withAgentOauth } from "../src/server/agent-oauth/mount"
import {
  agentConnectPath,
  agentConnectUid,
} from "../src/server/agent-oauth/paths"
import {
  createAgentOauthProvider,
  type AgentOauthOptions,
} from "../src/server/agent-oauth/provider"
import { agentOauthKeyEnv } from "./agent-oauth-keys"

/**
 * Стенд сервера авторизації агентів на тегованій базі прогону: кластер
 * профілю `postgres` (схема `agent_oauth` власника auth), міграція Better
 * Auth, крок DDL `agent_oauth` від ролі auth, сервер документів CIMD.
 * Сторінка взаємодії стенду віддає API взаємодії шаблону під
 * `/agent/connect/<uid>`, `/api/auth/*` — Better Auth: браузер тесту
 * (`Browser`) ходить туди зі своїм cookie-jar, як справжній.
 */
export const ORIGIN = "https://app.test"
export const RESOURCE = `${ORIGIN}/mcp`
const SECRET = "simetra-agent-oauth-test-secret-0123456789"

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

type Provider = ReturnType<typeof createAgentOauthProvider>

/** Застосунок стенду: Fetch-обробник плюс його сервер авторизації й API взаємодії. */
export type App = ((request: Request) => Promise<Response>) & {
  provider: Provider
  api: AgentInteraction
}

export interface Credentials {
  userId: string
  email: string
  password: string
}

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
  /** `requiresTenant` — прапорець застосунку з видами скоупу (Р-F4-4); типово `false`. */
  app(
    provider: Provider,
    o?: {
      requiresTenant?: boolean
      /** Підміна сесії Better Auth (тест збою моста); типово — справжня. */
      verifySession?: AgentInteractionOptions["verifySession"]
    }
  ): App
  /** Користувач Better Auth із паролем (вхід — `Browser.signIn`). */
  signUp(): Promise<Credentials>
  /** Новий браузер, у якому щойно зареєстрований користувач увійшов. */
  browser(app: App): Promise<Browser>
  /** Сесійний верифікатор людини шаблону (`createVerifySession`) над Better Auth стенду. */
  verifySession: AgentInteractionOptions["verifySession"]
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
  const verifySession = createVerifySession((args) => auth.api.getSession(args))
  const stand: Stand = {
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
    app: (provider, o = {}) => {
      const api = createAgentInteraction({
        provider,
        pool,
        origin: ORIGIN,
        cookieKeys: keys.cookieKeys,
        verifySession: o.verifySession ?? verifySession,
        requiresTenant: o.requiresTenant ?? false,
      })
      const fetch = withAgentOauth(
        async (request: Request) => {
          const { pathname } = new URL(request.url)
          if (pathname.startsWith("/api/auth/")) return auth.handler(request)
          if (agentConnectUid(pathname) !== undefined)
            return interactionPage(api, request)
          return new Response("not found", { status: 404 })
        },
        async () => toFetchHandler(provider.callback())
      )
      return Object.assign(fetch, { provider, api })
    },
    signUp: async () => {
      const email = `u${++seq}-${randomBytes(4).toString("hex")}@example.test`
      const password = randomBytes(12).toString("base64url")
      const r = await auth.api.signUpEmail({
        body: { email, password, name: "T" },
      })
      return { userId: r.user.id, email, password }
    },
    browser: async (app) => {
      const browser = new Browser(app)
      await browser.signIn(await stand.signUp())
      return browser
    },
    verifySession,
    close: async () => {
      docServer.close()
      await pool.end()
      await admin.end()
      await dropTaggedCluster(set)
    },
  }
  return stand
}

/**
 * Сторінка взаємодії стенду (екрани — F5): GET — дані згоди, POST — згода
 * чи відмова з тенантом і токеном CSRF у JSON. Лише обгортка над API шаблону.
 */
async function interactionPage(
  api: AgentInteraction,
  request: Request
): Promise<Response> {
  if (request.method === "GET") {
    const details = await api.interactionDetails(request)
    return details.ok ? Response.json(details.value) : details.response
  }
  const body = (await request.json()) as {
    action: "consent" | "abort"
    csrf: string
    tenant?: string
  }
  return body.action === "abort"
    ? api.abortInteraction(request, { csrf: body.csrf })
    : api.submitConsent(request, { csrf: body.csrf, tenant: body.tenant })
}

/**
 * Cookie-jar з `Path`: браузер шле cookie лише на шлях, для якого її
 * поставлено; cookie з тим самим ім'ям і різними шляхами (дві взаємодії)
 * живуть поряд.
 */
export class Jar {
  private readonly map = new Map<
    string,
    { name: string; value: string; path: string }
  >()
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(";")
      const eq = pair!.indexOf("=")
      const name = pair!.slice(0, eq).trim()
      const value = pair!.slice(eq + 1).trim()
      const attr = (key: string) =>
        attrs
          .map((a) => a.trim())
          .find((a) => a.toLowerCase().startsWith(`${key}=`))
          ?.slice(key.length + 1)
      const path = attr("path") ?? "/"
      const key = `${name}\u0000${path}`
      if (
        value === "" ||
        attr("max-age") === "0" ||
        /expires=Thu, 01 Jan 1970/i.test(line)
      )
        this.map.delete(key)
      else this.map.set(key, { name, value, path })
    }
  }
  header(url: string): string {
    const { pathname } = new URL(url, ORIGIN)
    return [...this.map.values()]
      .filter(
        (c) =>
          pathname === c.path ||
          pathname.startsWith(`${c.path.replace(/\/$/, "")}/`)
      )
      .map((c) => `${c.name}=${c.value}`)
      .join("; ")
  }
}

/**
 * Браузер людини: cookie-jar за `Path` і сесія Better Auth. Запити йдуть у
 * застосунок без ручних cookie; `with` — той самий браузер на іншому
 * застосунку стенду (інший `requiresTenant`).
 */
export class Browser {
  userId: string | undefined
  // Своя адреса на браузер: ліміт входу Better Auth рахується за адресою
  private readonly ip = `10.${[1, 2, 3].map(() => randomBytes(1)[0]!).join(".")}`
  constructor(
    readonly app: App,
    readonly jar = new Jar()
  ) {}
  with(app: App): Browser {
    const other = new Browser(app, this.jar)
    other.userId = this.userId
    return other
  }
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const target = new URL(url, ORIGIN).href
    const headers = new Headers(init.headers)
    const cookie = this.jar.header(target)
    if (cookie !== "") headers.set("cookie", cookie)
    headers.set("x-forwarded-for", this.ip)
    const res = await this.app(
      new Request(target, { ...init, headers, redirect: "manual" })
    )
    this.jar.take(res)
    return res
  }
  private auth(path: string, body: unknown): Promise<Response> {
    return this.fetch(`/api/auth${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify(body),
    })
  }
  async signIn(c: Pick<Credentials, "email" | "password">): Promise<void> {
    const res = await this.auth("/sign-in/email", c)
    if (res.status !== 200)
      throw new Error(`sign-in: ${res.status} ${await res.text()}`)
    this.userId = ((await res.json()) as { user: { id: string } }).user.id
  }
  async signInAnonymous(): Promise<void> {
    const res = await this.auth("/sign-in/anonymous", {})
    if (res.status !== 200)
      throw new Error(`anonymous sign-in: ${res.status} ${await res.text()}`)
    this.userId = ((await res.json()) as { user: { id: string } }).user.id
  }
  async signOut(): Promise<void> {
    const res = await this.auth("/sign-out", {})
    if (res.status !== 200)
      throw new Error(`sign-out: ${res.status} ${await res.text()}`)
    this.userId = undefined
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
  browser: Browser
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
  o: { clientId: string; redirectUri: string; scope?: string },
  browser = new Browser(app)
): Promise<{ res: Response; flow?: Flow }> {
  const { verifier, challenge } = pkce()
  const res = await browser.fetch(authorizeUrl(o, challenge))
  const uid = agentConnectUid(res.headers.get("location") ?? "")
  if (res.status !== 303 || uid === undefined) return { res }
  return { res, flow: { browser, verifier, uid, ...o } }
}

/** Сторінка взаємодії потоку: GET — дані згоди з токеном CSRF. */
export async function interactionView(flow: Flow) {
  const res = await flow.browser.fetch(agentConnectPath(flow.uid))
  if (res.status !== 200)
    throw new Error(`interaction: ${res.status} ${await res.text()}`)
  return (await res.json()) as AgentInteractionView
}

/** POST сторінки взаємодії від імені браузера потоку (чи іншого). */
export function postInteraction(
  flow: Flow,
  body: { action: "consent" | "abort"; csrf?: string; tenant?: string },
  browser: Browser = flow.browser
): Promise<Response> {
  return browser.fetch(agentConnectPath(flow.uid), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** Перехід на `resume` після згоди: код у переспрямуванні на `redirect_uri`. */
export async function resume(flow: Flow, consent: Response): Promise<string> {
  if (consent.status !== 303)
    throw new Error(`consent: ${consent.status} ${await consent.text()}`)
  const r = await flow.browser.fetch(consent.headers.get("location") ?? "")
  const callback = new URL(r.headers.get("location") ?? "about:blank")
  const code = callback.searchParams.get("code")
  if (r.status !== 303 || code === null)
    throw new Error(`resume: ${r.status} ${callback.href}`)
  return code
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

/**
 * Підключення агента так, як його проходить людина: `/authorize` → сторінка
 * взаємодії (дані згоди й токен CSRF) → згода → `resume` → обмін коду.
 * Cookie — лише з jar браузера за `Path`, вручну нічого не шлеться.
 */
export async function connectAgent(
  browser: Browser,
  o: {
    clientId: string
    redirectUri: string
    scope?: string
    tenant?: string
    /** Без обміну коду: тест обмінює його сам. */
    noExchange?: boolean
  }
): Promise<Login> {
  const { app } = browser
  const { res, flow } = await authorize(app, o, browser)
  if (flow === undefined)
    throw new Error(`authorize: ${res.status} ${await res.text()}`)
  const view = await interactionView(flow)
  const code = await resume(
    flow,
    await postInteraction(flow, {
      action: "consent",
      csrf: view.csrf,
      ...(o.tenant === undefined ? {} : { tenant: o.tenant }),
    })
  )
  const grantId = (await app.provider.AuthorizationCode.find(code))?.grantId
  if (grantId === undefined || browser.userId === undefined)
    throw new Error("connectAgent: no grant behind the code")
  const login = { userId: browser.userId, grantId, code, flow, tokens: {} }
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
