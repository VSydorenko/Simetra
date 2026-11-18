// Безпекові кейси D2 спеки П4-D §8.3 на production-збірці шаблону без аліасу
// `#instrument`: саме її отримує споживач. Кожен кейс про походження несе дійсний
// cookie сесії, тож відмова доводить правило походження, а не відсутність
// сесії; позитивний контроль — той самий запит з тим самим походженням `ok`.
//
// Два шари. Start ставить на кожну Server Function власний CSRF-фільтр
// (`defaultCsrfMiddleware`): запит без `Sec-Fetch-Site: same-origin` він
// відхиляє текстом `403 Forbidden` ще до коду шаблону. Правило шаблону
// (`checkRequestOrigin`, `command.forbidden` `origin`) тому видно лише на запиті,
// який Start пропускає, — `Sec-Fetch-Site: same-origin` з чужим `Origin`.
import { PAYLOAD_MAX_BYTES } from "simetra/model"
import {
  test,
  expect,
  B_ROWS,
  SEED_COUNT,
  type App,
  type TestUser,
} from "./fixtures"
import { send, type RawRequest, type Reply } from "./http"
import { decodeResponse, encodePayload } from "./serialization"

const CLIENT = "08f4943e-0296-4fbd-8d89-61b6f11355ee"
// Контракт ядра `Client` з клієнтського каталогу: `run` без нього — `stale-client`
const KERNEL =
  "0f83f2243ed39161f34412c27b93f22b1991f009df3f6ad9fd6afd79a333c6f4"

const EVIL = "https://evil.test"
const JSON_HEADERS = { "content-type": "application/json" }
const SERVER_FN = { ...JSON_HEADERS, "x-tsr-serverfn": "true" }

interface Json {
  [key: string]: unknown
}

const dataPath = (app: App) => `/_serverFn/${app.functionId("dataFn")}`

/** Адреса сокета клієнта, окрема на кейс: межа частоти рахує саме її. */
const address = (n: number) => `127.0.2.${n}`

const same = (app: App, user?: TestUser): Record<string, string> => ({
  origin: app.origin,
  "sec-fetch-site": "same-origin",
  ...(user === undefined ? {} : { cookie: user.cookie }),
})

/** Конверт даних: `subject` сесії й один запит. */
const envelope = (user: TestUser, request: Json) => ({
  subject: user.id,
  request,
})

const READ_VERSION = { type: "read", items: [{ type: "version" }] }

function callData(
  app: App,
  headers: Record<string, string>,
  body: unknown,
  extra: Partial<RawRequest> = {}
): Promise<Reply> {
  return send(app, {
    method: "POST",
    path: dataPath(app),
    headers: { ...SERVER_FN, ...headers },
    body: encodePayload(body),
    ...extra,
  })
}

/** Значення, яке Server Function віддала клієнту. */
function valueOf(reply: Reply): Json {
  expect(reply.status).toBe(200)
  // Відповідь Server Function несе значення сесії: його не кешують ні клієнт, ні проксі
  expect(reply.headers["cache-control"]).toBe("no-store")
  return (decodeResponse(reply.text) as { result: Json }).result
}

/** Відмова саме правила походження шаблону: точний код і причина. */
function expectOriginRefusal(reply: Reply): void {
  const result = valueOf(reply)
  expect(result.ok).toBe(false)
  expect(result.error).toEqual({ code: "command.forbidden", reason: "origin" })
}

/** Відмова будь-якого шару: Start (`403`) чи правило походження шаблону. */
function expectRefusedBeforeData(reply: Reply): void {
  if (reply.status === 403) {
    expect(reply.text).toBe("Forbidden")
    return
  }
  expectOriginRefusal(reply)
}

const refusal = (reply: Reply) => {
  expect(reply.status).toBe(413)
  const body = JSON.parse(reply.text) as Json
  expect(body.ok).toBe(false)
  expect(body.error).toEqual({
    code: "command.invalid",
    reason: "payload-too-large",
  })
}

const signIn = (
  app: App,
  from: string,
  headers: Record<string, string> = {},
  password = "wrong-password"
) =>
  send(app, {
    method: "POST",
    path: "/api/auth/sign-in/email",
    localAddress: from,
    headers: { ...JSON_HEADERS, origin: app.origin, ...headers },
    body: JSON.stringify({ email: "nobody@e2e.test", password }),
  })

