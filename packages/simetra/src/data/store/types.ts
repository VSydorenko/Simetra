import type { CommandError, Filter, OrderBy } from "simetra/model"
import type { DataError } from "../errors"

/** Logical object name: `"<kind>.<name>"`. */
export type ObjectName = string

/** Row key: a UUID string. */
export type Key = string

/** Column values of a row, by logical field name. */
export type Values = Readonly<Record<string, unknown>>

/** A confirmed server row: key and version are taken from its values. */
export interface ServerRow {
  readonly key: Key
  readonly version: number
  /**
   * The row version epoch of the database that answered (P4-B plan B1c, Р5);
   * absent or `null` — the database has none, so versions compare as usual.
   */
  readonly versionEpoch?: string | null
  readonly values: Values
}

/** A row of a tabular section of an owner. */
export interface SectionLine {
  readonly key: Key
  readonly values: Values
}

/** What a view reads (P4-B spec §6.2). */
export type ViewSpec =
  | { kind: "keys"; object: ObjectName; keys: readonly Key[] }
  | { kind: "card"; object: ObjectName; key: Key }
  | { kind: "section"; object: ObjectName; owner: Key; section: string }
  | {
      kind: "full"
      object: ObjectName
      where?: Filter
      orderBy?: OrderBy
      include?: readonly string[]
    }

/** Row state vocabulary (P4-B spec §6.5). */
export type RowState =
  "synced" | "pending" | "failed" | "conflict" | "unknown" | "stale" | "removed"

/** A row as a view shows it; `removed` keeps the place without values. */
export type RowView =
  | { readonly key: Key; readonly state: "removed" }
  | {
      readonly key: Key
      readonly version: number
      readonly values: Values
      readonly state: Exclude<RowState, "removed">
      readonly staleFields: readonly string[]
      readonly refs?: Readonly<Record<string, RowView | null>>
    }

/** Why a session or view was closed. */
export type CloseReason =
  "disposed" | "session-changed" | "signed-out" | "subject-changed"

/** The immutable snapshot of one view. */
export interface ViewSnapshot {
  readonly status: "loading" | "ready" | "refreshing" | "error" | "purged"
  /** A server refusal, or a developer error found while loading (`data.full-too-large`). */
  readonly error?: CommandError | DataError
  readonly reason?: CloseReason | "access-changed"
  readonly rows: readonly RowView[]
  readonly hasNewRows: boolean
  readonly needsRefresh: boolean
  readonly section?: {
    readonly ownerVersion: number | undefined
    readonly complete: boolean
    readonly lines: readonly SectionLine[]
    /**
     * The state of the owner header, from the row state vocabulary: `removed`
     * (no lines shown), `stale`, `unknown` when the store has no header.
     */
    readonly ownerState: RowState
  }
  readonly strategy?: "full" | "window"
  readonly truncated?: boolean
  readonly atEnd?: boolean
}

/** A memoized handle of one view form (P4-B spec §6.4). */
export interface ViewHandle {
  /** The immutable snapshot; the same object while the view is unchanged. */
  getSnapshot(): ViewSnapshot
  /**
   * Holds the view and loads it on the first hold; returns the release
   * function (idempotent). Throws `DataError` `data.views-limit` when a new
   * held form would exceed `viewsMax`.
   */
  subscribe(listener: () => void): () => void
  /** A user action: re-reads the view; may change its composition. */
  refresh(): void
  /** A user action: re-reads the view and clears `hasNewRows`. */
  showNew(): void
}

/** A generation token: async branches write only while it is valid. */
export interface GenerationToken {
  readonly valid: boolean
}

/** Limits of the core; defaults in `DEFAULT_CORE_LIMITS`. */
export interface CoreLimits {
  readonly seenMax: number
  readonly tombstonesMax: number
  readonly horizonBuckets: number
  readonly viewsMax: number
  readonly readParallel: number
  readonly keysPerRequest: number
  readonly fullPageSize: number
  readonly fullLimit: number
  readonly releaseDelayMs: number
  readonly preloadTtlMs: number
  /**
   * After a version epoch switch, visible views are re-read at a moment
   * uniform on `[0, revalidateIntervalMs)` (P4-B plan B1c, Р8): a primary
   * restart switches every client at once. The interval tick itself is B5.
   */
  readonly revalidateIntervalMs: number
}

export const DEFAULT_CORE_LIMITS: CoreLimits = {
  seenMax: 10_000,
  tombstonesMax: 10_000,
  horizonBuckets: 65_536,
  viewsMax: 200,
  readParallel: 4,
  keysPerRequest: 200,
  fullPageSize: 200,
  fullLimit: 5_000,
  releaseDelayMs: 1_000,
  preloadTtlMs: 5_000,
  revalidateIntervalMs: 60_000,
}

/** Diagnostic events of the core. */
export type CoreLogEntry =
  | { kind: "full-truncated"; object: ObjectName; limit: number }
  | { kind: "late-response"; what: string }
  | { kind: "listener-failed"; error: unknown }
  | { kind: "removed-restored"; object: ObjectName; count: number }
  | { kind: "horizon-hidden"; object: ObjectName; count: number }

/** A view the signal receiver re-reads (P4-B spec §8.4). */
export interface ActiveView {
  readonly spec: ViewSpec
  /** The composition keys; a card — its key, a section — its owner. */
  readonly keys: readonly Key[]
  readonly visible: boolean
}

/** The only way to change the store (P4-B spec §6.1). */
export interface Writer {
  /**
   * Applies one answer of a receiver re-read (P4-B plan B1c, Р7, Р12): the
   * session gates it once by `versionEpoch` (`acceptEpoch`); a discard counts
   * toward the pass of its `commit`, not once per answer. `rows` patch keys
   * that have an owner (a signal brings no new key in); `absent` are keys the
   * answer did not return (`removed`). `"discarded"` — nothing was written:
   * the answer came from an abandoned epoch, from a read started before a
   * switch, or the session is unavailable.
   */
  apply(
    object: ObjectName,
    answer: { rows: readonly ServerRow[]; absent: readonly Key[] },
    readEpoch: number,
    versionEpoch: string | null
  ): "applied" | "discarded"
  purge(
    object: ObjectName,
    target: { keys: readonly Key[] } | { scope: string | null }
  ): void
  markStale(object: ObjectName, keys: readonly Key[], minVersion: number): void
  /**
   * Marks rows of `channel` (every row when omitted) `stale` from a gap.
   * Marks are kept per channel: a row that moved keeps the mark of its old
   * channel until that channel is cleared, so the receiver must call
   * `clearDisconnected(channel)` also when it unsubscribes a channel.
   */
  markDisconnected(channel?: string): void
  /** Clears the gap mark of `channel`; marks of other channels stay. */
  clearDisconnected(channel: string): void
  markViews(
    object: ObjectName,
    flags: { needsRefresh?: boolean; hasNewRows?: boolean },
    spec?: ViewSpec
  ): void
}
