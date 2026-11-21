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
  /** A tombstone with the next epoch, or with `at` (a mark's epoch, never lowering a newer tombstone). */
  bury(id: string, at?: number): void
  /**
   * The tombstone epoch is greater than `readEpoch`, or the id is a pair the
   * rights barrier denies and the read started before the barrier.
   */
  buriedSince(id: string, readEpoch: number): boolean
  /**
   * Records a version with epoch `next()`: the max with the known one in the
   * same version epoch; a known version of another non-empty version epoch
   * is replaced (P4-B spec §6.2).
   */
  remember(id: string, version: number, versionEpoch: string | null): void
  seen(id: string): Seen | undefined
  /**
   * Gives memory entries without a version epoch the epoch `previous` that a
   * switch left: a `null` answer compared with it before the switch,
   * so after it the entry belongs to the old epoch, not to the new one.
   */
  adopt(previous: string): void
  /** The horizon of the id's bucket is greater than `readEpoch`. */
  evictedSince(id: string, readEpoch: number): boolean
  /**
   * Records that the key was hidden (`Writer.hide`) at a
   * fresh epoch and returns it. The mark outlives the store entry: a read
   * older than it must not show the row after the entry went away.
   */
  hide(id: string): number
  /** The hide mark of the id is greater than `readEpoch`. */
  hiddenSince(id: string, readEpoch: number): boolean
  /**
   * Buries the pair (scope, object) and records it as the last pair burial of
   * the object; every pair purge goes through it, not through `bury`.
   */
  buryPair(object: string, scope: string | null): void
  /**
   * The epoch of the last `buryPair` of the object (0 — none); under a rights
   * barrier that guards the object, at least its `appliedEpoch`; at least
   * the object's `buryObject` epoch.
   */
  lastPairBurial(object: string): number
  /**
   * Sets the rights barrier of the current snapshot (P4-B spec §6.2 rule 4):
   * a virtual tombstone of every pair the snapshot denies, newer than any
   * read that started before the snapshot was applied. `undefined` — none.
   */
  setBarrier(barrier: PairBarrier | undefined): void
  /**
   * Buries every pair of the object for a read that started before `at`
   * (a snapshot opened pairs that cannot be listed, P4-B spec §6.2 rule 4);
   * never lowers an earlier mark.
   */
  buryObject(object: string, at: number): void
  /** Drops both maps, the horizon and the last pair burials. */
  clear(): void
  /** Sizes of the service maps (inspection); `horizon` counts raised buckets. */
  sizes(): {
    seen: number
    tombstones: number
    hidden: number
    horizon: number
    pairBurials: number
  }
}

/**
 * The rights barrier of one snapshot (P4-B spec §6.2 rule 4). A read that
 * started before `appliedEpoch` may have run before the snapshot's
 * transaction, in any request of the packet: a pair it denies is buried for
 * such a read on the one path both stores ask (`buriedSince`).
 */
