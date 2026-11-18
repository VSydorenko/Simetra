// SSR, вхід і вихід, розрив сесії й повернення фокуса (сценарії 1, 3, 7–10 спеки
// П4-D §8.1) і безпекові кейси D3 (§8.3) на production-збірці без аліасу
// `#instrument`. Кінцева умова (Д3-1) — стан DOM і тіла відповідей `dataFn` з
// мережевого журналу Playwright. Кадри записує `browser.ts`: `page.clock`
// підміняє `requestAnimationFrame`, тож сценарії 9 і 10 (які ведуть час) беруть
// записувач змін DOM, решта — кадровий.
import { randomUUID } from "node:crypto"
import pg from "pg"
import { betterAuth } from "better-auth"
import { authOptions } from "../template/src/server/auth"
import {
  contextWithCookie,
  expectedHydrationRequests,
  framesOf,
  freshSession,
  listRows,
  recordFrames,
  serverRendered,
  watchDataFn,
} from "./browser"
import { test, expect, B_ROWS, type App } from "./fixtures"
import { send, type Reply } from "./http"
import { encodePayload } from "./serialization"

const CLIENT = "08f4943e-0296-4fbd-8d89-61b6f11355ee"
const SEED_ROW = /Client \d+/
// Один елемент `resume()` дальше `resumeMinIntervalMs` (за замовчуванням 15 с)
const BEYOND_RESUME_INTERVAL_MS = 16_000

const ORDER = [{ attribute: "description", direction: "asc" }] as const

const html = (app: App, cookie: string, path: string): Promise<Reply> =>
  send(app, { path, headers: { cookie } })

/** Скільки запитів чекати після гідратації списку, за знімком у HTML цього ж запиту. */
async function expectedFor(
  app: App,
  cookie: string,
  path: string,
  objectRef: "Catalog.Client" | "Catalog.Country"
): Promise<number> {
  const { text } = await html(app, cookie, path)
  return expectedHydrationRequests(
    objectRef,
    objectRef === "Catalog.Country" ? "full" : "window",
    text,
    objectRef === "Catalog.Client" ? [...ORDER] : undefined
  )
}

/** Після гідратації: усі запити `dataFn` зроблено, далі тиша. */
async function settle(
  page: import("@playwright/test").Page,
  log: ReturnType<typeof watchDataFn>,
  expected: number
): Promise<void> {
  await expect
    .poll(async () => (await log.flush(), log.calls.length))
    .toBe(expected)
  // Тиша: жодного запиту понад очікуване й після паузи
  await page.waitForTimeout(1_500)
  await log.flush()
  expect(log.calls).toHaveLength(expected)
}

test.describe("scenario 1: SSR entry on the Client list", () => {
  test("HTML and the first frame after hydration agree, then 1 + N requests and silence", async ({
    app,
    browser,
  }) => {
    const server = await serverRendered(
      browser,
      app,
      app.users.a.cookie,
      "/clients"
    )
    expect(server.rows.length).toBeGreaterThan(0)
    expect(server.rows[0]).toContain("Client 0")

    const context = await contextWithCookie(browser, app, app.users.a.cookie)
    const page = await context.newPage()
    await recordFrames(page, "frame")
    const log = watchDataFn(page, app)
    await page.goto(`${app.origin}/clients`)
    await page.waitForSelector("html[data-hydrated]")
    await settle(
      page,
      log,
      await expectedFor(app, app.users.a.cookie, "/clients", "Catalog.Client")
    )

    // Кожен кадр зі значеннями — той самий склад і порядок, що в HTML (Д-12)
    const frames = (await framesOf(page)).filter((f) => f.rows.length > 0)
    expect(frames.some((f) => f.hydrated)).toBe(true)
    for (const frame of frames) {
      expect(frame.keys).toEqual(server.keys)
      expect(frame.rows).toEqual(server.rows)
    }
    // 1 запит `version` + запити виглядів, усі від суб'єкта сесії
    expect(log.calls[0]?.items).toEqual(["version"])
    for (const call of log.calls) {
      expect(call.subject).toBe(app.users.a.id)
      expect(call.result?.ok).toBe(true)
    }
    await context.close()
  })
})

