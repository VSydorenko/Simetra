// Сценарії оракула як функції: їх женуть і зелені тести, і тести самого
// оракула на зламаних реалізаціях (`?break=`).
import type { Page } from '@playwright/test'
import { control, expect, loginAs, type Oracle, settle, trackServerFns, uniqueSubject } from './harness'

const ROW = '[data-region=list] [data-row-key]'
const rowKey = (page: Page, n: number) => page.locator(ROW).nth(n).getAttribute('data-row-key') as Promise<string>
const listRow = (page: Page, key: string) => page.locator(`[data-region=list] [data-row-key="${key}"]`)

export async function openList(page: Page, opts: { breaks?: string; subject?: string } = {}) {
  const subject = opts.subject ?? uniqueSubject()
  await loginAs(page, subject)
  await page.goto(opts.breaks ? `/?break=${opts.breaks}` : '/')
  await page.waitForFunction(() => (window as any).__t4Commits?.some((c: any) => c.id === 'list'))
  await settle(page, 200)
  return subject
}

/** Сценарій 1: SSR-вхід. Повертає HTML і запити після гідратації. */
export async function ssrEntry(page: Page, oracle: Oracle, breaks?: string) {
  await loginAs(page, uniqueSubject())
  const fns = trackServerFns(page)
  const resp = await page.goto(breaks ? `/?break=${breaks}` : '/')
  const html = await resp!.text()
  await page.waitForFunction(() => (window as any).__t4Commits?.some((c: any) => c.id === 'list'))
  await settle(page, 1500)
  return { html, requests: fns.data(), calls: fns.calls, commits: await oracle.regionUpdatesAfterHydration('list') }
}

/** Сценарій 2: список → картка → список (клієнтська навігація). */
export async function listCardList(page: Page, oracle: Oracle, opts: { breaks?: string } = {}) {
  await openList(page, opts)
  await control(page, { kind: 'latency', readMs: 300 })
  const key = await rowKey(page, 3)
  const name = await listRow(page, key).locator('[data-field=name]').textContent()
  const fns = trackServerFns(page)
  await oracle.mark('to-card', { allow: ['shift'] })
  await listRow(page, key).locator('[data-field=name]').click()
  await page.waitForSelector('[data-region=card]')
  // Картка з рядка сховища одразу — до відповіді сервера (затримка 300 мс).
  const log = await oracle.log()
  const firstCard = log.snaps.find((s) => s.regions.some((r) => r.name === 'card'))!
  const card = firstCard.regions.find((r) => r.name === 'card')!
  expect(card.rows[0]?.fields.name).toBe(name)
  await page.waitForFunction(() => (document.querySelector('[data-field=note]')?.textContent ?? '').length > 0)
  await settle(page, 200)
  const before = fns.reads().length
  await oracle.mark('to-list', { allow: ['shift'] })
  await page.click('[data-action=back]')
  await page.waitForSelector(ROW)
  await settle(page, 400)
  expect(fns.reads().length, 'повернення до списку без запиту').toBe(before)
  return { key }
}

async function openCard(page: Page, oracle: Oracle, opts: { breaks?: string } = {}) {
  await openList(page, opts)
  const key = await rowKey(page, 2)
  await oracle.mark('to-card', { allow: ['shift'] })
  await listRow(page, key).locator('[data-field=name]').click()
  await page.waitForSelector('[data-region=card] input[data-field=name]')
  await page.waitForFunction(() => (document.querySelector('[data-field=note]')?.textContent ?? '').length > 0)
  await settle(page, 200)
  return key
}

/** Сценарій 3: правка поля — оптимістичне значення, підтвердження змінює лише стан. */
export async function editField(page: Page, oracle: Oracle, opts: { breaks?: string } = {}) {
  await openCard(page, oracle, opts)
  await control(page, { kind: 'latency', writeMs: 300 })
  await oracle.mark('edit')
  await page.fill('[data-region=card] input[data-field=name]', 'Edited name')
  await page.press('[data-region=card] input[data-field=name]', 'Enter')
  await expect(page.locator('[data-region=card] [data-state]').first()).toHaveAttribute('data-state', 'pending')
  await expect(page.locator('[data-region=card] [data-state]').first()).toHaveAttribute('data-state', 'synced', { timeout: 3000 })
  await settle(page, 200)
  await expect(page.locator('[data-region=card] input[data-field=name]')).toHaveValue('Edited name')
}

