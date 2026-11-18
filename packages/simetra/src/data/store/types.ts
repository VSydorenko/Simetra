import type {
  CommandError,
  Filter,
  KnownVersions,
  OrderBy,
} from "simetra/model"
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
   * The row version epoch of the database that answered (P4-B spec §6.2);
   * absent or `null` — the database has none, so versions compare as usual.
   */
  readonly versionEpoch?: string | null
  readonly values: Values
  /**
   * Set on a row a `known` marker stands for (P4-B spec §6.7): the held row
   * the request was built from. Such a row confirms the held one — the
   * store applies it as a marker, never as new values.
   */
  readonly marker?: ServerRow
}

/**
 * The `known` of one read part and the rows it was built from, position by
 * position: a marker answers with its position in `known.keys`.
 */
export interface KnownSnapshot {
  readonly known: KnownVersions
  readonly held: readonly ServerRow[]
}

/** A row of a tabular section of an owner. */
export interface SectionLine {
  readonly key: Key
  readonly values: Values
}

/** What a view reads (P4-B spec §6.2). */
export type ViewSpec =
  | { kind: "keys"; object: ObjectName; keys: readonly Key[] }
  | {
      kind: "card"
      object: ObjectName
      key: Key
      /** Single-target `Ref` attributes whose target rows are read with the card. */
      include?: readonly string[]
    }
  | { kind: "section"; object: ObjectName; owner: Key; section: string }
  | {
      kind: "full"
      object: ObjectName
      where?: Filter
      orderBy?: OrderBy
      include?: readonly string[]
    }
  | {
      kind: "window"
      object: ObjectName
      where?: Filter
      orderBy?: OrderBy
      include?: readonly string[]
    }

/** Row state vocabulary (P4-B spec §6.5). */
export type RowState =
  "synced" | "pending" | "failed" | "conflict" | "unknown" | "stale" | "removed"

/** The state of an own mutation in the journal (P4-B spec §6.5). */
export type MutationState = "pending" | "failed" | "conflict" | "unknown"

/** What a mutation settled with (P4-B spec §7.1); `settled` never rejects. */
export type MutationResult =
  | {
      readonly ok: true
      /**
       * One row per operation: the confirmed row, or `undefined` when the
       * answer carried none that could be shown — no `rows`, a key with a
       * tombstone or a mark newer than the attempt, a re-read that failed.
       */
      readonly rows: readonly (ServerRow | undefined)[]
    }
  /**
   * A refusal: of the server or the transport (`CommandError`), or of the
   * write state before the transport — `DataError` `data.mutation-pending`,
   * `data.journal-full` (P4-B spec §7.1).
   */
  | { readonly ok: false; readonly error: CommandError | DataError }

/** One logical mutation of the data writer (P4-B spec §7.1). */
export interface Mutation {
  /** A local id of this attempt, not the `mutationId` of the envelope. */
  readonly id: string
  readonly settled: Promise<MutationResult>
}

/**
 * The write mode of an own mutation (P4-B spec §7.1). The thin M3 slice has
 * `await` only: the row shows its confirmed values until the answer.
 */
export type WritePolicy = "await"

/**
 * The own mutation of a row with the actions its state allows (P4-B spec
 * §6.5): `failed` — `retry`, `cancel`; `conflict` — `cancel`; `unknown` —
 * `dismiss`; a `removed` row — `cancel` (`dismiss` for `unknown`). `retry`
 * is absent while the values are hidden and after a purge or `removed`
 * erased the fields of the mutation.
 */
export interface RowMutation {
  readonly id: string
  readonly state: MutationState
  readonly error?: CommandError
  /**
   * A new attempt with the same fields and base; `undefined` when the
   * mutation is no longer the one this view showed.
   */
  readonly retry?: () => Mutation | undefined
  /** Drops the mutation: the row shows the confirmed values again. */
  readonly cancel?: () => void
  /** Drops an `unknown` mutation from the row. */
  readonly dismiss?: () => void
}

