import { randomUUID } from "node:crypto"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  createPgAdapter,
  type AdapterHooks,
} from "../src/server/agent-oauth/store"
import {
  connect,
  exchange,
  fixture,
  grantRow,
  refresh,
  RESOURCE,
  startStand,
  type Stand,
} from "./agent-oauth-helpers"

/**
 * Токени сервера авторизації агентів (спека П4-F §5.4): атомарне вживання й
 * ротація токена оновлення, відкликання гранту, строки за керованим годинником,
 * перевірка `resource` до бібліотеки (Р-F4-7), закріплення тенанта.
 * Відмову 401 через порт `VerifyAgentToken` додає задача 6; тут — те, що порт
 * читає: `Grant`, рядок `agent_grants`, записи токенів.
 */
let stand: Stand
let provider: ReturnType<Stand["provider"]>
let app: ReturnType<Stand["app"]>
const hooks: AdapterHooks = {}

const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata"
const LOOPBACK = "http://localhost:53123/callback"
const DAY_MS = 86_400_000

beforeAll(async () => {
  stand = await startStand("aoflow")
  stand.docs.set(
    "/claude.ai/oauth/claude-code-client-metadata",
    JSON.stringify(fixture("claude-code"))
  )
  provider = stand.provider({ adapter: createPgAdapter(stand.pool, hooks) })
  app = stand.app(provider)
}, 180_000)
afterAll(() => stand?.close(), 60_000)
afterEach(() => {
  vi.useRealTimers()
  hooks.beforeConsume = undefined
})

const login = async (
  o: { userId?: string; tenant?: string; scope?: string } = {}
) =>
  connect(app, {
    clientId: CLIENT,
    redirectUri: LOOPBACK,
    userId: o.userId ?? (await stand.user()),
    tenant: o.tenant,
    scope: o.scope,
  })

const rt = (l: { tokens: Record<string, unknown> }) =>
  l.tokens.refresh_token as string

/** Грант живий так, як його бачить порт: `Grant` є і рядок не відкликано. */
async function grantAlive(grantId: string): Promise<boolean> {
  return (
    (await provider.Grant.find(grantId)) !== undefined &&
    (await grantRow(stand.pool, grantId))?.revoked_at === null
  )
}