/** Сценарій 4: відмова правки — значення лишається з `failed`; «скасувати» повертає старе одним кадром. */
export async function rejectEdit(page: Page, oracle: Oracle, opts: { breaks?: string } = {}) {
  await openCard(page, oracle, opts)
  const input = page.locator('[data-region=card] input[data-field=name]')
  const original = await input.inputValue()
  await control(page, { kind: 'latency', writeMs: 200 })
  await control(page, { kind: 'failNext', code: 'command.forbidden' })
  await oracle.mark('edit')
  await input.fill('Rejected name')
  await input.press('Enter')
  await expect(page.locator('[data-region=card] [data-state]').first()).toHaveAttribute('data-state', 'failed', { timeout: 3000 })
  await settle(page, 300)
  await expect(input).toHaveValue('Rejected name')
  await oracle.mark('cancel')
  await page.click('[data-region=card] [data-action=cancel]')
  await expect(input).toHaveValue(original)
  await settle(page, 200)
  const log = await oracle.log()
  const values = log.snaps.filter((s) => s.seg === log.marks.length).map((s) => s.regions.find((r) => r.name === 'card')?.rows[0]?.fields.name)
  // Після «скасувати» — жодного проміжного значення: лише старе (або ще відхилене до кадру скасування).
  expect(values.every((v) => v === 'Rejected name' || v === original)).toBe(true)
  expect(values.at(-1)).toBe(original)
}

/** Сценарій 5: створення — рядок з'являється один раз зверху й не стрибає після підтвердження. */
export async function createRow(page: Page, oracle: Oracle, opts: { breaks?: string } = {}) {
  await openList(page, opts)
  await control(page, { kind: 'latency', writeMs: 300 })
  await oracle.mark('create', { allow: ['shift-once'] })
  await page.click('[data-action=create]')
  const created = page.locator(ROW).first()
  await expect(created.locator('[data-field=name]')).toHaveText('New item')
  await expect(created.locator('[data-state]')).toHaveAttribute('data-state', 'pending')
  const key = await created.getAttribute('data-row-key')
  await expect(created.locator('[data-state]')).toHaveAttribute('data-state', 'synced', { timeout: 3000 })
  await settle(page, 300)
  expect(await page.locator(ROW).first().getAttribute('data-row-key')).toBe(key)
}

/** Сигнал спайку 3 (імітація): позначки виглядів через Writer ядра. */
async function signal(page: Page, flags: { hasNewRows?: boolean; needsRefresh?: boolean }) {
  await page.evaluate((fl) => {
    const core = (window as any).__t4Holder.core
    core.commit((w: any) => w.markViews('Catalog.Item', fl), core.token())
  }, flags)
}

/** Сценарій 6: фонове перечитування — рядки на місці, нові лише через hasNewRows, видалені — `removed`. */
export async function backgroundRefresh(page: Page, oracle: Oracle, opts: { breaks?: string } = {}) {
  await openList(page, opts)
  const k1 = await rowKey(page, 1)
  const k4 = await rowKey(page, 4)
  await control(page, { kind: 'edit', id: k1, values: { name: 'Changed by other' } })
  await control(page, { kind: 'insert', id: '00000000-0000-4000-9000-000000000015', values: { num: 15, name: 'Inserted by other', amount: '0.00', status: 'open' } })
  await control(page, { kind: 'remove', id: k4 })
  await control(page, { kind: 'latency', readMs: 300 })
  await oracle.mark('signal+reread')
  await signal(page, { hasNewRows: true })
  await page.click('[data-action=reread]')
  await expect(listRow(page, k1).locator('[data-field=name]')).toHaveText('Changed by other', { timeout: 3000 })
  await expect(page.locator('[data-action=show-new]')).toBeVisible()
  await expect(listRow(page, k4).locator('[data-state]')).toHaveAttribute('data-state', 'removed')
  await expect(page.getByText('Inserted by other')).toHaveCount(0)
  await settle(page, 400)
  await oracle.mark('show-new', { allow: ['shift', 'reorder', 'clear'] })
  await page.click('[data-action=show-new]')
  await expect(page.getByText('Inserted by other')).toHaveCount(1, { timeout: 3000 })
  await expect(listRow(page, k4)).toHaveCount(0)
  await settle(page, 200)
}

