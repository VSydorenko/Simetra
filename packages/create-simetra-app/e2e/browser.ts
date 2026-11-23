// Помічники браузерних сценаріїв D3: кінцева умова — стан DOM і тіла
// відповідей `dataFn` з мережевого журналу Playwright, а не лічильники host-а
// (журнал з `#instrument` — #210).
import {
  expect,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test"
import { catalogIndex, clientCatalogSchema, type OrderBy } from "simetra/model"
import { listQuery } from "simetra/ui"
import clientCatalogJson from "../template/generated/client-catalog.json" with { type: "json" }
import type { App, TestUser } from "./fixtures"
import { send } from "./http"
import { decodeResponse } from "./serialization"

const catalog = clientCatalogSchema.parse(clientCatalogJson)
const index = catalogIndex(catalog.objects)

/** Контекст браузера з cookie сесії (рядок заголовка `Cookie`). */
export async function contextWithCookie(
  browser: Browser,
  app: App,
  cookie: string,
  options: { javaScriptEnabled?: boolean } = {}
): Promise<BrowserContext> {
  const context = await browser.newContext(options)
  await context.addCookies(
    cookie.split("; ").map((pair) => {
      const at = pair.indexOf("=")
      return {
        name: pair.slice(0, at),
        value: pair.slice(at + 1),
        url: app.origin,
      }
    })
  )
  return context
}

let freshAddress = 0

/**
 * Нова сесія користувача: сценарії, що виходять (7, 10), не вбивають сесію з
 * фікстури, якою користуються решта кейсів. Адреса сокета — окрема на виклик:
 * межа частоти входу рахує саме її.
 */
export async function freshSession(app: App, user: TestUser): Promise<string> {
  const reply = await send(app, {
    method: "POST",
    path: "/api/auth/sign-in/email",
    localAddress: `127.0.3.${(freshAddress += 1)}`,
    headers: { "content-type": "application/json", origin: app.origin },
    body: JSON.stringify({ email: user.email, password: user.password }),
  })
  if (reply.status !== 200)
    throw new Error(`sign-in answered ${reply.status}: ${reply.text}`)
  return reply.setCookie.map((c) => c.split(";")[0]).join("; ")
}

// -------------------------------------------------------------- журнал dataFn

export interface DataCall {
  subject: string
  /** Типи елементів запиту `read`: `version` чи `query`. */
  items: string[]
  /** Об'єкт (UUID) кожного елемента `query`. */
  objects: string[]
  status: number
  /** Тіло відповіді Server Function як текст: звідси читають значення. */
  text: string
  /** Розібрана відповідь; `undefined`, якщо тіло не JSON-значення Start. */
  result:
    { ok?: boolean; error?: { code?: string; reason?: string } } | undefined
}

/** Журнал запитів `dataFn` сторінки: кожен запит і його відповідь. */
export function watchDataFn(page: Page, app: App) {
  const calls: DataCall[] = []
  const pending: Array<Promise<void>> = []
  const path = `/_serverFn/${app.functionId("dataFn")}`
  page.on("response", (response) => {
    if (!response.url().endsWith(path)) return
    pending.push(
      (async () => {
        const request = response.request()
        const text = await response.text().catch(() => "")
        const body = JSON.parse(request.postData() ?? "{}") as { t?: unknown }
        const data = (
          decodeResponse(JSON.stringify(body.t)) as {
            data: {
              subject: string
              request: {
                items?: Array<{ type: string; query?: { object?: string } }>
              }
            }
          }
        ).data
        const items = data.request.items ?? []
        let result: DataCall["result"]
        try {
          result = (decodeResponse(text) as { result: DataCall["result"] })
            .result
        } catch {
          result = undefined
        }
        calls.push({
          subject: data.subject,
          items: items.map((item) => item.type),
          objects: items.flatMap((item) =>
            item.query?.object === undefined ? [] : [item.query.object]
          ),
          status: response.status(),
          text,
          result,
        })
      })()
    )
  })
  return {
    calls,
    /** Дочекатися розбору всіх відповідей, що вже прийшли. */
    async flush() {
      await Promise.all(pending)
    },
  }
}

/** Після гідратації: усі запити `dataFn` зроблено, далі тиша. */
export async function settle(
  page: Page,
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

/**
 * Скільки запитів `dataFn` іде після гідратації списку: один, хоч скільки
 * виглядів і `include` у знімку (§6.7, Р10) — збирач віддає частину
 * `version` і перечитування всіх видимих виглядів одним пакетом.
 */
export function expectedHydrationRequests(): number {
  return 1
}

/**
 * Objects whose `query` parts the single request after hydration must carry
 * (§6.7): the list object itself and, per `include`, the target object of
 * each reference that is not empty in at least one row of the snapshot (an
 * empty reference holds no target, so no held-target part exists). The
 * snapshot is the HTML of the SSR response. One function for every scenario:
 * a change of the views is fixed here, not in literals.
 */
export function expectedHydrationObjects(
  objectRef: "Catalog.Client" | "Catalog.Country",
  snapshotHtml: string,
  orderBy?: OrderBy
): string[] {
  const entry = index.byRef.get(objectRef)
  if (entry === undefined) throw new Error(`no ${objectRef} in the catalog`)
  const targets = (listQuery(entry, { orderBy }).include ?? [])
    .filter((attribute) => new RegExp(`[{,]${attribute}:"`).test(snapshotHtml))
    .map((attribute) => {
      const target = entry.attributes.find((a) => a.name === attribute)?.ref
      if (target === undefined)
        throw new Error(`include ${attribute} has no target object`)
      return target.object
    })
  return [...new Set([entry.id, ...targets])]
}

// ------------------------------------------------------------ запис кадрів

export interface Frame {
  path: string
  /** `textContent` рядків списку `[data-row-key]` у порядку DOM. */
  rows: string[]
  /** Ключі рядків списку. */
  keys: string[]
  /** Текст усієї сторінки: кожен кадр видно цілком, не лише список. */
  body: string
  hydrated: boolean
}

/**
 * Записувач стану DOM у кожному кадрі (`requestAnimationFrame`) чи, коли час
 * сторінки веде `page.clock` (який підміняє rAF), — після кожного пакета змін
 * DOM (`MutationObserver`, суворіше за кадр). Сусідні однакові стани зливаються.
 */
export async function recordFrames(
  page: Page,
  mode: "frame" | "mutation"
): Promise<void> {
  await page.addInitScript((recordMode) => {
    const frames: Array<{
      path: string
      rows: string[]
      keys: string[]
      body: string
      hydrated: boolean
    }> = []
    const sample = () => {
      const rowNodes = [...document.querySelectorAll("[data-row-key]")]
      const next = {
        path: location.pathname,
        rows: rowNodes.map((node) => node.textContent ?? ""),
        keys: rowNodes.map((node) => node.getAttribute("data-row-key") ?? ""),
        body: document.body?.textContent ?? "",
        hydrated: document.documentElement.hasAttribute("data-hydrated"),
      }
      const last = frames[frames.length - 1]
      if (last !== undefined && JSON.stringify(last) === JSON.stringify(next))
        return
      frames.push(next)
    }
    ;(window as unknown as { __frames: typeof frames }).__frames = frames
    if (recordMode === "frame") {
      const tick = () => {
        sample()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    } else {
      new MutationObserver(sample).observe(document, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      })
    }
  }, mode)
}

export function framesOf(page: Page): Promise<Frame[]> {
  return page.evaluate(
    () => (window as unknown as { __frames: Frame[] }).__frames
  )
}

/**
 * Кадри від першого з рядками (DOM, який віддав SSR): кадр без рядків після
 * цього — блимання, а не розбір HTML, тож відсіювати порожні не можна.
 */
export async function framesFromRows(page: Page): Promise<Frame[]> {
  const frames = await framesOf(page)
  const first = frames.findIndex((frame) => frame.rows.length > 0)
  if (first < 0) throw new Error("no frame with list rows was recorded")
  return frames.slice(first)
}

/** Рядки списку (текст) і ключі в поточному DOM. */
export function listRows(
  page: Page
): Promise<{ rows: string[]; keys: string[] }> {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[data-row-key]")]
    return {
      rows: nodes.map((node) => node.textContent ?? ""),
      keys: nodes.map((node) => node.getAttribute("data-row-key") ?? ""),
    }
  })
}

/** Сторінка списку без JavaScript: те, що сервер віддав у HTML. */
export async function serverRendered(
  browser: Browser,
  app: App,
  cookie: string,
  path: string
): Promise<{ rows: string[]; keys: string[] }> {
  const context = await contextWithCookie(browser, app, cookie, {
    javaScriptEnabled: false,
  })
  try {
    const page = await context.newPage()
    await page.goto(app.origin + path)
    return await listRows(page)
  } finally {
    await context.close()
  }
}
