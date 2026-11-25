import { createHmac, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import {
  authorize,
  Browser,
  connectAgent,
  fixture,
  grantRow,
  interactionView,
  ORIGIN,
  postInteraction,
  refresh,
  resume,
  startStand,
  type Flow,
  type Login,
  type Stand,
} from "./agent-oauth-helpers"

/**
 * Міст входу й API взаємодії сервера авторизації агентів (спека П4-F §5.4,
 * Р-F4-12): особа гранту — сесія Better Auth запиту, взаємодія — лише за
 * cookie браузера на її сторінці, токен CSRF, тенант за `requiresTenant`,
 * повторна авторизація трійки, список і відкликання лише своїх грантів.
 * DB-тест: грант, сесія й cookie живуть у `agent_oauth` і `better_auth`.
 * Відмову 401 на `/mcp` дає порт задачі 6; тут — те, що порт читає: `Grant`,
 * рядок `agent_grants`, записи токенів.
 */
let stand: Stand
let provider: ReturnType<Stand["provider"]>
let app: ReturnType<Stand["app"]>
let tenantApp: ReturnType<Stand["app"]>

const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata"
const LOOPBACK = "http://localhost:53123/callback"
const client = { clientId: CLIENT, redirectUri: LOOPBACK }

beforeAll(async () => {
  stand = await startStand("aoint")
  stand.docs.set(
    "/claude.ai/oauth/claude-code-client-metadata",
    JSON.stringify(fixture("claude-code"))
  )
  provider = stand.provider()
  app = stand.app(provider)
  tenantApp = stand.app(provider, { requiresTenant: true })
}, 180_000)
afterAll(() => stand?.close(), 60_000)

/** Живі рядки `agent_grants` користувача. */
async function liveGrants(userId: string): Promise<string[]> {
  const { rows } = await stand.pool.query(
    "SELECT grant_id FROM agent_oauth.agent_grants WHERE user_id = $1 AND revoked_at IS NULL",
    [userId]
  )
  return (rows as { grant_id: string }[]).map((r) => r.grant_id)
}

/** Грант мертвий так, як його бачить порт: немає `Grant`, токенів, рядок відкликано. */
async function expectRevoked(l: Login): Promise<void> {
  expect(await provider.Grant.find(l.grantId)).toBeUndefined()
  expect((await grantRow(stand.pool, l.grantId))?.revoked_at).not.toBeNull()
  expect(
    await provider.AccessToken.find(l.tokens.access_token as string)
  ).toBeUndefined()
  expect(
    (await refresh(app, CLIENT, l.tokens.refresh_token as string)).body.error
  ).toBe("invalid_grant")
}

async function expectAlive(l: Login): Promise<void> {
  expect(await provider.Grant.find(l.grantId)).toBeDefined()
  expect((await grantRow(stand.pool, l.grantId))?.revoked_at).toBeNull()
  expect(
    await provider.AccessToken.find(l.tokens.access_token as string)
  ).toBeDefined()
}

async function startFlow(browser: Browser): Promise<Flow> {
  const { res, flow } = await authorize(browser.app, client, browser)
  if (flow === undefined) throw new Error(`authorize: ${res.status}`)
  return flow
}

const consent = async (
  flow: Flow,
  o: { tenant?: string; csrf?: string } = {},
  browser?: Browser
) =>
  postInteraction(
    flow,
    {
      action: "consent",
      csrf: o.csrf ?? (await interactionView(flow)).csrf,
      ...(o.tenant === undefined ? {} : { tenant: o.tenant }),
    },
    browser
  )

/** Запит від імені сесії браузера (для `listAgentGrants`, `revokeAgentGrant`). */
const sessionRequest = (browser: Browser) =>
  new Request(`${ORIGIN}/`, {
    headers: { cookie: browser.jar.header(`${ORIGIN}/`) },
  })

async function listed(browser: Browser): Promise<string[]> {
  const out = await browser.app.api.listAgentGrants(sessionRequest(browser))
  if (!out.ok) throw new Error(`list: ${out.response.status}`)
  return out.value.map((g) => g.grantId)
}

describe("interactionDetails", () => {
  it("names the client by hosts, marks what the client says about itself, keeps the cookie on the page path", async () => {
    const browser = await stand.browser(app)
    const flow = await startFlow(browser)
    const view = await interactionView(flow)
    expect(view).toMatchObject({
      uid: flow.uid,
      clientId: CLIENT,
      clientHost: "claude.ai",
      redirectUriHost: "localhost:53123",
      clientProvided: { name: "Claude Code", clientUri: "https://claude.ai" },
      requiresTenant: false,
    })
    expect(view.csrf).toMatch(/^[\w-]{43}$/)
    // Поза сторінкою взаємодії браузер cookie взаємодії не шле
    expect(browser.jar.header(`${ORIGIN}/_serverFn/x`)).not.toContain(
      "_interaction="
    )
    // Навіть з cookie взаємодії, надісланою вручну, інший шлях — відмова
    const elsewhere = await app.api.interactionDetails(
      new Request(`${ORIGIN}/_serverFn/x`, {
        headers: {
          cookie: browser.jar.header(`${ORIGIN}/agent/connect/${flow.uid}`),
        },
      })
    )
    expect(elsewhere.ok).toBe(false)
    // І на сторінці іншої взаємодії: `uid` шляху мусить бути взаємодією cookie
    const other = await startFlow(browser)
    const crossed = await app.api.interactionDetails(
      new Request(`${ORIGIN}/agent/connect/${other.uid}`, {
        headers: {
          cookie: browser.jar.header(`${ORIGIN}/agent/connect/${flow.uid}`),
        },
      })
    )
    expect(crossed.ok).toBe(false)
    expect(
      (
        await app.api.interactionDetails(
          new Request(`${ORIGIN}/agent/connect/${flow.uid}`, {
            headers: {
              cookie: browser.jar.header(`${ORIGIN}/agent/connect/${flow.uid}`),
            },
          })
        )
      ).ok
    ).toBe(true)
  }, 60_000)
})

describe("submitConsent", () => {
  it("an anonymous or missing session gets no grant; the same interaction then works for a signed-in user", async () => {
    const browser = new Browser(app)
    const flow = await startFlow(browser)
    const none = await consent(flow)
    expect(none.status).toBe(401)
    await browser.signInAnonymous()
    const anon = await consent(flow)
    expect(anon.status).toBe(401)
    expect(await liveGrants(browser.userId!)).toEqual([])
    const user = await stand.signUp()
    await browser.signIn(user)
    const code = await resume(flow, await consent(flow))
    const grantId = (await provider.AuthorizationCode.find(code))?.grantId
    expect(await liveGrants(user.userId)).toEqual([grantId])
  }, 60_000)

  it("requiresTenant: without a tenant — no grant; a tenant without requiresTenant — refused", async () => {
    const browser = await stand.browser(tenantApp)
    const flow = await startFlow(browser)
    expect((await interactionView(flow)).requiresTenant).toBe(true)
    const bare = await consent(flow)
    expect(bare.status).toBe(400)
    expect(await bare.json()).toEqual({ error: "tenant_required" })
    expect((await consent(flow, { tenant: "not-a-uuid" })).status).toBe(400)
    expect(await liveGrants(browser.userId!)).toEqual([])
    const tenant = randomUUID()
    await resume(flow, await consent(flow, { tenant }))
    const [grantId] = await liveGrants(browser.userId!)
    expect((await grantRow(stand.pool, grantId!))?.tenant).toBe(tenant)

    const plain = browser.with(app)
    const flow2 = await startFlow(plain)
    const extra = await consent(flow2, { tenant: randomUUID() })
    expect(extra.status).toBe(400)
    expect(await extra.json()).toEqual({ error: "tenant_not_allowed" })
    expect(await liveGrants(browser.userId!)).toEqual([grantId])
    await resume(flow2, await consent(flow2))
    expect(await liveGrants(browser.userId!)).toHaveLength(2)
  }, 60_000)

  it("a cookie of another browser, a missing CSRF token or one of another interaction give no grant", async () => {
    const victim = await stand.browser(app)
    const flow = await startFlow(victim)
    const csrf = (await interactionView(flow)).csrf
    // Інший браузер із власною сесією й правильним токеном CSRF чужої
    // взаємодії: без cookie взаємодії `uid` шляху нічого не дає
    const attacker = await stand.browser(app)
    const foreign = await consent(flow, { csrf }, attacker)
    expect(foreign.status).toBe(404)
    expect(await liveGrants(attacker.userId!)).toEqual([])
    const missing = await postInteraction(flow, { action: "consent" })
    expect(missing.status).toBe(403)
    // Друга взаємодія в тому самому браузері: обидві cookie живуть за своїм шляхом
    const flow2 = await startFlow(victim)
    const crossed = await consent(flow2, { csrf })
    expect(crossed.status).toBe(403)
    expect(await liveGrants(victim.userId!)).toEqual([])
    // Токен CSRF — HMAC ключем cookie від `uid` і `jti` (у бібліотеці це одне
    // значення): без ключа його не підробити, а чужий браузер вище мав правильний
    expect(csrf).toBe(
      createHmac("sha256", stand.keys.cookieKeys[0]!)
        .update(`${flow.uid}.${flow.uid}`)
        .digest("base64url")
    )

    // Контроль: власний токен кожної взаємодії дає грант (другий — повторна
    // авторизація трійки, тож живе лише він)
    const code2 = await resume(flow2, await consent(flow2))
    const first = (await provider.AuthorizationCode.find(code2))?.grantId
    expect(await liveGrants(victim.userId!)).toEqual([first])
    const code = await resume(flow, await consent(flow, { csrf }))
    const second = (await provider.AuthorizationCode.find(code))?.grantId
    expect(await liveGrants(victim.userId!)).toEqual([second])
  }, 60_000)

  it("user A signs out, B signs in in the same browser: the grant of the new consent is B's", async () => {
    const browser = await stand.browser(app)
    const a = browser.userId!
    const first = await connectAgent(browser, client)
    expect((await provider.Grant.find(first.grantId))?.accountId).toBe(a)
    // Сесія OP знищена після `resume`: особа A не переходить у наступний вхід
    const { rows } = await stand.pool.query(
      "SELECT count(*)::int AS n FROM agent_oauth.models WHERE model = 'Session' AND payload->>'accountId' = $1",
      [a]
    )
    expect(rows[0].n).toBe(0)

    // Друга взаємодія: A погоджує, але `resume` не проходить, виходить, B входить
    const flow = await startFlow(browser)
    expect((await consent(flow)).status).toBe(303)
    // Згода A — повторна авторизація трійки: перше підключення A відкликано
    const [pending] = await liveGrants(a)
    expect(pending).not.toBe(first.grantId)
    await browser.signOut()
    const b = await stand.signUp()
    await browser.signIn(b)
    const code = await resume(flow, await consent(flow))
    const grantId = (await provider.AuthorizationCode.find(code))?.grantId
    expect((await provider.Grant.find(grantId!))?.accountId).toBe(b.userId)
    expect((await grantRow(stand.pool, grantId!))?.revoked_at).toBeNull()
    expect(await liveGrants(b.userId)).toEqual([grantId])
    // Неповернута згода A відкликана разом зі своїм `Grant`
    expect(await liveGrants(a)).toEqual([])
    expect(await provider.Grant.find(pending!)).toBeUndefined()

    // І повний цикл B у тому самому браузері
    const again = await connectAgent(browser, client)
    expect((await provider.Grant.find(again.grantId))?.accountId).toBe(b.userId)
  }, 60_000)

  it("signing out of Better Auth does not break the connection: refresh works", async () => {
    const browser = await stand.browser(app)
    const l = await connectAgent(browser, client)
    await browser.signOut()
    const r = await refresh(app, CLIENT, l.tokens.refresh_token as string)
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  }, 60_000)
})

describe("abortInteraction", () => {
  it("needs the CSRF token, returns access_denied to the client and gives no grant", async () => {
    const browser = await stand.browser(app)
    const flow = await startFlow(browser)
    expect((await postInteraction(flow, { action: "abort" })).status).toBe(403)
    const csrf = (await interactionView(flow)).csrf
    const aborted = await postInteraction(flow, { action: "abort", csrf })
    expect(aborted.status).toBe(303)
    const r = await browser.fetch(aborted.headers.get("location")!)
    const callback = new URL(r.headers.get("location")!)
    expect(callback.searchParams.get("error")).toBe("access_denied")
    expect(callback.searchParams.get("code")).toBeNull()
    expect(await liveGrants(browser.userId!)).toEqual([])
  }, 60_000)
})

describe("re-authorisation of the (client, user, tenant) triple", () => {
  it("without a tenant: revokes the previous grant, the old token is dead", async () => {
    const browser = await stand.browser(app)
    const old = await connectAgent(browser, client)
    const fresh = await connectAgent(browser, client)
    await expectRevoked(old)
    await expectAlive(fresh)
  }, 60_000)

  it("with a tenant: revokes the previous grant of that tenant only", async () => {
    const browser = await stand.browser(tenantApp)
    const t1 = randomUUID()
    const old = await connectAgent(browser, { ...client, tenant: t1 })
    const other = await connectAgent(browser, {
      ...client,
      tenant: randomUUID(),
    })
    const fresh = await connectAgent(browser, { ...client, tenant: t1 })
    await expectRevoked(old)
    await expectAlive(other)
    await expectAlive(fresh)
  }, 60_000)
})

describe("listAgentGrants and revokeAgentGrant", () => {
  it("user B neither sees nor revokes a grant of user A", async () => {
    const a = await stand.browser(app)
    const b = await stand.browser(app)
    const la = await connectAgent(a, client)
    const lb = await connectAgent(b, client)
    expect(await listed(a)).toEqual([la.grantId])
    expect(await listed(b)).toEqual([lb.grantId])
    const out = await app.api.revokeAgentGrant(sessionRequest(b), la.grantId)
    expect(out.ok).toBe(false)
    await expectAlive(la)
    expect(await listed(a)).toEqual([la.grantId])
    // Без сесії — ні списку, ні відкликання
    const anon = new Request(`${ORIGIN}/`)
    expect((await app.api.listAgentGrants(anon)).ok).toBe(false)
    expect((await app.api.revokeAgentGrant(anon, la.grantId)).ok).toBe(false)
    await expectAlive(la)
  }, 60_000)

  it("revokes the grant of the pair, the others live; the list shows only grants still in the store", async () => {
    const browser = await stand.browser(tenantApp)
    const [t1, t2, t3] = [randomUUID(), randomUUID(), randomUUID()]
    const l1 = await connectAgent(browser, { ...client, tenant: t1 })
    const l2 = await connectAgent(browser, { ...client, tenant: t2 })
    const l3 = await connectAgent(browser, { ...client, tenant: t3 })
    const list = await tenantApp.api.listAgentGrants(sessionRequest(browser))
    expect(list.ok && list.value.find((g) => g.grantId === l1.grantId)).toEqual(
      expect.objectContaining({
        clientId: CLIENT,
        clientHost: "claude.ai",
        tenant: t1,
        lastUsedAt: expect.any(Date),
        createdAt: expect.any(Date),
        expiresAt: expect.any(Date),
      })
    )
    const out = await tenantApp.api.revokeAgentGrant(
      sessionRequest(browser),
      l1.grantId
    )
    expect(out.ok).toBe(true)
    await expectRevoked(l1)
    await expectAlive(l2)
    expect((await listed(browser)).sort()).toEqual(
      [l2.grantId, l3.grantId].sort()
    )
    // Рядок живий, але `Grant` зник зі сховища — у списку його немає
    await stand.pool.query(
      "DELETE FROM agent_oauth.models WHERE model = 'Grant' AND grant_id = $1",
      [l3.grantId]
    )
    expect(await listed(browser)).toEqual([l2.grantId])
  }, 60_000)
})

describe("a failure inside the bridge", () => {
  // srvx ловить виняток Node-обробника й пише в stderr увесь запит із
  // cookie взаємодії й сесії; міст мусить віддати виняток сам, без журналу
  it("reaches the caller as the original error and never logs the request cookies", async () => {
    const browser = await stand.browser(app)
    const flow = await startFlow(browser)
    const csrf = (await interactionView(flow)).csrf
    const page = `${ORIGIN}/agent/connect/${flow.uid}`
    const cookie = browser.jar.header(page)
    const secrets = cookie.split("; ").map((c) => c.slice(c.indexOf("=") + 1))
    expect(secrets.length).toBeGreaterThan(1)
    const sessionDown = new Error("session store down")
    const broken = stand.app(provider, {
      verifySession: () => Promise.reject(sessionDown),
    })
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
    const storeDown = new Error("client store down")
    const find = vi.spyOn(provider.Client, "find").mockRejectedValue(storeDown)
    try {
      await expect(
        broken.api.submitConsent(new Request(page, { headers: { cookie } }), {
          csrf,
        })
      ).rejects.toBe(sessionDown)
      await expect(
        app.api.interactionDetails(new Request(page, { headers: { cookie } }))
      ).rejects.toBe(storeDown)
      const logged = JSON.stringify(
        errorLog.mock.calls.map((args) =>
          args.map((a) => (a instanceof Error ? a.stack : a))
        ),
        (_k, v: unknown) =>
          v instanceof Request ? [...v.headers].flat().join(" ") : v
      )
      for (const secret of secrets) expect(logged).not.toContain(secret)
      expect(errorLog).not.toHaveBeenCalled()
    } finally {
      find.mockRestore()
      errorLog.mockRestore()
    }
    expect(await liveGrants(browser.userId!)).toEqual([])
  }, 60_000)
})
