import { useVirtualizer } from "@tanstack/react-virtual"
import {
  createElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react"
import type { RowView } from "simetra/data/react"

export interface VirtualListProps {
  /** `rows` of `useRows`. */
  rows: readonly RowView[]
  /** Window only (`useRows`): the edges not reached show a loading slot. */
  atStart?: boolean
  atEnd?: boolean
  /** Window only (`useRows`): a new chain remounts the list. */
  chain?: number
  /** Window only (`useRows`): where a new chain is positioned. */
  target?: "start" | "end" | "keep"
  /** `setVisibleRange` of `useRows`: indices into `rows`, inclusive. */
  setVisibleRange(range: { first: number; last: number }): void
  /** The content of a row slot; `removed` and `hidden` rows come too. */
  renderRow(row: RowView, index: number): ReactNode
  /** The `data-state` of a row slot (P4-D spec §5.5: on the `[data-row-key]` element). */
  rowState?(row: RowView): string
  /** Loading slot content of an edge not reached; empty by default. */
  renderPlaceholder?(edge: "before" | "after"): ReactNode
  /** Row slot height in px: exact when `measure` is off, an estimate otherwise. */
  rowHeight: number
  /** Variable height: slots are measured and the first visible row is anchored. */
  measure?: boolean
  /** Visible height of the scroll area, px; also the server-side viewport. */
  height: number
  /** Server-side viewport width, px (the same range on server and client). */
  initialWidth?: number
  className?: string
}

const OVERSCAN = 6

const noopSubscribe = () => () => {}

interface Anchor {
  key: string
  top: number
}

function readAnchor(node: HTMLElement | null): Anchor | null {
  if (node === null) return null
  const port = node.getBoundingClientRect().top
  for (const row of node.querySelectorAll<HTMLElement>("[data-row-key]")) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > port + 1)
      return { key: row.getAttribute("data-row-key")!, top: rect.top - port }
  }
  return null
}

function readRowTop(node: HTMLElement, key: string): number | null {
  for (const row of node.querySelectorAll<HTMLElement>("[data-row-key]")) {
    if (row.getAttribute("data-row-key") === key)
      return row.getBoundingClientRect().top - node.getBoundingClientRect().top
  }
  return null
}

/**
 * A virtualized list over the rows of `useRows` (P4-B spec §6.4, spike 4 §6).
 * Slots are keyed by the row key and stand under one `translateY`; the
 * virtualizer's own scroll compensation of a grown row is off, the first
 * visible row is anchored in a layout effect instead (one frame, no shift).
 * A new `chain` remounts the list at its `target`.
 */
export function VirtualList(props: VirtualListProps): ReactNode {
  // Новий ланцюжок (перехід, нове сортування) монтує список наново з
  // `initialOffset` цілі: склад і прокрутка змінюються одним commit.
  // `keep` (оновлення) — без перемонтування, місце тримає якір.
  const reset = useRef<{ chain: number; target: string } | null>(null)
  if (
    reset.current === null ||
    (props.chain !== undefined &&
      props.chain !== reset.current.chain &&
      props.target !== "keep")
  )
    reset.current = {
      chain: props.chain ?? 0,
      target: props.target ?? "start",
    }
  return createElement(Scroller, {
    ...props,
    key: reset.current.chain,
    startAt: reset.current.target,
  })
}

