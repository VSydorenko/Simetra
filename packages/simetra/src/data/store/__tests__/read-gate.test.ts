import { describe, expect, it } from "vitest"
import type { MetadataRef } from "simetra/model"
import { coreInternals } from "../core"
import type { CorePart } from "../source"
import { issueTestFlight, type Flight } from "../sync/flight"
import { TEST_SITE, type ReadCause, type ReadTarget } from "../sync/vocabulary"
import { TASK, key, seed, settle, setup } from "./core-support"

/*
 * Читання без польоту шлюзу цієї сесії на дріт не йде (план SK-1, Р-SK1-2,
 * інваріант 1 §6): літерал з тими самими полями, політ іншої сесії й політ
 * тестового входу відмовляються до будь-якого запиту.
 */

const TASK_REF: MetadataRef = { kind: "Catalog", name: "Task" }
const cause: ReadCause = { reason: "user" }
const target: ReadTarget = { kind: "keys", object: TASK }
const parts: readonly CorePart[] = [
  { type: "query", query: { object: TASK_REF, id: key(1) } },
]

function armed() {
  const h = setup()
  seed(h.fake, 1, 1)
  return { ...h, source: coreInternals(h.core).source }
}

describe("read of the core takes only a flight of its own gate", () => {
  it("reads with a flight the gate issued (control)", async () => {
    const h = armed()
    const lease = h.source.lease()
    await h.source.read(parts, h.source.admit(cause, target, "R7", { lease }))
    expect(h.fake.log).toHaveLength(1)
    // Читання видало оренду на об'єкти частин; знімаємо її, як осідання польоту.
    lease.release()
  })

  // Оренда є в кожному політі: інакше відмову дала б стара перевірка оренди
  // (`a read of rows without a write lease`), а не шлюз.
  const GATE = /without a flight of the gate/

  it("rejects a literal with the same reason, target and code, and sends nothing", async () => {
    const h = armed()
    const lease = h.source.lease()
    // Літерал зі справжніми полями: бренд і запис шлюзу — те, чого в нього немає.
    const forged = { ...cause, target, site: "R7", lease } as Flight
    await expect(h.source.read(parts, forged)).rejects.toThrow(GATE)
    await settle()
    expect(h.fake.log).toHaveLength(0)
    // Відмова йде до `lease.issue`: оренди на об'єкти частин ніхто не видав.
    expect(coreInternals(h.core).pendingWrites(TASK)).toBe(0)
  })

  it("rejects a flight of another session", async () => {
    const h = armed()
    const other = armed()
    const lease = h.source.lease()
    const foreign = other.source.admit(cause, target, "R7", { lease })
    await expect(h.source.read(parts, foreign)).rejects.toThrow(GATE)
    await settle()
    expect(h.fake.log).toHaveLength(0)
    expect(other.fake.log).toHaveLength(0)
    expect(coreInternals(h.core).pendingWrites(TASK)).toBe(0)
  })

  it("rejects a flight of the test entry", async () => {
    const h = armed()
    const lease = h.source.lease()
    const testing = issueTestFlight(cause, target, TEST_SITE, { lease })
    await expect(h.source.read(parts, testing)).rejects.toThrow(GATE)
    await settle()
    expect(h.fake.log).toHaveLength(0)
    // Відмова йде до `lease.issue`: оренди на об'єкти частин ніхто не видав.
    expect(coreInternals(h.core).pendingWrites(TASK)).toBe(0)
  })
})