test.describe("data function (dataFn)", () => {
  test("a same-origin run with a session is ok (positive control)", async ({
    app,
  }) => {
    // Свій рядок користувача: `own` дозволяє його читати й змінювати
    const read = valueOf(
      await callData(
        app,
        same(app, app.users.a),
        envelope(app.users.a, {
          type: "read",
          items: [{ type: "query", query: { object: CLIENT, limit: 1 } }],
        })
      )
    ) as {
      value: {
        items: Array<{
          value: { rows: Array<{ id: string; version: string }> }
        }>
      }
    }
    const row = read.value.items[0]!.value.rows[0]!
    const description = `updated by e2e ${Date.now()}`
    const result = valueOf(
      await callData(
        app,
        same(app, app.users.a),
        envelope(app.users.a, {
          type: "run",
          operation: {
            action: "update",
            object: CLIENT,
            id: row.id,
            expectedVersion: Number(row.version),
            values: { description },
          },
          kernels: { [CLIENT]: KERNEL },
        })
      )
    )
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)
    const [stored] = await app.query<{ description: string }>(
      "SELECT description FROM app.client WHERE id = $1",
      [row.id]
    )
    expect(stored?.description).toBe(description)
  })

  test("a cross-site request with a valid cookie is refused", async ({
    app,
  }) => {
    const reply = await callData(
      app,
      { ...same(app, app.users.a), "sec-fetch-site": "cross-site" },
      envelope(app.users.a, READ_VERSION)
    )
    expectRefusedBeforeData(reply)
  })

  test("a foreign Origin without Sec-Fetch-Site is refused", async ({
    app,
  }) => {
    const reply = await callData(
      app,
      { origin: EVIL, cookie: app.users.a.cookie },
      envelope(app.users.a, READ_VERSION)
    )
    expectRefusedBeforeData(reply)
  })

  test("a request with neither Origin nor Sec-Fetch-Site is refused", async ({
    app,
  }) => {
    const reply = await callData(
      app,
      { cookie: app.users.a.cookie },
      envelope(app.users.a, READ_VERSION)
    )
    expectRefusedBeforeData(reply)
  })

  test("Host, X-Forwarded-Host, X-Forwarded-Proto and Origin of the attacker are refused", async ({
    app,
  }) => {
    const body = envelope(app.users.a, READ_VERSION)
    // Без `Sec-Fetch-Site`: фільтр Start відхиляє раніше за шаблон
    expectRefusedBeforeData(
      await callData(
        app,
        {
          origin: EVIL,
          host: "evil.test",
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "https",
          cookie: app.users.a.cookie,
        },
        body
      )
    )
    // З `Sec-Fetch-Site: same-origin` запит доходить до правила шаблону, і
    // походження застосунку береться лише з `SIMETRA_APP_ORIGIN`: ні `Host`,
    // ні `X-Forwarded-*` атакувальника його не підміняють. Два запити, щоб
    // кожне з джерел відсікалося окремо
    expectOriginRefusal(
      await callData(
        app,
        {
          "sec-fetch-site": "same-origin",
          origin: "http://evil.test",
          host: "evil.test",
          cookie: app.users.a.cookie,
        },
        body
      )
    )
    expectOriginRefusal(
      await callData(
        app,
        {
          "sec-fetch-site": "same-origin",
          origin: EVIL,
          "x-forwarded-host": "evil.test",
          "x-forwarded-proto": "https",
          cookie: app.users.a.cookie,
        },
        body
      )
    )
  })

  test("a same-origin Sec-Fetch-Site with a foreign Origin gets command.forbidden origin", async ({
    app,
  }) => {
    expectOriginRefusal(
      await callData(
        app,
        {
          "sec-fetch-site": "same-origin",
          origin: EVIL,
          cookie: app.users.a.cookie,
        },
        envelope(app.users.a, READ_VERSION)
      )
    )
  })

  test("the same origin without a session is unauthenticated", async ({
    app,
  }) => {
    const result = valueOf(
      await callData(app, same(app), envelope(app.users.a, READ_VERSION))
    )
    expect(result.ok).toBe(false)
    expect(result.error).toEqual({ code: "command.unauthenticated" })
  })

  test("an envelope with the subject of another user is a session change", async ({
    app,
  }) => {
    const result = valueOf(
      await callData(
        app,
        same(app, app.users.a),
        envelope(app.users.b, READ_VERSION)
      )
    )
    expect(result.ok).toBe(false)
    expect(result.error).toEqual({
      code: "command.unauthenticated",
      reason: "session-changed",
    })
  })

  test("each user reads only the rows of their own (extent own)", async ({
    app,
  }) => {
    const count = async (user: TestUser) => {
      const result = valueOf(
        await callData(
          app,
          same(app, user),
          envelope(user, {
            type: "read",
            items: [{ type: "query", query: { object: CLIENT, count: true } }],
          })
        )
      ) as {
        value: { items: Array<{ ok: boolean; value: { count: number } }> }
      }
      return result.value.items[0]!.value.count
    }
    const rows = async (user: TestUser) => {
      const result = valueOf(
        await callData(
          app,
          same(app, user),
          envelope(user, {
            type: "read",
            items: [{ type: "query", query: { object: CLIENT, limit: 100 } }],
          })
        )
      ) as {
        value: {
          items: Array<{
            value: {
              rows: Array<{ id: string; owner_id: string; description: string }>
            }
          }>
        }
      }
      return result.value.items[0]!.value.rows
    }
    expect(await count(app.users.b)).toBe(B_ROWS)
    expect(await count(app.users.a)).toBeGreaterThanOrEqual(SEED_COUNT)
    // Точні набори: рядки B — рівно ті, що вставлено й змінено через його
    // `CommandRuntime`; сторінка A — підмножина рядків із власником A і без жодного рядка B
    const idsOf = async (user: TestUser) =>
      (
        await app.query<{ id: string }>(
          "SELECT id FROM app.client WHERE owner_id = $1",
          [user.id]
        )
      ).map((r) => r.id)
    const bRows = await rows(app.users.b)
    expect(bRows.map((r) => r.id).sort()).toEqual(
      (await idsOf(app.users.b)).sort()
    )
    expect(bRows.map((r) => r.description).sort()).toEqual(
      Array.from({ length: B_ROWS }, (_, i) => `B-only ${i}`)
    )
    const aIds = new Set(await idsOf(app.users.a))
    const bIds = new Set(bRows.map((r) => r.id))
    const aPage = await rows(app.users.a)
    expect(aPage.length).toBeGreaterThan(0)
    expect(
      aPage.every((r) => aIds.has(r.id) && r.owner_id === app.users.a.id)
    ).toBe(true)
    expect(aPage.some((r) => bIds.has(r.id))).toBe(false)
  })
})

