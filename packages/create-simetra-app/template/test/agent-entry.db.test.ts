import { createHash, randomUUID } from "node:crypto"
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import {
  runtimeCatalogSchema,
  type AgentCallEvent,
  type ReadQuery,
} from "simetra/model"
import { createAgentToolCatalog, type CommandRuntime } from "simetra/server"
import { createMcpEntry } from "simetra/shell/mcp"
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import generatedCatalog from "../generated/runtime-catalog.json"
import { withAgentEntry } from "../src/server/agent-entry"
import { agentInputHashKey } from "../src/server/agent-oauth/keys"
import {
  createPgAdapter,
  sweepExpired,
  type AdapterHooks,
} from "../src/server/agent-oauth/store"
import { createVerifyAgentToken } from "../src/server/agent-oauth/verify-token"
import {
  connectAgent,
  fixture,
  grantRow,
  ORIGIN,
  refresh,
  RESOURCE,
  startStand,
  type App,
  type Browser,
  type Login,
  type Stand,
  tokenPost,
} from "./agent-oauth-helpers"

/**
 * Вхід MCP шаблону над справжнім сервером авторизації (спека П4-F §5.4,
 * Р-F4-11): порт `VerifyAgentToken` читає `AccessToken`, `Grant`, рядок
 * `agent_grants` і користувача Better Auth у Postgres — відмови й `last_used_at`
 * видно лише на базі. Кожна відмова — на обох ерах MCP. Кожен випадок ламає
 * рівно одну умову порту правкою рядка, щоб інші перевірки її не затуляли.
 */
let stand: Stand
let app: App
let tenantApp: App
type Fetch = (request: Request) => Promise<Response>
let mcp: Fetch
// Вхід застосунку з видами скоупу (Р-F4-4): порт вимагає закріплення сам
let pinnedMcp: Fetch
let port: ReturnType<typeof createVerifyAgentToken>
const events: AgentCallEvent[] = []
const reads: ReadQuery[] = []
const hooks: AdapterHooks = {}

const CLIENT = "https://claude.ai/oauth/claude-code-client-metadata"
const LOOPBACK = "http://localhost:53123/callback"
const OTHER_RESOURCE = "https://other.test/mcp"
// Значення даних і тексту входу: жодне не має потрапити в подію
const DATA_SENTINEL = "data-sentinel-51c2"
const INPUT_SENTINEL = "input-sentinel-9e07"

type Era = "legacy" | "modern"
const ERAS: Era[] = ["legacy", "modern"]

const runtimeCatalog = runtimeCatalogSchema.parse(generatedCatalog)

beforeAll(async () => {
  stand = await startStand("aoentry")
  stand.docs.set(
    "/claude.ai/oauth/claude-code-client-metadata",
    JSON.stringify(fixture("claude-code"))
  )
  const provider = stand.provider({
    adapter: createPgAdapter(stand.pool, hooks),
  })
  app = stand.app(provider)
  tenantApp = stand.app(provider, { requiresTenant: true })
  port = createVerifyAgentToken({
    provider,
    pool: stand.pool,
    requiresTenant: false,
  })
  // Рантайм без застосованої схеми застосунку: `describe` і подія не
  // торкаються бази даних застосунку, а `read` віддає рядок зі значенням-
  // сторожем, щоб довести, що його немає в події
  const runtime = {
    catalog: runtimeCatalog,
    read: async (_session: unknown, query: ReadQuery) => {
      reads.push(query)
      return { rows: [{ code: DATA_SENTINEL }] }
    },
    run: async () => ({ rows: [], changes: [], epoch: "e" }),
  } as unknown as CommandRuntime
  const over = (verifyAgentToken: typeof port): Fetch => {
    const entry = createMcpEntry({
      catalog: createAgentToolCatalog({ runtime }),
      runtimeCatalog,
      resource: RESOURCE,
      authorizationServer: ORIGIN,
      verifyAgentToken,
      onAgentCall: (event) => {
        events.push(event)
      },
      appOrigin: ORIGIN,
      inputHashKey: agentInputHashKey(stand.keys),
    })
    // Вхід MCP поверх застосунку стенду — так, як `src/server.ts` монтує його
    // над сервером авторизації
    return withAgentEntry(app, async () => (request) => entry.fetch(request))
  }
  mcp = over(port)
  // Каталог шаблону без видів скоупу, тож адаптер закріплення не вимагає:
  // відмову дає лише порт
  pinnedMcp = over(
    createVerifyAgentToken({ provider, pool: stand.pool, requiresTenant: true })
  )
}, 180_000)
afterAll(() => stand?.close(), 60_000)
afterEach(() => {
  vi.useRealTimers()
  hooks.beforeConsume = undefined
  events.length = 0
  reads.length = 0
})

