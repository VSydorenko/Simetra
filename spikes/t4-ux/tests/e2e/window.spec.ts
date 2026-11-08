// Спайк 4: вікно на ~100 тис. рядків під TanStack Virtual. Сценарії 1–8
// брифу під посиленим оракулом (стилі, покриття видимої області, жорсткий
// рух під час прокрутки). Дані — фейковий сервер ядра (суб'єкт `-win`).
import type { Page } from "@playwright/test"
import { format } from "../oracle/rules"
import {
  control,
  expect,
  loginAs,
  settle,
  test,
  uniqueSubject,
} from "./harness"

const ROW_H = 36
const PAGE = 100

type Win = {
  atStart: boolean
  atEnd: boolean
  chain: number
  pages: { tier: string; count: number }[]
}

const SPEC = (order: string) => ({
  kind: "window",
  object: "Catalog.Item",
  orderBy:
    order === "name"
      ? [{ attribute: "name", direction: "asc" }]
      : [{ attribute: "num", direction: "asc" }],
  pageSize: PAGE,
})

async function openWindow(page: Page, query = "") {
  await loginAs(page, uniqueSubject("alice-win"))
  await page.goto(`/window${query}`)
  await page.waitForFunction(() => (window as any).__t4Hydrated)
  await page.waitForSelector("[data-region=list] [data-row-key]")
}

/** Стан вікна з ядра сторінки. */
async function win(page: Page, order = "num"): Promise<Win> {
  return page.evaluate(
    (spec) => (window as any).__t4Holder.core.view(spec).getSnapshot().window,
    SPEC(order)
  )
}

async function keys(page: Page, order = "num"): Promise<string[]> {
  return page.evaluate(
    (spec) =>
      (window as any).__t4Holder.core
        .view(spec)
        .getSnapshot()
        .rows.map((r: { key: string }) => r.key),
    SPEC(order)
  )
}

const frame = (page: Page) =>
  page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => r()))
  )

/** Значення `num` першого видимого рядка. */
const firstVisibleNum = (page: Page) =>
  page.$$eval("[data-row-key]", (els) => {
    const port = document
      .querySelector("[data-scroll=list]")!
      .getBoundingClientRect()
    const e = els.find((x) => x.getBoundingClientRect().bottom > port.top + 1)
    return Number(e?.querySelector("[data-field=num]")?.textContent ?? 0)
  })

const scrollTop = (page: Page) =>
  page.$eval("[data-scroll=list]", (e) => e.scrollTop)

/** Прокрутка колесом (як користувач) кроками `dy`, поки не `done`. */
async function wheelUntil(
  page: Page,
  dy: number,
  done: (top: number) => boolean,
  max = 4000
) {
  const box = (await page.locator("[data-scroll=list]").boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < max; i++) {
    const top = await scrollTop(page)
    if (done(top)) return
    await page.mouse.wheel(0, dy)
    await frame(page)
  }
  throw new Error(`scroll did not finish at ${await scrollTop(page)}`)
}

async function expectClean(
  oracle: { violations(): Promise<unknown[]> },
  opts: { allowHydrationMutation?: boolean } = {}
) {
  let vs = (await oracle.violations()) as Parameters<typeof format>[0]
  // Змінна висота + SSR: сервер не знає висот, тож після гідратації вимір
  // змінює невидиме (висоту прокрутки, рядки запасу). Видиме стереже решта
  // правил сегмента 0 (shift, height, empty, blank) — вони лишаються.
  if (opts.allowHydrationMutation)
    vs = vs.filter((v) => v.kind !== "hydration-mutation")
  expect(vs, format(vs)).toEqual([])
}

