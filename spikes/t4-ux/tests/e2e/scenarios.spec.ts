import * as f from './flows'
import { expect, test } from './harness'

test('1. перший вхід з SSR: HTML = перший клієнтський кадр, без скелета, без commit-ів і запитів', async ({ page, oracle }) => {
  const { html, requests, commits } = await f.ssrEntry(page, oracle)
  expect(html).toContain('data-row-key')
  const log = await oracle.log()
  const list = log.snaps.find((s) => s.regions.some((r) => r.name === 'list'))!.regions.find((r) => r.name === 'list')!
  expect(list.skeleton).toBe(false)
  expect(list.rows.length).toBeGreaterThan(10)
  expect(requests, 'жодного запиту даних після гідратації').toEqual([])
  test.info().annotations.push({ type: 'shell-commits', description: String(commits.shellUpdates) })
  expect(commits.updates, 'жодного commit-у зони даних після гідратації').toBe(0)
  await oracle.expectClean()
})

test('2. список → картка → список', async ({ page, oracle }) => {
  await f.listCardList(page, oracle)
  await oracle.expectClean()
})
test('3. правка поля', async ({ page, oracle }) => {
  await f.editField(page, oracle)
  await oracle.expectClean()
})
test('4. відмова правки і скасування', async ({ page, oracle }) => {
  await f.rejectEdit(page, oracle)
  await oracle.expectClean()
})
test('5. створення рядка', async ({ page, oracle }) => {
  await f.createRow(page, oracle)
  await oracle.expectClean()
})
test('6. фонове перечитування', async ({ page, oracle }) => {
  await f.backgroundRefresh(page, oracle)
  await oracle.expectClean()
})
test('6б. змінене поле сортування → needsRefresh', async ({ page, oracle }) => {
  await f.sortKeyChanged(page, oracle)
  await oracle.expectClean()
})
test('7. прокрутка вікна', async ({ page, oracle }) => {
  await f.scrollWindow(page, oracle)
  await oracle.expectClean()
})
test('8. зміна рантайму', async ({ page, oracle }) => {
  await f.switchUser(page, oracle)
  await oracle.expectClean()
})
test('8б. зміна рантайму з відповіддю старого суб\'єкта в дорозі', async ({ page, oracle }) => {
  await f.switchUser(page, oracle, { inflight: true })
  await oracle.expectClean()
})
test('9. StrictMode: швидко туди й назад', async ({ page, oracle }) => {
  await f.quickBackAndForth(page, oracle)
  await oracle.expectClean()
})
