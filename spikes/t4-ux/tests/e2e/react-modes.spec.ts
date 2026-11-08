// Режими React і Start: потоковий SSR із Suspense, оновлення сховища під
// час переходу (transition) і повторне монтування після releaseDelayMs.
import {
  control,
  expect,
  loginAs,
  settle,
  test,
  uniqueSubject,
} from "./harness"
import { openList } from "./flows"

test("потоковий SSR: рядки в першому кадрі, лічильник доходить потоком у своєму слоті", async ({
  page,
  oracle,
}) => {
  await loginAs(page, uniqueSubject())
  const resp = await page.goto("/")
  const html = await resp!.text()
  expect(html).toContain("data-row-key")
  // Значення лічильника прийшло в тому самому документі пізнішим фрагментом потоку.
  expect(html).toMatch(/\$_TSR|data-count/)
  await expect(page.locator("[data-count=ready]")).toHaveText(/\d+/, {
    timeout: 5000,
  })
  await page.waitForFunction(() =>
    (window as any).__t4Commits?.some((c: any) => c.id === "list")
  )
  await settle(page, 500)
  await oracle.expectClean()
})

test("transition: запис осідає під час навігації — без проміжного кадру", async ({
  page,
  oracle,
}) => {
  await openList(page)
  await control(page, { kind: "latency", writeMs: 250, readMs: 200 })
  const row = page.locator("[data-region=list] [data-row-key]").nth(2)
  const key = (await row.getAttribute("data-row-key"))!
  await oracle.mark("toggle-and-navigate", { allow: ["shift"] })
  await row.locator("[data-action=toggle]").click()
  await row.locator("[data-field=name]").click()
  await page.waitForSelector("[data-region=card]")
  await settle(page, 600)
  await oracle.mark("back", { allow: ["shift"] })
  await page.click("[data-action=back]")
  await expect(
    page.locator(`[data-region=list] [data-row-key="${key}"] [data-state]`)
  ).toHaveAttribute("data-state", "synced")
  await settle(page, 300)
  await oracle.expectClean()
})

test("повторне монтування після releaseDelayMs: перечитування без скелета", async ({
  page,
  oracle,
}) => {
  await openList(page)
  await control(page, { kind: "latency", readMs: 300 })
  const key = await page
    .locator("[data-region=list] [data-row-key]")
    .nth(1)
    .getAttribute("data-row-key")
  await oracle.mark("to-card", { allow: ["shift"] })
  await page
    .locator(`[data-region=list] [data-row-key="${key}"] [data-field=name]`)
    .click()
  await page.waitForSelector("[data-region=card]")
  await settle(page, 1600) // > releaseDelayMs (1000): підмножину списку звільнено
  const before = await page.evaluate(
    () =>
      ((window as any).__t4Fns ?? []).filter((c: any) => c.name === "readRows")
        .length as number
  )
  await oracle.mark("back", { allow: ["shift"] })
  await page.click("[data-action=back]")
  await page.waitForSelector("[data-region=list] [data-row-key]")
  await settle(page, 300)
  test.info().annotations.push({
    type: "reads-on-remount",
    description: String(
      (await page.evaluate(
        () =>
          ((window as any).__t4Fns ?? []).filter(
            (c: any) => c.name === "readRows"
          ).length as number
      )) - before
    ),
  })
  await oracle.expectClean()
})
