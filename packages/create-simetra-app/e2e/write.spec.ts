// Запис у картці Client (сценарії 4–6 спеки П4-D §8.1) на production-збірці.
// Кінцева умова (Д3-1) — стан DOM і тіла відповідей `dataFn` з мережевого
// журналу Playwright. Кадри пише `requestAnimationFrame`, тож `page.clock` тут
// не вживається: він підміняє rAF і оракул кадрів нічого б не бачив.
// Суб'єкт у браузері — B (рядки за правом `own`); зміну «другого автора» робить
// інший сеанс того самого суб'єкта через `app.runtimeB`.
import type { Page } from "@playwright/test"
import { contextWithCookie, watchDataFn } from "./browser"
import { decodeResponse, encodePayload } from "./serialization"
import { test, expect, type App } from "./fixtures"

const OBJECT = { kind: "Catalog", name: "Client" } as const
const SAVE = /Save|Зберегти/
const TAKE_SERVER = /Take server version|Взяти серверне/

/** Стан картки в одному кадрі: усе, чим картка могла б блимнути. */
interface CardFrame {
  /** Значення поля шапки, яке бачить користувач; `null` — поля в кадрі немає. */
  value: string | null
  /** Серверне значення поруч із правкою (`conflict`); `null` — його немає. */
  server: string | null
  /** Стан чернетки (`data-draft`). */
  draft: string | null
  /** Код відмови біля поля (`data-field-error`). */
  fieldError: string | null
}

/**
 * Записувач кадрів картки: стан на кожен `requestAnimationFrame`, сусідні
 * однакові кадри зливаються. `[data-server] [data-field]` виключено: у
 * `conflict` поле повторюється в серверному рядку.
 */