const login = async (o: { tenant?: string; browser?: Browser } = {}) => {
  const target = o.tenant === undefined ? app : tenantApp
  const browser = (o.browser ?? (await stand.browser(target))).with(target)
  return connectAgent(browser, {
    clientId: CLIENT,
    redirectUri: LOOPBACK,
    ...(o.tenant === undefined ? {} : { tenant: o.tenant }),
  })
}

const at = (l: Pick<Login, "tokens">) => l.tokens.access_token as string
const rt = (l: Pick<Login, "tokens">) => l.tokens.refresh_token as string
const sha256 = (v: string) => createHash("sha256").update(v).digest("hex")

// Сирий JSON-RPC запит кожної ери: модерна несе конверт `_meta` і заголовки
// методу, легасі — ні (як у тестах адаптера `simetra/shell/mcp`)
function rpc(
  era: Era,
  token: string,
  method: string,
  params: Record<string, unknown> = {}
): Request {
  const modern = era === "modern"
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      ...(modern
        ? {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": method,
            ...(typeof params.name === "string"
              ? { "mcp-name": params.name }
              : {}),
          }
        : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: modern
        ? {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientInfo": {
                name: "test",
                version: "1",
              },
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          }
        : params,
    }),
  })
}

const describeCall = (era: Era, token: string) =>
  rpc(era, token, "tools/call", { name: "describe", arguments: {} })

/** Токен проходить на обох ерах: контроль до правки, що має його зламати. */
async function expectAccepted(token: string): Promise<void> {
  for (const era of ERAS) {
    const response = await mcp(describeCall(era, token))
    expect(response.status, era).toBe(200)
    await response.body?.cancel()
  }
}

/** Відмова 401 на обох ерах і жодної події виклику. */
async function expectRefused(token: string, entry: Fetch = mcp): Promise<void> {
  for (const era of ERAS) {
    const response = await entry(describeCall(era, token))
    expect(response.status, era).toBe(401)
    expect(response.headers.get("www-authenticate"), era).toContain(
      "resource_metadata="
    )
  }
  expect(events).toEqual([])
}

const patchAccessToken = (token: string, patch: Record<string, unknown>) =>
  stand.pool.query(
    "UPDATE agent_oauth.models SET payload = payload || $2::jsonb WHERE model = 'AccessToken' AND id_hash = $1",
    [sha256(token), JSON.stringify(patch)]
  )

const patchGrant = (grantId: string, patch: Record<string, unknown>) =>
  stand.pool.query(
    "UPDATE agent_oauth.models SET payload = payload || $2::jsonb WHERE model = 'Grant' AND grant_id = $1",
    [grantId, JSON.stringify(patch)]
  )

const nowSec = () => Math.floor(Date.now() / 1000)

const OLD_USE = new Date("2001-01-01T00:00:00Z")
const setLastUsed = (grantId: string, at: Date) =>
  stand.pool.query(
    "UPDATE agent_oauth.agent_grants SET last_used_at = $2 WHERE grant_id = $1",
    [grantId, at]
  )
async function lastUsed(grantId: string): Promise<Date> {
  const { rows } = await stand.pool.query(
    "SELECT last_used_at FROM agent_oauth.agent_grants WHERE grant_id = $1",
    [grantId]
  )
  return rows[0].last_used_at as Date
}