test.describe("body limit", () => {
  const over = PAYLOAD_MAX_BYTES + 1

  test("Content-Length over the limit on the data function", async ({
    app,
  }) => {
    refusal(
      await send(app, {
        method: "POST",
        path: dataPath(app),
        headers: {
          ...SERVER_FN,
          ...same(app, app.users.a),
          "content-length": String(over),
        },
        body: "{",
      })
    )
  })

  test("a chunked body over the limit on the data function", async ({
    app,
  }) => {
    refusal(
      await send(app, {
        method: "POST",
        path: dataPath(app),
        headers: { ...SERVER_FN, ...same(app, app.users.a) },
        chunkedBytes: over,
      })
    )
  })

  test("a gzip body", async ({ app }) => {
    refusal(
      await send(app, {
        method: "POST",
        path: dataPath(app),
        headers: {
          ...SERVER_FN,
          ...same(app, app.users.a),
          "content-encoding": "gzip",
        },
        body: "x",
      })
    )
  })

  test("a chunked body over the limit on sign-in", async ({ app }) => {
    refusal(
      await send(app, {
        method: "POST",
        path: "/api/auth/sign-in/email",
        localAddress: address(30),
        headers: { ...JSON_HEADERS, origin: app.origin },
        chunkedBytes: over,
      })
    )
  })

  test("Content-Length over the limit on sign-in", async ({ app }) => {
    refusal(
      await send(app, {
        method: "POST",
        path: "/api/auth/sign-in/email",
        localAddress: address(31),
        headers: {
          ...JSON_HEADERS,
          origin: app.origin,
          "content-length": String(over),
        },
        body: "{",
      })
    )
  })

  test("a small body is not refused (control)", async ({ app }) => {
    const reply = await signIn(app, address(32))
    expect(reply.status).toBe(401)
  })
})

