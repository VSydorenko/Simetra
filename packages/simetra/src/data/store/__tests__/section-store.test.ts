import { describe, expect, it } from "vitest"
import type { SectionLine } from "../types"
import { harness, K1, K2, K3, row, S, T, type Harness } from "./store-support"

const U = "00000000-0000-4000-8000-0000000000b3"

const LINES: SectionLine[] = [
  { key: "00000000-0000-4000-8000-0000000000c1", values: { qty: 1 } },
]

const putLines = (
  h: Harness,
  owner: string,
  ownerVersion: number,
  options: {
    readEpoch?: number
    ownerScope?: string | null | "unknown"
    source?: "owner-section" | "other"
    lines?: SectionLine[]
  } = {}
) =>
  h.write((s) =>
    h.sections.put(
      s,
      owner,
      "lines",
      options.lines ?? LINES,
      ownerVersion,
      options.readEpoch ?? h.now(),
      options.ownerScope ?? S,
      options.source ?? "owner-section"
    )
  )

describe("SectionStore.put", () => {
  it("writes the lines of an owner-section result as complete", () => {
    const h = harness()
    expect(putLines(h, K1, 1)).toBe("written")
    expect(h.sections.get(K1, "lines")).toEqual({
      lines: LINES,
      ownerVersion: 1,
      complete: true,
      scope: S,
    })
  })

  it("throws outside commit", () => {
    const h = harness()
    let kept: Parameters<Parameters<Harness["write"]>[0]>[0] | undefined
    h.write((s) => (kept = s))
    expect(
      () => kept && h.sections.put(kept, K1, "lines", LINES, 1, 0, S, "other")
    ).toThrow("write scope is closed")
  })

  it("rejects a lower ownerVersion entirely", () => {
    const h = harness()
    putLines(h, K1, 2)
    expect(putLines(h, K1, 1, { lines: [] })).toBe("rejected")
    expect(h.sections.get(K1, "lines")?.lines).toEqual(LINES)
    expect(h.sections.get(K1, "lines")?.ownerVersion).toBe(2)
  })

  it("rejects an owner with a key tombstone newer than the read", () => {
    const h = harness()
    const early = h.now()
    h.write((s) => h.store.purgeKeys(s, [K1]))
    expect(putLines(h, K1, 1, { readEpoch: early })).toBe("rejected")
  })

  it("rejects an owner with a pair tombstone newer than the read", () => {
    const h = harness()
    const early = h.now()
    h.write((s) => h.store.purgeScope(s, S))
    expect(putLines(h, K1, 1, { readEpoch: early, ownerScope: S })).toBe(
      "rejected"
    )
  })

  it("rejects an owner removed after the read started", () => {
    const h = harness()
    h.write((s) => h.store.put(s, row(K1, 1), h.now(), false))
    const early = h.now()
    h.write((s) => h.store.remove(s, K1, h.now()))
    expect(putLines(h, K1, 1, { readEpoch: early })).toBe("rejected")
  })

  it("an owner with unknown scope is rejected by any newer pair tombstone of the object", () => {
    const h = harness()
    const early = h.now()
    h.write((s) => h.store.purgeScope(s, T))
    expect(
      putLines(h, K1, 1, { readEpoch: early, ownerScope: "unknown" })
    ).toBe("rejected")
  })

  it("an owner without an entry from a read older than its bucket horizon is rejected", () => {
    const h = harness({ limits: { seenMax: 1 } })
    const early = h.now()
    for (const key of [K1, K2]) {
      h.write((s) => h.store.put(s, row(key, 1), h.now(), false))
      h.write((s) => h.store.own(s, key))
      h.write((s) => h.store.disown(s, key)) // K2 витісняє пам'ять K1
    }
    expect(putLines(h, K1, 1, { readEpoch: early })).toBe("rejected")
    expect(putLines(h, K1, 1)).toBe("written")
  })

  it("rejects an owner whose stored-scope pair tombstone is newer than the read", () => {
    const h = harness()
    const early = h.now()
    h.write((s) => h.store.purgeScope(s, S))
    h.write((s) => h.store.put(s, row(K1, 1, { org: S }), h.now(), false))
    expect(putLines(h, K1, 1, { readEpoch: early, ownerScope: T })).toBe(
      "rejected"
    )
  })

  // K1 у T; старе читання бачить K1 у S; purge(S), надгробок пари S витіснено.
  const movedUnderHorizon = () => {
    const h = harness({ limits: { tombstonesMax: 1 } })
    h.write((s) => h.store.put(s, row(K1, 1, { org: T }), h.now(), false))
    const early = h.now()
    h.write((s) => h.store.purgeScope(s, S))
    h.write((s) => h.store.purgeScope(s, U))
    return { h, early }
  }

  it("(c) header then section in one commit: lines under a horizon-hidden header are rejected", () => {
    const { h, early } = movedUnderHorizon()
    const results = h.write((s) => [
      h.store.put(s, row(K1, 2, { org: S }), early, false),
      h.sections.put(s, K1, "lines", LINES, 2, early, S, "owner-section"),
    ])
    expect(results).toEqual(["stale-inserted", "rejected"])
    expect(h.sections.get(K1, "lines")).toBeUndefined()
  })

  it("(c) section then header: lines for an owner moving into an evicted pair are rejected", () => {
    const { h, early } = movedUnderHorizon()
    expect(putLines(h, K1, 2, { readEpoch: early, ownerScope: S })).toBe(
      "rejected"
    )
    expect(
      h.write((s) => h.store.put(s, row(K1, 2, { org: S }), early, false))
    ).toBe("stale-inserted")
    expect(h.sections.get(K1, "lines")).toBeUndefined()
  })

  it("a write from another source is not complete", () => {
    const h = harness()
    putLines(h, K1, 1, { source: "other" })
    expect(h.sections.get(K1, "lines")?.complete).toBe(false)
  })
})

describe("SectionStore maintenance", () => {
  it("purgeScope drops sections of owners of that scope and of unknown scope", () => {
    const h = harness()
    putLines(h, K1, 1, { ownerScope: S })
    putLines(h, K2, 1, { ownerScope: "unknown" })
    putLines(h, K3, 1, { ownerScope: T })
    h.write((s) => h.sections.purgeScope(s, S))
    expect(h.sections.get(K1, "lines")).toBeUndefined()
    expect(h.sections.get(K2, "lines")).toBeUndefined()
    expect(h.sections.get(K3, "lines")).toBeDefined()
  })

  it("resetCompleteness clears complete", () => {
    const h = harness()
    putLines(h, K1, 1)
    h.write((s) => h.sections.resetCompleteness(s, K1, "lines"))
    expect(h.sections.get(K1, "lines")?.complete).toBe(false)
    expect(h.sections.get(K1, "lines")?.lines).toEqual(LINES)
  })

  it("clearOwner drops the lines", () => {
    const h = harness()
    putLines(h, K1, 1)
    h.write((s) => h.sections.clearOwner(s, K1))
    expect(h.sections.get(K1, "lines")).toBeUndefined()
  })

  it("session close drops the sections", () => {
    const h = harness()
    putLines(h, K1, 1)
    h.session.close("disposed", () => {})
    expect(h.sections.get(K1, "lines")).toBeUndefined()
  })
})
