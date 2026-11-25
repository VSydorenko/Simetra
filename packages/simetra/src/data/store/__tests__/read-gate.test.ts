import { describe, expect, it } from "vitest"
import type { MetadataRef } from "simetra/model"
import { coreInternals } from "../core"
import type { CorePart } from "../source"
import type { Flight } from "../sync/flight"
import type { ReadCause, ReadTarget } from "../sync/vocabulary"
import { TEST_FLIGHT } from "../testing/fake-source"
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
    // `release` без `issue` — тест не держить оренду відкритою.
    lease.release()
  })

  it("rejects a literal with the same reason, target and code, and sends nothing", async () => {
    const h = armed()
    const lease = h.source.lease()
    // Літерал зі справжніми полями: бренд і запис шлюзу — те, чого в нього немає.
    const forged = { ...cause, target, site: "R7", lease } as Flight
    await expect(h.source.read(parts, forged)).rejects.toThrow()
    await settle()
    expect(h.fake.log).toHaveLength(0)
  })

  it("rejects a flight of another session, and a flight of the test entry", async () => {
    const h = armed()
    const other = armed()
    const lease = h.source.lease()
    const foreign = other.source.admit(cause, target, "R7", { lease })
    await expect(h.source.read(parts, foreign)).rejects.toThrow()
    await expect(h.source.read(parts, TEST_FLIGHT)).rejects.toThrow()
    await settle()
    expect(h.fake.log).toHaveLength(0)
    expect(other.fake.log).toHaveLength(0)
  })
})