test.describe("scenario 8: full Country list with SSR", () => {
  test("HTML and the first frame agree, the full view costs 1 + N requests", async ({
    app,
    browser,
  }) => {
    const server = await serverRendered(
      browser,
      app,
      app.users.a.cookie,
      "/countries"
    )
    expect(server.rows.length).toBeGreaterThan(0)
    expect(server.rows[0]).toContain("Country ")

    const context = await contextWithCookie(browser, app, app.users.a.cookie)
    const page = await context.newPage()
    await recordFrames(page, "frame")
    const log = watchDataFn(page, app)
    await page.goto(`${app.origin}/countries`)
    await page.waitForSelector("html[data-hydrated]")
    await settle(
      page,
      log,
      await expectedFor(
        app,
        app.users.a.cookie,
        "/countries",
        "Catalog.Country"
      )
    )
    const frames = (await framesOf(page)).filter((f) => f.rows.length > 0)
    for (const frame of frames) {
      expect(frame.keys).toEqual(server.keys)
      expect(frame.rows).toEqual(server.rows)
    }
    await context.close()
  })
})

test.describe("scenario 3: list, card, list within releaseDelayMs", () => {
  test("the card comes from the store and the list keeps its rows without a new read", async ({
    app,
    browser,
  }) => {
    const context = await contextWithCookie(browser, app, app.users.a.cookie)
    const page = await context.newPage()
    const log = watchDataFn(page, app)
    await page.goto(`${app.origin}/clients`)
    await page.waitForSelector("html[data-hydrated]")
    await settle(
      page,
      log,
      await expectedFor(app, app.users.a.cookie, "/clients", "Catalog.Client")
    )
    const hydrationCalls = log.calls.length
    const before = await listRows(page)
    const first = page.locator("[data-row-key]").first()
    const description = (await first.textContent()) ?? ""
    expect(description).toContain("Client 0")
    const key = before.keys[0]!

    await first.click()
    await expect(page.locator("[data-region=card]")).toBeVisible()
    await expect(page).toHaveURL(new RegExp(`/clients/${key}$`))
    // Шапка картки — значення зі сховища, без читання шапки
    await expect(
      page.locator("[data-region=card] [data-field=description]")
    ).toBeVisible()
    await page.waitForTimeout(500)
    await log.flush()
    const afterCard = log.calls.length
    const cardCalls = log.calls.slice(hydrationCalls)
    // Лише читання табличних частин: шапку вже тримає сховище
    for (const call of cardCalls) expect(call.text).not.toContain("Client 0")

    await page.getByRole("link", { name: "Clients" }).click()
    await expect(page.locator("[data-region=list]")).toBeVisible()
    await expect
      .poll(async () => (await listRows(page)).keys)
      .toEqual(before.keys)
    await page.waitForTimeout(500)
    await log.flush()
    // Повернення в межах `releaseDelayMs`: вигляд списку ще тримається
    expect(log.calls.length).toBe(afterCard)
    expect((await listRows(page)).rows).toEqual(before.rows)
    await context.close()
  })
})

test.describe("scenario 7: sign-out in the current tab", () => {
  test("the data disappears in one frame and the route is the login", async ({
    app,
    browser,
  }) => {
    const cookie = await freshSession(app, app.users.a)
    const context = await contextWithCookie(browser, app, cookie)
    const page = await context.newPage()
    await recordFrames(page, "frame")
    const log = watchDataFn(page, app)
    await page.goto(`${app.origin}/clients`)
    await page.waitForSelector("html[data-hydrated]")
    await settle(
      page,
      log,
      await expectedFor(app, cookie, "/clients", "Catalog.Client")
    )
    const shown = (await listRows(page)).rows.length
    expect(shown).toBeGreaterThan(0)
    const mark = (await framesOf(page)).length

    await page.getByRole("button", { name: "Sign out" }).click()
    await expect(page).toHaveURL(/\/login$/)
    await expect(page.locator("[data-region=login]")).toBeVisible()
    await page.waitForTimeout(500)

    const after = (await framesOf(page)).slice(mark - 1)
    const counts = after.map((f) => f.rows.length)
    // Рядки є, потім їх немає: жодного кадру з частиною і жодного повернення
    expect(new Set(counts)).toEqual(new Set([shown, 0]))
    expect(counts.indexOf(0)).toBeGreaterThan(0)
    expect(counts.slice(counts.indexOf(0)).every((n) => n === 0)).toBe(true)
    // Жодного значення з даних у кадрах після зникнення
    for (const frame of after.filter((f) => f.rows.length === 0))
      expect(frame.body).not.toMatch(SEED_ROW)

    // Сесії немає: список веде на вхід і не несе рядків
    const reply = await html(app, cookie, "/clients")
    expect(reply.status).toBe(307)
    await context.close()
  })
})

