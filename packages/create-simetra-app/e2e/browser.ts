// Помічники браузерних сценаріїв D3 (Д3-1): кінцева умова — стан DOM і тіла
// відповідей `dataFn` з мережевого журналу Playwright, а не лічильники host-а
// (журнал з `#instrument` — #210).
import type { Browser, BrowserContext, Page } from "@playwright/test"
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

/**
 * Скільки запитів `dataFn` іде після гідратації списку об'єкта (шов #207): один
 * на `version` плюс по одному на видимий вигляд знімка (§8.1: `revalidate`
 * кожного). Видимі вигляди: сам список (над `full` ще й вигляд повного
 * набору) і по виглядові на кожен `include`, чиє посилання хоч в одному рядку
 * знімка не порожнє (порожніх посилань вигляд не читає). Знімок — HTML
 * відповіді SSR. Одна функція на всі сценарії: зміна числа виглядів правиться
 * тут.
 */
export function expectedHydrationRequests(
  objectRef: "Catalog.Client" | "Catalog.Country",
  residency: "window" | "full",
  snapshotHtml: string,
  orderBy?: OrderBy
): number {
  const entry = index.byRef.get(objectRef)
  if (entry === undefined) throw new Error(`no ${objectRef} in the catalog`)
  const includes = (listQuery(entry, { orderBy }).include ?? []).filter(
    (attribute) => new RegExp(`[{,]${attribute}:"`).test(snapshotHtml)
  )
  const views = 1 + (residency === "full" ? 1 : 0) + includes.length
  return 1 + views
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
