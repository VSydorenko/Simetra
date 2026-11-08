import { control, expect, loginAs, settle, test, uniqueSubject } from './harness'

test('1. перший вхід з SSR: HTML = перший клієнтський кадр, без скелета, без commit-ів і запитів', async ({ page, oracle }) => {
  await loginAs(page, uniqueSubject())
  const requests: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/_serverFn/')) requests.push(r.url())
  })
  const resp = await page.goto('/')
  const html = await resp!.text()
  await page.waitForFunction(() => (window as any).__t4Commits?.some((c: any) => c.id === 'list'))
  await settle(page, 1000)
  const log = await oracle.log()
  // Серверний HTML уже містить рядки списку, а перший знімок — не скелет.
  expect(html).toContain('data-row-key')
  const first = log.snaps.find((s) => s.regions.some((r) => r.name === 'list'))!
  const list = first.regions.find((r) => r.name === 'list')!
  expect(list.skeleton).toBe(false)
  expect(list.rows.length).toBeGreaterThan(10)
  expect(requests, 'жодного запиту даних після гідратації').toEqual([])
  const c = await oracle.regionUpdatesAfterHydration('list')
  test.info().annotations.push({ type: 'shell-commits-after-list-hydration', description: String(c.shellUpdates) })
  expect(c.updates, 'жодного commit-у зони даних після гідратації').toBe(0)
  await oracle.expectClean()
})
