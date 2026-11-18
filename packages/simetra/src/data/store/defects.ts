/*
 * Прапорці навмисних дефектів ядра — лише для самотесту чутливості
 * модельного тесту (спека П4-B §12): кожен вимикає одне правило
 * ядра в точці, де воно виконується, і модель мусить почервоніти. Набір
 * доступний лише через `inspectCore` (не через `simetra/data`); порожній
 * набір не змінює поведінки.
 */

/** A deliberate defect of the core switched on by the model test's self-check. */
export type DefectFlag =
  /** A `version` answer without a divergence lifts the stale-client mark. */
  | "stale-mark-lifts"
  /** `commit` ignores an invalid generation token. */
  | "no-token-check"
  /** The version rule accepts an older row. */
  | "version-decrease"
  /** Purge and release of a removed slot write no tombstone. */
  | "no-tombstone"
  /** An evicted tombstone raises no eviction horizon. */
  | "no-horizon-tombstones"
  /** An evicted version memory entry raises no eviction horizon. */
  | "no-horizon-seen"
  /** A read older than the `removed` mark lifts it when its version is larger. */
  | "removed-by-older-read"
  /** A scope purge selects rows by their values, not by the stored scope. */
  | "purge-by-values"
  /** A purge leaves view loads in flight valid. */
  | "purge-keeps-flights"
  /** A system re-read rebuilds the composition of the view (a window included). */
  | "reread-changes-layout"
  /** A row released by its last owner stays in the store. */
  | "row-without-owner"
  /** `removed` leaves the tabular section lines of the owner. */
  | "removed-keeps-sections"
  /** The revision and cached view of a row outlive the row. */
  | "revision-survives-row"
  /** A purge leaves cards and sections of purged keys alive. */
  | "purge-keeps-views"
  /** A purge marks cards and sections of keys it did not purge as purged. */
  | "purge-marks-unrelated-views"
  /** A repeated "row absent" answer does not move the `removed` mark epoch. */
  | "repeated-remove-keeps-epoch"
  /** A by-key read that finds no row changes nothing. */
  | "absent-row-ignored"
  /** The version memory is never trimmed. */
  | "unbounded-seen"
  /** `revalidate` re-reads the views through a full load. */
  | "system-reread-via-load"
  /** A read that started before `hide` lifts its mark. */
  | "hide-lifted-by-older-read"
  /** A tabular section subset does not go stale on a `hide` of its owner. */
  | "section-ignores-hide"
  /** A window page answer is written without the token of its chain and generation. */
  | "page-without-generation"
  /** A window view keeps a copy of the values and shows it where the store has none. */
  | "window-copies-values"
  /** A dismissed `removed` slot is buried with the current epoch, not the epoch of its mark. */
  | "bury-removed-current-epoch"
  /** The re-check deferred by a load in flight is queued only with listeners. */
  | "recheck-needs-listeners"
  /** An `update` shows its values in the row before the answer. */
  | "predict-before-answer"
  /** The write-back of a `run` row and the settling of its mutation are two `commit`s. */
  | "settle-separate-commit"
  /** A write-back lifts the `hidden` mark of the key. */
  | "write-back-lifts-hidden"
  /** The answer of a cancelled attempt is written. */
  | "answer-after-cancel"
  /** A hidden slot of the SSR snapshot carries the values of its row. */
  | "hidden-values-in-snapshot"
  /** The check after hydration re-reads no visible view. */
  | "hydrate-without-revalidate"
  /** `revalidate` ignores `minAgeMs`: a view with a young freshness mark is re-read. */
  | "min-age-ignored"
  /** `revalidate` ignores `minAgeMs` for tabular section views only. */
  | "min-age-ignored-sections"
  /** `revalidate` treats every view with a freshness mark as young, however old. */
  | "min-age-all-young"
  /** A hydrated view first shown after the reconciliation is not read. */
  | "late-hydrated-not-reread"

/** The defect set of a core; empty outside the self-check. */
export type Defects = ReadonlySet<DefectFlag>

// Заморожений: спільний за замовчуванням набір не можна змінити ззовні.
export const NO_DEFECTS: Defects = Object.freeze(new Set<DefectFlag>())
