import { NO_DEFECTS, type Defects } from "./defects"
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
  /**
   * Records a version with epoch `next()`: the max with the known one in the
   * same version epoch; a known version of another non-empty version epoch
   * is replaced (P4-B plan B1c, Р5).
   */
  remember(id: string, version: number, versionEpoch: string | null): void
  seen(id: string): Seen | undefined
  /**
   * Gives memory entries without a version epoch the epoch `previous` that a
   * switch left (Р5, Р6): a `null` answer compared with it before the switch,
   * so after it the entry belongs to the old epoch, not to the new one.
   */
  adopt(previous: string): void
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
  /** Sizes of the service maps (inspection); `horizon` counts raised buckets. */
  sizes(): {
    seen: number
    tombstones: number
    horizon: number
    pairBurials: number
  }
}

/** A remembered version, the session epoch it was recorded at and its version epoch. */
export interface Seen {
  readonly version: number
  readonly epoch: number
  /** The version epoch of `version`; `null` — the database has none. */
  readonly versionEpoch: string | null
}

/**
 * Two version epochs that cannot be ordered: both non-empty and different
 * (P4-B plan B1c, Р5, Р6). `null` or absent — a replica or a database without
 * an epoch — compares with any epoch by version as usual.
 */
export function differentEpochs(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return a != null && b != null && a !== b
}

/**
 * The epoch a write keeps in store state (P4-B plan B1c, Р5, Р6): the incoming
 * one, and for a `null` answer (a replica, a database without an epoch) the
 * epoch already held. Every write of an epoch into the store goes through it
 * (guarded by `__tests__/epoch-write-guard.test.ts`).
 */
export function effectiveEpoch(
  incoming: string | null | undefined,
  held: string | null | undefined
): string | null {
  return incoming ?? held ?? null
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
  limits: Pick<CoreLimits, "seenMax" | "tombstonesMax" | "horizonBuckets">,
  defects: Defects = NO_DEFECTS
): Epochs {
  let epoch = 0
  const seen = new Map<string, Seen>()
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
    epochOf: (v: V) => number,
    skipHorizon: () => boolean
  ) {
    while (map.size > max) {
      const oldest = map.entries().next()
      if (oldest.done) return
      map.delete(oldest.value[0])
      if (!skipHorizon()) evicted(oldest.value[0], epochOf(oldest.value[1]))
    }
  }

  // Одне число на об'єкт без LRU: власник ТЧ з невідомим скоупом
  // перевіряється за будь-якою парою об'єкта, і витіснення його не губить.
  const pairBurials = new Map<string, number>()

  // Предикати винесено, щоб `bury`/`remember` не створювали замикання на виклик.
  const skipTombstoneHorizon = () => defects.has("no-horizon-tombstones")
  const skipSeenHorizon = () => defects.has("no-horizon-seen")

  function bury(id: string) {
    const at = ++epoch
    tombstones.delete(id)
    tombstones.set(id, at)
    trim(tombstones, limits.tombstonesMax, (v) => v, skipTombstoneHorizon)
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
    remember(id, version, versionEpoch) {
      const at = ++epoch
      // Версії різних непорожніх епох не впорядковані: запис іншої заміняється.
      const found = seen.get(id)
      const held =
        found === undefined || differentEpochs(found.versionEpoch, versionEpoch)
          ? undefined
          : found
      seen.delete(id)
      seen.set(id, {
        version: Math.max(held?.version ?? -Infinity, version),
        epoch: at,
        versionEpoch: effectiveEpoch(versionEpoch, held?.versionEpoch),
      })
      if (!defects.has("unbounded-seen"))
        trim(seen, limits.seenMax, (v) => v.epoch, skipSeenHorizon)
    },
    seen: (id) => seen.get(id),
    adopt(previous) {
      // Порядок LRU не змінюється: це та сама пам'ять, лише з епохою.
      for (const [id, s] of seen) {
        if (s.versionEpoch !== null) continue
        seen.set(id, { ...s, versionEpoch: effectiveEpoch(null, previous) })
      }
    },
    evictedSince: (id, readEpoch) => (horizon[bucket(id)] ?? 0) > readEpoch,
    clear() {
      seen.clear()
      tombstones.clear()
      horizon.fill(0)
      pairBurials.clear()
    },
    sizes: () => ({
      seen: seen.size,
      tombstones: tombstones.size,
      horizon: horizon.reduce((n, at) => (at > 0 ? n + 1 : n), 0),
      pairBurials: pairBurials.size,
    }),
  }
}
