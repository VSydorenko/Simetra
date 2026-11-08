import { describe, expect, it, vi } from "vitest"
import { catalogEntry } from "../../../model/runtime/__tests__/entries"
import { keyId } from "../epoch"
import { mergeVersioned, scopeOf, type RowEntry } from "../object-store"
import {
  harness,
  K1,
  K2,
  K3,
  OBJECT,
  partial,
  row,
  S,
  T,
  type Harness,
} from "./store-support"

const put = (
  h: Harness,
  r: ReturnType<typeof row>,
  readEpoch = h.now(),
  lazyRead = false
) => h.write((s) => h.store.put(s, r, readEpoch, lazyRead))
const remove = (h: Harness, key: string, readEpoch = h.now()) =>
  h.write((s) => h.store.remove(s, key, readEpoch))
const own = (h: Harness, key: string) => h.write((s) => h.store.own(s, key))
const disown = (h: Harness, key: string) =>
  h.write((s) => h.store.disown(s, key))
const purgeScope = (h: Harness, scope: string | null) =>
  h.write((s) => h.store.purgeScope(s, scope))
const purgeKeys = (h: Harness, keys: string[]) =>
  h.write((s) => h.store.purgeKeys(s, keys))
const channelOf = (e: RowEntry) => `ch:${String(e.scope)}`

// Пам'ять версій K1 витісняє K2 (seenMax 1): кошик K1 отримує горизонт.
const evictedK1 = (limits: { horizonBuckets?: number } = {}) => {
  const h = harness({ limits: { seenMax: 1, ...limits } })
  const early = h.now()
  put(h, row(K1, 1))
  own(h, K1)
  disown(h, K1)
  put(h, row(K2, 1))
  own(h, K2)
  disown(h, K2)
  expect(h.session.epochs.seen(keyId(OBJECT, K1))).toBeUndefined()
  return { h, early }
}

describe("mergeVersioned", () => {
  it("drops a lower version", () => {
    expect(mergeVersioned(row(K1, 2), row(K1, 1))).toBeUndefined()
  })

  it("merges an equal version partially", () => {
    const merged = mergeVersioned(
      row(K1, 1, { title: "a", notes: "n" }),
      partial(K1, 1, { title: "b" })
    )
    expect(merged?.values).toMatchObject({ title: "b", notes: "n", org: S })
  })
})

describe("scopeOf (П11)", () => {
  it("reads the attribute whose column is the scope column", () => {
    expect(scopeOf(catalogEntry(), { org: S })).toBe(S)
  })

  it("a scope-kind root is its own scope", () => {
    const root = catalogEntry({ scopeColumn: "id" })
    expect(scopeOf(root, { ref: K1, org: S })).toBe(K1)
  })

  it("an object without a scope column has scope null", () => {
    const flat = catalogEntry({ scopeColumn: undefined })
    expect(scopeOf(flat, { org: S })).toBeNull()
  })
})

