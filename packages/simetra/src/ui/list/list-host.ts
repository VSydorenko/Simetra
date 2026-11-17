import {
  createElement,
  useCallback,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactElement,
} from "react"
import { useRows, type RowView, type UseRowsResult } from "simetra/data/react"
import type { CatalogIndex, OrderBy } from "simetra/model"
import { useCatalogEntry, useCatalogIndex } from "../catalog"
import { FieldView, headerColumns, type FieldColumn } from "../fields"
import { useMessage } from "../messages"
import { useNavigation } from "../navigation"
import { LIST_HEIGHT, ROW_HEIGHT } from "./geometry"
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

// after ⑤ (#222): `RowView.mutation` за планом B3-4-Л (Р5, Р7) — і на гілці
// `removed`; до мерджу тип рядка цього поля не має, тож воно читається
// структурно, без власної заміни в T5.
interface RowMutation {
  readonly error?: { readonly code: string }
  readonly cancel?: () => void
}
const mutationOf = (row: RowView): RowMutation | undefined =>
  (row as { readonly mutation?: RowMutation }).mutation

const isObjectRef = (column: FieldColumn) =>
  column.attribute.type === "Ref" &&
  column.attribute.ref !== undefined &&
  column.attribute.enumValues === undefined &&
  column.attribute.pair === undefined

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
  const mutation = mutationOf(row)
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
      { role: "row", "data-state": state, style: rowStyle },
      createElement(StateCell, { state }),
      row.state === "removed"
        ? createElement(
            "button",
            { type: "button", onClick: props.onRemove },
            remove
          )
        : null,
      // after ⑤ (#222): «Скасувати» — дія мутації рядка `removed` (Р7).
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
      "data-state": state,
      style: { ...rowStyle, cursor: "pointer" },
      onClick: open,
      onKeyDown: (event: KeyboardEvent) => {
        if (event.key === "Enter") open()
      },
    },
    createElement(StateCell, {
      state,
      // after ⑤ (#222): код відмови — у підказці комірки (П4-B §6.5).
      title: state === "failed" ? mutation?.error?.code : undefined,
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
  const include = useMemo(
    () =>
      props.include ?? columns.filter(isObjectRef).map((column) => column.name),
    [props.include, columns]
  )
  const orderBy = useMemo<OrderBy>(
    () => props.orderBy ?? [{ attribute: entry.keyName, direction: "asc" }],
    [props.orderBy, entry]
  )
  const view = useRows({
    object,
    orderBy,
    include: include.length === 0 ? undefined : include,
  })

  // `VirtualList` лише показує крайовий слот: дочитування сторінки — справа
  // хоста. Колбек сталий, а вигляд читається з посилання: інакше кожен новий
  // знімок перезапускав би ефект діапазону й дочитування.
  const latest = useRef<UseRowsResult>(view)
  latest.current = view
  const onRange = useCallback((range: { first: number; last: number }) => {
    const v = latest.current
    v.setVisibleRange(range)
    if (v.atEnd === false && range.last >= v.rows.length - 1) v.loadAfter()
    if (v.atStart === false && range.first <= 0) v.loadBefore()
  }, [])

  const openCard = useCallback(
    (key: string) => navigation.openCard(object, key),
    [navigation, object]
  )
  // Виняток безпеки: жодного рядка в тому самому кадрі, навіть якщо знімок
  // ще несе попередні.
  const rows = view.status === "purged" ? [] : view.rows
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
        style: { flex: "none", width: "var(--simetra-state-cell-width)" },
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
