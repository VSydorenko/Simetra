// Спайк 4: вікно списку (~100 тис. рядків) на TanStack Virtual над ядром.
// Склад і порядок — з ядра (ланцюжок сторінок); віртуалізатор лише малює.
// Два режими висоти: фіксована (`h=fixed`) і змінна з виміром (`h=var`).
import { createFileRoute, Link, redirect } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  memo,
  Profiler,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react"
import type { OrderBy } from "../../../../packages/simetra/src/model/index"
import {
  ITEM,
  type RowView,
  type ViewHandle,
  type ViewSnapshot,
  type ViewSpec,
} from "../core"
import { breaks } from "../t4/breaks"
import { useCore, useWindowView, useWriter } from "../t4/hooks"
import { StateCell, stateClass } from "../ui/StateCell"
import { ROW_H, VIEW_H } from "../ui/styles"
import { onRegionRender } from "./index"

export const ORDERS: Record<string, OrderBy> = {
  num: [{ attribute: "num", direction: "asc" }],
  name: [{ attribute: "name", direction: "asc" }],
  status: [
    { attribute: "status", direction: "desc", nulls: "last" },
    { attribute: "num", direction: "asc" },
  ],
} as Record<string, OrderBy>

export const winSpec = (order: string): ViewSpec => ({
  kind: "window",
  object: ITEM,
  orderBy: ORDERS[order] ?? ORDERS.num!,
  pageSize: 100,
})

let mountedOnce = false

/** Оцінка висоти рядка змінної висоти (до виміру). */
export const VAR_EST = 58

interface Search {
  order: string
  h: "fixed" | "var"
}

export const Route = createFileRoute("/window")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    order: typeof s.order === "string" && s.order in ORDERS ? s.order : "num",
    h: s.h === "var" ? "var" : "fixed",
  }),
  loaderDeps: ({ search }) => ({ order: search.order }),
  loader: async ({ context, deps }) => {
    const core = context.holder.core
    if (!core) throw redirect({ to: "/login" })
    const spec = winSpec(deps.order)
    // Зміна сортування — дія: новий ланцюжок читається, поки видно старий.
    if (core.view(spec).getSnapshot().status === "loading")
      await core.preload(spec)
  },
  component: () => (
    <Profiler id="list" onRender={onRegionRender}>
      <WindowPage />
    </Profiler>
  ),
})

function WindowPage() {
  const { order, h } = Route.useSearch()
  const [snap, handle, formKey] = useWindowView(winSpec(order))
  const core = useCore()
  const w = snap.window
  // Новий ланцюжок (перехід, нове сортування) монтує список наново з
  // `initialOffset` цілі: склад і прокрутка змінюються одним commit.
  // `keep` (оновлення) — без перемонтування, місце тримає якір.
  const reset = useRef<{ form: string; chain: number; target: string }>(null)
  if (
    reset.current === null ||
    reset.current.form !== formKey ||
    (w !== undefined && w.chain !== reset.current.chain && w.target !== "keep")
  )
    reset.current = {
      form: formKey,
      chain: w?.chain ?? 0,
      target: w?.target ?? "start",
    }
  const refreshing = snap.status === "refreshing"
  return (
    <div data-region="list">
      <div className="toolbar">
        <strong>Window</strong>
        <span className="count" data-slot="count">
          {w ? `${w.pages.length}p` : ""}
        </span>
        {Object.keys(ORDERS).map((o) => (
          <Link
            key={o}
            to="/window"
            search={{ order: o, h }}
            data-action={`order-${o}`}
          >
            {o}
          </Link>
        ))}
        <button data-action="start" onClick={() => handle.goToStart()}>
          ⤒
        </button>
        <button data-action="end" onClick={() => handle.goToEnd()}>
          ⤓
        </button>
        <button data-action="refresh" onClick={() => handle.refresh()}>
          Оновити
        </button>
        <button
          data-action="lazy"
          onClick={() => {
            // Доливання лінивого поля видимих рядків: картки ядра читають
            // `note` і частковим злиттям доливають його в той самий рядок.
            if (!core) return
            for (const el of document.querySelectorAll("[data-row-key]")) {
              const key = el.getAttribute("data-row-key")!
              void core.preload(
                { kind: "card", object: ITEM, key },
                { ttlMs: 60_000 }
              )
            }
          }}
        >
          Ліниві
        </button>
        <span className="slot" data-slot="selection">
          <span
            className={refreshing ? "" : "hidden"}
            data-selection="refreshing"
          >
            Оновлення…
          </span>
          {snap.hasNewRows || snap.needsRefresh ? (
            <button
              className="banner"
              data-action="show-new"
              onClick={() =>
                snap.hasNewRows ? handle.showNew() : handle.refresh()
              }
            >
              {snap.hasNewRows ? "Є нові рядки" : "Список змінився"}
            </button>
          ) : null}
        </span>
      </div>
      <Scroller
        key={`${reset.current.form}#${reset.current.chain}`}
        snap={snap}
        handle={handle}
        variable={h === "var"}
        target={reset.current.target}
      />
    </div>
  )
}