/** Сценарій 6б: змінене поле сортування — рядок на місці з новим значенням. */
export async function sortKeyChanged(page: Page, oracle: Oracle) {
  await openList(page)
  const k2 = await rowKey(page, 2)
  await control(page, { kind: 'edit', id: k2, values: { num: 95 } })
  await oracle.mark('reread')
  await page.click('[data-action=reread]')
  await expect(listRow(page, k2).locator('[data-field=num]')).toHaveText('95', { timeout: 3000 })
  expect(await rowKey(page, 2)).toBe(k2)
  await settle(page, 300)
  return { needsRefresh: await page.locator('[data-action=show-new]').count() }
}

/** Сценарій 7: прокрутка вікна — підвантаження сторінки без стрибка прокрутки. */
export async function scrollWindow(page: Page, oracle: Oracle, opts: { breaks?: string } = {}) {
  await openList(page, opts)
  await control(page, { kind: 'latency', readMs: 300 })
  await oracle.mark('scroll', { allow: ['scroll'] })
  await page.evaluate(() => {
    const el = document.querySelector('[data-scroll=list]')!
    el.scrollTop = 100 * 36 - 600 - 300
  })
  await settle(page, 50)
  await oracle.mark('observe-load')
  await page.waitForFunction(() => document.querySelectorAll('[data-region=list] [data-row-key]').length > 0 && (window as any).__oracle && document.querySelector('[data-scroll=list] > div')!.clientHeight > 100 * 36 + 36)
  await settle(page, 300)
}

/** Сценарій 8: зміна рантайму — дані старого суб'єкта не видно жодного кадру. */
export async function switchUser(page: Page, oracle: Oracle, opts: { breaks?: string; inflight?: boolean } = {}) {
  const a = uniqueSubject('alice')
  await loginAs(page, a)
  if (opts.breaks) {
    await page.goto(`/login?break=${opts.breaks}`)
    await page.waitForFunction(() => (window as any).__t4Hydrated)
    await oracle.mark('login', { allow: ['shift', 'clear', 'reorder', 'scroll'] })
    await page.fill('[data-field=login]', a)
    await page.click('[data-action=login]')
    await page.waitForSelector(ROW)
  }
  if (opts.inflight) {
    // Повільна сторінка суб'єкта A ще в дорозі, коли входить B.
    await control(page, { kind: 'latency', readMs: 1200 })
    await oracle.mark('scroll', { allow: ['scroll'] })
    await page.evaluate(() => (document.querySelector('[data-scroll=list]')!.scrollTop = 100 * 36 - 600 - 300))
    await settle(page, 100)
  }
  await oracle.mark('logout', { allow: ['clear', 'shift', 'reorder', 'scroll'], forbidText: 'Alpha' })
  await page.click('[data-action=logout]')
  await page.waitForSelector('[data-region=login]')
  await page.fill('[data-field=login]', uniqueSubject('bob'))
  await page.click('[data-action=login]')
  await page.waitForSelector(ROW)
  await expect(page.locator(ROW).first()).toContainText('Bravo')
  await settle(page, opts.inflight ? 1500 : 300)
  if (opts.inflight) {
    // Пізня відповідь A, якби її прийняли, лягла б за першою сторінкою B — дивимось туди.
    await oracle.mark('scroll-b', { allow: ['scroll', 'shift'] })
    await page.evaluate(() => (document.querySelector('[data-scroll=list]')!.scrollTop = 100 * 36 - 300))
    await settle(page, 300)
  }
}

/** StrictMode + швидкий перехід «туди й назад»: без нового запиту й без порожнього кадру. */
export async function quickBackAndForth(page: Page, oracle: Oracle) {
  await openList(page)
  const key = await rowKey(page, 1)
  // Картку завантажено один раз, далі — лише навігація.
  await oracle.mark('warm', { allow: ['shift'] })
  await listRow(page, key).locator('[data-field=name]').click()
  await page.waitForFunction(() => (document.querySelector('[data-field=note]')?.textContent ?? '').length > 0)
  await page.click('[data-action=back]')
  await page.waitForSelector(ROW)
  await settle(page, 200)
  const fns = trackServerFns(page)
  for (let i = 0; i < 5; i++) {
    await oracle.mark(`forth-${i}`, { allow: ['shift'] })
    await listRow(page, key).locator('[data-field=name]').click()
    await oracle.mark(`back-${i}`, { allow: ['shift'] })
    await page.goBack()
    await page.waitForSelector(ROW)
  }
  await settle(page, 300)
  expect(fns.reads()).toEqual([])
}
