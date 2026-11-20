// Авторизація маршрутів сигналів (D5, інваріанти І1–І3, І5, І10, І11 плану) на
// production-збірці з увімкненими сигналами: фікстура дає власний Centrifugo і
// ключ підпису, згенерований на прогін. Кожен кейс відмови несе дійсний cookie
// (або доводить саме відсутність сесії), тож відмова — правило маршруту, а не
// побічний ефект; позитивний контроль — той самий запит, що проходить.
// Відмова старту «URL без ключів» уже в `security.spec.ts`; тут — лише дзеркало.
import { randomUUID } from "node:crypto"
import { ZERO_UUID } from "simetra/model"
import runtimeCatalog from "../template/generated/runtime-catalog.json" with { type: "json" }
import { refusesToStart } from "./refuse-start"
import { send, type Reply } from "./http"
import { anonymousSession, expect, test, type App } from "./fixtures"

const CONNECTION = "/simetra/signals/connection-token"
const CHANNELS = "/simetra/signals/channel-tokens"
const JWKS = "/simetra/signals/jwks"
const EVIL = "https://evil.test"

interface Json {
  [key: string]: unknown
}

const same = (app: App, cookie?: string): Record<string, string> => ({
  origin: app.origin,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
  ...(cookie === undefined ? {} : { cookie }),
})

const post = (
  app: App,
  path: string,
  headers: Record<string, string>,
  body: unknown
): Promise<Reply> =>
  send(app, { method: "POST", path, headers, body: JSON.stringify(body) })

const json = (reply: Reply): Json => JSON.parse(reply.text) as Json

const objectId = (name: string): string =>
  runtimeCatalog.objects.find((o) => o.name === name)!.id

/** Канал змін нескоупленого об'єкта: `simetra:<вид скоупу>:<скоуп>:<об'єкт>`. */
const changesChannel = (name: string, scope = ZERO_UUID): string =>
  `simetra:${ZERO_UUID}:${scope}:${objectId(name)}`

/** Підпис JWT перевіряється відкритим ключем з JWKS host-а, як це робить Centrifugo. */
async function expectSignedByJwks(app: App, token: string): Promise<void> {
  const keys = json(await send(app, { path: JWKS })).keys as (Json & {
    kid: string
  })[]
  const [head, payload, signature] = token.split(".")
  const { kid } = decodeJwt(token).header
  const jwk = keys.find((k) => k.kid === kid)
  expect(jwk).toBeDefined()
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "Ed25519" },
    false,
    ["verify"]
  )
  const ok = await crypto.subtle.verify(
    { name: "Ed25519" },
    key,
    Buffer.from(signature ?? "", "base64url"),
    Buffer.from(`${head}.${payload}`)
  )
  expect(ok).toBe(true)
}

/** Заголовок і корисне навантаження JWT без перевірки підпису: перевіряє Centrifugo. */
function decodeJwt(token: string): { header: Json; payload: Json } {
  const [header, payload] = token.split(".")
  const part = (value: string | undefined): Json =>
    JSON.parse(Buffer.from(value ?? "", "base64url").toString("utf8")) as Json
  return { header: part(header), payload: part(payload) }
}

