import { useMemo } from "react"
import type { Filter, OrderBy } from "simetra/model"
import type { DataError } from "../errors"
import type { CommandError } from "simetra/model"
import type {
  CloseReason,
  RowView,
  ViewHandle,
  ViewSnapshot,
} from "../store/types"
import { useCoreSource } from "./provider"
import { useViews } from "./views"

export interface UseRowsInput {
  /** Logical object name `"<kind>.<name>"`. */
  object: string
  where?: Filter
  orderBy?: OrderBy
  /** Attributes of a single-target `Ref` whose rows come with each row. */
  include?: readonly string[]
}

/** The result of {@link useRows}: one immutable snapshot and its actions. */
export interface UseRowsResult {
  readonly rows: readonly RowView[]
  readonly status: ViewSnapshot["status"]
  readonly error?: CommandError | DataError
  readonly reason?: CloseReason | "access-changed"
  readonly strategy?: "full" | "window"
  readonly truncated?: boolean
  readonly atStart?: boolean
  readonly atEnd?: boolean
  readonly hasNewRows: boolean
  readonly needsRefresh: boolean
  /**
   * The object is incompatible with the build (P4-B spec §10): no check yet in
   * the thin slice, so always `false`.
   */
  readonly isStale: boolean
  /** Window only: changes with every new composition; a list host remounts by it. */
  readonly chain?: number
  /** Window only: where the host scrolls when a new chain replaces the old one. */
  readonly target?: "start" | "end" | "keep"
  setVisibleRange(range: { first: number; last: number }): void
  loadBefore(): void
  loadAfter(): void
  refresh(): void
  showNew(): void
}

const noop = () => {}

function toResult(
  snapshot: ViewSnapshot,
  handle: ViewHandle | undefined
): UseRowsResult {
  return {
    ...snapshot,
    isStale: false,
    setVisibleRange: handle ? (r) => handle.setVisibleRange(r) : noop,
    loadBefore: handle ? () => handle.loadBefore() : noop,
    loadAfter: handle ? () => handle.loadAfter() : noop,
    refresh: handle ? () => handle.refresh() : noop,
    showNew: handle ? () => handle.showNew() : noop,
  }
}

/**
 * The rows of an object: `full` or `window` by the runtime `residency`. The
 * result is the same object while the view is unchanged; no Suspense.
 */
export function useRows(input: UseRowsInput): UseRowsResult {
  const source = useCoreSource()
  const { object, where, orderBy, include } = input
  const { snapshots, handles } = useViews(
    source,
    (core) => [
      {
        kind: core.residencyOf(object),
        object,
        where,
        orderBy,
        include,
      },
    ],
    JSON.stringify([object, where ?? null, orderBy ?? null, include ?? null])
  )
  const snapshot = snapshots[0]!
  const handle = handles[0]
  return useMemo(() => toResult(snapshot, handle), [snapshot, handle])
}