test.describe("scenario 9: focus after a change by another session", () => {
  test("the value updates in place; a new row gives only the show-new action", async ({
    app,
    browser,
  }) => {
    const { runtime, claims } = app.runtimeB
    const object = { kind: "Catalog", name: "Client" } as const
    const own = await runtime.read(claims, { object, limit: 50 })
    // Рядки B за ключем (id), порядок списку — за `description`
    const target = own.rows.find((row) => row.description === "B-only 1")
    expect(target).toBeDefined()
    const targetId = String(target!.ref)
    const context = await contextWithCookie(browser, app, app.users.b.cookie)
    try {
      const page = await context.newPage()
      await page.clock.install()
      await recordFrames(page, "mutation")
      const log = watchDataFn(page, app)
      await page.goto(`${app.origin}/clients`)
      await page.waitForSelector("html[data-hydrated]")
      await settle(
        page,
        log,
        await expectedFor(app, app.users.b.cookie, "/clients", "Catalog.Client")
      )
      const before = await listRows(page)
      expect(before.rows).toHaveLength(B_ROWS)
      expect(before.rows.join()).not.toMatch(SEED_ROW)

      // Той самий суб'єкт у іншому сеансі міняє видимий рядок
      await runtime.run(claims, {
        action: "update",
        object,
        id: targetId,
        expectedVersion: Number(target!.version),
        values: { description: "B-only 1 changed" },
      })
      const sent = log.calls.length
      await page.clock.fastForward(BEYOND_RESUME_INTERVAL_MS)
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      await expect
        .poll(async () => (await listRows(page)).rows.join())
        .toContain("B-only 1 changed")
      const updated = await listRows(page)
      // На місці: той самий склад і порядок, значення нове
      expect(updated.keys).toEqual(before.keys)
      await log.flush()
      const resumeCalls = log.calls.slice(sent)
      expect(resumeCalls.length).toBeGreaterThan(0)
      expect(resumeCalls.some((c) => c.text.includes("B-only 1 changed"))).toBe(
        true
      )

      // Новий рядок: склад не змінюється, є лише дія «показати нові»
      await runtime.run(claims, {
        action: "create",
        object,
        id: randomUUID(),
        values: {
          code: "BNEW00001",
          description: "B-new row",
          owner: app.users.b.id,
        },
      })
      await page.clock.fastForward(BEYOND_RESUME_INTERVAL_MS)
      await page.evaluate(() => window.dispatchEvent(new Event("focus")))
      await expect(
        page.getByRole("button", { name: "New rows — show" })
      ).toBeVisible()
      const afterNew = await listRows(page)
      expect(afterNew.keys).toEqual(before.keys)
      expect(afterNew.rows.join()).not.toContain("B-new row")
      // Кожен стан DOM між ними мав склад із B_ROWS рядків
      for (const frame of (await framesOf(page)).filter(
        (f) => f.rows.length > 0
      ))
        expect(frame.keys).toEqual(before.keys)
    } finally {
      await context.close()
      // Дані B повертаються до виду фікстури: інші тести бачать рівно B_ROWS
      await app.query("UPDATE app.client SET description = $1 WHERE id = $2", [
        "B-only 1",
        targetId,
      ])
      await app.query("DELETE FROM app.client WHERE code = $1", ["BNEW00001"])
    }
  })
})