function Scroller(props: {
  snap: ViewSnapshot
  handle: ViewHandle
  variable: boolean
  target: string
}) {
  const { snap, handle, variable } = props
  const rows = snap.rows
  const w = snap.window
  const before = w !== undefined && !w.atStart ? 1 : 0
  const after = w !== undefined && !w.atEnd ? 1 : 0
  const count = before + rows.length + after
  const est = variable ? VAR_EST : ROW_H
  const keyAt = useCallback(
    (i: number) =>
      i < before
        ? "@before"
        : i < before + rows.length
          ? rows[i - before]!.key
          : "@after",
    [rows, before]
  )
  const el = useRef<HTMLDivElement | null>(null)
  // Видима висота області — без рамки (1px з кожного боку).
  const initial =
    props.target === "end" ? Math.max(0, count * est - (VIEW_H - 2)) : 0
  const v = useVirtualizer({
    count,
    getScrollElement: () => el.current,
    estimateSize: () => est,
    getItemKey: keyAt,
    // `asyncrender` — поломка для самотесту оракула: рендер після прокрутки
    // не синхронний і без запасу — порожня смуга.
    overscan: breaks.has("asyncrender") ? 0 : 6,
    useFlushSync: !breaks.has("asyncrender"),
    // SSR і перший клієнтський рендер: той самий прямокутник — той самий
    // діапазон рядків, без зміни DOM після гідратації.
    initialRect: { width: 1000, height: VIEW_H },
    initialOffset: initial,
    // Якір читання за ключем на prepend і обрізання країв (virtual-core
    // 3.19 робить його лише для `end`).
    anchorTo: breaks.has("noanchor") || breaks.has("astart") ? "start" : "end",
  })
  // Ріст рядка над видимими віртуалізатор компенсує з ResizeObserver — на
  // кадр пізніше за зміну вмісту (виміряно: один намальований кадр зі
  // зсувом), а разом із власним якорем нижче — удруге. Компенсацію робить
  // лише власний якір, синхронно. Це властивість екземпляра, не опція.
  v.shouldAdjustScrollPositionOnItemSizeChange = () => false
  // Лише полігон: тести читають стан віртуалізатора.
  if (typeof window !== "undefined") (window as any).__t4Virt = v
  const setEl = useCallback(
    (node: HTMLDivElement | null) => {
      // Новий ланцюжок: позиція цілі — до першого малювання.
      if (node !== null && el.current === null && initial > 0)
        node.scrollTop = node.scrollHeight - node.clientHeight
      el.current = node
    },
    [initial]
  )
  const items = v.getVirtualItems()

  // Якір читання (обхід): перший видимий рядок і його відступ від верху
  // області — до commit (DOM ще попередній), після commit прокрутка
  // повертає його на те саме місце в тому самому кадрі. Покриває зміну
  // вмісту й виміру рядків над видимими; prepend і обрізання країв тримає
  // якір virtual-core (`anchorTo: "end"`), тоді тут різниця 0.
  const anchor = useRef<{ key: string; top: number } | null>(null)
  anchor.current = breaks.has("noanchor") ? null : readAnchor(el.current)
  useLayoutEffect(() => {
    const a = anchor.current
    const node = el.current
    if (a === null || node === null) return
    const now = readRow(node, a.key)
    if (now === null) return
    const delta = now - a.top
    if (Math.abs(delta) >= 0.5) node.scrollTop += delta
  })

  // Видимий діапазон — ключами (індекси зсуваються після prepend/обрізання).
  const offset = v.scrollOffset ?? initial
  let first: string | undefined
  let last: string | undefined
  for (const it of items) {
    if (it.end <= offset || it.start >= offset + VIEW_H) continue
    const i = it.index - before
    if (i < 0 || i >= rows.length) continue
    first ??= rows[i]!.key
    last = rows[i]!.key
  }
  // Перший список сторінки (гідратація SSR) звітує діапазон лише після
  // першої прокрутки: інакше дочитування наступної сторінки змінило б DOM
  // (висоту прокрутки) без дії користувача. Далі — одразу.
  const [active, setActive] = useState(() => mountedOnce)
  useEffect(() => {
    mountedOnce = true
  }, [])
  useEffect(() => {
    if (active && first !== undefined && last !== undefined)
      handle.setVisibleRange(first, last)
  }, [handle, first, last, active])

  const top = items[0]?.start ?? 0
  const lift: CSSProperties = {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    transform: `translateY(${top}px)`,
  }
  return (
    <div
      className="list"
      ref={setEl}
      data-scroll="list"
      style={{ overflowAnchor: "none" }}
      onScroll={active ? undefined : () => setActive(true)}
    >
      <Profiler id="rows" onRender={onRegionRender}>
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {/* Рядки в потоці під одним зсувом: вимір висоти не рухає вже
              намальованих рядків, лише наступні й загальну висоту. */}
          <div style={lift}>
            {items.map((it) => {
              const i = it.index - before
              const measure = variable ? v.measureElement : undefined
              if (i < 0 || i >= rows.length)
                return (
                  <div
                    key={it.key}
                    ref={measure}
                    data-index={it.index}
                    className={`wrow placeholder ${variable ? "var" : ""}`}
                    data-loading={i < 0 ? "before" : "after"}
                  >
                    <span />
                    <span>Завантаження…</span>
                  </div>
                )
              return (
                <WinRow
                  key={it.key}
                  view={rows[i]!}
                  index={it.index}
                  variable={variable}
                  measure={measure}
                />
              )
            })}
          </div>
        </div>
      </Profiler>
    </div>
  )
}