export interface PairBarrier {
  /** `epochs.next()` when the snapshot was applied. */
  readonly appliedEpoch: number
  /** The snapshot denies reading the pair (scope, object). */
  denies(object: string, scope: string | null): boolean
  /**
   * The snapshot judges the object's pairs (a rights contract and a scope
   * column): lines of an owner with unknown scope are not written from a
   * read that started before `appliedEpoch`.
   */
  guards(object: string): boolean
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
 * (P4-B spec §6.2). `null` or absent — a replica or a database without
 * an epoch — compares with any epoch by version as usual.
 */
export function differentEpochs(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  return a != null && b != null && a !== b
}

/**
 * The epoch a write keeps in store state (P4-B spec §6.2): the incoming
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

/**
 * The epoch an entry keeps when the store copies its own state (a stale
 * mark, a remembered lower bound): its own epoch, no incoming one. A write of
 * an answer never uses it — `effectiveEpoch` with a literal `null` held epoch
 * is refused by the guard, so the held epoch cannot be dropped by accident.
 */
export function heldEpoch(own: string | null | undefined): string | null {
  return own ?? null
}

/** The epoch id of a key: `"<object>\u0000<key>"`. */
export const keyId = (object: string, key: string): string =>
  `${object}\u0000${key}`

/**
 * The epoch id of a pair (scope, object): `"<object>\u0000scope\u0000<scope>"`;
 * the scope of an unscoped object (`null`) is the empty string.
 */
export const pairId = (object: string, scope: string | null): string =>
  `${object}${PAIR_MARK}${scope ?? ""}`

const PAIR_MARK = "\u0000scope\u0000"

/** The (object, scope) of a pair id; `undefined` for a key id. */
function pairOf(
  id: string
): { object: string; scope: string | null } | undefined {
  const at = id.indexOf(PAIR_MARK)
  // Ключ id має один NUL — одразу за об'єктом; ключ «scope…» з NUL у ньому
  // ядро не створює.
  if (at < 0 || id.indexOf("\u0000") !== at) return undefined
  const scope = id.slice(at + PAIR_MARK.length)
  return { object: id.slice(0, at), scope: scope === "" ? null : scope }
}

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
  const hiddenMarks = new Map<string, number>()
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
  let barrier: PairBarrier | undefined
  // Поховання всіх пар об'єкта (`buryObject`): одне число на об'єкт.
  const objectBurials = new Map<string, number>()

  // Віртуальний надгробок знімка: судить лише читання, що стартувало до
  // застосування знімка (пізніше читання сервер виконав після транзакції
  // знімка — його судила RLS).
  const barred = (id: string, readEpoch: number): boolean => {
    const judging =
      barrier !== undefined && readEpoch < barrier.appliedEpoch
        ? barrier
        : undefined
    if (judging === undefined && objectBurials.size === 0) return false
    const pair = pairOf(id)
    if (pair === undefined) return false
    if (readEpoch < (objectBurials.get(pair.object) ?? 0)) return true
    return judging !== undefined && judging.denies(pair.object, pair.scope)
  }

  // Предикати винесено, щоб `bury`/`remember` не створювали замикання на виклик.
  const skipTombstoneHorizon = () => defects.has("no-horizon-tombstones")
  const skipSeenHorizon = () => defects.has("no-horizon-seen")

  function bury(id: string, markEpoch?: number) {
    // Надгробок із явною епохою (позначка `removed`) не знижує новішого.
    const at =
      markEpoch === undefined
        ? ++epoch
        : Math.max(markEpoch, tombstones.get(id) ?? 0)
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
    lastPairBurial(object) {
      const real = pairBurials.get(object) ?? 0
      const all = Math.max(real, objectBurials.get(object) ?? 0)
      return barrier !== undefined && barrier.guards(object)
        ? Math.max(all, barrier.appliedEpoch)
        : all
    },
    setBarrier(next) {
      barrier = next
    },
    buryObject(object, at) {
      objectBurials.set(object, Math.max(at, objectBurials.get(object) ?? 0))
    },
    buriedSince: (id, readEpoch) =>
      (tombstones.get(id) ?? -1) > readEpoch || barred(id, readEpoch),
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
    hide(id) {
      const at = ++epoch
      hiddenMarks.delete(id)
      hiddenMarks.set(id, at)
      // Та сама межа й той самий горизонт, що в надгробків: витіснена позначка
      // `hide` піднімає горизонт кошика, тож читання, старше за неї, ховається.
      trim(hiddenMarks, limits.tombstonesMax, (v) => v, skipTombstoneHorizon)
      return at
    },
    hiddenSince: (id, readEpoch) => (hiddenMarks.get(id) ?? -1) > readEpoch,
    clear() {
      seen.clear()
      tombstones.clear()
      hiddenMarks.clear()
      horizon.fill(0)
      pairBurials.clear()
      barrier = undefined
      objectBurials.clear()
    },
    sizes: () => ({
      seen: seen.size,
      tombstones: tombstones.size,
      hidden: hiddenMarks.size,
      horizon: horizon.reduce((n, at) => (at > 0 ? n + 1 : n), 0),
      pairBurials: pairBurials.size,
    }),
  }
}