test.describe("scenario 10: sign-out in another tab, then focus", () => {
  test("the first tab loses the data in one state and goes to the login", async ({
    app,
    browser,
  }) => {
    const cookie = await freshSession(app, app.users.a)
    const context = await contextWithCookie(browser, app, cookie)
    const first = await context.newPage()
    await first.clock.install()
    await recordFrames(first, "mutation")
    const log = watchDataFn(first, app)
    await first.goto(`${app.origin}/clients`)
    await first.waitForSelector("html[data-hydrated]")
    await settle(
      first,
      log,
      await expectedFor(app, cookie, "/clients", "Catalog.Client")
    )
    const shown = (await listRows(first)).rows.length
    expect(shown).toBeGreaterThan(0)

    const second = await context.newPage()
    await second.goto(`${app.origin}/clients`)
    await second.waitForSelector("html[data-hydrated]")
    await second.getByRole("button", { name: "Sign out" }).click()
    await expect(second).toHaveURL(/\/login$/)

    // Дх14: вкладка дізнається про розрив на першому запиті після фокуса; у М3
    // це `resume()` для виглядів, старших за `resumeMinIntervalMs`
    const mark = (await framesOf(first)).length
    const sent = log.calls.length
    await first.clock.fastForward(BEYOND_RESUME_INTERVAL_MS)
    await first.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(first).toHaveURL(/\/login$/)
    await expect(first.locator("[data-region=login]")).toBeVisible()
    await log.flush()
    const refused = log.calls.slice(sent)
    expect(refused.length).toBeGreaterThan(0)
    for (const call of refused) {
      expect(call.result?.ok).toBe(false)
      expect(call.result?.error?.code).toBe("command.unauthenticated")
      expect(call.result?.error?.reason).toBeUndefined()
      expect(call.text).not.toMatch(SEED_ROW)
    }

    const after = (await framesOf(first)).slice(mark - 1)
    const counts = after.map((f) => f.rows.length)
    expect(new Set(counts)).toEqual(new Set([shown, 0]))
    expect(counts.slice(counts.indexOf(0)).every((n) => n === 0)).toBe(true)
    for (const frame of after.filter((f) => f.rows.length === 0))
      expect(frame.body).not.toMatch(SEED_ROW)
    await context.close()
  })
})

test.describe("security: data runtime per request", () => {
  /** Власні рядки відкриваються лише своєму суб'єкту (права `own`, Д-13). */
  function expectOwn(reply: Reply, who: "a" | "b", app: App): void {
    expect(reply.status).toBe(200)
    const own = who === "a" ? app.users.a : app.users.b
    const other = who === "a" ? app.users.b : app.users.a
    // Позитивний контроль: порожній список не доводить нічого
    expect(reply.text).toContain(who === "a" ? "Client 0" : "B-only 0")
    expect(reply.text).toContain(`subject:"${own.id}"`)
    expect(reply.text).not.toContain(other.id)
    expect(reply.text).not.toMatch(who === "a" ? /B-only \d/ : SEED_ROW)
  }

  test("A, B, A in turn and in parallel: only own rows and own subject", async ({
    app,
  }) => {
    const ask = (who: "a" | "b") =>
      html(app, app.users[who].cookie, "/clients").then((reply) => ({
        who,
        reply,
      }))
    for (const who of ["a", "b", "a"] as const) {
      const { reply } = await ask(who)
      expectOwn(reply, who, app)
    }
    const replies = await Promise.all(
      (["a", "b", "b", "a", "a", "b"] as const).map(ask)
    )
    for (const { who, reply } of replies) expectOwn(reply, who, app)
  })
})

