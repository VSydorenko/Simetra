import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AttemptEvent } from "../attempts"
import type { ReadEvent } from "../source"
import type { ViewSpec } from "../types"
import { SETTLE_OUTCOMES } from "../sync/vocabulary"
import { TASK, key, seed, settle, setup, watch } from "./core-support"

/*
 * Діагностика `watchAttempts` (спека ядра синхронізації §5.13, §5.5): подія
 * «спробу розпочато» і подія «осіло» з одним наслідком із закритого переліку,
 * обидві з тим самим непрозорим ідентифікатором цілі, що й `sync()`; читання
 * спроби несуть її номер у `watchReads`.
 */

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, "random").mockReturnValue(0.5)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const spec: ViewSpec = { kind: "keys", object: TASK, keys: [key(1), key(2)] }

function build(options: Parameters<typeof setup>[0] = {}) {
  const h = setup({ now: () => Date.now(), ...options })
  seed(h.fake, 1, 2)
  const attempts: AttemptEvent[] = []
  const reads: ReadEvent[] = []
  h.inspect.watchAttempts((event) => attempts.push(event))
  h.inspect.watchReads((event) => reads.push(event))
  return { ...h, attempts, reads }
}

const idOf = (h: ReturnType<typeof build>) => {
  const state = h.inspect.sync().find((s) => s.target.kind === "view")!
  if (state.target.kind !== "view") throw new Error("not a view")
  return state.target.id
}

describe("watchAttempts", () => {
  it("a load: started with its origin, settled applied, the same attempt number and target id; its reads carry the number", async () => {
    const h = build()
    watch(h.core.view(spec))
    await settle()
    const [started, settled] = h.attempts
    expect(started).toMatchObject({
      phase: "started",
      kind: "load",
      reason: "mount",
      site: "M1",
      target: { kind: "view", object: TASK, id: idOf(h) },
    })
    expect(settled).toMatchObject({
      phase: "settled",
      kind: "load",
      outcome: "applied",
      attempt: started!.attempt,
      target: { id: idOf(h) },
    })
    expect(h.attempts).toHaveLength(2)
    expect(h.reads.length).toBeGreaterThan(0)
    for (const read of h.reads) expect(read.attempt).toBe(started!.attempt)
  })

  it("a system re-read: started as reread and settled applied", async () => {
    const h = build()
    watch(h.core.view(spec))
    await settle()
    h.attempts.length = 0
    await h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(h.attempts.map((e) => [e.phase, e.kind])).toEqual([
      ["started", "reread"],
      ["settled", "reread"],
    ])
    expect(h.attempts[1]).toMatchObject({ outcome: "applied" })
  })

  it("a failed read settles failed", async () => {
    const h = build({ mode: "manual" })
    watch(h.core.view(spec))
    await settle()
    h.fake.take().fail("command.unavailable")
    await settle()
    expect(h.attempts.at(-1)).toMatchObject({
      phase: "settled",
      outcome: "failed",
    })
  })

  it("a read of an incompatible object goes out as failed with the skip condition, without a request", async () => {
    const h = build()
    h.core.staleClient(TASK)
    watch(h.core.view(spec))
    await settle()
    expect(h.attempts.at(-1)).toMatchObject({
      phase: "settled",
      outcome: "failed",
      skip: "stale-object",
    })
    expect(h.fake.log.filter((p) => p.query?.object.name === "Task")).toEqual(
      []
    )
  })

  it("an answer after close settles closed", async () => {
    const h = build({ mode: "manual" })
    watch(h.core.view(spec))
    await settle()
    h.core.close("disposed")
    h.fake.deliverAll()
    await settle()
    expect(h.attempts.at(-1)).toMatchObject({
      phase: "settled",
      outcome: "closed",
    })
  })

  it("a page read of a window carries the id of its view", async () => {
    const win: ViewSpec = {
      kind: "window",
      object: TASK,
      orderBy: [{ attribute: "title", direction: "asc" }],
    }
    const h = build({ limits: { windowPage: 1 } })
    watch(h.core.view(win))
    await settle()
    h.attempts.length = 0
    h.core.view(win).loadAfter()
    await settle()
    const page = h.attempts.filter((e) => e.kind === "page")
    expect(page.map((e) => e.phase)).toEqual(["started", "settled"])
    for (const event of page) expect(event.target.id).toBe(idOf(h))
    expect(page[0]!.target.kind).toBe("page")
  })

  it("every settle outcome is one of the closed list, each started attempt settles once", async () => {
    const h = build()
    watch(h.core.view(spec))
    await settle()
    await h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    const started = h.attempts.filter((e) => e.phase === "started")
    for (const event of started) {
      const settled = h.attempts.filter(
        (e) => e.phase === "settled" && e.attempt === event.attempt
      )
      expect(settled).toHaveLength(1)
      expect(SETTLE_OUTCOMES).toContain(
        (settled[0] as { outcome: string }).outcome
      )
    }
  })

  it("a throwing listener does not break the read, several listeners and unsubscribe work", async () => {
    const h = build()
    h.inspect.watchAttempts(() => {
      throw new Error("diagnostics must not break the core")
    })
    const second: AttemptEvent[] = []
    const off = h.inspect.watchAttempts((event) => second.push(event))
    watch(h.core.view(spec))
    await settle()
    expect(second.length).toBe(h.attempts.length)
    off()
    await h.core.revalidate(TASK, { visibleOnly: false })
    await settle()
    expect(second.length).toBeLessThan(h.attempts.length)
  })
})