describe("a granted agent calls the MCP entry", () => {
  it.each([
    ["legacy", "legacy" as const],
    ["modern", { pin: "2026-07-28" }],
  ])(
    "the MCP SDK client calls describe with the token of connectAgent (%s era)",
    async (_era, mode) => {
      const l = await login()
      const client = new Client(
        { name: "test", version: "0.0.0" },
        { versionNegotiation: { mode } }
      )
      const transport = new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch: (url, init) => mcp(new Request(url, init)),
        authProvider: { token: async () => at(l) },
      })
      await client.connect(transport)
      try {
        const result = await client.callTool({
          name: "describe",
          arguments: {},
        })
        expect(result.isError).not.toBe(true)
        const text = (result.content as { type: string; text: string }[])[0]!
          .text
        const names = (
          JSON.parse(text) as {
            data: { objects: { object: { name: string } }[] }
          }
        ).data.objects.map((o) => o.object.name)
        expect(names).toContain("Country")
      } finally {
        await client.close()
      }
      // Службові методи (`initialize`, `server/discover`, `tools/list`)
      // події не дають: одна подія — один `tools/call`
      expect(events).toMatchObject([
        { tool: "describe", status: "ok", sub: l.userId, actor: CLIENT },
      ])
      expect(events[0]!.pin).toBeUndefined()
    },
    60_000
  )

  it.each(ERAS)(
    "one call gives one event without data values or input text (%s era)",
    async (era) => {
      const l = await login()
      const response = await mcp(
        rpc(era, at(l), "tools/call", {
          name: "read",
          arguments: {
            query: {
              object: { kind: "Catalog", name: "Country" },
              limit: 2,
              where: { attribute: "code", op: "eq", value: INPUT_SENTINEL },
            },
          },
        })
      )
      expect(response.status).toBe(200)
      expect(await response.text()).toContain(DATA_SENTINEL)
      // Вхід дійшов до рантайму — подія про справжній виклик
      expect(JSON.stringify(reads)).toContain(INPUT_SENTINEL)
      await vi.waitFor(() => expect(events).toHaveLength(1))
      const [event] = events
      expect(event).toMatchObject({
        tool: "read",
        status: "ok",
        rows: 1,
        sub: l.userId,
        actor: CLIENT,
      })
      expect(event!.inputHash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(event)).not.toContain(DATA_SENTINEL)
      expect(JSON.stringify(event)).not.toContain(INPUT_SENTINEL)
      expect(JSON.stringify(event)).not.toContain(at(l))
    },
    60_000
  )

  it("a call updates last_used_at of the grant", async () => {
    const l = await login()
    const old = new Date("2001-01-01T00:00:00Z")
    await stand.pool.query(
      "UPDATE agent_oauth.agent_grants SET last_used_at = $2 WHERE grant_id = $1",
      [l.grantId, old]
    )
    const before = Date.now()
    const response = await mcp(describeCall("modern", at(l)))
    expect(response.status).toBe(200)
    const { rows } = await stand.pool.query(
      "SELECT last_used_at FROM agent_oauth.agent_grants WHERE grant_id = $1",
      [l.grantId]
    )
    expect((rows[0].last_used_at as Date).getTime()).toBeGreaterThanOrEqual(
      before - 1000
    )
  }, 60_000)

  it("a tenant grant passes its pin to the call", async () => {
    const tenant = randomUUID()
    const l = await login({ tenant })
    const response = await mcp(describeCall("modern", at(l)))
    expect(response.status).toBe(200)
    expect(events).toMatchObject([{ pin: tenant }])
  }, 60_000)
})