/** A row as a view shows it; `removed` keeps the place without values. */
export type RowView =
  | {
      readonly key: Key
      readonly state: "removed"
      readonly mutation?: RowMutation
    }
  | {
      readonly key: Key
      readonly version: number
      readonly values: Values
      readonly state: Exclude<RowState, "removed">
      readonly staleFields: readonly string[]
      /**
       * The values are hidden by a mark (the eviction horizon or `Writer.hide`)
       * until a read that started after it; a form shows no draft meanwhile.
       * A row hydrated from an SSR snapshot has no facts of the row: its
       * `version` is the sentinel 0 and it carries no `stale`; the UI must not
       * read either while `hidden` is set.
       */
      readonly hidden?: true
      /**
       * The stored row carries a stale mark — a version below the known one,
       * a version epoch switch not proved since, or a signal gap — whatever
       * `state` shows: a mutation state takes precedence over `stale` (§6.5),
       * the fact stays here. A `hide` is the separate fact `hidden`.
       */
      readonly stale?: true
      /** The own mutation of the row; its state is `state` unless hidden. */
      readonly mutation?: RowMutation
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
  /**
   * The object of the view is marked stale (P4-B spec §10): the server
   * contract of its kernel differs from this build, no write to it passes.
   * Sticky until the page reloads. Present only while true; not to be
   * confused with a `stale` row.
   */
  readonly isStale?: boolean
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
  /** Window only: the list starts at the first row of the sort order. */
  readonly atStart?: boolean
  /**
   * Window only: the number of the composition. It changes only together
   * with a new composition (P4-B spec §6.4), so a list host remounts by it.
   */
  readonly chain?: number
  /** Window only: where the host scrolls when a new chain replaces the old one. */
  readonly target?: "start" | "end" | "keep"
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
  /** Window only (no-op elsewhere): reads the page before the first one. */
  loadBefore(): void
  /** Window only (no-op elsewhere): reads the page after the last one. */
  loadAfter(): void
  /**
   * The rows a list host shows, by index in the composition. Does nothing in
   * the thin M3 slice: the tiers it would drive are #206.
   */
  setVisibleRange(range: { first: number; last: number }): void
}

/**
 * A row of a core snapshot (P4-B spec §6.6). A row with values is a tuple
 * `[values, extra?]`: its key and version are the key and version fields of
 * `values`, so nothing is repeated. A `removed` or `hidden` slot carries no
 * values and no facts of the row (a slot keeps the place, nothing more):
 * the HTML and the first client frame show the same composition without a
 * value leaving the server.
 */
export type RowSlot =
  | readonly [values: Values]
  | readonly [values: Values, extra: RowSlotExtra]
  | {
      readonly key: Key
      readonly state: "removed"
      readonly scope: string | null
    }
  | {
      readonly key: Key
      readonly state: "hidden"
      readonly scope: string | null
    }

/** What a row slot adds to its values; absent when it is all the default. */
export interface RowSlotExtra {
  /** The version epoch of the row, when it is not the object's `epoch`. */
  readonly epoch?: string | null
  /** The row version each lazy field was read with. */
  readonly lazy?: Readonly<Record<string, number>>
  /** The version epoch of a lazy field, when it is not the row's. */
  readonly lazyIn?: Readonly<Record<string, string | null>>
  /** The row carries a stale mark (the epochs of the marks stay on the server). */
  readonly stale?: true
}

/** The rows of one object in a core snapshot. */
export interface ObjectSnapshot {
  /** The version epoch most rows are in; a slot names its own when it differs. */
  readonly epoch: string | null
  readonly slots: readonly RowSlot[]
}

/** One tabular section of one owner in a core snapshot. */
export interface SectionSnapshot {
  readonly owner: Key
  readonly section: string
  /** The values of the lines, in order; a line key is the section's key field. */
  readonly lines: readonly Values[]
  readonly ownerVersion: number
  readonly epoch: string | null
  readonly complete: boolean
  /** The scope of the owner when the lines were read; `"unknown"` — no header then. */
  readonly scope: string | null
  /** A `null` answer after an epoch switch was not ordered with the lines. */
  readonly stale?: true
}

/** The cursor of a window page edge: the sort columns and the key of a row. */
export interface CursorSnapshot {
  readonly values: Values
  readonly key: Key
}

/** The lower bound a window page was read with (P4-B spec §6.4). */
export type LowerSnapshot =
  | { readonly kind: "start" }
  | { readonly kind: "after" | "from"; readonly cursor: CursorSnapshot }

/** The pages of a window in a core snapshot: counts of rows, not keys. */
export interface WindowSnapshot {
  readonly pages: readonly {
    readonly size: number
    readonly lower: LowerSnapshot
    readonly generation: number
  }[]
  readonly chain: number
  readonly target: "start" | "end" | "keep"
  readonly atStart: boolean
  readonly generation: number
  readonly frontier: {
    readonly after?: CursorSnapshot
    readonly before?: CursorSnapshot
  }
}

