import { describe, expect, it } from "vitest"
import { createEpochs } from "../epoch"

const limits = { seenMax: 100, tombstonesMax: 100, horizonBuckets: 65_536 }

describe("createEpochs", () => {
  it("next() strictly grows and now() follows it", () => {
    const e = createEpochs(limits)
    const a = e.next()
    const b = e.next()
    expect(b).toBeGreaterThan(a)
    expect(e.now()).toBe(b)
  })

  it("bury after a read started is seen; a read started after is not", () => {
    const e = createEpochs(limits)
    const early = e.now()
    e.bury("o\u0000k")
    expect(e.buriedSince("o\u0000k", early)).toBe(true)
    expect(e.buriedSince("o\u0000other", early)).toBe(false)
    expect(e.buriedSince("o\u0000k", e.now())).toBe(false)
  })

  it("an evicted tombstone raises the horizon of its own bucket only", () => {
    const e = createEpochs({ ...limits, tombstonesMax: 3 })
    const early = e.now()
    e.bury("o\u0000k1")
    e.bury("o\u0000k2")
    e.bury("o\u0000k3")
    e.bury("o\u0000k4") // витісняє k1
    expect(e.evictedSince("o\u0000k1", early)).toBe(true)
    expect(e.evictedSince("o\u0000k2", early)).toBe(false)
    expect(e.evictedSince("o\u0000k1", e.now())).toBe(false)
  })

  it("continuous eviction leaves an untouched bucket's horizon alone", () => {
    const e = createEpochs({ ...limits, seenMax: 10 })
    const early = e.now()
    for (let i = 0; i < 10_000; i++) e.remember(`o\u0000churn-${i}`, 1)
    // 10 000 ключів зачіпають лише частину з 65 536 кошиків
    const untouched = Array.from({ length: 200 }, (_, i) => `o\u0000probe-${i}`)
    const hit = untouched.filter((id) => e.evictedSince(id, early)).length
    expect(hit).toBeLessThan(untouched.length / 2)
  })

  it("remember keeps the maximum version", () => {
    const e = createEpochs(limits)
    e.remember("o\u0000k", 5)
    e.remember("o\u0000k", 3)
    expect(e.seen("o\u0000k")?.version).toBe(5)
    e.remember("o\u0000k", 7)
    expect(e.seen("o\u0000k")?.version).toBe(7)
    expect(e.seen("o\u0000missing")).toBeUndefined()
  })

  it("clear() drops both maps and the horizon", () => {
    const e = createEpochs({ ...limits, seenMax: 1, tombstonesMax: 1 })
    const early = e.now()
    e.remember("o\u0000a", 1)
    e.remember("o\u0000b", 1) // витісняє a
    e.bury("o\u0000c")
    e.bury("o\u0000d") // витісняє c
    expect(e.evictedSince("o\u0000a", early)).toBe(true)
    e.clear()
    expect(e.seen("o\u0000b")).toBeUndefined()
    expect(e.buriedSince("o\u0000d", early)).toBe(false)
    expect(e.evictedSince("o\u0000a", early)).toBe(false)
    expect(e.evictedSince("o\u0000c", early)).toBe(false)
  })
})
