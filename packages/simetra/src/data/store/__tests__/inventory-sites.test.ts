import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { CatalogEntry, RightsRow, RightsSnapshot } from "simetra/model"
import {
  SCOPE_KIND_ID,
  catalogEntrySection,
  catalogRights,
} from "../../../model/runtime/__tests__/entries"
import { coreInternals } from "../core"
import type { FakeRead } from "../testing/fake-source"
import type { ViewSpec } from "../types"
import {
  S,
  TASK,
  key,
  org,
  seed,
  settle,
  setup,
  task,
  watch,
} from "./core-support"

/*
 * Рядки Додатка Б, яких не досягають ні модельні тести, ні тести бюджетів:
 * по одному `it` на рядок, що кличе шлях через фейкове джерело. Збирач О1
 * (`setup`) судить кожен їхній запит, а тут ще й перевірено, що саме цей
 * код з'явився в подіях `watchReads`.
 */

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("R12: the barrier re-reads a section nobody else promises", () => {
  const USER = "00000000-0000-4000-8000-0000000000a1"
  const T = "00000000-0000-4000-8000-0000000000b2"
  const readRow = (scope: string): RightsRow => ({
    level: "scope",
    levelId: null,
    scope,
    container: null,
    object: "task",
    action: "read",
    extent: "any",
    dimensionId: null,
  })
  const both: RightsSnapshot = {
    userId: USER,
    scopeSets: [S, T].map((scope) => ({ scopeKind: SCOPE_KIND_ID, scope })),
    rights: [readRow(S), readRow(T)],
    members: [],
    dimensionValues: [],
  }
  // Друга ТЧ того самого власника: бар'єр перечитує за власником, а вигляд,
  // який не летить, отримує читання без хвоста — тобто рядок R12, не R15.
  const withNotes: CatalogEntry = {
    ...task,
    rights: catalogRights(),
    tabularSections: [
      ...task.tabularSections,
      catalogEntrySection({
        id: "notes",
        name: "notes",
        table: { schema: "public", name: "task_notes" },
      }),
    ],
  }
  const sectionOf = (name: string): ViewSpec => ({
    kind: "section",
    object: TASK,
    owner: key(1),
    section: name,
  })
  const named = (name: string) => (read: FakeRead) =>
    (read.query as { tabularSection?: string } | undefined)?.tabularSection ===
    name

  it("a section dropped by the snapshot barrier makes its idle sibling of the same owner read again", async () => {
    const { core, fake, reads } = setup({
      rightsSnapshot: true,
      objects: [withNotes, org],
      mode: "manual",
    })
    fake.rightsSnapshot = both
    fake.rightsVersion = "1".padStart(64, "0")
    core.requestRights()
    await settle()
    seed(fake, 1, 1)
    const line = [{ ref: key(901), qty: 1, lineNumber: 1 }]
    fake.setLines(TASK, key(1), "lines", line)
    fake.setLines(TASK, key(1), "notes", line)
    watch(core.view(sectionOf("lines")))
    await settle()
    fake.deliverAll()
    await settle()
    // Читання `notes` стартує до нового знімка й осідає після нього, а
    // власника без шапки в сховищі немає: бар'єр відкидає ТЧ.
    watch(core.view(sectionOf("notes")))
    await settle()
    fake.rightsVersion = "2".padStart(64, "0")
    core.requestRights()
    await settle()
    // Читання `lines` після знімка осідає першим, тож під час бар'єра воно
    // не летить.
    fake.take(named("lines")).answer()
    await settle()
    fake.take(named("notes")).answer()
    await settle()
    expect(reads.events.map((e) => e.site)).toContain("R12")
  })
})

describe("R18: a requirement raised while a system re-read flies", () => {
  it("a re-read that started before the requirement repeats once the answer settles", async () => {
    const { core, fake, reads } = setup()
    seed(fake, 1, 3)
    const handle = core.view({ kind: "full", object: TASK })
    watch(handle)
    await settle()
    fake.hold = () => true
    void core.revalidate(TASK, { visibleOnly: true })
    await settle()
    const held = fake.take()
    // Вимога «склад не підтверджено» з епохи, новішої за старт читання, — як
    // після приєднання каналу, що спрацювало, поки читання летіло.
    core.commit(
      (w) =>
        w.markViews(TASK, {
          unconfirmedSince: coreInternals(core).epochs.next(),
        }),
      core.token()
    )
    await settle()
    fake.hold = undefined
    held.answer()
    await settle()
    await settle()
    expect(reads.events.map((e) => e.site)).toContain("R18")
    expect(handle.getSnapshot().status).toBe("ready")
  })
})
