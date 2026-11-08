/*
 * Прапорці навмисних дефектів ядра — лише для самотесту чутливості
 * модельного тесту (план П4-B3-2, задача 10): кожен вимикає одне правило
 * ядра в точці, де воно виконується, і модель мусить почервоніти. Набір
 * доступний лише через `inspectCore` (не через `simetra/data`); порожній
 * набір не змінює поведінки.
 */

/** A deliberate defect of the core switched on by the model test's self-check. */
export type DefectFlag =
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
  /** A system re-read rebuilds the composition of the view. */
  | "reread-changes-layout"
  /** A row released by its last owner stays in the store. */
  | "row-without-owner"
  /** `removed` leaves the tabular section lines of the owner. */
  | "removed-keeps-sections"
  /** The revision and cached view of a row outlive the row. */
  | "revision-survives-row"

/** The defect set of a core; empty outside the self-check. */
export type Defects = ReadonlySet<DefectFlag>

export const NO_DEFECTS: Defects = new Set<DefectFlag>()