test.describe("signal token routes", () => {
  test("positive control: own session gets a connection token and a token of its own channel", async ({
    app,
  }) => {
    const { a } = app.users
    const connection = await post(app, CONNECTION, same(app, a.cookie), {
      subject: a.id,
    })
    expect(connection.status).toBe(200)
    expect(connection.headers["cache-control"]).toBe("no-store")
    const body = json(connection)
    expect(typeof body.expiresAt).toBe("string")
    const { header } = decodeJwt(String(body.token))
    // Токен підписано ключем цього прогону: `kid` ключа, згенерованого фікстурою
    expect(header).toMatchObject({ alg: "EdDSA", kid: app.signals.kid })
    await expectSignedByJwks(app, String(body.token))

    // Канал змін `Client`: ClientOwner має на нього право `own` (рядкове право
    // канал відкриває; `simetra-user:` оракул до B6 не пропускає нікому)
    const channel = changesChannel("Client")
    const channels = await post(app, CHANNELS, same(app, a.cookie), {
      subject: a.id,
      channels: [channel],
    })
    expect(channels.status).toBe(200)
    const tokens = json(channels).tokens as Json[]
    expect(tokens.map((t) => t.channel)).toEqual([channel])
    expect(decodeJwt(String(tokens[0]!.token)).payload.channel).toBe(channel)
    await expectSignedByJwks(app, String(tokens[0]!.token))
  })

  // І1
  for (const [name, headers] of [
    ["a foreign Origin", { origin: EVIL, "sec-fetch-site": "same-origin" }],
    ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
  ] as const)
    for (const path of [CONNECTION, CHANNELS])
      test(`${name} with a valid cookie is refused 403 on ${path} without Set-Cookie`, async ({
        app,
      }) => {
        const { a } = app.users
        const reply = await post(
          app,
          path,
          { ...same(app, a.cookie), ...headers },
          { subject: a.id, channels: [] }
        )
        expect(reply.status).toBe(403)
        expect(reply.setCookie).toEqual([])
        expect(reply.text).not.toContain("token")
      })

  // І2
  test("no session and an anonymous session get no tokens", async ({ app }) => {
    const anonymous = await anonymousSession(app)
    for (const path of [CONNECTION, CHANNELS]) {
      // Анонім шле власний id: відмова має бути саме «немає сесії», а не
      // `session-changed` через чужий `subject`
      for (const [cookie, subject] of [
        [undefined, app.users.a.id],
        [anonymous.cookie, anonymous.id],
      ] as const) {
        const reply = await post(app, path, same(app, cookie), {
          subject,
          channels: [],
        })
        expect(reply.status).toBe(401)
        expect(json(reply)).toEqual({ reason: "unauthenticated" })
      }
    }
  })

  // І3
  test("channel tokens cover only the channels of the grant", async ({
    app,
  }) => {
    const { b } = app.users
    const own = changesChannel("Client")
    // Обидва канали правильної форми, оракул відмовляє: `Client` не скоуплений
    // (дозволено лише нульовий скоуп), а `GlobalRoles` ClientOwner не читає
    const wrongScope = changesChannel("Client", randomUUID())
    const noRight = changesChannel("GlobalRoles")
    const reply = await post(app, CHANNELS, same(app, b.cookie), {
      subject: b.id,
      channels: [wrongScope, noRight, own],
    })
    expect(reply.status).toBe(200)
    const tokens = json(reply).tokens as Json[]
    expect(tokens.map((t) => t.channel)).toEqual([own])
    expect(reply.text).not.toContain(wrongScope)
    expect(reply.text).not.toContain(noRight)
  })

  // І5
  test("the JWKS is public and carries no private members", async ({ app }) => {
    const reply = await send(app, { path: JWKS })
    expect(reply.status).toBe(200)
    const keys = json(reply).keys as Json[]
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys)
      expect(Object.keys(key).sort()).toEqual([
        "alg",
        "crv",
        "kid",
        "kty",
        "use",
        "x",
      ])
    expect(keys.map((k) => k.kid)).toContain(app.signals.kid)
  })

  // І11 (серверна половина: заміну тримача в клієнті перевіряє частина 2)
  test("a token for another subject than the session is refused before the grant", async ({
    app,
  }) => {
    const { a, b } = app.users
    for (const path of [CONNECTION, CHANNELS]) {
      // Cookie Bob, `subject` Alice: сторінка тримала Alice, сесію підмінено
      const reply = await post(app, path, same(app, b.cookie), {
        subject: a.id,
        channels: [],
      })
      expect(reply.status).toBe(401)
      expect(json(reply)).toEqual({ reason: "session-changed" })
      expect(reply.text).not.toContain("token")
    }
  })
})

// І10
test.describe("server start: signals are all or nothing", () => {
  test("signing keys without a signals url stop the server", async ({
    app,
  }) => {
    await refusesToStart(
      app,
      {
        NODE_ENV: "production",
        SIMETRA_APP_ORIGIN: app.origin,
        BETTER_AUTH_SECRET: app.secret,
        SIMETRA_SIGNALS_KEYS: app.serverEnv.SIMETRA_SIGNALS_KEYS!,
      },
      "SIMETRA_SIGNALS"
    )
  })
})