test.describe("спайк 4 — вікно", () => {
  test.setTimeout(180_000)
  test("1. 50 сторінок вниз і назад без вивантаження", async ({
    page,
    oracle,
  }) => {
    await openWindow(page, "?margin=1000")
    await oracle.mark("scroll", { allow: ["scroll"] })
    const far = 50 * PAGE * ROW_H
    await wheelUntil(page, 1200, (t) => t >= far)
    await wheelUntil(page, -1200, (t) => t === 0)
    await settle(page, 300)
    const w = await win(page)
    expect(w.pages.length).toBeGreaterThanOrEqual(50)
    expect(w.pages.every((p) => p.tier === "resident")).toBe(true)
    await expectClean(oracle)
  })

  test("2. те саме з вивантаженням: сторінки 1–40 стають знімками", async ({
    page,
    oracle,
  }) => {
    await openWindow(page, "?margin=2&unload=0")
    await oracle.mark("scroll", { allow: ["scroll"] })
    await wheelUntil(page, 1200, (t) => t >= 50 * PAGE * ROW_H)
    await settle(page, 300)
    const down = await win(page)
    expect(down.pages.slice(0, 40).every((p) => p.tier === "ghost")).toBe(true)
    expect(
      down.pages.filter((p) => p.tier === "resident").length
    ).toBeLessThanOrEqual(6)
    await wheelUntil(page, -1200, (t) => t === 0)
    await settle(page, 500)
    const up = await win(page)
    expect(up.pages[0]!.tier).toBe("resident")
    await expectClean(oracle)
  })

  test("2б. межа знімків відкидає далекі сторінки з місцем: повернення дочитує край без стрибка", async ({
    page,
    oracle,
  }) => {
    await openWindow(page, "?margin=2&unload=0&ghostKb=600")
    const first = (await keys(page))[0]
    await oracle.mark("scroll", { allow: ["scroll"] })
    // Прогрес — за рядками: відкидання передніх сторінок з місцем тримає
    // scrollTop сталим (якір), тож він прогресу не показує.
    for (
      let i = 0;
      i < 1500 && (await firstVisibleNum(page)) < 30 * PAGE * 10;
      i++
    ) {
      await wheelUntil(page, 1200, () => true).catch(() => {})
      await page.mouse.wheel(0, 1200)
      await frame(page)
    }
    expect(await firstVisibleNum(page)).toBeGreaterThanOrEqual(30 * PAGE * 10)
    await settle(page, 300)
    expect((await win(page)).atStart).toBe(false)
    for (
      let i = 0;
      i < 3000 && !((await win(page)).atStart && (await scrollTop(page)) === 0);
      i++
    ) {
      await page.mouse.wheel(0, -1200)
      await frame(page)
    }
    await settle(page, 500)
    expect((await keys(page))[0]).toBe(first)
    expect(await scrollTop(page)).toBe(0)
    await expectClean(oracle)
  })

  test("3. goToEnd, прокрутка вгору (prepend з якорем) і goToStart", async ({
    page,
    oracle,
  }) => {
    await openWindow(page)
    await oracle.mark("end", { allow: ["reorder", "shift", "scroll"] })
    await page.click("[data-action=end]")
    await page.waitForFunction((spec) => {
      const w = (window as any).__t4Holder.core.view(spec).getSnapshot().window
      return w.atEnd && !w.atStart && w.target === "end"
    }, SPEC("num"))
    await settle(page, 200)
    const atBottom = await page.$eval(
      "[data-scroll=list]",
      (e) => e.scrollTop + e.clientHeight >= e.scrollHeight - 1
    )
    expect(atBottom).toBe(true)
    await expect(page.locator("[data-field=num]").last()).toHaveText("1000000")
    await oracle.mark("scroll-up", { allow: ["scroll"] })
    await wheelUntil(page, -600, (t) => t < 50, 3000).catch(() => {})
    // Догрузка вгору: щонайменше 5 сторінок перед кінцем.
    for (let i = 0; i < 400 && (await win(page)).pages.length < 6; i++) {
      await page.mouse.wheel(0, -600)
      await frame(page)
    }
    await settle(page, 300)
    expect((await win(page)).pages.length).toBeGreaterThanOrEqual(6)
    await oracle.mark("start", { allow: ["reorder", "shift", "scroll"] })
    await page.click("[data-action=start]")
    await page.waitForFunction((spec) => {
      const w = (window as any).__t4Holder.core.view(spec).getSnapshot().window
      return w.atStart && w.target === "start"
    }, SPEC("num"))
    await settle(page, 200)
    expect(await scrollTop(page)).toBe(0)
    await expect(page.locator("[data-field=num]").first()).toHaveText("10")
    await expectClean(oracle)
  })

  test("4. зміна сортування: новий ланцюжок і прокрутка на початок одним кадром", async ({
    page,
    oracle,
  }) => {
    await openWindow(page)
    await oracle.mark("scroll", { allow: ["scroll"] })
    await wheelUntil(page, 1200, (t) => t >= 5 * PAGE * ROW_H)
    await settle(page, 300)
    await oracle.mark("sort", { allow: ["reorder", "shift", "scroll"] })
    await page.click("[data-action=order-name]")
    await page.waitForURL(/order=name/)
    await page.waitForFunction(
      () =>
        document.querySelector("[data-scroll=list]")!.scrollTop === 0 &&
        document.querySelector("[data-field=name]")!.textContent ===
          "Alpha item 1"
    )
    await settle(page, 300)
    const newFirst = (await keys(page, "name"))[0]!
    const log = await oracle.log()
    const seg = log.marks.length
    // Кожен стан сегмента: або старий ланцюжок на старій прокрутці, або
    // новий (видно його перший рядок) — на нулі. Інше — проміжний кадр.
    let sawNew = false
    for (const s of log.snaps.filter((x) => x.seg === seg)) {
      const r = s.regions.find((x) => x.name === "list")!
      expect(r.rows.length, `snap ${s.i}`).toBeGreaterThan(0)
      const isNew = r.rows.some((x) => x.vis && x.key === newFirst)
      if (isNew) {
        sawNew = true
        expect(r.scrollTop, `snap ${s.i}`).toBe(0)
      } else {
        expect(sawNew, `old chain after new, snap ${s.i}`).toBe(false)
        expect(r.scrollTop, `old chain at 0, snap ${s.i}`).not.toBe(0)
      }
    }
    expect(sawNew).toBe(true)
    await expectClean(oracle)
  })

  test("5. сигнал: змінено, видалено, новий рядок — без зсуву", async ({
    page,
    oracle,
  }) => {
    await openWindow(page)
    await oracle.mark("scroll", { allow: ["scroll"] })
    await wheelUntil(page, 1200, (t) => t >= 3 * PAGE * ROW_H)
    await settle(page, 300)
    const visible = await page.$$eval("[data-row-key]", (els) => {
      const port = document
        .querySelector("[data-scroll=list]")!
        .getBoundingClientRect()
      return els
        .filter((e) => {
          const r = e.getBoundingClientRect()
          return r.top >= port.top && r.bottom <= port.bottom
        })
        .map((e) => e.getAttribute("data-row-key")!)
    })
    const [edited, removed] = [visible[2]!, visible[4]!]
    await oracle.mark("signal")
    // Поле сортування змінено: рядок лишається на місці, `needsRefresh`.
    await control(page, {
      kind: "edit",
      id: edited,
      values: { num: -5, name: "Edited by other" },
    })
    await control(page, { kind: "remove", id: removed })
    await control(page, {
      kind: "insert",
      id: "00000000-0000-4000-8000-0000000fffff",
      values: {
        num: 3005,
        name: "Inserted by other",
        amount: "1.00",
        status: "open",
      },
    })
    await page.evaluate(async () => {
      const core = (window as any).__t4Holder.core
      await core.revalidate("Catalog.Item")
      core.commit(
        (w: any) => w.markViews("Catalog.Item", { hasNewRows: true }),
        core.token()
      )
    })
    await settle(page, 300)
    await expect(
      page.locator(`[data-row-key="${edited}"] [data-field=name]`)
    ).toHaveText("Edited by other")
    await expect(
      page.locator(`[data-row-key="${removed}"] [data-state]`)
    ).toHaveAttribute("data-state", "removed")
    await expect(page.locator("[data-action=show-new]")).toBeVisible()
    await expectClean(oracle)
  })

  test("6. оновлення сторінки посередині: рядки між сторінками не губляться", async ({
    page,
    oracle,
  }) => {
    await openWindow(page, "?margin=3")
    await oracle.mark("scroll", { allow: ["scroll"] })
    await wheelUntil(page, 1200, (t) => t >= 5 * PAGE * ROW_H)
    await settle(page, 400)
    // На межах сторінок (n=500|501, 600|601) — нові рядки; один видалено.
    const ins = [
      { id: "00000000-0000-4000-8000-0000000ff001", num: 5005 },
      { id: "00000000-0000-4000-8000-0000000ff002", num: 6005 },
    ]
    for (const r of ins)
      await control(page, {
        kind: "insert",
        id: r.id,
        values: {
          num: r.num,
          name: `Boundary ${r.num}`,
          amount: "1.00",
          status: "open",
        },
      })
    await oracle.mark("refresh", { allow: ["shift"] })
    await page.click("[data-action=refresh]")
    await page.waitForFunction(
      (spec) =>
        (window as any).__t4Holder.core.view(spec).getSnapshot().status ===
        "ready",
      SPEC("num")
    )
    await settle(page, 300)
    const shown = await page.evaluate(
      (spec) =>
        (window as any).__t4Holder.core
          .view(spec)
          .getSnapshot()
          .rows.map((r: any) => r.values.num as number),
      SPEC("num")
    )
    for (const r of ins) expect(shown).toContain(r.num)
    const sorted = [...shown].sort((a, b) => a - b)
    expect(shown).toEqual(sorted)
    // Суцільно: між сусідами — лише крок 10 або вставлений рядок.
    for (let i = 1; i < shown.length; i++)
      expect(shown[i]! - shown[i - 1]!, `at ${shown[i]}`).toBeLessThanOrEqual(
        10
      )
    await expectClean(oracle)
  })

  test("7. SSR: перший кадр = HTML, після гідратації без зсуву й без запиту", async ({
    page,
    oracle,
  }) => {
    await loginAs(page, uniqueSubject("alice-win"))
    await page.goto("/window")
    await page.waitForFunction(() => (window as any).__t4Hydrated)
    await settle(page, 800)
    // Журнал серверних функцій клієнта: у production-збірці URL непрозорі.
    // Після гідратації — лише звірка `getVersion`, жодного читання даних.
    const calls = await page.evaluate(() =>
      ((window as any).__t4Fns ?? []).map((f: { name: string }) => f.name)
    )
    expect(calls.filter((n: string) => n !== "getVersion")).toEqual([])
    const log = await oracle.log()
    expect(log.appMutationsAfterParse).toEqual([])
    const r = await oracle.regionUpdatesAfterHydration("rows")
    expect(r.updates).toBe(0)
    await expectClean(oracle)
  })

  test("8. змінна висота: ліниве поле в зарезервованому місці, ріст рядка над видимими — якір", async ({
    page,
    oracle,
  }) => {
    await openWindow(page, "?h=var")
    await oracle.mark("scroll", { allow: ["scroll"] })
    await wheelUntil(page, 600, (t) => t >= 20 * 58)
    await settle(page, 300)
    await oracle.mark("lazy")
    await page.click("[data-action=lazy]")
    await page.waitForFunction(() =>
      [...document.querySelectorAll("[data-row-key] [data-field=note]")].some(
        (n) => n.textContent !== "…"
      )
    )
    await settle(page, 300)
    // Рядок над видимою областю (у запасі віртуалізатора) росте сигналом.
    const above = await page.$$eval("[data-row-key]", (els) => {
      const port = document
        .querySelector("[data-scroll=list]")!
        .getBoundingClientRect()
      return els
        .filter((e) => e.getBoundingClientRect().bottom <= port.top)
        .map((e) => e.getAttribute("data-row-key")!)
    })
    expect(above.length).toBeGreaterThan(0)
    await oracle.mark("grow-above")
    await control(page, {
      kind: "edit",
      id: above[above.length - 1]!,
      values: { name: "Grown " + "very long words ".repeat(30) },
    })
    await page.evaluate(() =>
      (window as any).__t4Holder.core.revalidate("Catalog.Item")
    )
    await settle(page, 400)
    // Кінець списку зі змінною висотою: оцінки виправляються вимірами.
    await oracle.mark("end", { allow: ["reorder", "shift", "scroll"] })
    await page.click("[data-action=end]")
    await settle(page, 600)
    await oracle.mark("scroll-up", { allow: ["scroll"] })
    for (let i = 0; i < 60; i++) {
      await page.mouse.wheel(0, -400)
      await frame(page)
    }
    await settle(page, 400)
    const hyd = (await oracle.log()).appMutationsAfterParse
    console.log(
      `var SSR: мутацій після гідратації ${hyd.length}: ${[...new Set(hyd.map((m) => `${m.type} ${m.target}${m.attr ? "@" + m.attr : ""}`))].join("; ")}`
    )
    await expectClean(oracle, { allowHydrationMutation: true })
  })
})
