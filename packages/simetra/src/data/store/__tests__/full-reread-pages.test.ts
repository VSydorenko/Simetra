import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ViewSpec } from "../types"
import {
  TASK,
  key,
  keysOf,
  settle,
  setup,
  taskValues,
  watch,
} from "./core-support"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/*
 * Системне перечитування `full` понад одну сторінку (спека П4-B §6.7, Рд41):
 * сторінки — частинами одного пакета від збережених меж складу.
 */

const FULL: ViewSpec = { kind: "full", object: TASK }
const ROWS = 250
// Ключі з проміжками: у проміжок можна вставити рядок між межами сторінок.
const at = (n: number) => key(n * 10)

async function opened() {
  const h = setup()
  // Без епохи версій `known` не шлеться.
  h.fake.epoch = "a".repeat(64)
  for (let n = 1; n <= ROWS; n++)
    h.fake.insert(
      TASK,
      taskValues(n, { ref: at(n), status: null, subject: null })
    )
  const handle = h.core.view(FULL)
  const watched = watch(handle)
  await settle()
  expect(handle.getSnapshot().rows).toHaveLength(ROWS)
  return { ...h, handle, watched }
}

async function revalidate(h: Awaited<ReturnType<typeof opened>>) {
  const from = h.fake.requests.length
  await h.core.revalidate(TASK, { visibleOnly: true })
  await settle()
  return h.fake.requests.slice(from)
}

const keysOfView = (h: Awaited<ReturnType<typeof opened>>) =>
  h.handle.getSnapshot().rows.map((r) => r.key)

describe("the system re-read of a full view over one page", () => {
  it("sends the pages as parts of one request, each with the known of its keys", async () => {
    const h = await opened()
    const from = h.fake.log.length
    const requests = await revalidate(h)
    expect(requests).toEqual([2])
    const reads = h.fake.log.slice(from)
    expect(reads.map((r) => r.known?.keys.length)).toEqual([200, 50])
    // Рядки без змін — маркери: значення в відповіді немає.
    for (const read of reads) {
      const rows = (read.response as { rows: Record<string, unknown>[] }).rows
      for (const row of rows)
        expect(Object.keys(row).length).toBeLessThanOrEqual(2)
    }
    expect(keysOfView(h)).toHaveLength(ROWS)
    expect(h.inspect.violations()).toEqual([])
  })

  it("drops the pages after a stale bound and reads on sequentially: a row inserted before the bound, one inside the gap", async () => {
    const h = await opened()
    h.fake.insert(
      TASK,
      taskValues(1, { ref: key(5), status: null, subject: null })
    )
    // Лежить між кінцем першої сторінки відповіді й збереженою межею.
    h.fake.insert(
      TASK,
      taskValues(2, { ref: key(1995), status: null, subject: null })
    )
    const from = h.fake.log.length
    const requests = await revalidate(h)
    expect(requests).toHaveLength(2)
    // Після двох сторінок пакета — одне читання від кінця першої (без ключів):
    // проміжок прочитано, а не підтверджено ключами складу.
    const after = h.fake.log.slice(from + 2)
    expect(after.map((r) => keysOf(r.query).length)).toEqual([0])
    const keys = keysOfView(h)
    // Склад стабільний (§6.5): нові рядки не входять без `showNew`.
    expect(keys).toEqual(Array.from({ length: ROWS }, (_, i) => at(i + 1)))
    expect(new Set(keys).size).toBe(keys.length)
    expect(h.handle.getSnapshot().hasNewRows).toBe(true)
    expect(h.inspect.violations()).toEqual([])
  })

  it("keeps the composition when rows were deleted between the bounds: no gaps, no duplicates", async () => {
    const h = await opened()
    h.fake.remove(TASK, at(100))
    h.fake.remove(TASK, at(230))
    const requests = await revalidate(h)
    // Пакет сторінок, продовження від останнього рядка першої, підтвердження
    // двох ключів складу за ключем.
    expect(requests).toEqual([2, 1, 1])
    const rows = h.handle.getSnapshot().rows
    expect(rows.map((r) => r.key)).toEqual(
      Array.from({ length: ROWS }, (_, i) => at(i + 1))
    )
    for (const row of rows)
      expect(row.state === "removed").toBe(
        row.key === at(100) || row.key === at(230)
      )
    expect(h.handle.getSnapshot().hasNewRows).toBe(false)
    expect(h.inspect.violations()).toEqual([])
  })
})
