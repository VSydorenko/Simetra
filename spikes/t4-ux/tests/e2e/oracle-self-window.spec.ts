// Самотест посиленого оракула на вікні (критерій 1): кожна навмисна поломка
// дає порушення свого типу; без поломки той самий сценарій чистий.
import type { Page } from "@playwright/test"
import {
  control,
  expect,
  loginAs,
  settle,
  test,
  uniqueSubject,
} from "./harness"

async function open(page: Page, query: string) {
  await loginAs(page, uniqueSubject("alice-win"))
  await page.goto(`/window${query}`)
  await page.waitForFunction(() => (window as any).__t4Hydrated)
  await page.waitForSelector("[data-region=list] [data-row-key]")
  const box = (await page.locator("[data-scroll=list]").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

const frame = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r()))
  )

/** Сценарій: швидка прокрутка вниз. */
async function fastScroll(page: Page) {
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 2400)
    await frame(page)
  }
}

/** Сценарій: кінець, потім вгору (prepend з якорем). */
async function endThenUp(page: Page, oracle: any) {
  await oracle.mark("end", { allow: ["reorder", "shift", "scroll"] })
  await page.click("[data-action=end]")
  await settle(page, 600)
  await oracle.mark("up", { allow: ["scroll"] })
  for (let i = 0; i < 40; i++) {
    await page.mouse.wheel(0, -600)
    await frame(page)
  }
  await settle(page, 400)
}

/** Сценарій: чужа зміна видимого рядка. */
async function signal(page: Page, oracle: any) {
  await settle(page, 300)
  const key = await page.$$eval("[data-row-key]", (els) =>
    els[3]!.getAttribute("data-row-key")!
  )
  await oracle.mark("signal")
  await control(page, { kind: "edit", id: key, values: { amount: "777.00" } })
  await page.evaluate(() =>
    (window as any).__t4Holder.core.revalidate("Catalog.Item")
  )
  await settle(page, 400)
}

const cases = [
  {
    brk: "asyncrender",
    kind: ["blank"],
    run: async (p: Page, o: any) => {
      await o.mark("scroll", { allow: ["scroll"] })
      await fastScroll(p)
    },
  },
  // Без якоря prepend віртуалізатор малює діапазон старого зсуву: видима
  // область порожня (`blank`) чи рядки стрибають (`scroll-rigid`).
  { brk: "noanchor", kind: ["scroll-rigid", "blank"], run: endThenUp },
  { brk: "highlight", kind: ["value-aba"], run: signal },
] as const

for (const c of cases) {
  test(`оракул вікна ловить: ${c.brk} → ${c.kind.join(" | ")}`, async ({
    page,
    oracle,
  }) => {
    test.setTimeout(120_000)
    await open(page, `?break=${c.brk}`)
    await c.run(page, oracle)
    const vs = await oracle.violations()
    expect(vs.some((v) => (c.kind as readonly string[]).includes(v.kind))).toBe(
      true
    )
  })
  test(`без поломки той самий сценарій чистий: ${c.brk}`, async ({
    page,
    oracle,
  }) => {
    test.setTimeout(120_000)
    await open(page, "")
    await c.run(page, oracle)
    const vs = await oracle.violations()
    expect(vs).toEqual([])
  })
}
