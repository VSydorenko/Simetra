import {
  createElement,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactElement,
} from "react"
import { useRows, type RowView, type UseRowsResult } from "simetra/data/react"
import type { CatalogEntry, CatalogIndex, OrderBy } from "simetra/model"
import { useCatalogEntry, useCatalogIndex } from "../catalog"
import { FieldView, headerColumns, type FieldColumn } from "../fields"
import { useMessage } from "../messages"
import { useNavigation } from "../navigation"
import { LIST_HEIGHT, ROW_HEIGHT, STATE_CELL_WIDTH } from "./geometry"
import { SelectionPanel } from "./selection-panel"
import { StateCell, displayState } from "./state-cell"
import { VirtualList } from "./virtual-list"

export interface ListHostProps {
  /** Logical object name `"<kind>.<name>"`. */
  object: string
  /** Sort order; by the key by default. */
  orderBy?: OrderBy
  /** `Ref` attributes whose targets come with the rows; by default every single-target `Ref` column. */
  include?: readonly string[]
}

const isObjectRef = (column: FieldColumn) =>
  column.attribute.type === "Ref" &&
  column.attribute.ref !== undefined &&
  column.attribute.enumValues === undefined &&
  column.attribute.pair === undefined

/**
 * The read of a list: sort order and `include`. One function for the host and
 * the route loader (P4-D spec §6), so the view a loader preloads is the view
 * the host subscribes to.
 */
export function listQuery(
  entry: CatalogEntry,
  options: { orderBy?: OrderBy; include?: readonly string[] } = {}
): { orderBy: OrderBy; include?: readonly string[] } {
  const include =
    options.include ??
    headerColumns(entry)
      .filter(isObjectRef)
      .map((column) => column.name)
  return {
    orderBy: options.orderBy ?? [
      { attribute: entry.keyName, direction: "asc" },
    ],
    ...(include.length === 0 ? {} : { include }),
  }
}

/** What {@link edgeLoader} reads from `useRows`. */
export type EdgeView = Pick<
  UseRowsResult,
  "rows" | "atStart" | "atEnd" | "setVisibleRange" | "loadBefore" | "loadAfter"
>

/**
 * The `setVisibleRange` of a list host: `VirtualList` only shows the edge
 * slots, so the host reads the next page when a not-reached edge is reached by
 * the visible range. Exported for the host tests only.
 */
export function edgeLoader(
  view: () => EdgeView
): (range: { first: number; last: number }) => void {
  return (range) => {
    const v = view()
    v.setVisibleRange(range)
    if (v.atEnd === false && range.last >= v.rows.length - 1) v.loadAfter()
    if (v.atStart === false && range.first <= 0) v.loadBefore()
  }
}

/** Props of one list row; exported for the host tests only. */
export interface ListRowProps {
  row: RowView
  columns: readonly FieldColumn[]
  catalog: CatalogIndex
  onOpen(key: string): void
  onRemove(): void
}

/** One row of {@link ListHost}; not part of the public API. */
export function ListRow(props: ListRowProps): ReactElement {
  const { row } = props
  const remove = useMessage("action.remove")
  const cancel = useMessage("action.cancel")
  const state = displayState(row)
  const mutation = row.mutation
  const rowStyle = {
    display: "flex",
    alignItems: "center",
    height: "100%",
  }
  // `removed` і `hidden` — той самий слот без жодного значення: `hidden` —
  // сховування правами, тож значення рядка не потрапляють навіть у DOM.
  if (row.state === "removed" || state === "hidden") {
    return createElement(
      "div",
      { role: "row", style: rowStyle },
      createElement(StateCell, { state }),
      row.state === "removed"
        ? createElement(
            "button",
            { type: "button", onClick: props.onRemove },
            remove
          )
        : null,
      // «Скасувати» на `removed` — дія мутації рядка (П4-B §6.5): без неї
      // невідправлена правка зникла б разом зі слотом.
      row.state === "removed" && mutation?.cancel !== undefined
        ? createElement(
            "button",
            { type: "button", onClick: mutation.cancel },
            cancel
          )
        : null
    )
  }
  const open = () => props.onOpen(row.key)
  return createElement(
    "div",
    {
      role: "row",
      tabIndex: 0,
      style: { ...rowStyle, cursor: "pointer" },
      onClick: open,
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Enter") open()
      },
    },
    createElement(StateCell, {
      state,
      // Код відмови — у підказці комірки (П4-B §6.5).
      title: state === "failed" ? mutation?.error?.code : undefined,
      stale: row.stale === true,
    }),
    ...props.columns.map((column) => {
      const ref = column.attribute.ref
      const entry =
        ref !== undefined && isObjectRef(column)
          ? props.catalog.byId.get(ref.object)
          : undefined
      return createElement(
        "span",
        { key: column.name, role: "gridcell", style: { flex: 1, minWidth: 0 } },
        createElement(FieldView, {
          attribute: column.attribute,
          value: row.values[column.name],
          target:
            entry === undefined
              ? undefined
              : { row: row.refs?.[column.name] ?? null, entry },
        })
      )
    })
  )
}

/**
 * The standard list of an object (P4-D spec §5.1): the eager header columns
 * of the catalog, a state cell per row and the selection panel. A click or
 * `Enter` on a row opens its card; `removed` and `hidden` rows open nothing.
 * Needs `CatalogProvider`, `NavigationProvider` and `DataRuntimeProvider`.
 */
export function ListHost(props: ListHostProps): ReactElement {
  const { object } = props
  const entry = useCatalogEntry(object)
  const catalog = useCatalogIndex()
  const navigation = useNavigation()
  const loading = useMessage("state.loading")
  const columns = useMemo(() => headerColumns(entry), [entry])
  const query = useMemo(
    () => listQuery(entry, { orderBy: props.orderBy, include: props.include }),
    [entry, props.orderBy, props.include]
  )
  const view = useRows({ object, ...query })

  // Колбек сталий, а вигляд читається з посилання: інакше кожен новий знімок
  // перезапускав би ефект діапазону й дочитування.
  const latest = useRef<UseRowsResult>(view)
  latest.current = view
  const onRange = useMemo(() => edgeLoader(() => latest.current), [])

  const openCard = useCallback(
    (key: string) => navigation.openCard(object, key),
    [navigation, object]
  )
  const rows = view.rows
  const body =
    view.status === "loading" && rows.length === 0
      ? createElement(
          "div",
          { "data-loading": "list", style: { height: LIST_HEIGHT } },
          loading
        )
      : createElement(VirtualList, {
          rows,
          atStart: view.atStart,
          atEnd: view.atEnd,
          chain: view.chain,
          target: view.target,
          setVisibleRange: onRange,
          rowState: displayState,
          rowHeight: ROW_HEIGHT,
          height: LIST_HEIGHT,
          renderRow: (row: RowView) =>
            createElement(ListRow, {
              row,
              columns,
              catalog,
              onOpen: openCard,
              onRemove: view.refresh,
            }),
        })
  return createElement(
    "div",
    { "data-region": "list", "data-object": object, role: "grid" },
    createElement(SelectionPanel, { view }),
    createElement(
      "div",
      { role: "row", style: { display: "flex", height: ROW_HEIGHT } },
      createElement("span", {
        role: "columnheader",
        style: { flex: "none", width: STATE_CELL_WIDTH },
      }),
      ...columns.map((column) =>
        createElement(
          "span",
          {
            key: column.name,
            role: "columnheader",
            style: { flex: 1, minWidth: 0 },
          },
          column.title
        )
      )
    ),
    body
  )
}
