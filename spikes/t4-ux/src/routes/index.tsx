import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { memo, Profiler, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RowView } from '../core/types'
import { logout } from '../server/fns'
import { breaks } from '../t4/breaks'
import { ensureWindow, LIST, loadMore, refresh, reload } from '../t4/facade'
import { useCore, useHolder, useRows, useWriter } from '../t4/hooks'
import { StateCell, stateClass } from '../ui/StateCell'
import { ROW_H, VIEW_H } from '../ui/styles'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    const core = context.holder.core
    if (!core) throw redirect({ to: '/login' })
    // Вікно вже в ядрі (гідратація або попередній візит) — без запиту.
    await ensureWindow(core)
  },
  component: ProfiledList,
})

// Окремий Profiler зони даних: відрізняє commit-и списку від внутрішніх commit-ів роутера.
function ProfiledList() {
  return (
    <Profiler id="list" onRender={onRegionRender}>
      <ListPage />
    </Profiler>
  )
}

export function onRegionRender(id: string, phase: string) {
  if (typeof window !== 'undefined') ((window as any).__t4Commits ??= []).push({ id, phase, t: performance.now() })
}

const OVERSCAN = 5

function ListPage() {
  const snap = useRows()
  const core = useCore()
  const holder = useHolder()
  const writer = useWriter()
  const navigate = useNavigate()
  const [scrollTop, setScrollTop] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(snap.rows.length, Math.ceil((scrollTop + VIEW_H) / ROW_H) + OVERSCAN)
  const tail = snap.atEnd ? 0 : 1

  useEffect(() => {
    if (core && !snap.atEnd && last >= snap.rows.length - 30) void loadMore(core, holder)
  }, [core, holder, last, snap.rows.length, snap.atEnd])

  // Зламана реалізація: стрибок прокрутки після підвантаження.
  const prevLen = useRef(snap.rows.length)
  useLayoutEffect(() => {
    if (breaks.has('scrolljump') && snap.rows.length > prevLen.current && ref.current) ref.current.scrollTop += ROW_H * 3
    prevLen.current = snap.rows.length
  }, [snap.rows.length])

  const skeleton = snap.status === 'loading' || (breaks.has('skeleton') && snap.status === 'refreshing')
  const rowH = breaks.has('heightjump') && snap.status === 'refreshing' ? ROW_H + 8 : ROW_H

  return (
    <div data-region="list">
      <div className="toolbar">
        <strong>Items</strong>
        {breaks.has('hydration') && <span>{typeof window === 'undefined' ? 'SSR' : 'CSR'}</span>}
        <button data-action="refresh" onClick={() => core && void refresh(core)}>Перечитати</button>
        <button
          data-action="create"
          onClick={() => {
            if (!writer) return
            if (ref.current) ref.current.scrollTop = 0
            void writer.create({ num: -1, name: 'New item', amount: '0.00', status: 'open' })
          }}
        >
          Створити
        </button>
        <span className="slot" data-slot="selection">
          <span className={snap.status === 'refreshing' ? '' : 'hidden'} data-selection="refreshing">Оновлення…</span>
          {snap.hasNewRows || snap.needsRefresh ? (
            <button className="banner" data-action="show-new" onClick={() => core && void reload(core)}>
              {snap.hasNewRows ? 'Є нові рядки — показати' : 'Порядок змінився — оновити'}
            </button>
          ) : null}
        </span>
        <button
          data-action="logout"
          onClick={async () => {
            // Виняток безпеки: дані старого суб'єкта прибираються до будь-якого очікування.
            holder.replace(null)
            await logout()
            await navigate({ to: '/login' })
          }}
        >
          Вийти
        </button>
      </div>
      <div className="list" ref={ref} data-scroll="list" onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        {skeleton ? (
          <div data-skeleton="list" className="placeholder" style={{ padding: 8 }}>
            Завантаження…
          </div>
        ) : (
          <div style={{ height: (snap.rows.length + tail) * rowH, position: 'relative' }}>
            {snap.rows.slice(first, last).map((v, i) => (
              <ListRow key={v.key} view={v} index={first + i} rowH={rowH} onDismiss={() => core?.dismissRemoved(LIST)} onDelete={() => writer?.remove(v.key)} />
            ))}
            {tail ? (
              <div className="row placeholder" data-loading-more style={{ top: snap.rows.length * rowH }}>
                <span />
                <span>{snap.loadingMore ? 'Завантаження…' : ''}</span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

const ListRow = memo(function ListRow(props: { view: RowView; index: number; rowH: number; onDismiss: () => void; onDelete: () => void }) {
  const { view, index, rowH } = props
  const shown = useBrokenDisplay(view)
  if (!shown) return null
  const r = shown.row
  const pf = (f: string) => (view.pendingFields.includes(f) ? 'pf' : undefined)
  return (
    <div className={`row ${stateClass(view)}`} data-row-key={view.key} data-index={index} style={{ top: index * rowH, height: rowH }}>
      <span className="cells" data-field="num">{String(r.num ?? '')}</span>
      <span className="cells">
        <Link to="/items/$id" params={{ id: view.key }} data-field="name" className={pf('name')}>
          {String(r.name ?? '')}
        </Link>
      </span>
      <span className={`cells ${pf('amount') ?? ''}`} data-field="amount">{String(r.amount ?? '')}</span>
      <span className="cells" data-field="status">{String(r.status ?? '')}</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <StateCell view={view} onDismissRemoved={props.onDismiss} />
        {view.state === 'synced' ? (
          <button data-action="delete" onClick={props.onDelete}>
            ×
          </button>
        ) : null}
      </div>
    </div>
  )
})

/** Навмисні поломки показу для тесту оракула; без `?break` повертає view як є. */
export function useBrokenDisplay(view: RowView): RowView | null {
  const prevState = useRef(view.state)
  const lastSynced = useRef(view)
  const [hide, setHide] = useState(false)
  const [revert, setRevert] = useState<RowView | null>(null)
  const transition = prevState.current === 'pending' && view.state === 'synced'
  useLayoutEffect(() => {
    if (transition && breaks.has('flash')) setHide(true)
    if (transition && breaks.has('revert')) setRevert(lastSynced.current)
    prevState.current = view.state
    if (view.state === 'synced') lastSynced.current = view
  })
  useEffect(() => {
    if (hide) setTimeout(() => setHide(false), 30)
    if (revert) setTimeout(() => setRevert(null), 30)
  }, [hide, revert])
  if (hide) return null
  return revert ?? view
}
