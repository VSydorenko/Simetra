import { keyId } from "./epoch"
import { lazyFieldStale, visibleRow, type RowEntry } from "./object-store"
import type {
  CloseReason,
  Key,
  ObjectName,
  RowView,
  Values,
  ViewSnapshot,
} from "./types"

/*
 * Знімки виглядів (спека П4-B §6.1 «Знімок рядка — незмінна посилка», §6.5):
 * спільний `RowView` рядка з кешем за ревізією, `refs` вигляду поверх нього
 * і збирання знімка вигляду зі структурним спільним використанням.
 */

const EMPTY_VALUES: Values = Object.freeze({})
const NO_FIELDS: readonly string[] = Object.freeze([])
const NO_ROWS: readonly RowView[] = Object.freeze([])

/** The snapshot of a view that has no data and no subset yet. */
export const LOADING: ViewSnapshot = Object.freeze({
  status: "loading",
  rows: NO_ROWS,
  hasNewRows: false,
  needsRefresh: false,
})

/**
 * The stable empty snapshot of a closed core (§6.1 «Закриття з причиною»),
 * which every handle returns, or of a view whose key was purged (§6.5).
 */
export const purgedSnapshot = (
  reason: CloseReason | "access-changed"
): ViewSnapshot =>
  Object.freeze({
    status: "purged",
    reason,
    rows: NO_ROWS,
    hasNewRows: false,
    needsRefresh: false,
  })

// Значення з декодера — дерева простих об'єктів і масивів: структурна
// рівність дає ту саму посилку після перечитування без змін.
function equalValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  )
    return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  return ka.every(
    (k) =>
      Object.hasOwn(b, k) &&
      equalValue(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k]
      )
  )
}

const sameList = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

/**
 * The view of a store entry, sharing `prev` (and its parts) while nothing
 * shown changed. A slot hidden by the eviction horizon shows no values;
 * `staleFields` are the lazy fields read with an older row version (§6.2
 * rule 2).
 */
export function computeRowView(
  key: Key,
  e: RowEntry,
  lazyFields: readonly string[],
  prev: RowView | undefined
): RowView {
  if (e.removed !== undefined) {
    return prev?.state === "removed"
      ? prev
      : Object.freeze({ key, state: "removed" })
  }
  const shown = visibleRow(e)
  const values = shown ?? EMPTY_VALUES
  const { minVersion, disconnect, seen } = e.stale
  const state =
    minVersion !== undefined || disconnect !== undefined || seen !== undefined
      ? "stale"
      : "synced"
  const stale =
    shown === undefined
      ? NO_FIELDS
      : lazyFields.filter(
          (f) => Object.hasOwn(shown, f) && lazyFieldStale(e, f)
        )
  const base = prev?.state === "removed" ? undefined : prev
  const nextValues =
    base !== undefined && equalValue(base.values, values) ? base.values : values
  const staleFields =
    base !== undefined && sameList(base.staleFields, stale)
      ? base.staleFields
      : stale.length === 0
        ? NO_FIELDS
        : Object.freeze(stale)
  if (
    base !== undefined &&
    base.version === e.version &&
    base.state === state &&
    base.values === nextValues &&
    base.staleFields === staleFields &&
    base.refs === undefined
  )
    return base
  return Object.freeze({
    key,
    version: e.version,
    values: nextValues === values ? Object.freeze({ ...values }) : nextValues,
    state,
    staleFields,
  })
}

/** The row view with the `refs` of a view's `include`, sharing `prev`. */
export function withRefs(
  base: RowView,
  refs: Readonly<Record<string, RowView | null>> | undefined,
  prev: RowView | undefined
): RowView {
  if (base.state === "removed" || refs === undefined) return base
  if (
    prev !== undefined &&
    prev.state !== "removed" &&
    prev.key === base.key &&
    prev.version === base.version &&
    prev.state === base.state &&
    prev.values === base.values &&
    prev.staleFields === base.staleFields &&
    prev.refs !== undefined &&
    Object.keys(refs).every((name) => prev.refs?.[name] === refs[name])
  )
    return prev
  return Object.freeze({ ...base, refs: Object.freeze({ ...refs }) })
}

/**
 * The shared `RowView` cache of the core. A revision and a cached view live
 * only for a key that has a store entry: `get` of a missing entry and
 * `settle` drop both, so the maps never outgrow the store.
 */