test.describe("Better Auth", () => {
  test("sign-up is closed", async ({ app }) => {
    const email = `signup-${Date.now()}@e2e.test`
    const reply = await send(app, {
      method: "POST",
      path: "/api/auth/sign-up/email",
      localAddress: address(40),
      headers: { ...JSON_HEADERS, origin: app.origin },
      body: JSON.stringify({ email, password: "a-long-password-1", name: "X" }),
    })
    expect(reply.status).toBeGreaterThanOrEqual(400)
    expect(reply.status).toBeLessThan(500)
    expect(reply.setCookie).toEqual([])
    expect(
      await app.query('SELECT 1 FROM better_auth."user" WHERE email = $1', [
        email,
      ])
    ).toEqual([])
  })

  test("anonymous sign-in is closed", async ({ app }) => {
    const reply = await send(app, {
      method: "POST",
      path: "/api/auth/sign-in/anonymous",
      localAddress: address(41),
      headers: { ...JSON_HEADERS, origin: app.origin },
      body: "{}",
    })
    expect(reply.status).toBe(404)
    expect(reply.setCookie).toEqual([])
    expect(
      await app.query('SELECT 1 FROM better_auth."user" WHERE "isAnonymous"')
    ).toEqual([])
  })

  test("the rate limit counts the real socket address", async ({ app }) => {
    // Змінні `X-Forwarded-For` і підроблений `x-simetra-client-ip` з однієї
    // адреси сокета: лічильник один, і межа вичерпується
    const first = address(50)
    const statuses: number[] = []
    for (let i = 0; i < 8; i++) {
      const reply = await signIn(app, first, {
        "x-forwarded-for": `10.0.0.${i + 1}`,
        "x-simetra-client-ip": `10.9.9.${i + 1}`,
      })
      statuses.push(reply.status)
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true)
    expect(statuses.slice(5).every((s) => s === 429)).toBe(true)
    // Запит з іншої адреси сокета проходить
    expect((await signIn(app, address(51))).status).toBe(401)
    // Ключ лічильника — справжня адреса: не `no-trusted-ip` і не підроблена
    const keys = (
      await app.query<{ key: string }>(
        'SELECT key FROM better_auth."rateLimit"'
      )
    ).map((r) => r.key)
    expect(keys.some((k) => k.startsWith(`${first}|`))).toBe(true)
    expect(keys.some((k) => k.includes("no-trusted-ip"))).toBe(false)
    expect(
      keys.some((k) => k.includes("10.9.9.") || k.includes("10.0.0."))
    ).toBe(false)
  })

  test("the session records the real client address", async ({ app }) => {
    // Вхід `signUpEmail` скрипта `dev-user` теж створює сесію, але без адреси:
    // сесія входу через сервер — та, що з адресою сокета
    const rows = await app.query<{ ipAddress: string }>(
      'SELECT "ipAddress" FROM better_auth.session WHERE "userId" = $1',
      [app.users.a.id]
    )
    expect(rows.map((r) => r.ipAddress)).toContain(app.users.a.address)
  })

  test("get-session is not cached", async ({ app }) => {
    const reply = await send(app, {
      path: "/api/auth/get-session",
      headers: { cookie: app.users.a.cookie },
    })
    expect(reply.status).toBe(200)
    expect(reply.headers["cache-control"]).toBe("no-store")
  })

  test("the rate-limit table exists after the database setup", async ({
    app,
  }) => {
    expect(
      await app.query(
        "SELECT 1 FROM information_schema.tables WHERE table_schema = 'better_auth' AND table_name = 'rateLimit'"
      )
    ).toHaveLength(1)
  })
})

test.describe("HTML", () => {
  test("is not cached and varies on Cookie", async ({ app, page }) => {
    const response = await page.goto(`${app.origin}/`)
    expect(response?.status()).toBe(200)
    const headers = response!.headers()
    expect(headers["cache-control"]).toBe("private, no-store")
    expect(headers["vary"]?.toLowerCase()).toContain("cookie")
    expect(headers["x-content-type-options"]).toBe("nosniff")
    expect(headers["referrer-policy"]).toBe("same-origin")
    expect(headers["content-security-policy"]).toBe("frame-ancestors 'none'")
  })
})

test.describe("server start (spec 4.1)", () => {
  const refusesToStart = async (
    app: App,
    env: Record<string, string | undefined>,
    variable: string
  ) => {
    const port = await app.freePort()
    const run = app.start({
      PORT: String(port),
      HOST: "127.0.0.1",
      NITRO_HOST: "127.0.0.1",
      ...env,
    })
    // Порт має відмовляти весь час до виходу процесу, а не лише після нього:
    // сервер, що встиг почати слухати, — вже небезпечний
    let exitCode: number | null | "alive" = "alive"
    void run.exited.then((code) => (exitCode = code))
    const deadline = Date.now() + 20_000
    while (exitCode === "alive" && Date.now() < deadline) {
      await expect(send({ port }, { path: "/" })).rejects.toThrow(
        /ECONNREFUSED/
      )
      await new Promise((r) => setTimeout(r, 50))
    }
    if (exitCode === "alive") run.child.kill("SIGKILL")
    expect(exitCode).not.toBe("alive")
    expect(exitCode).not.toBe(0)
    expect(run.output()).toContain(variable)
    await expect(send({ port }, { path: "/" })).rejects.toThrow(/ECONNREFUSED/)
  }

  test("a non-canonical SIMETRA_APP_ORIGIN stops the server", async ({
    app,
  }) => {
    await refusesToStart(
      app,
      {
        NODE_ENV: "production",
        SIMETRA_APP_ORIGIN: "https://a.test/",
        BETTER_AUTH_SECRET: app.secret,
      },
      "SIMETRA_APP_ORIGIN"
    )
  })

  test("production without BETTER_AUTH_SECRET stops the server", async ({
    app,
  }) => {
    await refusesToStart(
      app,
      { NODE_ENV: "production", SIMETRA_APP_ORIGIN: app.origin },
      "BETTER_AUTH_SECRET"
    )
  })
})