function Scroller(props: VirtualListProps & { startAt: string }) {
  const { rows, rowHeight, height, measure = false, setVisibleRange } = props
  const before = props.atStart === false ? 1 : 0
  const after = props.atEnd === false ? 1 : 0
  const count = before + rows.length + after
  const keyAt = useCallback(
    (i: number) =>
      i < before
        ? "@before"
        : i < before + rows.length
          ? String(rows[i - before]!.key)
          : "@after",
    [rows, before]
  )
  const el = useRef<HTMLDivElement | null>(null)
  const initial =
    props.startAt === "end" ? Math.max(0, count * rowHeight - height) : 0
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => el.current,
    estimateSize: () => rowHeight,
    // Типовий вимір без `entry` віддає кешований розмір, тож повторний вимір
    // у layout-ефекті нічого б не змінив: розмір слота читається з розкладки.
    measureElement: (node, entry) =>
      Math.round(
        entry?.borderBoxSize[0]?.blockSize ??
          node.getBoundingClientRect().height
      ),
    getItemKey: keyAt,
    overscan: OVERSCAN,
    // Рендер після прокрутки синхронний: асинхронний дав би порожню смугу.
    useFlushSync: true,
    // SSR і перший клієнтський рендер: той самий прямокутник — той самий
    // діапазон рядків, без зміни DOM після гідратації.
    initialRect: { width: props.initialWidth ?? 1000, height },
    initialOffset: initial,
    // Якір читання за ключем на prepend і обрізання країв.
    anchorTo: "end",
  })
  // Ріст рядка над видимими віртуалізатор компенсує з ResizeObserver, на
  // кадр пізніше за зміну вмісту, а разом із власним якорем нижче — удруге.
  // Компенсацію робить лише власний якір, синхронно. Це властивість
  // екземпляра, не опція: передана як опція, вона мовчки ігнорується.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
  const setEl = useCallback(
    (node: HTMLDivElement | null) => {
      // Новий ланцюжок: позиція цілі — до першого малювання.
      if (node !== null && el.current === null && initial > 0)
        node.scrollTop = node.scrollHeight - node.clientHeight
      el.current = node
    },
    [initial]
  )
  const items = virtualizer.getVirtualItems()

  // Якір читання: перший видимий рядок і його відступ від верху області —
  // під час рендеру (DOM ще попередній); після commit прокрутка повертає
  // його на те саме місце в тому самому кадрі. Покриває зміну вмісту й
  // виміру рядків над видимими.
  const anchor = useRef<Anchor | null>(null)
  anchor.current = measure ? readAnchor(el.current) : null
  useLayoutEffect(() => {
    const a = anchor.current
    const node = el.current
    if (a === null || node === null) return
    // Вимір у тому самому commit, що змінив вміст: корекція йде до
    // малювання, а не з ResizeObserver після нього (інакше один кадр зі
    // зсувом видимих).
    for (const slot of node.querySelectorAll<HTMLElement>("[data-index]"))
      virtualizer.measureElement(slot)
    const top = readRowTop(node, a.key)
    if (top === null) return
    const delta = top - a.top
    if (Math.abs(delta) >= 0.5) node.scrollTop += delta
  })

  // Видимий діапазон — індекси в `rows` (без слотів країв).
  const offset = virtualizer.scrollOffset ?? initial
  let first: number | undefined
  let last: number | undefined
  for (const it of items) {
    if (it.end <= offset || it.start >= offset + height) continue
    const i = it.index - before
    if (i < 0 || i >= rows.length) continue
    first ??= i
    last = i
  }
  // Список, що гідратує серверний HTML, звітує діапазон лише після першої
  // прокрутки: інакше дочитування наступної сторінки змінило б DOM (висоту
  // прокрутки) без дії користувача. Клієнтський монтаж звітує одразу. Серверний
  // знімок `useSyncExternalStore` читається лише під час гідратації, тож
  // `hydrating` визначає екземпляр, а не сторінку; значення фіксується
  // початковим станом, бо після гідратації знімок стає клієнтським.
  const hydrating = useSyncExternalStore(
    noopSubscribe,
    () => false,
    () => true
  )
  const [active, setActive] = useState(() => !hydrating)
  useEffect(() => {
    if (active && first !== undefined && last !== undefined)
      setVisibleRange({ first, last })
  }, [setVisibleRange, first, last, active])

  const lift: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    transform: `translateY(${items[0]?.start ?? 0}px)`,
  }
  const slotStyle: CSSProperties | undefined = measure
    ? undefined
    : // Постійна висота: `removed` і `hidden` не рухають сусідів.
      { height: rowHeight, overflow: "hidden" }
  return createElement(
    "div",
    {
      className: props.className,
      ref: setEl,
      "data-scroll": "list",
      style: { height, overflowY: "auto", overflowAnchor: "none" },
      onScroll: active ? undefined : () => setActive(true),
    },
    createElement(
      "div",
      { style: { height: virtualizer.getTotalSize(), position: "relative" } },
      // Рядки в потоці під одним зсувом: вимір висоти не рухає вже
      // намальованих рядків, лише наступні й загальну висоту.
      createElement(
        "div",
        { style: lift },
        items.map((it) => {
          const i = it.index - before
          const ref = measure ? virtualizer.measureElement : undefined
          if (i < 0 || i >= rows.length)
            return createElement(
              "div",
              {
                key: it.key,
                ref,
                "data-index": it.index,
                "data-loading": i < 0 ? "before" : "after",
                style: slotStyle,
              },
              props.renderPlaceholder?.(i < 0 ? "before" : "after")
            )
          const row = rows[i]!
          return createElement(
            "div",
            {
              key: it.key,
              ref,
              "data-index": it.index,
              "data-row-key": String(row.key),
              "data-state": props.rowState?.(row),
              style: slotStyle,
            },
            props.renderRow(row, i)
          )
        })
      )
    )
  )
}
