import { channelTopic, type RightsRow } from "simetra/model"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  SCOPE_KIND_ID,
  catalogEntry,
} from "../../../model/runtime/__tests__/entries"
import { coreInternals } from "../core"
import { keyId } from "../epoch"
import { createFakeSignalTransport } from "../testing/fake-signal-transport"
import { QUIET_MS } from "../receiver"
import type { Key, ViewSpec } from "../types"
import {
  TASK,
  key,
  org,
  S,
  seed,
  settle,
  setup,
  task,
  taskValues,
} from "./core-support"

/*
 * Осідання відповіді приймача одним проходом (SK-2, Р-SK2-3, Р-SK2-8): крок 9
 * (`scheduleRetry` K2) після збою застосування й single-flight пачки. Окремо
 * від `receiver-signals.test.ts`: той файл рахує запити (множина тестів
 * бюджетів SK-0 §3), а ці тести спостерігають стан, а не лічильник запитів.
 */

const USER = "00000000-0000-4000-8000-0000000000a1"

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const read: RightsRow = {
  level: "scope",
  levelId: null,
  scope: S,
  container: null,
  object: "task",
  action: "read",
  extent: "any",
  dimensionId: null,
}

const channel = channelTopic({
  kind: "changes",
  scopeKindId: SCOPE_KIND_ID,
  scope: S,
  object: task.id,
})

const keysView = (...keys: Key[]): ViewSpec => ({
  kind: "keys",
  object: TASK,
  keys,
})

function harness() {
  const transport = createFakeSignalTransport()
  const h = setup({ rightsSnapshot: true, signals: transport })
  h.fake.rightsSnapshot = {
    userId: USER,
    scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
    rights: [read],
    members: [],
    dimensionValues: [],
  }
  h.fake.rightsVersion = "1".repeat(64)
  return { ...h, transport }
}
type Harness = ReturnType<typeof harness>

let seq = 0
const change = (op: "create" | "update", k: Key, rowVer: number) => ({
  id: String(++seq),
  object: task.id,
  op,
  keys: { id: k },
  row_ver: rowVer,
})
const emit = (h: Harness, payload: unknown) =>
  h.transport.emit(channel, payload)

/** Дає пачці закритись і відповідям осісти. */
const closeBatch = async () => {
  await vi.advanceTimersByTimeAsync(QUIET_MS)
  await settle()
}

describe("settlement of a key read: step 9 and the single flight", () => {
  it("schedules the min-version re-read after the pass although the apply of the answer threw", async () => {
    // Ключ 1 відповідає версією нижче за `row_ver` сигналу (K2: дочитування),
    // а новий ключ 77 валить застосування вже після цього: гачок `scheduleRetry`
    // стоїть після області запису, тож збій застосування його не скасовує.
    const h = harness()
    seed(h.fake, 1, 3)
    const handle = h.core.view(keysView(key(1)))
    handle.subscribe(() => {})
    h.core
      .view({
        kind: "full",
        object: TASK,
        where: { attribute: "title", op: "eq", value: "fresh" },
      })
      .subscribe(() => {})
    await settle()
    const { epochs } = coreInternals(h.core)
    const buriedSince = epochs.buriedSince.bind(epochs)
    vi.spyOn(epochs, "buriedSince").mockImplementation((id, since) => {
      if (id === keyId(TASK, key(77))) throw new Error("apply defect")
      return buriedSince(id, since)
    })
    const served = h.fake.edit(TASK, key(1), { title: "v" })
    emit(h, change("update", key(1), served + 1))
    const v = h.fake.insert(TASK, taskValues(77, { title: "fresh" }))
    emit(h, change("create", key(77), v))
    await closeBatch()
    expect(h.log.some((e) => e.kind === "listener-failed")).toBe(true)
    expect(handle.getSnapshot().rows[0]!.state).toBe("stale")
    // Сервер дійшов до очікуваної версії: дочитування знімає позначку.
    h.fake.edit(TASK, key(1), { title: "v2" })
    await vi.advanceTimersByTimeAsync(500)
    await settle()
    expect(handle.getSnapshot().rows[0]!.state).not.toBe("stale")
  })

  it("starts the next batch only after the whole one settled, while the answer of a ready object is already written", async () => {
    // Об'єкт A (з ТЧ власника) осідає сам; повний вигляд B читається сторінками
    // по одному рядку, тож його друга сторінка тримається. Нова пачка не
    // стартує, доки B не осяде (single-flight), а шапка A лягає після ТЧ.
    const entry = catalogEntry({
      id: "00000000-0000-4000-8000-000000007001",
      name: "Pair0",
      kindLabel: "pair0",
      table: { schema: "public", name: "pair0" },
      tabularSections: [],
    })
    const transport = createFakeSignalTransport()
    const h = setup({
      rightsSnapshot: true,
      signals: transport,
      objects: [org, task, entry],
      limits: { fullPageSize: 1 },
    })
    h.fake.rightsSnapshot = {
      userId: USER,
      scopeSets: [{ scopeKind: SCOPE_KIND_ID, scope: S }],
      rights: [read, { ...read, object: entry.kindLabel }],
      members: [],
      dimensionValues: [],
    }
    h.fake.rightsVersion = "1".repeat(64)
    const B = `Catalog.${entry.name}`
    seed(h.fake, 1, 3)
    h.fake.insert(B, taskValues(1))
    h.fake.insert(B, taskValues(2))
    const header = h.core.view(keysView(key(1)))
    header.subscribe(() => {})
    h.core.view({ kind: "full", object: B }).subscribe(() => {})
    h.fake.setLines(TASK, key(1), "lines", [
      { ref: key(900), qty: 1, lineNumber: 1 },
    ])
    const section = h.core.view({
      kind: "section",
      object: TASK,
      owner: key(1),
      section: "lines",
    })
    section.subscribe(() => {})
    await settle()
    const topicOf = (object: string) =>
      channelTopic({
        kind: "changes",
        scopeKindId: SCOPE_KIND_ID,
        scope: S,
        object,
      })
    const signalTask = (version: number) =>
      transport.emit(topicOf(task.id), {
        id: String(++seq),
        object: task.id,
        op: "update",
        keys: { id: key(1) },
        row_ver: version,
      })
    h.fake.mode = "manual"
    const version = h.fake.setLines(TASK, key(1), "lines", [
      { ref: key(901), qty: 2, lineNumber: 1 },
    ])
    signalTask(version)
    transport.emit(topicOf(entry.id), {
      id: String(++seq),
      object: entry.id,
      op: "invalidate",
    })
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    // Перший запит пачки: шапка й ТЧ A, перша сторінка B.
    while (h.fake.pending.length > 0) h.fake.take().answer()
    await settle()
    // Друга сторінка B ще в польоті, а A уже записано.
    expect(h.fake.pending.some((r) => r.object === B)).toBe(true)
    expect(JSON.stringify(section.getSnapshot().section?.lines)).toContain(
      key(901)
    )
    // Друга пачка A закрилась, але перша ще не осіла: читання немає.
    const second = h.fake.edit(TASK, key(1), { title: "second" })
    signalTask(second)
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await settle()
    expect(h.fake.pending.some((r) => r.object === TASK)).toBe(false)
    expect(header.getSnapshot().rows[0]).not.toMatchObject({
      values: { title: "second" },
    })
    h.fake.mode = "auto"
    h.fake.deliverAll()
    await settle()
    expect(header.getSnapshot().rows[0]).toMatchObject({
      values: { title: "second" },
    })
  })
})