export interface RowViews {
  /** Marks a key changed in this `commit`. */
  touch(object: ObjectName, key: Key): void
  /** The revision of a key: a fresh value of one core-wide counter on every touch; 0 — untouched. */
  revision(object: ObjectName, key: Key): number
  get(
    object: ObjectName,
    key: Key,
    e: RowEntry | undefined,
    lazyFields: readonly string[]
  ): RowView | undefined
  /** Keys touched since the last `settle`, by object. */
  dirty(): ReadonlyMap<ObjectName, ReadonlySet<Key>>
  /** Drops revisions and views of touched keys without an entry; clears `dirty`. */
  settle(exists: (object: ObjectName, key: Key) => boolean): void
  /** Ids of every revision and cached view (inspection). */
  ids(): Iterable<{ object: ObjectName; key: Key }>
  /** Sizes of the revision map and the view cache (inspection). */
  sizes(): { revisions: number; views: number }
  clear(): void
}

export function createRowViews(): RowViews {
  let clock = 0
  const revisions = new Map<string, number>()
  const cache = new Map<string, { rev: number; view: RowView }>()
  const parts = new Map<string, { object: ObjectName; key: Key }>()
  const touched = new Map<ObjectName, Set<Key>>()

  const drop = (id: string) => {
    revisions.delete(id)
    cache.delete(id)
    parts.delete(id)
  }

  return {
    touch(object, key) {
      const id = keyId(object, key)
      // Один лічильник на всі ключі: після `settle` ревізія ключа не
      // повторює записаної раніше, тож перевірка дочитування не хибить.
      revisions.set(id, ++clock)
      parts.set(id, { object, key })
      const keys = touched.get(object) ?? new Set<Key>()
      keys.add(key)
      touched.set(object, keys)
    },
    revision: (object, key) => revisions.get(keyId(object, key)) ?? 0,
    get(object, key, e, lazyFields) {
      const id = keyId(object, key)
      if (e === undefined) {
        drop(id)
        return undefined
      }
      const rev = revisions.get(id) ?? 0
      const cached = cache.get(id)
      if (cached !== undefined && cached.rev === rev) return cached.view
      const view = computeRowView(key, e, lazyFields, cached?.view)
      cache.set(id, { rev, view })
      parts.set(id, { object, key })
      return view
    },
    dirty: () => touched,
    settle(exists) {
      for (const [object, keys] of touched) {
        for (const key of keys) {
          if (!exists(object, key)) drop(keyId(object, key))
        }
      }
      touched.clear()
    },
    ids: () => parts.values(),
    sizes: () => ({ revisions: revisions.size, views: cache.size }),
    clear() {
      revisions.clear()
      cache.clear()
      parts.clear()
      touched.clear()
    },
  }
}

/** The parts of a view snapshot before sharing (§6.4). */
export type SnapshotParts = Omit<ViewSnapshot, "rows"> & {
  readonly rows: readonly RowView[]
}

/**
 * Builds the next snapshot of a view: `prev` itself when nothing changed, and
 * `prev.rows` / `prev.section` when those did not change.
 */
export function shareSnapshot(
  prev: ViewSnapshot | undefined,
  next: SnapshotParts
): ViewSnapshot {
  const rows =
    prev !== undefined && sameList(prev.rows, next.rows)
      ? prev.rows
      : next.rows.length === 0
        ? NO_ROWS
        : Object.freeze([...next.rows])
  const section =
    next.section !== undefined &&
    prev?.section !== undefined &&
    prev.section.ownerVersion === next.section.ownerVersion &&
    prev.section.complete === next.section.complete &&
    prev.section.ownerState === next.section.ownerState &&
    prev.section.lines === next.section.lines
      ? prev.section
      : next.section
  if (
    prev !== undefined &&
    prev.status === next.status &&
    prev.error === next.error &&
    prev.reason === next.reason &&
    prev.rows === rows &&
    prev.hasNewRows === next.hasNewRows &&
    prev.needsRefresh === next.needsRefresh &&
    prev.section === section &&
    prev.strategy === next.strategy &&
    prev.truncated === next.truncated &&
    prev.atEnd === next.atEnd
  )
    return prev
  const out: Record<string, unknown> = { ...next, rows, section }
  for (const name of Object.keys(out)) {
    if (out[name] === undefined) delete out[name]
  }
  return Object.freeze(out) as unknown as ViewSnapshot
}
