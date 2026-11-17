import { useMemo } from "react"
import type { CommandError } from "simetra/model"
import type { DataError } from "../errors"
import type {
  CloseReason,
  RowState,
  RowView,
  SectionLine,
  ViewSnapshot,
} from "../store/types"
import { useCoreSource } from "./provider"
import { useViews } from "./views"

export interface UseRowInput {
  /** Logical object name `"<kind>.<name>"`. */
  object: string
  /** The row key. */
  id: string
  /** Tabular sections to read with the header. */
  tabularSections?: readonly string[]
}

/** One tabular section of a card. */
export interface CardSection {
  readonly lines: readonly SectionLine[]
  /** All lines are loaded and belong to the header version shown. */
  readonly complete: boolean
  readonly ownerState: RowState
}

export interface UseRowResult {
  /** The header; `undefined` until it is read, `removed` keeps the place. */
  readonly row: RowView | undefined
  readonly tabularSections: Readonly<Record<string, CardSection>>
  /** The confirmed version of the header. */
  readonly version: number | undefined
  /**
   * `false` while the header is not whole: its version differs from the one
   * of a section, any field is `stale`, a view `needsRefresh`, or the values
   * are `hidden`.
   */
  readonly editable: boolean
  readonly status: ViewSnapshot["status"]
  readonly error?: CommandError | DataError
  readonly reason?: CloseReason | "access-changed"
  readonly needsRefresh: boolean
  /** Always `false` in the thin slice (see `UseRowsResult.isStale`). */
  readonly isStale: boolean
}

// Старшинство стану комбінації виглядів: закрите й помилка важать більше за
// завантаження; `loading` лише тоді, коли шапки ще немає.
const PRECEDENCE = ["purged", "error", "loading", "refreshing"] as const

function combineStatus(
  snapshots: readonly ViewSnapshot[],
  hasRow: boolean
): ViewSnapshot["status"] {
  for (const status of PRECEDENCE) {
    if (snapshots.some((s) => s.status === status)) {
      return status === "loading" && hasRow ? "refreshing" : status
    }
  }
  return "ready"
}

/** One card: the header row and the requested tabular sections. */
export function useRow(input: UseRowInput): UseRowResult {
  const source = useCoreSource()
  const { object, id } = input
  const sections = input.tabularSections ?? []
  const { snapshots } = useViews(
    source,
    () => [
      { kind: "card", object, key: id },
      ...sections.map((section) => ({
        kind: "section" as const,
        object,
        owner: id,
        section,
      })),
    ],
    JSON.stringify([object, id, sections])
  )
  return useMemo(() => {
    const row = snapshots[0]!.rows[0]
    const tabularSections: Record<string, CardSection> = {}
    sections.forEach((name, i) => {
      const section = snapshots[i + 1]?.section
      if (section !== undefined) {
        tabularSections[name] = {
          lines: section.lines,
          complete: section.complete,
          ownerState: section.ownerState,
        }
      }
    })
    const live = row !== undefined && row.state !== "removed" ? row : undefined
    const needsRefresh = snapshots.some((s) => s.needsRefresh)
    const failed = snapshots.find((s) => s.error !== undefined)
    const closed = snapshots.find((s) => s.reason !== undefined)
    return {
      row,
      tabularSections,
      version: live?.version,
      editable:
        live !== undefined &&
        live.hidden === undefined &&
        live.staleFields.length === 0 &&
        !needsRefresh &&
        sections.every(
          (_, i) => snapshots[i + 1]?.section?.ownerVersion === live.version
        ),
      status: combineStatus(snapshots, row !== undefined),
      ...(failed?.error === undefined ? {} : { error: failed.error }),
      ...(closed?.reason === undefined ? {} : { reason: closed.reason }),
      needsRefresh,
      isStale: false,
    }
  }, [snapshots])
}