describe("ObjectStore.put", () => {
  it("throws outside commit", () => {
    const h = harness()
    let kept: Parameters<Parameters<Harness["write"]>[0]>[0] | undefined
    h.write((s) => (kept = s))
    expect(() => kept && h.store.put(kept, row(K1, 1), 0, false)).toThrow(
      "write scope is closed"
    )
  })

  it("a lower version is rejected", () => {
    const h = harness()
    put(h, row(K1, 2))
    expect(put(h, row(K1, 1))).toBe("rejected")
    expect(h.store.get(K1)?.row?.version).toBe(2)
  })

  it("an equal version merges partially", () => {
    const h = harness()
    put(h, row(K1, 1, { status: "Open" }))
    expect(put(h, partial(K1, 1, { title: "x" }))).toBe("written")
    expect(h.store.get(K1)?.row?.values).toMatchObject({
      title: "x",
      status: "Open",
      org: S,
    })
  })

  it("the first write of a scoped key without the scope column is rejected and goes to the tail", () => {
    const h = harness()
    expect(put(h, partial(K1, 1))).toBe("rejected")
    expect(h.store.get(K1)).toBeUndefined()
    expect(h.store.drainTail()).toEqual([K1])
  })

  it.each([
    ["equal", 1],
    ["higher", 2],
  ])(
    "a late %s version from a read older than removed is rejected and stays without values",
    (_, version) => {
      const h = harness()
      const early = h.now()
      put(h, row(K1, 1))
      remove(h, K1)
      expect(put(h, row(K1, version), early)).toBe("rejected")
      expect(h.store.get(K1)?.row).toBeUndefined()
    }
  )

  it("a read started after removed restores the values", () => {
    const h = harness()
    put(h, row(K1, 1))
    remove(h, K1)
    expect(put(h, row(K1, 1))).toBe("written")
    expect(h.store.get(K1)?.row?.values).toMatchObject({ title: "t1" })
    expect(h.store.get(K1)?.removed).toBeUndefined()
  })

  it("a pair tombstone rejects a row of that pair that was not in the store", () => {
    const h = harness()
    const early = h.now()
    purgeScope(h, S)
    expect(put(h, row(K1, 1), early)).toBe("rejected")
    expect(h.store.get(K1)).toBeUndefined()
  })

  it("a row stored in T and returned in S by a read older than purgeScope(S) is rejected", () => {
    const h = harness()
    put(h, row(K1, 1, { org: T }))
    const early = h.now()
    purgeScope(h, S)
    expect(h.store.get(K1)?.scope).toBe(T)
    expect(put(h, row(K1, 2, { org: S }), early)).toBe("rejected")
    expect(h.store.get(K1)?.scope).toBe(T)
    expect(h.store.get(K1)?.version).toBe(1)
  })

  it("a row inserted in S after purgeScope(S) and returned in T by a read older than the purge is rejected (stored scope)", () => {
    const h = harness()
    const early = h.now()
    purgeScope(h, S)
    put(h, row(K1, 1, { org: S }))
    expect(put(h, row(K1, 2, { org: T }), early)).toBe("rejected")
    expect(put(h, partial(K1, 2), early)).toBe("rejected")
    expect(h.store.get(K1)?.version).toBe(1)
  })

  it("a partial write without the scope column keeps the stored scope", () => {
    const h = harness()
    put(h, row(K1, 1, { org: T }))
    put(h, partial(K1, 2))
    expect(h.store.get(K1)?.scope).toBe(T)
  })

  it("a lower version of an evicted key is stale-inserted with minVersion", () => {
    const h = harness()
    put(h, row(K1, 5))
    own(h, K1)
    disown(h, K1)
    expect(put(h, row(K1, 3))).toBe("stale-inserted")
    expect(h.store.get(K1)?.stale.minVersion?.v).toBe(5)
    expect(h.store.drainTail()).toEqual([K1])
  })

  it("stale-inserted → disown → a new read of the same lower version is stale-inserted again", () => {
    const h = harness()
    put(h, row(K1, 5))
    own(h, K1)
    disown(h, K1)
    put(h, row(K1, 3))
    own(h, K1)
    disown(h, K1)
    expect(put(h, row(K1, 3))).toBe("stale-inserted")
    expect(h.store.get(K1)?.stale.minVersion?.v).toBe(5)
  })

  it("disown remembers the expected minVersion, not the lower stale-inserted version", () => {
    const h = harness({ limits: { seenMax: 1 } })
    put(h, row(K1, 5))
    own(h, K1)
    disown(h, K1)
    put(h, row(K1, 3))
    own(h, K1)
    // K2 витісняє пам'ять K1, поки K1 у сховищі зі stale-вставки
    put(h, row(K2, 1))
    own(h, K2)
    disown(h, K2)
    disown(h, K1)
    expect(put(h, row(K1, 3))).toBe("stale-inserted")
    expect(h.store.get(K1)?.stale.minVersion?.v).toBe(5)
  })

  it("a key without a tombstone from a read older than the horizon is stale-inserted with hidden values", () => {
    const { h, early } = evictedK1()
    expect(put(h, row(K1, 1), early)).toBe("stale-inserted")
    expect(h.store.get(K1)?.stale.seen).toBeDefined()
    expect(h.store.drainTail()).toEqual([K1])
  })

  it("the same key from a read younger than the horizon is written", () => {
    const { h } = evictedK1()
    expect(put(h, row(K1, 1))).toBe("written")
    expect(h.store.get(K1)?.stale.seen).toBeUndefined()
  })

  it("an evicted tombstone with version memory kept: the same version read before the delete is stale-inserted hidden, not synced", () => {
    const h = harness({ limits: { tombstonesMax: 1 } })
    put(h, row(K1, 1))
    own(h, K1)
    disown(h, K1)
    const early = h.now()
    purgeKeys(h, [K1])
    purgeKeys(h, [K2]) // витісняє надгробок K1
    expect(h.session.epochs.seen(keyId(OBJECT, K1))).toBeDefined()
    expect(put(h, row(K1, 1), early)).toBe("stale-inserted")
    expect(h.store.get(K1)?.stale.seen).toBeDefined()
  })

  it("an evicted pair tombstone: a row of that scope not in the store from an older read is stale-inserted hidden", () => {
    const h = harness({ limits: { tombstonesMax: 1 } })
    const early = h.now()
    purgeScope(h, S)
    purgeScope(h, T) // витісняє надгробок пари S
    expect(put(h, row(K1, 1, { org: S }), early)).toBe("stale-inserted")
    expect(h.store.get(K1)?.stale.seen).toBeDefined()
  })

  it("a later read clears the horizon mark", () => {
    const { h, early } = evictedK1()
    put(h, row(K1, 1), early)
    expect(put(h, row(K1, 1))).toBe("written")
    expect(h.store.get(K1)?.stale.seen).toBeUndefined()
  })

  it("logs horizon-hidden once per commit with a count", () => {
    // один кошик: витіснення K1 піднімає горизонт і для K2
    const { h, early } = evictedK1({ horizonBuckets: 1 })
    h.log.length = 0
    h.write((s) => {
      h.store.put(s, row(K1, 1), early, false)
      h.store.put(s, row(K2, 1), early, false)
    })
    expect(h.log).toEqual([
      { kind: "horizon-hidden", object: "Catalog.Task", count: 2 },
    ])
  })

  it("a newer version with lazyRead = false keeps the lazy field with its lower lazy version", () => {
    const h = harness()
    put(h, row(K1, 1, { notes: "n" }), h.now(), true)
    put(h, row(K1, 2))
    const e = h.store.get(K1)
    expect(e?.row?.values.notes).toBe("n")
    expect(e?.lazyVersions.get("notes")).toBe(1)
    expect(e?.version).toBe(2)
  })

  it("two writes in one commit give one notification batch", () => {
    const h = harness()
    const listener = vi.fn()
    h.session.onFlush(listener)
    h.write((s) => {
      h.store.put(s, row(K1, 1), h.now(), false)
      h.store.put(s, row(K2, 1), h.now(), false)
    })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe("ObjectStore.remove (П15)", () => {
  it("erases the header and lazy fields, keeps scope and version", () => {
    const h = harness()
    put(h, row(K1, 3, { org: T, notes: "n" }), h.now(), true)
    remove(h, K1)
    const e = h.store.get(K1)
    expect(e?.row).toBeUndefined()
    expect(e?.lazyVersions.size).toBe(0)
    expect(e?.scope).toBe(T)
    expect(e?.version).toBe(3)
  })

  it("a remove from a read older than the last write still removes, marks divergent and queues the tail", () => {
    const h = harness()
    const early = h.now()
    h.session.epochs.next()
    put(h, row(K1, 1))
    remove(h, K1, early)
    expect(h.store.get(K1)?.row).toBeUndefined()
    expect(h.store.get(K1)?.removed?.divergent).toBe(true)
    expect(h.store.drainTail()).toEqual([K1])
  })

  it("a remove without divergence queues no tail", () => {
    const h = harness()
    put(h, row(K1, 1))
    remove(h, K1)
    expect(h.store.get(K1)?.removed?.divergent).toBe(false)
    expect(h.store.drainTail()).toEqual([])
  })

  it("a truly deleted row gets exactly one re-read with divergence", () => {
    const h = harness()
    const early = h.now()
    h.session.epochs.next()
    put(h, row(K1, 1))
    remove(h, K1, early)
    expect(h.store.drainTail()).toEqual([K1])
    // порожня відповідь самого хвоста: його читання новіше
    remove(h, K1)
    expect(h.store.drainTail()).toEqual([])
    expect(h.store.get(K1)?.removed?.divergent).toBe(false)
  })

  it("a truly deleted row gets no re-read without divergence", () => {
    const h = harness()
    put(h, row(K1, 1))
    remove(h, K1)
    remove(h, K1)
    expect(h.store.drainTail()).toEqual([])
  })

  it("restoring a divergent slot logs removed-restored per commit with a count", () => {
    const h = harness()
    const early = h.now()
    h.session.epochs.next()
    put(h, row(K1, 1))
    put(h, row(K2, 1))
    h.write((s) => {
      h.store.remove(s, K1, early)
      h.store.remove(s, K2, early)
    })
    h.log.length = 0
    h.write((s) => {
      h.store.put(s, row(K1, 1), h.now(), false)
      h.store.put(s, row(K2, 1), h.now(), false)
    })
    expect(h.log).toEqual([
      { kind: "removed-restored", object: "Catalog.Task", count: 2 },
    ])
  })

  it("restoring a non-divergent slot logs nothing", () => {
    const h = harness()
    put(h, row(K1, 1))
    remove(h, K1)
    h.log.length = 0
    put(h, row(K1, 1))
    expect(h.log).toEqual([])
  })

  it("is a no-op for a key with a newer key tombstone", () => {
    const h = harness()
    put(h, row(K1, 1))
    own(h, K1)
    const early = h.now()
    h.session.epochs.bury(keyId(OBJECT, K1))
    remove(h, K1, early)
    expect(h.store.get(K1)?.removed).toBeUndefined()
    expect(h.store.get(K1)?.row).toBeDefined()
  })

  it("is a no-op for a key without an entry", () => {
    const h = harness()
    const before = h.now()
    remove(h, K1)
    expect(h.store.get(K1)).toBeUndefined()
    expect(h.now()).toBe(before)
  })
})

describe("ObjectStore.purge", () => {
  it("purgeScope returns the removed slot too", () => {
    const h = harness()
    put(h, row(K1, 1))
    put(h, row(K2, 1))
    remove(h, K1)
    expect(purgeScope(h, S).sort()).toEqual([K1, K2].sort())
    expect(h.store.get(K1)).toBeUndefined()
  })

  it("a row that moved scopes is not purged with its old scope", () => {
    const h = harness()
    put(h, row(K1, 1, { org: S }))
    put(h, row(K1, 2, { org: T }))
    expect(purgeScope(h, S)).toEqual([])
    expect(h.store.get(K1)?.scope).toBe(T)
  })

  it("a scope-kind root: scopeOf is its id and purgeScope(id) removes it", () => {
    const h = harness({ entry: catalogEntry({ scopeColumn: "id" }) })
    put(h, row(K1, 1))
    expect(h.store.get(K1)?.scope).toBe(K1)
    expect(purgeScope(h, K1)).toEqual([K1])
    expect(h.store.get(K1)).toBeUndefined()
  })

  it("purgeScope buries the keys of the pair: a late read returning the row in another scope is rejected", () => {
    const h = harness()
    put(h, row(K1, 1, { org: S }))
    const early = h.now()
    purgeScope(h, S)
    expect(put(h, row(K1, 2, { org: T }), early)).toBe("rejected")
  })

  it("purgeKeys buries the keys: a late read does not bring them back", () => {
    const h = harness()
    const early = h.now()
    put(h, row(K1, 1))
    expect(purgeKeys(h, [K1, K3])).toEqual([K1])
    expect(put(h, row(K1, 1), early)).toBe("rejected")
    expect(put(h, row(K3, 1), early)).toBe("rejected")
  })
})

describe("ObjectStore.own / disown", () => {
  it("disown of a removed slot leaves a tombstone: an old response returns no values", () => {
    const h = harness()
    const early = h.now()
    put(h, row(K1, 1))
    own(h, K1)
    remove(h, K1)
    disown(h, K1)
    expect(h.store.get(K1)).toBeUndefined()
    expect(put(h, row(K1, 1), early)).toBe("rejected")
    expect(h.store.get(K1)).toBeUndefined()
  })

  it("disown keeps the row while another owner holds it", () => {
    const h = harness()
    put(h, row(K1, 1))
    own(h, K1)
    own(h, K1)
    disown(h, K1)
    expect(h.store.get(K1)?.owners).toBe(1)
  })
})

describe("ObjectStore stale marks", () => {
  it("minVersion is not cleared by a lower version", () => {
    const h = harness()
    put(h, row(K1, 1))
    h.write((s) => h.store.markStale(s, [K1], 3))
    put(h, row(K1, 2))
    expect(h.store.get(K1)?.stale.minVersion).toBeDefined()
  })

  it("minVersion is not cleared by a read started before the mark", () => {
    const h = harness()
    put(h, row(K1, 1))
    const early = h.now()
    h.write((s) => h.store.markStale(s, [K1], 3))
    put(h, row(K1, 3), early)
    expect(h.store.get(K1)?.stale.minVersion).toBeDefined()
  })

  it("minVersion is cleared by a version ≥ v read after the mark", () => {
    const h = harness()
    put(h, row(K1, 1))
    h.write((s) => h.store.markStale(s, [K1], 3))
    put(h, row(K1, 3))
    expect(h.store.get(K1)?.stale.minVersion).toBeUndefined()
  })

  it("disconnect is cleared only by its own channel", () => {
    const h = harness()
    put(h, row(K1, 1, { org: S }))
    put(h, row(K2, 1, { org: T }))
    h.write((s) => h.store.markDisconnected(s, channelOf))
    put(h, row(K2, 2, { org: T }))
    h.write((s) => h.store.clearDisconnected(s, `ch:${S}`, channelOf))
    expect(h.store.get(K1)?.stale.disconnect).toBeUndefined()
    expect(h.store.get(K2)?.stale.disconnect?.channel).toBe(`ch:${T}`)
  })

  it("markDisconnected with a channel marks only rows of that channel", () => {
    const h = harness()
    put(h, row(K1, 1, { org: S }))
    put(h, row(K2, 1, { org: T }))
    h.write((s) => h.store.markDisconnected(s, channelOf, `ch:${T}`))
    expect(h.store.get(K1)?.stale.disconnect).toBeUndefined()
    expect(h.store.get(K2)?.stale.disconnect).toBeDefined()
  })

  it("every mark takes a new epoch", () => {
    const h = harness({ limits: { seenMax: 1 } })
    put(h, row(K1, 1))
    let before = h.now()
    h.write((s) => h.store.markStale(s, [K1], 5))
    expect(h.store.get(K1)?.stale.minVersion?.epoch).toBeGreaterThan(before)
    before = h.now()
    h.write((s) => h.store.markDisconnected(s, channelOf))
    expect(h.store.get(K1)?.stale.disconnect?.epoch).toBeGreaterThan(before)
    before = h.now()
    remove(h, K1)
    expect(h.store.get(K1)?.removed?.epoch).toBeGreaterThan(before)
    const { h: h2, early } = evictedK1()
    before = h2.now()
    put(h2, row(K1, 1), early)
    expect(h2.store.get(K1)?.stale.seen?.epoch).toBeGreaterThan(before)
  })
})

describe("ObjectStore close", () => {
  it("session close drops rows and the tail", () => {
    const h = harness()
    const early = h.now()
    h.session.epochs.next()
    put(h, row(K1, 1))
    remove(h, K1, early)
    h.session.close("disposed", () => {})
    expect(h.store.get(K1)).toBeUndefined()
    expect(h.store.drainTail()).toEqual([])
  })
})
