// Скриншоти візуальної моделі станів (критерій 6): усі стани рядка одночасно
// в одному списку, картка з лінивим полем і станом, політики predict/await.
import { control, expect, settle, test } from "./harness"
import { openList } from "./flows"
import { confirmed, signal } from "./signals"

test.skip(
  ({ browserName }) => browserName !== "chromium",
  "скриншоти — один браузер"
)
const ROW = "[data-region=list] [data-row-key]"
const keyAt = (page: import("@playwright/test").Page, n: number) =>
  page.locator(ROW).nth(n).getAttribute("data-row-key") as Promise<string>
const row = (page: import("@playwright/test").Page, k: string) =>
  page.locator(`[data-region=list] [data-row-key="${k}"]`)

test("стани рядка у списку", async ({ page, oracle: _o }) => {
  await openList(page)
  await page.setViewportSize({ width: 1100, height: 760 })
  const k = await Promise.all(
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => keyAt(page, n))
  )
  // failed
  await control(page, { kind: "failNext", code: "command.forbidden" })
  await row(page, k[0]!).locator("[data-action=toggle]").click()
  await expect(row(page, k[0]!).locator("[data-state]")).toHaveAttribute(
    "data-state",
    "failed"
  )
  // conflict
  await control(page, {
    kind: "edit",
    id: k[1]!,
    values: { status: "archived" },
  })
  await row(page, k[1]!).locator("[data-action=toggle]").click()
  await expect(row(page, k[1]!).locator("[data-state]")).toHaveAttribute(
    "data-state",
    "conflict"
  )
  // stale, removed, hasNewRows
  await signal(
    page,
    { op: "stale", keys: [k[2]!] },
    { op: "remove", keys: [k[3]!] },
    { op: "views", flags: { hasNewRows: true } }
  )
  // unknown (перечитування ключа повільне — стан тримається)
  await control(page, { kind: "latency", readMs: 20000 })
  await control(page, { kind: "lostReplyNext" })
  await row(page, k[4]!).locator("[data-action=toggle]").click()
  await expect(row(page, k[4]!).locator("[data-state]")).toHaveAttribute(
    "data-state",
    "unknown"
  )
  // pending (update) і pending (delete) — запис утримано сервером
  await control(page, { kind: "hold" })
  await row(page, k[5]!).locator("[data-action=toggle]").click()
  await row(page, k[6]!).locator("[data-action=delete]").click()
  await settle(page, 200)
  await page
    .locator("[data-region=list]")
    .screenshot({ path: "screenshots/list-states.png" })
  await control(page, { kind: "release" })
  void confirmed
})

test("картка: лінивe поле, ТЧ, стан failed", async ({ page, oracle: _o }) => {
  await openList(page)
  const k = await keyAt(page, 2)
  await control(page, { kind: "latency", readMs: 1500 })
  await row(page, k).locator("[data-field=name]").click()
  await page.waitForSelector("[data-region=card]")
  await settle(page, 100)
  await page
    .locator("[data-region=card]")
    .screenshot({ path: "screenshots/card-lazy-loading.png" })
  await page.waitForFunction(
    () =>
      (document.querySelector("[data-field=note]")?.textContent ?? "").length >
      0
  )
  await control(page, { kind: "latency", readMs: 0 })
  await control(page, { kind: "failNext", code: "command.forbidden" })
  await page.fill("[data-region=card] input[data-field=name]", "Rejected edit")
  await page.press("[data-region=card] input[data-field=name]", "Enter")
  await expect(
    page.locator("[data-region=card] [data-state]").first()
  ).toHaveAttribute("data-state", "failed")
  await page
    .locator("[data-region=card]")
    .screenshot({ path: "screenshots/card-failed.png" })
})

for (const policy of ["predict", "await"] as const)
  test(`політика ${policy}: кадр під час запису`, async ({
    page,
    oracle: _o,
  }) => {
    await openList(page)
    await page.goto(`/?policy=${policy}`)
    await page.waitForSelector(ROW)
    const k = await keyAt(page, 2)
    await control(page, { kind: "hold" })
    await row(page, k).locator("[data-action=toggle]").click()
    await settle(page, 150)
    await page.locator("[data-region=list] [data-scroll]").screenshot({
      path: `screenshots/policy-${policy}-pending.png`,
      clip: { x: 0, y: 0, width: 1000, height: 200 },
    })
    await control(page, { kind: "release" })
  })
