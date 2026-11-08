import * as f from "./flows"
import { expect, test } from "./harness"

test("1. перший вхід з SSR: HTML = перший клієнтський кадр, без скелета, без commit-ів і запитів", async ({
  page,
  oracle,
}) => {
  const { html, requests, calls, commits, listCommits } = await f.ssrEntry(
    page,
    oracle
  )
  test.info().annotations.push({
    type: "list-region-commits (stream count boundary)",
    description: String(listCommits.updates),
  })
  expect(
    calls.filter((c) => c === "getVersion"),
    "одна звірка знімка (контракт version)"
  ).toHaveLength(1)
  expect(html).toContain("data-row-key")
  const log = await oracle.log()
  const list = log.snaps
    .find((s) => s.regions.some((r) => r.name === "list"))!
    .regions.find((r) => r.name === "list")!
  expect(list.skeleton).toBe(false)
  expect(list.rows.length).toBeGreaterThan(10)
  expect(requests, "жодного запиту даних після гідратації").toEqual([])
  test.info().annotations.push({
    type: "shell-commits",
    description: String(commits.shellUpdates),
  })
  expect(commits.updates, "жодного commit-у рядків після гідратації").toBe(0)
  await oracle.expectClean()
})

test("2. список → картка → список", async ({ page, oracle }) => {
  await f.listCardList(page, oracle)
  await oracle.expectClean()
})
test("3. правка поля", async ({ page, oracle }) => {
  await f.editField(page, oracle)
  await oracle.expectClean()
})
test("4. відмова правки і скасування", async ({ page, oracle }) => {
  await f.rejectEdit(page, oracle)
  await oracle.expectClean()
})
test("5. створення рядка", async ({ page, oracle }) => {
  await f.createRow(page, oracle)
  await oracle.expectClean()
})
test("6. фонове перечитування", async ({ page, oracle }) => {
  await f.backgroundRefresh(page, oracle)
  await oracle.expectClean()
})
test("6б. змінене поле сортування: рядок на місці", async ({
  page,
  oracle,
}) => {
  const r = await f.sortKeyChanged(page, oracle)
  test.info().annotations.push({
    type: "needsRefresh-banner-after-sort-change",
    description: String(r.needsRefresh),
  })
  await oracle.expectClean()
})
test("7. прокрутка вікна", async ({ page, oracle }) => {
  // Спайк 4: посилений оракул (правило `blank`) ловить порожню смугу
  // власної віртуалізації цього полігона — рендер через setState з
  // onScroll асинхронний. Відомий дефект полігона, не ядра; T5 іде на
  // TanStack Virtual (`/window`). Тест лишається доказом сили оракула.
  test.fail()
  await f.scrollWindow(page, oracle)
  await oracle.expectClean()
})
test("8. зміна рантайму", async ({ page, oracle }) => {
  await f.switchUser(page, oracle)
  await oracle.expectClean()
})
test("8б. зміна рантайму з відповіддю старого суб'єкта в дорозі", async ({
  page,
  oracle,
}) => {
  // Спайк 4: посилений оракул (правило `blank`) ловить порожню смугу
  // власної віртуалізації цього полігона — рендер через setState з
  // onScroll асинхронний. Відомий дефект полігона, не ядра; T5 іде на
  // TanStack Virtual (`/window`). Тест лишається доказом сили оракула.
  test.fail()
  await f.switchUser(page, oracle, { inflight: true })
  await oracle.expectClean()
})
test("9. StrictMode: швидко туди й назад", async ({ page, oracle }) => {
  await f.quickBackAndForth(page, oracle)
  await oracle.expectClean()
})
