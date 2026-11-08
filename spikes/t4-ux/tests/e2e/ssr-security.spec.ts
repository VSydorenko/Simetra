// Тотожність SSR-знімка: права змінились між серверним рендером і
// гідратацією → виняток безпеки (дані зникають одразу, UI показує причину).
// Знімок не потрапляє іншому користувачу: паралельні SSR-запити двох
// суб'єктів, заголовки кешу, ядро на запит.
import {
  control,
  expect,
  loginAs,
  settle,
  test,
  uniqueSubject,
} from "./harness"

test("права змінились між SSR і гідратацією → purge і причина", async ({
  page,
  oracle,
}) => {
  await loginAs(page, uniqueSubject())
  // Друга вкладка тієї самої сесії — з неї сервер «відкликає права».
  const helper = await page.context().newPage()
  await helper.goto("/login")
  await helper.waitForFunction(() => (window as any).__t4Hydrated)
  await page.route("**/", async (route) => {
    if (route.request().resourceType() !== "document") return route.continue()
    const resp = await route.fetch()
    const body = await resp.text()
    // HTML відрендерено з правами v1; до гідратації сервер відкликає права.
    await control(helper, { kind: "rights", version: 2 })
    await route.fulfill({ response: resp, body })
  })
  await page.goto("/")
  await page.waitForFunction(
    () => (window as any).__t4Verify !== undefined,
    null,
    { timeout: 5000 }
  )
  expect(await page.evaluate(() => (window as any).__t4Verify)).toBe(
    "rights-changed"
  )
  await settle(page, 200)
  await expect(page.locator("[data-region=list] [data-row-key]")).toHaveCount(0)
  await expect(page.locator("[data-security]")).toHaveAttribute(
    "data-security",
    "rights-changed"
  )
  const log = await oracle.log()
  const lastList = log.snaps.at(-1)!.regions.find((r) => r.name === "list")!
  expect(lastList.text).not.toContain("Alpha")
})

test("знімок SSR одного суб'єкта не потрапляє іншому: паралельні запити, кеш, ядро на запит", async ({
  browser,
}) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await loginAs(a, uniqueSubject("alice"))
  await loginAs(b, uniqueSubject("bob"))
  // 10 пар паралельних SSR-запитів: жодна відповідь не містить чужих даних.
  for (let i = 0; i < 10; i++) {
    const [ra, rb] = await Promise.all([a.request.get("/"), b.request.get("/")])
    const [ha, hb] = await Promise.all([ra.text(), rb.text()])
    expect(ha).toContain("Alpha item")
    expect(ha).not.toContain("Bravo")
    expect(hb).toContain("Bravo item")
    expect(hb).not.toContain("Alpha")
    // Відповідь із персональним знімком не кешується спільними кешами.
    for (const r of [ra, rb]) {
      expect(r.headers()["cache-control"] ?? "").toMatch(/private|no-store/)
      expect((r.headers()["vary"] ?? "").toLowerCase()).toContain("cookie")
    }
  }
  // Без cookie — жодних даних у HTML.
  const anon = await (
    await browser.newContext()
  ).request
    .get("/", { maxRedirects: 0 })
    .catch(() => null)
  if (anon) expect(await anon.text()).not.toMatch(/Alpha item|Bravo item/)
  await ctxA.close()
  await ctxB.close()
})
