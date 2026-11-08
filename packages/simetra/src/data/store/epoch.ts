import type { CoreLimits } from "./types"

/**
 * Session epoch counter with key/pair tombstones, version memory and the
 * eviction horizon (P4-B spec §6.1, §6.2 rule 1). Ids are
 * `"<object>\u0000<key>"` for a key and `"<object>\u0000scope\u0000<scope>"`
 * for a pair.
 */
export interface Epochs {
  now(): number
  /** Increments first, then returns. */
  next(): number
  bury(id: string): void
  /** The tombstone epoch is greater than `readEpoch`. */
  buriedSince(id: string, readEpoch: number): boolean
  /** Records a version (max with the known one) with epoch `next()`. */
  remember(id: string, version: number): void
  seen(id: string): { version: number; epoch: number } | undefined
  /** The horizon of the id's bucket is greater than `readEpoch`. */
  evictedSince(id: string, readEpoch: number): boolean
  /**
   * Buries the pair (scope, object) and records it as the last pair burial of
   * the object; every pair purge goes through it, not through `bury`.
   */
  buryPair(object: string, scope: string | null): void
  /** The epoch of the last `buryPair` of the object (0 — none). */
  lastPairBurial(object: string): number
  /** Drops both maps, the horizon and the last pair burials. */
  clear(): void
}

/** The epoch id of a key: `"<object>\u0000<key>"`. */
export const keyId = (object: string, key: string): string =>
  `${object}\u0000${key}`

/**
 * The epoch id of a pair (scope, object): `"<object>\u0000scope\u0000<scope>"`;
 * the scope of an unscoped object (`null`) is the empty string.
 */
export const pairId = (object: string, scope: string | null): string =>
  `${object}\u0000scope\u0000${scope ?? ""}`

// FNV-1a 32 біти: стабільний хеш, тож один id завжди в одному кошику.
function fnv1a(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function createEpochs(
  limits: Pick<CoreLimits, "seenMax" | "tombstonesMax" | "horizonBuckets">
): Epochs {
  let epoch = 0
  const seen = new Map<string, { version: number; epoch: number }>()
  const tombstones = new Map<string, number>()
  // Горизонт за хеш-кошиками, а не глобальний: на безперервному витісненні
  // вікна глобальна межа робила б `stale` майже кожну відповідь.
  const horizon = new Uint32Array(limits.horizonBuckets)
  const bucket = (id: string) => fnv1a(id) % limits.horizonBuckets

  const evicted = (id: string, at: number) => {
    const b = bucket(id)
    if (at > (horizon[b] ?? 0)) horizon[b] = at
  }

  // Map зберігає порядок вставки: перший ключ — найстаріший (LRU за вставкою).
  function trim<V>(
    map: Map<string, V>,
    max: number,
    epochOf: (v: V) => number
  ) {
    while (map.size > max) {
      const oldest = map.entries().next()
      if (oldest.done) return
      map.delete(oldest.value[0])
      evicted(oldest.value[0], epochOf(oldest.value[1]))
    }
  }

  // Одне число на об'єкт без LRU: власник ТЧ з невідомим скоупом
  // перевіряється за будь-якою парою об'єкта, і витіснення його не губить.
  const pairBurials = new Map<string, number>()

  function bury(id: string) {
    const at = ++epoch
    tombstones.delete(id)
    tombstones.set(id, at)
    trim(tombstones, limits.tombstonesMax, (v) => v)
  }

  return {
    now: () => epoch,
    next: () => ++epoch,
    bury,
    buryPair(object, scope) {
      bury(pairId(object, scope))
      pairBurials.set(object, epoch)
    },
    lastPairBurial: (object) => pairBurials.get(object) ?? 0,
    buriedSince: (id, readEpoch) => (tombstones.get(id) ?? -1) > readEpoch,
    remember(id, version) {
      const at = ++epoch
      const known = seen.get(id)?.version ?? -Infinity
      seen.delete(id)
      seen.set(id, { version: Math.max(known, version), epoch: at })
      trim(seen, limits.seenMax, (v) => v.epoch)
    },
    seen: (id) => seen.get(id),
    evictedSince: (id, readEpoch) => (horizon[bucket(id)] ?? 0) > readEpoch,
    clear() {
      seen.clear()
      tombstones.clear()
      horizon.fill(0)
      pairBurials.clear()
    },
  }
}