/**
 * A ready held view in a core snapshot. `layout` and `unshown` are runs
 * `[start, length, …]` of indices into `objects[spec.object].slots`: the
 * rows of the composition in list order, and the rows the view owns without
 * showing (a `full` filter drops them locally). The `include` targets are not
 * listed: they follow from the values of the rows.
 */
export interface SubsetSnapshot {
  readonly spec: ViewSpec
  readonly layout?: readonly number[]
  readonly unshown?: readonly number[]
  readonly window?: WindowSnapshot
  /** `full` and `window` forms: the list reached the end of the order. */
  readonly atEnd?: boolean
  readonly truncated?: true
  /**
   * Section views only: the state of the owner header when the store holds
   * it but no row of the snapshot carries it (the header belongs to a view
   * that is not ready), so `ownerState` is the same on both sides.
   */
  readonly ownerState?: RowState
}

/**
 * The state of a core a client takes over before its first render (P4-B spec
 * §6.6): only what ready held views show — never the journal of mutations,
 * the listeners, the rows nobody owns or the epochs of the session.
 */
export interface CoreSnapshot {
  readonly format: 1
  readonly objects: Readonly<Record<ObjectName, ObjectSnapshot>>
  readonly sections: Readonly<Record<ObjectName, readonly SectionSnapshot[]>>
  readonly subsets: readonly SubsetSnapshot[]
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
  /**
   * The rows of a window page (P4-B spec §6.4: 100). A knob of the core for
   * the model test, which needs small pages; hosts keep the default.
   */
  readonly windowPage: number
  readonly fullLimit: number
  readonly releaseDelayMs: number
  readonly preloadTtlMs: number
  /**
   * After a version epoch switch, visible views are re-read at a moment
   * uniform on `[0, revalidateIntervalMs)` (P4-B spec §6.2): a primary
   * restart switches every client at once. The interval tick itself is B5.
   */
  readonly revalidateIntervalMs: number
  /**
   * The least age of a view's freshness mark for `resume()` to re-read it
   * (P4-B spec §6.3 «Частота»). The default is 15 s, but not above
   * `revalidateIntervalMs`; an explicit value above it is a `TypeError`.
   */
  readonly resumeMinIntervalMs: number
}

export const DEFAULT_CORE_LIMITS: CoreLimits = {
  seenMax: 10_000,
  tombstonesMax: 10_000,
  horizonBuckets: 65_536,
  viewsMax: 200,
  readParallel: 4,
  keysPerRequest: 200,
  fullPageSize: 200,
  windowPage: 100,
  fullLimit: 5_000,
  releaseDelayMs: 1_000,
  preloadTtlMs: 5_000,
  revalidateIntervalMs: 60_000,
  resumeMinIntervalMs: 15_000,
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
   * Applies one answer of a receiver re-read (P4-B spec §6.2): the
   * session gates it once by `versionEpoch` and the epochs of its rows
   * (`acceptEpochs`), so a row of an abandoned epoch discards the whole
   * answer; a discard counts toward the pass of its `commit`, not once per
   * answer. `rows` patch keys that have an owner (a signal brings no new key
   * in); `absent` are keys the answer did not return (`removed`). `"discarded"` — nothing was written:
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
   * Writes the rows of an own command result (P4-B spec §7.2 step 3), and
   * only the journal calls it. A row is written by the version rule only for
   * a key with an owner, whose stored row and session are in `epoch`; it
   * never lifts `hidden`, `removed` or a tombstone. Returns the keys the
   * caller re-reads by key: such a mark, a key or pair tombstone newer than
   * `readEpoch` (the start of the attempt), another epoch. A key without an
   * owner is not returned unless its `epoch` differs from the session's
   * (nothing to write — the answer row stands), nor is a row older than the
   * stored one (the store holds a newer confirmed version).
   */
  writeBack(
    object: ObjectName,
    rows: readonly ServerRow[],
    epoch: string,
    readEpoch: number
  ): readonly Key[]
  /**
   * Hides the values of the keys (rights, the eviction horizon): the only
   * entry point of rights narrowing. The values return only
   * with a read that started after this call, in every view that holds the
   * key — invisible ones, `include` targets and window snapshots included —
   * re-read after the `commit`; a failed re-read leaves them hidden. Stored
   * tabular section lines of the keys are dropped, whether the header is in
   * the store or not. A write-back does not lift the mark. Whether the key
   * is gone for good is `purge`, not `hide`.
   */
  hide(object: ObjectName, keys: readonly Key[]): void
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
