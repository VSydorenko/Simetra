import { createElement, type ReactElement } from "react"
import type { UseRowsResult } from "simetra/data/react"
import { useMessage } from "../messages"
import { SELECTION_COUNT_WIDTH, SELECTION_PANEL_HEIGHT } from "./geometry"

/** What the panel reads from `useRows`. */
export type SelectionPanelView = Pick<
  UseRowsResult,
  | "status"
  | "error"
  | "reason"
  | "hasNewRows"
  | "needsRefresh"
  | "isStale"
  | "refresh"
  | "showNew"
>

function Button(props: { label: string; onClick(): void }) {
  return createElement(
    "button",
    { type: "button", onClick: props.onClick },
    props.label
  )
}

/**
 * The selection panel over a list (P4-D spec §5.1): a slot of fixed height
 * with the view status and its actions. No row counter in M3 (ADR-0091); its
 * slot is kept empty so the counter adds no shift later.
 */
export function SelectionPanel(props: {
  view: SelectionPanelView
}): ReactElement {
  const { view } = props
  const refreshing = useMessage("state.refreshing")
  const purged = useMessage("state.purged")
  const showNew = useMessage("action.showNew")
  const refreshList = useMessage("action.refreshList")
  const retry = useMessage("action.retry")
  const reloadPage = useMessage("action.reloadPage")
  const updateRequired = useMessage("app.updateRequired")
  const isPurged = view.status === "purged"
  return createElement(
    "div",
    {
      "data-region": "panel",
      style: {
        display: "flex",
        alignItems: "center",
        height: SELECTION_PANEL_HEIGHT,
        overflow: "hidden",
      },
    },
    // Живі регіони стоять у DOM завжди: скринрідер оголошує зміну вмісту
    // наявного регіону, а не щойно вставлений регіон.
    createElement(
      "span",
      { "aria-live": "polite", "data-panel": "status" },
      view.status === "refreshing" ? refreshing : null,
      view.status === "error" && view.error !== undefined
        ? createElement(
            "span",
            { "data-error": view.error.code },
            view.error.code
          )
        : null
    ),
    view.status === "error"
      ? createElement(Button, { label: retry, onClick: view.refresh })
      : null,
    !isPurged && view.hasNewRows
      ? createElement(Button, { label: showNew, onClick: view.showNew })
      : null,
    !isPurged && view.needsRefresh
      ? createElement(Button, { label: refreshList, onClick: view.refresh })
      : null,
    // `isStale` хука — несумісний клієнт (П4-B §6.4, §10), не застарілість
    // рядка: застарілий рядок показує власна комірка стану.
    view.isStale ? createElement("span", null, updateRequired) : null,
    createElement(
      "span",
      {
        "aria-live": "assertive",
        "data-panel": "security",
        "data-reason": isPurged ? view.reason : undefined,
      },
      isPurged ? purged : null
    ),
    isPurged
      ? createElement(Button, {
          label: reloadPage,
          // Виняток безпеки скидає стан сторінки цілком: перезавантаження —
          // єдина дія, що не лишає в пам'яті нічого від попередньої сесії.
          onClick: () => window.location.reload(),
        })
      : null,
    // Шов #206: місце лічильника — порожнє, але тієї самої ширини.
    createElement("span", {
      "data-slot": "count",
      style: {
        marginInlineStart: "auto",
        flex: "none",
        width: SELECTION_COUNT_WIDTH,
      },
    })
  )
}