describe("401 on both eras (invariants 17, 18)", () => {
  it("a refresh token as bearer", async () => {
    const l = await login()
    await expectRefused(rt(l))
  }, 60_000)

  it("a token of another resource", async () => {
    const l = await login()
    // Порт сам звіряє ресурс, а не лише адаптер
    expect(await port(at(l), OTHER_RESOURCE)).toBeNull()
    await expectAccepted(at(l))
    events.length = 0
    await patchAccessToken(at(l), { aud: OTHER_RESOURCE })
    await expectRefused(at(l))
  }, 60_000)

  it.each([
    ["jkt", { jkt: "dpop-thumbprint" }],
    ["cnf (x5t#S256)", { "x5t#S256": "certificate-thumbprint" }],
  ])(
    "a sender-constrained token (%s) as bearer",
    async (_name, patch) => {
      const l = await login()
      await expectAccepted(at(l))
      events.length = 0
      await patchAccessToken(at(l), patch)
      await expectRefused(at(l))
    },
    60_000
  )

  it("an expired access token, inside the clock tolerance of the library", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    // `exp` + 5 с: бібліотека (допуск 15 с) і сховище запис ще віддають
    vi.useFakeTimers({
      toFake: ["Date"],
      now: Date.now() + (3600 + 5) * 1000,
    })
    await expectRefused(at(l))
  }, 60_000)

  it("after /revoke: the next call is 401, the Grant is gone, the row is revoked and not listed", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    const revoked = await app(
      new Request(`${ORIGIN}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: at(l),
          client_id: CLIENT,
        }).toString(),
      })
    )
    expect(revoked.status).toBe(200)
    await expectRefused(at(l))
    expect(await app.provider.Grant.find(l.grantId)).toBeUndefined()
    await vi.waitFor(async () =>
      expect((await grantRow(stand.pool, l.grantId))?.revoked_at).not.toBe(null)
    )
    const list = await app.api.listAgentGrants(
      new Request(`${ORIGIN}/`, {
        headers: { cookie: l.flow.browser.jar.header(`${ORIGIN}/`) },
      })
    )
    if (!list.ok) throw new Error(`list: ${list.response.status}`)
    expect(list.value.map((g) => g.grantId)).not.toContain(l.grantId)
  }, 60_000)

  it("the Grant record is gone while its token and row remain", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    await stand.pool.query(
      "DELETE FROM agent_oauth.models WHERE model = 'Grant' AND grant_id = $1",
      [l.grantId]
    )
    await expectRefused(at(l))
  }, 60_000)

  it.each([
    ["clientId", () => ({ clientId: "https://other.test/cimd.json" })],
    ["accountId", () => ({ accountId: randomUUID() })],
    // Прострочений на 1 с: допуск бібліотеки (15 с) запис ще віддає
    ["exp", () => ({ exp: nowSec() - 1 })],
  ])(
    "the Grant with another %s",
    async (_field, patch) => {
      const l = await login()
      await expectAccepted(at(l))
      events.length = 0
      await patchGrant(l.grantId, patch())
      await expectRefused(at(l))
    },
    60_000
  )

  it.each([
    ["revoked", "revoked_at = now()"],
    ["expired", "expires_at = now() - interval '1 second'"],
  ])(
    "the agent_grants row is %s while the Grant lives",
    async (_name, set) => {
      const l = await login()
      await expectAccepted(at(l))
      events.length = 0
      await stand.pool.query(
        `UPDATE agent_oauth.agent_grants SET ${set} WHERE grant_id = $1`,
        [l.grantId]
      )
      await expectRefused(at(l))
    },
    60_000
  )

  it("the tenant of the row differs from the pin of the token", async () => {
    const l = await login({ tenant: randomUUID() })
    await expectAccepted(at(l))
    events.length = 0
    await stand.pool.query(
      "UPDATE agent_oauth.agent_grants SET tenant = $2 WHERE grant_id = $1",
      [l.grantId, randomUUID()]
    )
    await expectRefused(at(l))
  }, 60_000)

  it("the Better Auth user is deleted", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    await stand.pool.query('DELETE FROM better_auth."user" WHERE id = $1', [
      l.userId,
    ])
    await expectRefused(at(l))
  }, 60_000)

  it("the user is marked anonymous after the grant", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    await stand.pool.query(
      'UPDATE better_auth."user" SET "isAnonymous" = true WHERE id = $1',
      [l.userId]
    )
    // Відмова не рахується як використання гранту
    await setLastUsed(l.grantId, OLD_USE)
    await expectRefused(at(l))
    expect(await lastUsed(l.grantId)).toEqual(OLD_USE)
  }, 60_000)

  it("a token without a pin in an application with scope kinds; last_used_at stays", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    await setLastUsed(l.grantId, OLD_USE)
    await expectRefused(at(l), pinnedMcp)
    expect(await lastUsed(l.grantId)).toEqual(OLD_USE)
  }, 60_000)

  it("an access token of a refresh with scope=offline_access carries no mcp; last_used_at stays", async () => {
    const narrow = (l: Login) =>
      tokenPost(app, {
        grant_type: "refresh_token",
        refresh_token: rt(l),
        client_id: CLIENT,
        resource: RESOURCE,
        scope: "offline_access",
      })
    // Без `prompt=consent` бібліотека прибирає `offline_access` зі scope
    // запиту, тож вужчого оновлення токен оновлення не дозволяє
    expect((await narrow(await login())).body.error).toBe("invalid_scope")
    // З `prompt=consent` дозволяє: токен видано, але без `mcp`
    const l = await connectAgent(await stand.browser(app), {
      clientId: CLIENT,
      redirectUri: LOOPBACK,
      prompt: "consent",
    })
    await expectAccepted(at(l))
    events.length = 0
    const narrowed = await narrow(l)
    expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200)
    const token = narrowed.body.access_token as string
    expect(
      (await app.provider.AccessToken.find(token))?.scope?.split(" ")
    ).not.toContain("mcp")
    await setLastUsed(l.grantId, OLD_USE)
    await expectRefused(token)
    expect(await lastUsed(l.grantId)).toEqual(OLD_USE)
  }, 60_000)

  it("the agent_grants row belongs to another user", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    const other = await stand.signUp()
    await stand.pool.query(
      "UPDATE agent_oauth.agent_grants SET user_id = $2 WHERE grant_id = $1",
      [l.grantId, other.userId]
    )
    await expectRefused(at(l))
  }, 60_000)

  it("a replayed refresh token revokes the grant: the rotated and the original access token", async () => {
    const l = await login()
    const rotated = await refresh(app, CLIENT, rt(l))
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200)
    await expectAccepted(rotated.body.access_token as string)
    events.length = 0
    const replay = await refresh(app, CLIENT, rt(l))
    expect(replay.status).toBe(400)
    // Позначку рядка ставить слухач `grant.revoked` після відповіді
    await vi.waitFor(async () =>
      expect((await grantRow(stand.pool, l.grantId))?.revoked_at).not.toBe(null)
    )
    await expectRefused(rotated.body.access_token as string)
    await expectRefused(at(l))
  }, 60_000)

  it("a lost refresh race revokes the grant: every access token of it, the winner's too", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    const arrived: string[] = []
    let release!: () => void
    const open = new Promise<void>((r) => (release = r))
    const timer = setTimeout(release, 5000)
    // Бар'єр: обидва оновлення пройшли `find` бібліотеки до вживання
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
      refresh(app, CLIENT, rt(l)),
      refresh(app, CLIENT, rt(l)),
    ])
    expect(arrived).toHaveLength(2)
    const winners = results.filter((r) => r.status === 200)
    expect(winners).toHaveLength(1)
    await vi.waitFor(async () =>
      expect((await grantRow(stand.pool, l.grantId))?.revoked_at).not.toBe(null)
    )
    const winner = winners[0]!.body.access_token as string
    // Сирота: токен переможця пережив видалення записів гранту програвшим
    // запитом, тож відмову дає саме порт, а не відсутність токена
    expect(await app.provider.AccessToken.find(winner)).toBeDefined()
    await expectRefused(winner)
    await expectRefused(at(l))
  }, 60_000)
})

describe("after the expiry sweep (P4-F §5.4)", () => {
  it("a grant past its row expiry is swept with its records; the next call is 401", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    // Рядок закінчився давніше за запас прибирання; записи бібліотеки ще живі
    await stand.pool.query(
      "UPDATE agent_oauth.agent_grants SET expires_at = $2 WHERE grant_id = $1",
      [l.grantId, new Date(Date.now() - 10 * 60_000)]
    )
    await sweepExpired(stand.pool)
    expect(await grantRow(stand.pool, l.grantId)).toBeUndefined()
    expect(await app.provider.Grant.find(l.grantId)).toBeUndefined()
    await expectRefused(at(l))
  }, 60_000)

  it("a deleted agent_grants row is a refusal while the token and the Grant live", async () => {
    const l = await login()
    await expectAccepted(at(l))
    events.length = 0
    await stand.pool.query(
      "DELETE FROM agent_oauth.agent_grants WHERE grant_id = $1",
      [l.grantId]
    )
    expect(await app.provider.AccessToken.find(at(l))).toBeDefined()
    expect(await app.provider.Grant.find(l.grantId)).toBeDefined()
    await expectRefused(at(l))
  }, 60_000)
})

describe("the human session verifier", () => {
  it("refuses an agent access token on the signals token route", async () => {
    const l = await login()
    // Маршрут токенів сигналів пускає лише сесію людини (`guardRequest` →
    // `verifySession`); токен агента — не сесія Better Auth
    expect(
      await stand.verifySession(
        new Headers({ authorization: `Bearer ${at(l)}` })
      )
    ).toBeNull()
    // Контроль: справжня сесія Better Auth того самого стенду проходить
    const session = await stand.verifySession(
      new Headers({ cookie: l.flow.browser.jar.header(`${ORIGIN}/`) })
    )
    expect(session?.sub).toBe(l.userId)
  }, 60_000)
})