async function recordCardFrames(
  page: Page,
  field: string,
  errorSlot = field
): Promise<void> {
  await page.addInitScript(
    ([name, slot]) => {
      const frames: CardFrame[] = []
      const text = (selector: string) =>
        document.querySelector(selector)?.textContent ?? null
      const sample = () => {
        // Редактор (`input`) або показ (`span`, поки запис іде й поле не
        // редагується): значення, яке бачить користувач, у обох випадках
        const input = document.querySelector<HTMLElement>(
          `[data-field="${name}"]:not([data-server] [data-field])`
        )
        const next: CardFrame = {
          value:
            input === null
              ? null
              : input instanceof HTMLInputElement
                ? input.value
                : input.textContent,
          server: text(`[data-server="${name}"]`),
          draft:
            document
              .querySelector("[data-region=card]")
              ?.getAttribute("data-draft") ?? null,
          fieldError:
            document
              .querySelector(`[data-field-slot="${slot}"] [data-field-error]`)
              ?.getAttribute("data-field-error") ?? null,
        }
        const last = frames[frames.length - 1]
        if (last === undefined || JSON.stringify(last) !== JSON.stringify(next))
          frames.push(next)
      }
      ;(window as unknown as { __cardFrames: CardFrame[] }).__cardFrames =
        frames
      const tick = () => {
        sample()
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    [field, errorSlot] as const
  )
}

const cardFrames = (page: Page): Promise<CardFrame[]> =>
  page.evaluate(
    () => (window as unknown as { __cardFrames: CardFrame[] }).__cardFrames
  )

/** Кадри від останнього кадру, що вже був до дії (він показує її початок). */
async function framesSince(page: Page, before: number): Promise<CardFrame[]> {
  return (await cardFrames(page)).slice(Math.max(before - 1, 0))
}

const editor = (page: Page, field: string) =>
  page.locator(`input[data-field="${field}"]:not([data-server] [data-field])`)

/** Рядок B за описом: id і версія для зовнішньої зміни. */
async function rowOfB(app: App, description: string) {
  const { runtime, claims } = app.runtimeB
  const own = await runtime.read(claims, { object: OBJECT, limit: 50 })
  const row = own.rows.find((r) => r.description === description)
  if (row === undefined) throw new Error(`B has no row "${description}"`)
  return { id: String(row.ref), version: Number(row.version) }
}

/** Картка рядка в чистому контексті B: SSR, гідратація, значення в редакторі. */
async function openCard(
  app: App,
  browser: import("@playwright/test").Browser,
  id: string,
  expected: string,
  errorSlot = "description"
) {
  const context = await contextWithCookie(browser, app, app.users.b.cookie)
  const page = await context.newPage()
  await recordCardFrames(page, "description", errorSlot)
  const log = watchDataFn(page, app)
  await page.goto(`${app.origin}/clients/${id}`)
  await page.waitForSelector("html[data-hydrated]")
  await expect(editor(page, "description")).toHaveValue(expected)
  return { context, page, log }
}

test.describe("scenario 4: awaited save of a header field", () => {
  test("no frame between the click and the response shows the old value", async ({
    app,
    browser,
  }) => {
    const OLD = "B-only 2"
    const NEW = "B-only 2 saved"
    const { id } = await rowOfB(app, OLD)
    const { context, page, log } = await openCard(app, browser, id, OLD)
    try {
      await editor(page, "description").fill(NEW)
      const save = page.getByRole("button", { name: SAVE })
      await expect(save).toBeEnabled()
      // Мітка — після кадру з правкою: інакше «до кліку» ще показує старе
      await expect
        .poll(async () => (await cardFrames(page)).at(-1)?.value)
        .toBe(NEW)
      await log.flush()
      const sent = log.calls.length
      const before = (await cardFrames(page)).length
      await save.click()
      await expect
        .poll(async () => (await cardFrames(page)).at(-1)?.draft)
        .toBe("idle")
      await expect
        .poll(
          async () => (
            await log.flush(),
            log.calls.slice(sent).filter((c) => c.text.includes(NEW)).length
          )
        )
        .toBeGreaterThan(0)
      // Запас кадрів: пізнє блимання старим після відповіді теж помітне
      await page.waitForTimeout(500)

      const frames = await framesSince(page, before)
      expect(frames.length).toBeGreaterThan(0)
      for (const frame of frames) {
        expect(frame.value).toBe(NEW)
        expect(frame.fieldError).toBeNull()
        expect(frame.server).toBeNull()
      }
      expect(frames.at(-1)?.draft).toBe("idle")
      // Відповідь сервера: запис пройшов
      await log.flush()
      const writes = log.calls.slice(sent).filter((c) => !c.items.length)
      expect(
        log.calls.slice(sent).every((c) => c.result?.ok === true),
        JSON.stringify({ writes, calls: log.calls.slice(sent) })
      ).toBe(true)
      const [row] = await app.query<{ description: string }>(
        "SELECT description FROM app.client WHERE id = $1",
        [id]
      )
      expect(row?.description).toBe(NEW)
    } finally {
      await context.close()
      await app.query("UPDATE app.client SET description = $1 WHERE id = $2", [
        OLD,
        id,
      ])
    }
  })
})

test.describe("scenario 5: save conflicts with another session's change", () => {
  test("edits stay; take-server resets them in one frame", async ({
    app,
    browser,
  }) => {
    const ORIGINAL = "B-only 0"
    const EDIT = "B-only 0 local edit"
    const SERVER = "B-only 0 by other session"
    const { id, version } = await rowOfB(app, ORIGINAL)
    const { context, page, log } = await openCard(app, browser, id, ORIGINAL)
    try {
      await editor(page, "description").fill(EDIT)
      // Другий сеанс того самого суб'єкта міняє картку до збереження
      await app.runtimeB.runtime.run(app.runtimeB.claims, {
        action: "update",
        object: OBJECT,
        id,
        expectedVersion: version,
        values: { description: SERVER },
      })
      await log.flush()
      const sent = log.calls.length
      await page.getByRole("button", { name: SAVE }).click()
      await expect(page.locator("[data-region=card]")).toHaveAttribute(
        "data-draft",
        "conflict"
      )
      // Серверний рядок прочитано: поруч із правкою
      await expect(page.locator('[data-server="description"]')).toHaveText(
        SERVER
      )
      await log.flush()
      expect(
        log.calls
          .slice(sent)
          .some((c) => c.result?.error?.code === "command.conflict"),
        JSON.stringify(log.calls.slice(sent).map((c) => c.text))
      ).toBe(true)
      // Правки лишаються
      await expect(editor(page, "description")).toHaveValue(EDIT)
      // Кадр записується з відставанням на один rAF: чекаємо його, а не читаємо одразу
      await expect
        .poll(async () => (await cardFrames(page)).at(-1))
        .toEqual({
          value: EDIT,
          server: SERVER,
          draft: "conflict",
          fieldError: null,
        })

      const take = page.getByRole("button", { name: TAKE_SERVER })
      await expect(take).toBeEnabled()
      const before = (await cardFrames(page)).length
      await take.click()
      await expect(editor(page, "description")).toHaveValue(SERVER)
      await page.waitForTimeout(500)

      // Одним кадром: від кадру конфлікту одразу до скинутого стану
      const frames = await framesSince(page, before)
      expect(frames).toEqual([
        { value: EDIT, server: SERVER, draft: "conflict", fieldError: null },
        { value: SERVER, server: null, draft: "idle", fieldError: null },
      ])
      // Скидання не пише: серверне значення в базі не змінилося
      const [row] = await app.query<{ description: string }>(
        "SELECT description FROM app.client WHERE id = $1",
        [id]
      )
      expect(row?.description).toBe(SERVER)
    } finally {
      await context.close()
      await app.query("UPDATE app.client SET description = $1 WHERE id = $2", [
        ORIGINAL,
        id,
      ])
    }
  })
})

// Сценарій 6. Редактор картки кличе той самий кодек T0, що й сервер, тож з UI
// не ввести значення, яке відкидає лише сервер: `Ref` у шапці не редагується, а
// `code`/`description` кодек відсікає ще до запиту. Тому в запиті збереження
// `page.route` підміняє `country` на неіснуючий UUID, а відмову дає справжнє
// зовнішнє обмеження бази. Що підміна справді подіяла, доводить відповідь у
// журналі: `command.invalid` з `path: "country_id"` — колонка проводу, яку картка кладе біля поля `country` (позитивний контроль).
test.describe("scenario 6: server refusal command.invalid with a path", () => {
  test("edits stay, the code stands beside the field, no extra requests", async ({
    app,
    browser,
  }) => {
    const OLD = "B-only 2"
    const EDIT = "B-only 2 refused"
    const { id } = await rowOfB(app, OLD)
    const { context, page, log } = await openCard(
      app,
      browser,
      id,
      OLD,
      "country"
    )
    try {
      let rewritten = 0
      await page.route(
        `**/_serverFn/${app.functionId("dataFn")}`,
        async (route) => {
          const body = JSON.parse(route.request().postData() ?? "{}") as {
            t: unknown
          }
          const { data } = decodeResponse(JSON.stringify(body.t)) as {
            data: {
              request: { type: string; operation?: { values?: object } }
            }
          }
          if (data.request.type !== "run") return route.continue()
          rewritten += 1
          data.request.operation!.values = {
            ...data.request.operation!.values,
            // Провід несе колонки таблиці: `country` — колонка `country_id`
            country_id: "00000000-0000-4000-8000-000000000000",
          }
          await route.continue({ postData: encodePayload(data) })
        }
      )
      await editor(page, "description").fill(EDIT)
      await expect
        .poll(async () => (await cardFrames(page)).at(-1)?.value)
        .toBe(EDIT)
      await log.flush()
      const sent = log.calls.length
      const before = (await cardFrames(page)).length
      await page.getByRole("button", { name: SAVE }).click()
      await expect
        .poll(async () => (await cardFrames(page)).at(-1)?.draft)
        .toBe("failed")
      await expect
        .poll(async () => (await cardFrames(page)).at(-1)?.fieldError)
        .toBe("command.invalid")
      await page.waitForTimeout(500)

      // Позитивний контроль: підміна дійшла, сервер відмовив саме за `country`
      await log.flush()
      const calls = log.calls.slice(sent)
      expect(rewritten).toBe(1)
      expect(calls).toHaveLength(1)
      const refusal = (
        decodeResponse(calls[0]!.text) as {
          result: { ok: boolean; error?: { code: string; path?: string } }
        }
      ).result
      expect(refusal.ok).toBe(false)
      expect(refusal.error).toMatchObject({
        code: "command.invalid",
        path: "country_id",
      })

      // Правки лишаються в кожному кадрі після кліку, код — біля `country`
      const frames = await framesSince(page, before)
      for (const frame of frames) expect(frame.value).toBe(EDIT)
      expect(frames.at(-1)).toMatchObject({
        draft: "failed",
        fieldError: "command.invalid",
      })
      await expect(
        page.locator('[data-field-slot="country"] [data-field-error]')
      ).toHaveAttribute("data-field-error", "command.invalid")
      await expect(editor(page, "description")).toHaveValue(EDIT)
      const [row] = await app.query<{ description: string }>(
        "SELECT description FROM app.client WHERE id = $1",
        [id]
      )
      expect(row?.description).toBe(OLD)
    } finally {
      await context.close()
      await app.query("UPDATE app.client SET description = $1 WHERE id = $2", [
        OLD,
        id,
      ])
    }
  })
})