describe("refresh token", () => {
  it("is issued without offline_access in the request and rotates", async () => {
    const l = await login({ scope: "mcp" })
    expect(rt(l)).toBeTruthy()
    const again = await refresh(app, CLIENT, rt(l))
    expect(again.status, JSON.stringify(again.body)).toBe(200)
    expect(again.body.refresh_token).not.toBe(rt(l))
  }, 60_000)

  it("two parallel refreshes with one token: exactly one 200, only that grant is revoked", async () => {
    const userId = await stand.user()
    const raced = await login({ userId, tenant: randomUUID() })
    // Інший грант того самого клієнта й користувача (інший тенант) живе далі
    const other = await login({ userId, tenant: randomUUID() })
    const arrived: string[] = []
    let release!: () => void
    const open = new Promise<void>((r) => (release = r))
    const timer = setTimeout(release, 5000)
    // Бар'єр: обидва запити пройшли `find` бібліотеки до вживання
    hooks.beforeConsume = async (model) => {
      if (model !== "RefreshToken") return
      arrived.push(model)
      if (arrived.length >= 2) {
        clearTimeout(timer)
        release()
      }
      await open
    }
    const results = await Promise.all([
      refresh(app, CLIENT, rt(raced)),
      refresh(app, CLIENT, rt(raced)),
    ])
    hooks.beforeConsume = undefined
    expect(arrived).toHaveLength(2)
    const ok = results.filter((r) => r.status === 200)
    const bad = results.filter((r) => r.status !== 200)
    expect(ok).toHaveLength(1)
    expect(bad[0]!.body.error).toBe("invalid_grant")
    expect(await provider.Grant.find(raced.grantId)).toBeUndefined()
    expect(
      (await grantRow(stand.pool, raced.grantId))?.revoked_at
    ).not.toBeNull()
    // Токени переможця мертві: оновлення — `invalid_grant`, а сирітський
    // токен доступу (знахідка 1 F0) не має живого гранту
    const winner = ok[0]!.body
    const wr = await refresh(app, CLIENT, winner.refresh_token as string)
    expect(wr.body.error).toBe("invalid_grant")
    const wat = await provider.AccessToken.find(winner.access_token as string)
    expect(
      wat?.grantId === undefined ? false : await grantAlive(wat.grantId)
    ).toBe(false)
    expect(
      await provider.AccessToken.find(raced.tokens.access_token as string)
    ).toBeUndefined()
    // Відкликано лише свій грант
    expect(await grantAlive(other.grantId)).toBe(true)
    expect((await refresh(app, CLIENT, rt(other))).status).toBe(200)
  }, 60_000)

  it("replay of a used token revokes only its own grant", async () => {
    const userId = await stand.user()
    const replayed = await login({ userId, tenant: randomUUID() })
    const other = await login({ userId, tenant: randomUUID() })
    expect((await refresh(app, CLIENT, rt(replayed))).status).toBe(200)
    const replay = await refresh(app, CLIENT, rt(replayed))
    expect(replay.body.error).toBe("invalid_grant")
    expect(await provider.Grant.find(replayed.grantId)).toBeUndefined()
    await vi.waitFor(async () =>
      expect(
        (await grantRow(stand.pool, replayed.grantId))?.revoked_at
      ).not.toBeNull()
    )
    expect(await grantAlive(other.grantId)).toBe(true)
    expect((await refresh(app, CLIENT, rt(other))).status).toBe(200)
  }, 60_000)

  it("after /revoke of the access token: refresh is invalid_grant, the grant and its row are revoked", async () => {
    const l = await login()
    const res = await app(
      new Request("https://app.test/revoke", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: l.tokens.access_token as string,
          client_id: CLIENT,
        }).toString(),
      })
    )
    expect(res.status).toBe(200)
    expect((await refresh(app, CLIENT, rt(l))).body.error).toBe("invalid_grant")
    expect(await provider.Grant.find(l.grantId)).toBeUndefined()
    await vi.waitFor(async () =>
      expect((await grantRow(stand.pool, l.grantId))?.revoked_at).not.toBeNull()
    )
  }, 60_000)

  it("refresh after 29 idle days works, after 31 idle days is invalid_grant (controlled clock)", async () => {
    const l = await login()
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(Date.now() + 29 * DAY_MS)
    const day29 = await refresh(app, CLIENT, rt(l))
    expect(day29.status, JSON.stringify(day29.body)).toBe(200)
    // Ротація дала 30 днів від останнього оновлення
    vi.setSystemTime(Date.now() + 31 * DAY_MS)
    const day60 = await refresh(app, CLIENT, day29.body.refresh_token as string)
    expect(day60.body.error).toBe("invalid_grant")
    const fresh = await login()
    vi.setSystemTime(Date.now() + 31 * DAY_MS)
    expect((await refresh(app, CLIENT, rt(fresh))).body.error).toBe(
      "invalid_grant"
    )
  }, 60_000)

  it("deleted Better Auth user: refresh is invalid_grant, the row goes with the user", async () => {
    const l = await login()
    await stand.pool.query('DELETE FROM better_auth."user" WHERE id = $1', [
      l.userId,
    ])
    expect((await refresh(app, CLIENT, rt(l))).body.error).toBe("invalid_grant")
    expect(await grantRow(stand.pool, l.grantId)).toBeUndefined()
  }, 60_000)
})

describe("/token resource checked before the library (Р-F4-7)", () => {
  const FOREIGN = "https://evil.test/mcp"

  it("a refresh with a foreign or repeated resource does not burn the token; without resource it works", async () => {
    const l = await login()
    for (const resource of [FOREIGN, [RESOURCE, RESOURCE]]) {
      const r = await refresh(app, CLIENT, rt(l), resource)
      expect(r.status).toBe(400)
      expect(r.body.error).toBe("invalid_target")
    }
    const plain = await refresh(app, CLIENT, rt(l), undefined)
    expect(plain.status, JSON.stringify(plain.body)).toBe(200)
    const at = await provider.AccessToken.find(
      plain.body.access_token as string
    )
    expect([at?.aud].flat()).toEqual([RESOURCE])
    expect(await grantAlive(l.grantId)).toBe(true)
  }, 60_000)

  it("a code exchange with a foreign or repeated resource does not consume the code; the grant stays alive", async () => {
    const l = await connect(app, {
      clientId: CLIENT,
      redirectUri: LOOPBACK,
      userId: await stand.user(),
      noExchange: true,
    })
    for (const resource of [FOREIGN, [RESOURCE, RESOURCE]]) {
      const r = await exchange(app, l, resource)
      expect(r.body.error).toBe("invalid_target")
    }
    const ok = await exchange(app, l)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(await grantAlive(l.grantId)).toBe(true)
  }, 60_000)
})

describe("grant tenant pinned into the token", () => {
  it("carries the grant tenant as pin, also after refresh; no tenant — no pin", async () => {
    const tenant = randomUUID()
    const l = await login({ tenant })
    const at = await provider.AccessToken.find(l.tokens.access_token as string)
    expect(at?.extra).toEqual({ pin: tenant })
    const again = await refresh(app, CLIENT, rt(l))
    const at2 = await provider.AccessToken.find(
      again.body.access_token as string
    )
    expect(at2?.extra).toEqual({ pin: tenant })
    const bare = await login()
    const at3 = await provider.AccessToken.find(
      bare.tokens.access_token as string
    )
    expect(at3?.extra ?? {}).not.toHaveProperty("pin")
  }, 60_000)
})
