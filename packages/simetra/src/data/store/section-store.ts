import {
  differentEpochs,
  effectiveEpoch,
  heldEpoch,
  keyId,
  pairId,
} from "./epoch"
import type { RowEntry } from "./object-store"
import type { ObjectStore } from "./object-store"
import type { Scope, Session } from "./session"
import type { Key, ObjectName, SectionLine } from "./types"

/** The owner scope a section entry keeps; `"unknown"` — written without a header. */
export type OwnerScope = string | null | "unknown"

/** Lines of one tabular section of one owner. */
export interface SectionEntry {
  readonly lines: readonly SectionLine[]
  readonly ownerVersion: number
  /** The epoch `ownerVersion` was read in; `null` — the database has none. */
  readonly versionEpoch: string | null
  readonly complete: boolean
  readonly scope: OwnerScope
  /**
   * After a version epoch switch a `null` answer was not ordered with these
   * lines of the current epoch (P4-B plan B1c, Р5, Р13): they are `stale`
   * until the next written answer replaces the entry.
   */
  readonly staleEpoch?: true
}

/**
 * Lines read below the header version, or in another version epoch than the
 * header (versions of different epochs are not ordered).
 */
export function sectionLinesStale(
  lines: SectionEntry,
  header: RowEntry
): boolean {
  return (
    differentEpochs(lines.versionEpoch, header.versionEpoch) ||
    lines.ownerVersion < header.version
  )
}

/** Tabular section lines by (owner, section) (P4-B spec §6.1, §6.2 rule 3). */
export interface SectionStore {
  /**
   * `source: "other"` writes `complete = false` (Рд27). `"stale"` — after a
   * switch a `null` answer met lines of the current epoch: they stay, marked
   * `staleEpoch`, and the caller re-reads the section.
   */
  put(
    scope: Scope,
    owner: Key,
    section: string,
    lines: readonly SectionLine[],
    ownerVersion: number,
    versionEpoch: string | null,
    readEpoch: number,
    ownerScope: OwnerScope,
    source: "owner-section" | "other"
  ): "written" | "rejected" | "stale"
  /**
   * Drops sections of owners of this scope and of owners with unknown scope,
   * by the owner scope captured at `put`. A header that moved into the purged
   * scope after its lines were written is not seen here: the caller
   * (`Writer.purge`) must also call `clearOwner` for every key that
   * `ObjectStore.purgeScope` / `purgeKeys` returns. Returns the owners whose
   * lines were dropped.
   */
  purgeScope(scope: Scope, scopeId: string | null): Key[]
  resetCompleteness(scope: Scope, owner: Key, section: string): void
  clearOwner(scope: Scope, owner: Key): void
  get(owner: Key, section: string): SectionEntry | undefined
  /** Sizes of the owner maps (inspection). */
  sizes(): { owners: number; ownerVersions: number }
}

export function createSectionStore(options: {
  object: ObjectName
  session: Pick<Session, "epochs" | "versions" | "onClose" | "onSwitch">
  rows: Pick<ObjectStore, "get">
}): SectionStore {
  const { object, session, rows } = options
  const { epochs, versions } = session
  const owners = new Map<Key, Map<string, SectionEntry>>()
  // Найбільша бачена `ownerVersion` власника; живе, доки живі його ТЧ:
  // після clearOwner і purge стару відповідь відкидають removed і надгробки.
  // Версії різних непорожніх епох не впорядковані (Р5): запис несе епоху,
  // з якою його прочитано.
  const ownerVersions = new Map<
    Key,
    { version: number; versionEpoch: string | null }
  >()

  session.onClose(() => {
    owners.clear()
    ownerVersions.clear()
  })

  // Перемикання епохи (Р5): записи без епохи читались до нього, тож належать
  // покинутій — відповідь нової їх заміняє, а `null` порівнюється як завжди.
  session.onSwitch((previous) => {
    for (const sections of owners.values()) {
      for (const [name, e] of sections) {
        sections.set(name, {
          ...e,
          versionEpoch: effectiveEpoch(e.versionEpoch, previous),
        })
      }
    }
    for (const [owner, seen] of ownerVersions) {
      ownerVersions.set(owner, {
        ...seen,
        versionEpoch: effectiveEpoch(seen.versionEpoch, previous),
      })
    }
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
    versionEpoch: string | null,
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
    // Власник `removed` показує причину без рядків (§6.2, правило 5): рядки
    // ТЧ не пишуться за будь-якої епохи читання, доки слот не зніме
    // перечитування шапки (П15) — читання ТЧ шапки не відновлює.
    if (e?.removed !== undefined) return true
    const seen = ownerVersions.get(owner)
    if (seen === undefined) return false
    // Нова непорожня епоха заміняє запис старої незалежно від версії.
    if (differentEpochs(seen.versionEpoch, versionEpoch)) return false
    return ownerVersion < seen.version
  }

  return {
    put(
      scope,
      owner,
      section,
      lines,
      ownerVersion,
      versionEpoch,
      readEpoch,
      ownerScope,
      source
    ) {
      scope.assert()
      if (stale(owner, ownerVersion, versionEpoch, readEpoch, ownerScope))
        return "rejected"
      const seen = ownerVersions.get(owner)
      // `null` останньої баченої епохи не змінює (Р6): тримана — запис
      // власника, без нього — епоха шапки в сховищі, а після перемикання
      // без обох — покинута, бо `null` не доводить поточної (Р5).
      const held =
        seen?.versionEpoch ??
        rows.get(owner)?.versionEpoch ??
        versions.previous()
      // Після перемикання `null`-відповідь не впорядкована з даними поточної
      // епохи (Р5): рядки ТЧ не пишуться, а наявні стають `stale` і
      // перечитуються — як рядок шапки. Перечитування — одне на позначку:
      // репліка знову відповіла б `null`.
      if (
        versionEpoch === null &&
        versions.previous() !== null &&
        held === versions.current()
      ) {
        const sections = owners.get(owner)
        const e = sections?.get(section)
        if (sections === undefined || e === undefined || e.staleEpoch)
          return "rejected"
        sections.set(section, {
          ...e,
          versionEpoch: heldEpoch(e.versionEpoch),
          staleEpoch: true,
        })
        return "stale"
      }
      const sections = owners.get(owner) ?? new Map<string, SectionEntry>()
      sections.set(section, {
        lines,
        ownerVersion,
        versionEpoch: effectiveEpoch(versionEpoch, held),
        complete: source === "owner-section",
        scope: ownerScope,
      })
      owners.set(owner, sections)
      ownerVersions.set(
        owner,
        seen === undefined || differentEpochs(seen.versionEpoch, versionEpoch)
          ? {
              version: ownerVersion,
              versionEpoch: effectiveEpoch(versionEpoch, held),
            }
          : {
              version: Math.max(seen.version, ownerVersion),
              versionEpoch: effectiveEpoch(versionEpoch, held),
            }
      )
      return "written"
    },

    purgeScope(scope, scopeId) {
      scope.assert()
      const dropped: Key[] = []
      for (const [owner, sections] of owners) {
        let hit = false
        for (const [name, e] of sections) {
          if (e.scope !== scopeId && e.scope !== "unknown") continue
          sections.delete(name)
          hit = true
        }
        if (hit) dropped.push(owner)
        if (sections.size === 0) drop(owner)
      }
      return dropped
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
    sizes: () => ({ owners: owners.size, ownerVersions: ownerVersions.size }),
  }
}
