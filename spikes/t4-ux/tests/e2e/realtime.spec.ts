// Сценарії оракула зі звіту спайку 3 (розділ «Сценарії для оракула спайку 2»)
// над справжнім ядром і фейковим каналом сигналів.
import { control, expect, settle, test } from './harness'
import { openList } from './flows'
import { confirmed, rejoin, signal } from './signals'

const ROW = '[data-region=list] [data-row-key]'
const row = (page: import('@playwright/test').Page, key: string) => page.locator(`[data-region=list] [data-row-key="${key}"]`)
const stateOf = (page: import('@playwright/test').Page, key: string) => row(page, key).locator('[data-state]')
const keyAt = (page: import('@playwright/test').Page, n: number) => page.locator(ROW).nth(n).getAttribute('data-row-key') as Promise<string>

test('р1. сигнал власної команди раніше відповіді run: A → B, synced → pending → synced', async ({ page, oracle }) => {
  await openList(page)
  const k = await keyAt(page, 2)
  const base = await confirmed(page, k)
  await control(page, { kind: 'hold' })
  await oracle.mark('toggle')
  await row(page, k).locator('[data-action=toggle]').click()
  await expect(stateOf(page, k)).toHaveAttribute('data-state', 'pending')
  // Сервер закомітив, сигнал обігнав відповідь run.
  await signal(page, { op: 'patch', rows: [{ key: k, version: base.version + 1, values: { ...base.values, status: base.values.status === 'open' ? 'closed' : 'open' } }] })
  await settle(page, 100)
  await control(page, { kind: 'release' })
  await expect(stateOf(page, k)).toHaveAttribute('data-state', /synced|conflict/)
  await settle(page, 300)
  test.info().annotations.push({ type: 'final-state', description: (await stateOf(page, k).getAttribute('data-state'))! })
  await oracle.expectClean()
})

test('р2. чужа зміна під pending: показ — значення користувача, conflict; «взяти серверну» показує чуже', async ({ page, oracle }) => {
  await openList(page)
  const k = await keyAt(page, 2)
  await control(page, { kind: 'hold' })
  await oracle.mark('toggle')
  await row(page, k).locator('[data-action=toggle]').click()
  const mine = await row(page, k).locator('[data-field=status]').textContent()
  const v = await control(page, { kind: 'edit', id: k, values: { status: 'archived' } })
  const base = await confirmed(page, k)
  await signal(page, { op: 'patch', rows: [{ key: k, version: base.version + 1, values: { ...base.values, status: 'archived' } }] })
  await control(page, { kind: 'release' })
  await expect(stateOf(page, k)).toHaveAttribute('data-state', 'conflict', { timeout: 3000 })
  await expect(row(page, k).locator('[data-field=status]')).toHaveText(mine!)
  await settle(page, 200)
  await oracle.mark('take-server')
  await row(page, k).locator('[data-action=take-server]').click()
  await expect(row(page, k).locator('[data-field=status]')).toHaveText('archived')
  await settle(page, 200)
  void v
  await oracle.expectClean()
})

test('р3. сплеск 1000 сигналів над вікном: склад і порядок незмінні, без порожніх кадрів', async ({ page, oracle }) => {
  await openList(page)
  const keys = await page.locator(ROW).evaluateAll((els) => els.map((e) => e.getAttribute('data-row-key')!))
  const bases = new Map<string, { version: number; values: Record<string, unknown> }>()
  for (const k of keys) bases.set(k, await confirmed(page, k))
  await oracle.mark('burst')
  await page.evaluate(
    async ({ keys, bases }) => {
      const core = (window as any).__t4Holder.core
      const v = new Map(Object.entries(bases as Record<string, { version: number; values: Record<string, unknown> }>))
      for (let i = 0; i < 1000; i++) {
        const k = keys[i % keys.length]!
        const b = v.get(k)!
        b.version++
        core.commit((w: any) => w.patch('Catalog.Item', [{ key: k, version: b.version, values: { ...b.values, amount: `${i}.00` } }]), core.token())
        if (i % 25 === 0) await new Promise((r) => requestAnimationFrame(() => r(null)))
      }
    },
    { keys, bases: Object.fromEntries(bases) },
  )
  await settle(page, 300)
  const after = await page.locator(ROW).evaluateAll((els) => els.map((e) => e.getAttribute('data-row-key')!))
  expect(after).toEqual(keys)
  await oracle.expectClean()
})

test('р4. розрив і 50 пропущених змін: stale на місці, після відновлення один кадр нових значень, removed, hasNewRows', async ({ page, oracle }) => {
  await openList(page)
  const keys = await page.locator(ROW).evaluateAll((els) => els.map((e) => e.getAttribute('data-row-key')!))
  await oracle.mark('disconnect')
  await signal(page, { op: 'stale', keys })
  await expect(stateOf(page, keys[0]!)).toHaveAttribute('data-state', 'stale')
  // 50 змін, поки канал лежить; видалення одного рядка; новий рядок.
  for (let i = 0; i < 50; i++) await control(page, { kind: 'edit', id: keys[i % keys.length]!, values: { amount: `${900 + i}.00` } })
  await control(page, { kind: 'remove', id: keys[3]! })
  await control(page, { kind: 'insert', id: '00000000-0000-4000-9000-0000000000aa', values: { num: 25, name: 'Inserted while offline', amount: '1.00', status: 'open' } })
  await settle(page, 200)
  await oracle.mark('reconnect')
  await rejoin(page, keys)
  await signal(page, { op: 'views', flags: { hasNewRows: true } })
  await expect(stateOf(page, keys[3]!)).toHaveAttribute('data-state', 'removed', { timeout: 3000 })
  await expect(stateOf(page, keys[0]!)).toHaveAttribute('data-state', 'synced')
  await expect(page.locator('[data-action=show-new]')).toBeVisible()
  await settle(page, 300)
  // Після відновлення значення змінились рівно один раз на рядок.
  const log = await oracle.log()
  const seg = log.marks.length
  const amounts = log.snaps.filter((s) => s.seg === seg).map((s) => s.regions.find((r) => r.name === 'list')!.rows.find((r) => r.key === keys[1])?.fields.amount)
  expect(new Set(amounts).size).toBeLessThanOrEqual(2)
  await oracle.expectClean()
})