test.describe("security: no session, anonymous session", () => {
  test("a request without a session is sent to the login without rows or snapshot", async ({
    app,
  }) => {
    const reply = await send(app, { path: "/clients" })
    expect(reply.status).toBe(307)
    expect(reply.headers.location).toBe("/login")
    expect(reply.text).not.toMatch(SEED_ROW)
    expect(reply.text).not.toContain("core:")
  })

  test("an anonymous Better Auth session gets no rows and no snapshot", async ({
    app,
    browser,
  }) => {
    // Серверним API: HTTP-шлях анонімного входу вимкнено
    const pool = new pg.Pool({
      connectionString: app.adminUrl,
      options: "-c search_path=better_auth",
    })
    let cookie: string
    try {
      const auth = betterAuth(authOptions(pool, app.origin, app.secret))
      const result = await auth.api.signInAnonymous({ returnHeaders: true })
      cookie = result.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ")
    } finally {
      await pool.end()
    }
    const reply = await html(app, cookie, "/clients")
    expect(reply.status).toBe(307)
    expect(reply.headers.location).toBe("/login")
    expect(reply.text).not.toMatch(SEED_ROW)
    expect(reply.text).not.toContain("core:")

    const context = await contextWithCookie(browser, app, cookie)
    const page = await context.newPage()
    await page.goto(`${app.origin}/clients`)
    await expect(page).toHaveURL(/\/login$/)
    expect(await page.locator("[data-row-key]").count()).toBe(0)
    await context.close()
  })

  test("a visitor signs in on the login form and lands on own rows", async ({
    app,
    browser,
  }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    const log = watchDataFn(page, app)
    await page.goto(`${app.origin}/clients`)
    await expect(page).toHaveURL(/\/login$/)
    await page.waitForSelector("html[data-hydrated]")
    await page.getByLabel("Email").fill(app.users.a.email)
    await page.getByLabel("Password").fill(app.users.a.password)
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page).toHaveURL(/\/clients$/)
    await expect(page.locator("[data-row-key]").first()).toContainText(
      "Client 0"
    )
    await expect
      .poll(async () => (await log.flush(), log.calls.length))
      .toBeGreaterThan(0)
    for (const call of log.calls) expect(call.subject).toBe(app.users.a.id)
    await context.close()
  })

  test("a wrong password shows a code and no data", async ({
    app,
    browser,
  }) => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${app.origin}/login`)
    await page.waitForSelector("html[data-hydrated]")
    await page.getByLabel("Email").fill(app.users.a.email)
    await page.getByLabel("Password").fill("wrong-password")
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page.locator("[data-simetra-error]")).toHaveAttribute(
      "data-simetra-error",
      /^command\./
    )
    await expect(page).toHaveURL(/\/login$/)
    await context.close()
  })
})

test.describe("security: sign-in of B over the live session of A", () => {
  test("no value of A in the DOM after the swap, requests carry the subject of B", async ({
    app,
    browser,
  }) => {
    const context = await contextWithCookie(browser, app, app.users.a.cookie)
    const page = await context.newPage()
    await recordFrames(page, "frame")
    const log = watchDataFn(page, app)
    await page.goto(`${app.origin}/clients`)
    await page.waitForSelector("html[data-hydrated]")
    await expect(page.locator("[data-row-key]").first()).toContainText(
      "Client 0"
    )
    // Форма входу доступна й із живою сесією; сторінка тримає рантайм A
    await page.goto(`${app.origin}/login`)
    await page.waitForSelector("html[data-hydrated]")
    // Гідратація `/login` звіряє знімок A (`version`): це запити A до входу B
    await page.waitForTimeout(1_000)
    await log.flush()
    const sent = log.calls.length
    await page.getByLabel("Email").fill(app.users.b.email)
    await page.getByLabel("Password").fill(app.users.b.password)
    await page.getByRole("button", { name: "Sign in" }).click()
    await expect(page).toHaveURL(/\/clients$/)
    await expect(page.locator("[data-row-key]").first()).toContainText(
      "B-only 0"
    )
    await page.waitForTimeout(1_500)
    await log.flush()
    const after = log.calls.slice(sent)
    expect(after.length).toBeGreaterThan(0)
    for (const call of after) {
      expect(call.subject).toBe(app.users.b.id)
      expect(call.result?.error?.reason).toBeUndefined()
      expect(call.text).not.toMatch(SEED_ROW)
    }
    for (const frame of await framesOf(page)) {
      expect(frame.body).not.toMatch(SEED_ROW)
      expect(frame.body).not.toContain(app.users.a.id)
    }
    expect((await listRows(page)).rows).toHaveLength(B_ROWS)
    await context.close()
  })
})

test.describe("security: Server Functions of the build", () => {
  const envelope = (subject: string) => ({
    subject,
    request: {
      type: "read",
      items: [{ type: "query", query: { object: CLIENT, limit: 5 } }],
    },
  })

  test("only the same-origin dataFn returns rows; cross-site none, dataFn included", async ({
    app,
  }) => {
    const ids = Object.entries(app.serverFunctions)
    expect(ids.map(([name]) => name)).toContain("dataFn")
    const call = (id: string, site: "cross-site" | "same-origin") =>
      send(app, {
        method: "POST",
        path: `/_serverFn/${id}`,
        headers: {
          "content-type": "application/json",
          "x-tsr-serverfn": "true",
          origin: site === "same-origin" ? app.origin : "https://evil.test",
          "sec-fetch-site": site,
          cookie: app.users.a.cookie,
        },
        body: encodePayload(envelope(app.users.a.id)),
      })
    for (const [name, id] of ids) {
      expect(
        (await call(id, "cross-site")).text,
        `${name} cross-site`
      ).not.toMatch(SEED_ROW)
      const same = await call(id, "same-origin")
      if (name === "dataFn") expect(same.text).toMatch(SEED_ROW)
      else expect(same.text, `${name} same-origin`).not.toMatch(SEED_ROW)
    }
  })
})

test.describe("errors do not reach the client as text", () => {
  test("a runtime database failure shows a code, not the host or the role", async ({
    app,
  }) => {
    const port = await app.freePort()
    const leak = "leaky_role_xyz:pw@db.internal.example:1/leaky_db_xyz"
    const server = app.start({
      ...app.serverEnv,
      PORT: String(port),
      SIMETRA_APP_ORIGIN: `http://127.0.0.1:${port}`,
      SIMETRA_RUNTIME_DATABASE_URL: `postgresql://${leak}`,
    })
    try {
      await expect
        .poll(
          async () =>
            send({ port }, { path: "/" }).then(
              () => true,
              () => false
            ),
          { timeout: 30_000 }
        )
        .toBe(true)
      const reply = await send(
        { port },
        { path: "/clients", headers: { cookie: app.users.a.cookie } }
      )
      expect(reply.status).toBe(200)
      // Включно з дегідрованим станом роутера (`$_TSR`) — він у тому ж HTML
      for (const text of ["leaky", "db.internal", "ECONN", "ENOTFOUND"])
        expect(reply.text).not.toContain(text)
      // Помилка є, але лише кодом
      expect(reply.text).toContain("command.unavailable")
      expect(reply.text).not.toMatch(SEED_ROW)
    } finally {
      server.child.kill("SIGTERM")
      await Promise.race([
        server.exited,
        new Promise((r) => setTimeout(r, 5_000)),
      ])
    }
  })
})

test.describe("the Start CSRF refusal reaches the UI as command.forbidden", () => {
  test("a bare 403 from the Server Function is shown as the forbidden code", async ({
    app,
    browser,
  }) => {
    const context = await contextWithCookie(browser, app, app.users.a.cookie)
    const page = await context.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    // Рівно та відповідь, яку Start дає на запит без `Sec-Fetch-Site:
    // same-origin` (§8.3, перший шар; сам фільтр доведено в `security.spec.ts`):
    // браузер не дає підробити `Sec-Fetch-*`, тож шар підміняється відповіддю
    await page.route("**/_serverFn/**", (route) =>
      route.fulfill({
        status: 403,
        contentType: "text/plain",
        body: "Forbidden",
      })
    )
    await page.goto(`${app.origin}/clients`)
    await page.waitForSelector("html[data-hydrated]")
    await expect(
      page.locator('[data-panel=status] [data-error="command.forbidden"]')
    ).toBeVisible()
    expect(errors).toEqual([])
    await context.close()
  })
})