const WinRow = memo(function WinRow(props: {
  view: RowView
  index: number
  variable: boolean
  measure: ((el: Element | null) => void) | undefined
}) {
  const { variable } = props
  const view = useGhostShown(props.view)
  const writer = useWriter()
  const r = view.values
  const removed = view.status.state === "removed"
  const note = r.note
  const busy = view.status.state !== "synced" && view.status.state !== "stale"
  // `highlight` — поломка для самотесту: підсвічування зміни значення на
  // 30 мс (поширений прийом) — спалах тла, який оракул має зловити.
  const [lit, setLit] = useState(false)
  const firstValues = useRef(view.values)
  useEffect(() => {
    if (!breaks.has("highlight") || firstValues.current === view.values) return
    setLit(true)
    const t = setTimeout(() => setLit(false), 30)
    return () => clearTimeout(t)
  }, [view.values])
  // Змінна висота: вимір у тому самому commit, що змінив вміст рядка. Тоді
  // корекція прокрутки для рядка над видимими йде до мікрозадач і малювання,
  // а не з ResizeObserver після нього (інакше один стан — зсув видимих).
  const self = useRef<HTMLDivElement | null>(null)
  const measure = props.measure
  useLayoutEffect(() => {
    if (measure !== undefined && self.current !== null) measure(self.current)
  }, [measure, view.values])
  const setRef = useCallback(
    (node: HTMLDivElement | null) => {
      self.current = node
      measure?.(node)
    },
    [measure]
  )
  return (
    <div
      ref={setRef}
      data-index={props.index}
      className={`wrow ${variable ? "var" : ""} ${stateClass(view)}`}
      style={lit ? { background: "#fff3b0" } : undefined}
      data-row-key={view.key}
      data-ghost={view.ghost ? "1" : undefined}
    >
      <span className="cells" data-field="num">
        {removed ? "" : String(r.num ?? "")}
      </span>
      <span className="cells name">
        <span data-field="name">{removed ? "" : String(r.name ?? "")}</span>
        {variable ? (
          // Лінивому полю зарезервовано рядок фіксованої висоти: доливання
          // не змінює висоти рядка.
          <span className="note" data-field="note">
            {removed ? "" : note === undefined ? "…" : String(note)}
          </span>
        ) : null}
      </span>
      <span className="cells" data-field="amount">
        {removed ? "" : String(r.amount ?? "")}
      </span>
      <span className="cells">
        <button
          data-action="toggle"
          disabled={busy || removed}
          onClick={() =>
            writer?.update(view.key, {
              status: r.status === "open" ? "closed" : "open",
            })
          }
        >
          <span data-field="status">
            {removed ? "" : String(r.status ?? "—")}
          </span>
        </button>
      </span>
      <div className="state-col">
        <StateCell view={view} />
      </div>
    </div>
  )
})

const AS_SHOWN = { state: "synced" } as const

/**
 * Знімок вивантаженої сторінки показується як останній показаний рядок:
 * дочитування за ключами починається ще в запасі, до появи на екрані, тож
 * позначка `stale` на ≈RTT лише блимала б. Позначка з'являється, якщо
 * знімок не оновився за 500 мс (повільна мережа, офлайн).
 */
function useGhostShown(view: RowView): RowView {
  const [late, setLate] = useState(false)
  useEffect(() => {
    if (!view.ghost) {
      setLate(false)
      return
    }
    const t = setTimeout(() => setLate(true), 500)
    return () => clearTimeout(t)
  }, [view.ghost])
  if (!view.ghost || late || view.status.state !== "stale") return view
  return { ...view, status: { ...view.status, ...AS_SHOWN } }
}

function readAnchor(
  node: HTMLDivElement | null
): { key: string; top: number } | null {
  if (node === null) return null
  const port = node.getBoundingClientRect().top
  for (const row of node.querySelectorAll<HTMLElement>("[data-row-key]")) {
    const r = row.getBoundingClientRect()
    if (r.bottom > port + 1)
      return { key: row.getAttribute("data-row-key")!, top: r.top - port }
  }
  return null
}

function readRow(node: HTMLDivElement, key: string): number | null {
  const row = node.querySelector<HTMLElement>(`[data-row-key="${key}"]`)
  return row === null
    ? null
    : row.getBoundingClientRect().top - node.getBoundingClientRect().top
}
