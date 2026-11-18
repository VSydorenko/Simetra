import { createElement, type ReactElement } from "react"
import type { RowState, RowView } from "simetra/data/react"
import { useMessage, type MessageKey } from "../messages"
import { STATE_CELL_WIDTH } from "./geometry"

/** The state a host shows for a row: the row state, or `hidden` over it. */
export type DisplayState = RowState | "hidden"

/**
 * Which state a row shows (P4-D spec §5.4): `hidden` wins over every other
 * state, `stale` included — the core reports a hidden row as `stale` too.
 */
export function displayState(row: RowView): DisplayState {
  if (row.state === "removed") return "removed"
  // Сховування правами — не застарілість: значення такого рядка не показуються
  // взагалі, тож `hidden` перевіряється раніше за стан рядка.
  if (row.hidden === true) return "hidden"
  return row.state
}

const STATE_KEYS: Record<DisplayState, MessageKey | undefined> = {
  synced: undefined,
  pending: "state.pending",
  unknown: "state.unknown",
  failed: "state.failed",
  conflict: "state.conflict",
  stale: "state.stale",
  hidden: "state.hidden",
  removed: "state.removed",
}

/** The message key of a display state; `synced` has none. */
export function stateMessageKey(state: DisplayState): MessageKey | undefined {
  return STATE_KEYS[state]
}

function StateText(props: { messageKey: MessageKey }) {
  return useMessage(props.messageKey)
}

/**
 * The first cell of a list row: the text name of the row state at a fixed
 * width. A state change is announced politely (`aria-live`); `title` carries
 * a hint, e.g. the error code of a failed save.
 */
export function StateCell(props: {
  state: DisplayState
  title?: string
}): ReactElement {
  const key = stateMessageKey(props.state)
  return createElement(
    "span",
    {
      role: "gridcell",
      "aria-live": "polite",
      title: props.title,
      style: {
        flex: "none",
        width: STATE_CELL_WIDTH,
        overflow: "hidden",
      },
    },
    key === undefined ? null : createElement(StateText, { messageKey: key })
  )
}
