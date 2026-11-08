import { keyId, pairId } from "./epoch"
import type { ObjectStore } from "./object-store"
import type { Scope, Session } from "./session"
import type { Key, ObjectName, SectionLine } from "./types"

/** The owner scope a section entry keeps; `"unknown"` — written without a header. */
export type OwnerScope = string | null | "unknown"

/** Lines of one tabular section of one owner. */
export interface SectionEntry {
  readonly lines: readonly SectionLine[]
  readonly ownerVersion: number
  readonly complete: boolean
  readonly scope: OwnerScope
}

/** Tabular section lines by (owner, section) (P4-B spec §6.1, §6.2 rule 3). */
export interface SectionStore {
  /** `source: "other"` writes `complete = false` (Рд27). */
  put(
    scope: Scope,
    owner: Key,
    section: string,
    lines: readonly SectionLine[],
    ownerVersion: number,
    readEpoch: number,
    ownerScope: OwnerScope,
    source: "owner-section" | "other"
  ): "written" | "rejected"
  /**
   * Drops sections of owners of this scope and of owners with unknown scope,
   * by the owner scope captured at `put`. A header that moved into the purged
   * scope after its lines were written is not seen here: the caller
   * (`Writer.purge`, Task 8) must also call `clearOwner` for every key that
   * `ObjectStore.purgeScope` / `purgeKeys` returns.
   */
  purgeScope(scope: Scope, scopeId: string | null): void
  resetCompleteness(scope: Scope, owner: Key, section: string): void
  clearOwner(scope: Scope, owner: Key): void
  get(owner: Key, section: string): SectionEntry | undefined
}

export function createSectionStore(options: {
  object: ObjectName
  session: Pick<Session, "epochs" | "onClose">
  rows: Pick<ObjectStore, "get">
}): SectionStore {
  const { object, session, rows } = options
  const { epochs } = session
  const owners = new Map<Key, Map<string, SectionEntry>>()
  // Найбільша бачена `ownerVersion` власника; живе, доки живі його ТЧ:
  // після clearOwner і purge стару відповідь відкидають removed і надгробки.
  const ownerVersions = new Map<Key, number>()

  session.onClose(() => {
    owners.clear()
    ownerVersions.clear()
  })

  const pairBuried = (scopeId: string | null, readEpoch: number) =>
    epochs.buriedSince(pairId(object, scopeId), readEpoch)

  function drop(owner: Key) {
    owners.delete(owner)
    ownerVersions.delete(owner)
  }

  function stale(
    owner: Key,
    ownerVersion: number,
    readEpoch: number,
    ownerScope: OwnerScope
  ): boolean {
    const id = keyId(object, owner)
    const e = rows.get(owner)
    // Власника без запису ядро могло забути разом з його надгробком.
    if (e === undefined && epochs.evictedSince(id, readEpoch)) return true
    // Витіснений надгробок пари скоупу власника, якого шапка в сховищі не
    // підтверджує (немає запису чи шапка в іншому скоупі), міг належати purge.
    if (
      ownerScope !== "unknown" &&
      (e === undefined || e.scope !== ownerScope) &&
      epochs.evictedSince(pairId(object, ownerScope), readEpoch)
    )
      return true
    // Шапку сховано горизонтом від цього чи новішого читання: рядки ТЧ з
    // того самого читання показали б те, що шапка ховає.
    if (e?.stale.seen !== undefined && readEpoch < e.stale.seen.epoch)
      return true
    if (epochs.buriedSince(id, readEpoch)) return true
    const lastPair = epochs.lastPairBurial(object)
    if (
      ownerScope === "unknown"
        ? lastPair > readEpoch
        : pairBuried(ownerScope, readEpoch)
    )
      return true
    if (e !== undefined && pairBuried(e.scope, readEpoch)) return true
    if (e?.removed !== undefined && e.removed.epoch > readEpoch) return true
    return ownerVersion < (ownerVersions.get(owner) ?? -Infinity)
  }

  return {
    put(
      scope,
      owner,
      section,
      lines,
      ownerVersion,
      readEpoch,
      ownerScope,
      source
    ) {
      scope.assert()
      if (stale(owner, ownerVersion, readEpoch, ownerScope)) return "rejected"
      const sections = owners.get(owner) ?? new Map<string, SectionEntry>()
      sections.set(section, {
        lines,
        ownerVersion,
        complete: source === "owner-section",
        scope: ownerScope,
      })
      owners.set(owner, sections)
      ownerVersions.set(
        owner,
        Math.max(ownerVersions.get(owner) ?? ownerVersion, ownerVersion)
      )
      return "written"
    },

    purgeScope(scope, scopeId) {
      scope.assert()
      for (const [owner, sections] of owners) {
        for (const [name, e] of sections) {
          if (e.scope === scopeId || e.scope === "unknown")
            sections.delete(name)
        }
        if (sections.size === 0) drop(owner)
      }
    },

    resetCompleteness(scope, owner, section) {
      scope.assert()
      const sections = owners.get(owner)
      const e = sections?.get(section)
      if (sections === undefined || e === undefined) return
      sections.set(section, { ...e, complete: false })
    },

    clearOwner(scope, owner) {
      scope.assert()
      drop(owner)
    },

    get: (owner, section) => owners.get(owner)?.get(section),
  }
}