test('р5. видалення рядка іншим, поки картка відкрита: removed з останніми значеннями', async ({ page, oracle }) => {
  await openList(page)
  const k = await keyAt(page, 2)
  await oracle.mark('to-card', { allow: ['shift'] })
  await row(page, k).locator('[data-field=name]').click()
  await page.waitForSelector('[data-region=card] input[data-field=name]')
  await settle(page, 300)
  const name = await page.locator('[data-region=card] input[data-field=name]').inputValue()
  await control(page, { kind: 'remove', id: k })
  await oracle.mark('removed-by-other')
  await signal(page, { op: 'remove', keys: [k] })
  await expect(page.locator('[data-region=card] [data-state]').first()).toHaveAttribute('data-state', 'removed')
  await expect(page.locator('[data-region=card] input[data-field=name]')).toHaveValue(name)
  await settle(page, 200)
  await oracle.expectClean()
})

test('р6. власне видалення: pending на місці, зникає лише після підтвердження; відмова — failed на місці', async ({ page, oracle }) => {
  await openList(page)
  const k = await keyAt(page, 2)
  const k2 = await keyAt(page, 3)
  await control(page, { kind: 'latency', writeMs: 300 })
  await oracle.mark('delete', { allow: ['shift-once'] })
  await row(page, k).locator('[data-action=delete]').click()
  await expect(stateOf(page, k)).toHaveAttribute('data-state', 'pending')
  await expect(row(page, k)).toHaveCount(0, { timeout: 3000 })
  await settle(page, 200)
  await control(page, { kind: 'failNext', code: 'command.forbidden' })
  await oracle.mark('delete-rejected')
  await row(page, k2).locator('[data-action=delete]').click()
  await expect(stateOf(page, k2)).toHaveAttribute('data-state', 'failed', { timeout: 3000 })
  await settle(page, 200)
  await oracle.expectClean()
})

test('р7. дубль і перестановка сигналів: значення лише вперед', async ({ page, oracle }) => {
  await openList(page)
  const k = await keyAt(page, 2)
  const b = await confirmed(page, k)
  const at = (v: number) => ({ key: k, version: b.version + v, values: { ...b.values, amount: `${v}00.00` } })
  await oracle.mark('signals')
  await signal(page, { op: 'patch', rows: [at(2)] })
  await signal(page, { op: 'patch', rows: [at(1)] })
  await signal(page, { op: 'patch', rows: [at(2)] })
  await signal(page, { op: 'patch', rows: [at(1)] })
  await settle(page, 200)
  await expect(row(page, k).locator('[data-field=amount]')).toHaveText('200.00')
  await oracle.expectClean()
})

test('р8. репліка відстає: synced → stale → synced лише за відставання', async ({ page, oracle }) => {
  await openList(page)
  const k = await keyAt(page, 2)
  const b = await confirmed(page, k)
  await oracle.mark('signal-ahead-of-replica')
  // Сигнал каже «є v+1», а читання ще віддає v: рядок лишається stale.
  await signal(page, { op: 'stale', keys: [k], minVersion: b.version + 1 })
  await rejoin(page, [k])
  await settle(page, 200)
  await expect(stateOf(page, k)).toHaveAttribute('data-state', 'stale')
  await oracle.mark('replica-caught-up')
  await control(page, { kind: 'edit', id: k, values: { amount: '777.00' } })
  await rejoin(page, [k])
  await expect(stateOf(page, k)).toHaveAttribute('data-state', 'synced', { timeout: 3000 })
  await expect(row(page, k).locator('[data-field=amount]')).toHaveText('777.00')
  await settle(page, 200)
  await oracle.expectClean()
})

test('р9. відповідь run втрачено: pending → unknown → synced без проміжних значень', async ({ page, oracle }) => {
  await openList(page)
  const k = await keyAt(page, 2)
  await control(page, { kind: 'latency', writeMs: 200, readMs: 200 })
  await control(page, { kind: 'lostReplyNext' })
  await oracle.mark('toggle')
  await row(page, k).locator('[data-action=toggle]').click()
  const toggled = await row(page, k).locator('[data-field=status]').textContent()
  await expect(stateOf(page, k)).toHaveAttribute('data-state', 'unknown', { timeout: 3000 })
  await expect(stateOf(page, k)).toHaveAttribute('data-state', 'synced', { timeout: 3000 })
  await expect(row(page, k).locator('[data-field=status]')).toHaveText(toggled!)
  await settle(page, 200)
  await oracle.expectClean()
})
