import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { memo, Profiler, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { RowView } from '../core'
import { logout } from '../server/fns'
import { breaks } from '../t4/breaks'
import { LIST, rereadVisible } from '../t4/facade'
import { useCore, useHolder, useRows, useWriter } from '../t4/hooks'
import { StateCell, stateClass } from '../ui/StateCell'
import { ROW_H, VIEW_H } from '../ui/styles'

export const Route = createFileRoute('/')({
  loader: async ({ context }) => {
    const core = context.holder.core
    if (!core) throw redirect({ to: '/login' })
    // Вигляд уже в ядрі (гідратація або попередній візит у межах releaseDelayMs) — без запиту.
    if (core.view(LIST).getSnapshot().status === 'loading') await core.preload(LIST)
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

export function onRegionRender(id: string, phase: string, actualDuration?: number) {
  if (typeof window !== 'undefined') ((window as any).__t4Commits ??= []).push({ id, phase, t: performance.now(), d: actualDuration })
}

const OVERSCAN = 5

function ListPage() {
  const [snap, handle] = useRows()
  const core = useCore()
  const holder = useHolder()
  const writer = useWriter()
  const navigate = useNavigate()
  const [scrollTop, setScrollTop] = useState(0)
  const [reread, setReread] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const atEnd = snap.window?.atEnd ?? true

  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const last = Math.min(snap.rows.length, Math.ceil((scrollTop + VIEW_H) / ROW_H) + OVERSCAN)
  const tail = atEnd ? 0 : 1

  useEffect(() => {
    if (!atEnd && snap.rows.length > 0 && last >= snap.rows.length - 30) handle.loadAfter()
  }, [handle, last, snap.rows.length, atEnd])

  // Зламана реалізація: стрибок прокрутки після підвантаження.
  const prevLen = useRef(snap.rows.length)
  useLayoutEffect(() => {
    if (breaks.has('scrolljump') && snap.rows.length > prevLen.current && ref.current) ref.current.scrollTop += ROW_H * 3
    prevLen.current = snap.rows.length
  }, [snap.rows.length])

  const refreshing = snap.status === 'refreshing' || reread
  const skeleton = (snap.status === 'loading' && snap.rows.length === 0) || (breaks.has('skeleton') && refreshing)
  const rowH = breaks.has('heightjump') && refreshing ? ROW_H + 8 : ROW_H

  return (
    <div data-region="list">
      <div className="toolbar">
        <strong>Items</strong>
        {breaks.has('hydration') && <span>{typeof window === 'undefined' ? 'SSR' : 'CSR'}</span>}
        <button
          data-action="reread"
          onClick={async () => {
            if (!core) return
            setReread(true)
            await rereadVisible(core)
            // Зламана реалізація: перечитування саме змінює склад і порядок.
            if (breaks.has('reorder')) handle.showNew()
            setReread(false)
          }}
        >
          Перечитати
        </button>
        <button
          data-action="create"
          onClick={() => {
            if (!writer) return
            if (ref.current) ref.current.scrollTop = 0
            void writer.create({ num: 5, name: 'New item', amount: '0.00', status: 'open' })
          }}
        >
          Створити
        </button>
        <span className="slot" data-slot="selection">
          <span className={refreshing ? '' : 'hidden'} data-selection="refreshing">
            Оновлення…
          </span>
          {snap.hasNewRows || snap.needsRefresh ? (
            <button className="banner" data-action="show-new" onClick={() => (snap.hasNewRows ? handle.showNew() : handle.refresh())}>
              {snap.hasNewRows ? 'Є нові рядки — показати' : 'Список змінився — оновити'}
            </button>
          ) : null}
        </span>
        <button
          data-action="logout"
          onClick={async () => {
            // Виняток безпеки: дані старого суб'єкта прибираються до будь-якого очікування.
            if (!breaks.has('keepcore')) holder.replace(null)
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
              <ListRow key={v.key} view={v} index={first + i} rowH={rowH} onDismiss={() => handle.refresh()} />
            ))}
            {tail ? (
              // Слот «далі» прив'язаний до позиції: після підвантаження старий слот
              // замінюють рядки, а новий з'являється нижче — нічого не переїжджає.
              <div key={`more-${snap.rows.length}`} className="row placeholder" data-loading-more style={{ top: snap.rows.length * rowH }}>
                <span />
                <span>Завантаження…</span>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

const ListRow = memo(function ListRow(props: { view: RowView; index: number; rowH: number; onDismiss: () => void }) {
  const { view, index, rowH } = props
  const writer = useWriter()
  const shown = useBrokenDisplay(view)
  if (!shown) return null
  const r = shown.values
  const pf = (f: string) => (view.status.pendingFields.includes(f) ? 'pf' : undefined)
  const busy = view.status.state !== 'synced' && view.status.state !== 'stale'
  return (
    <div className={`row ${stateClass(view)}`} data-row-key={view.key} data-index={index} style={{ top: index * rowH, height: rowH }}>
      <span className="cells" data-field="num">{String(r.num ?? '')}</span>
      <span className="cells">
        <Link to="/items/$id" params={{ id: view.key }} data-field="name" className={pf('name')}>
          {String(r.name ?? '')}
        </Link>
      </span>
      <span className={`cells ${pf('amount') ?? ''}`} data-field="amount">{String(r.amount ?? '')}</span>
      <span className={`cells ${pf('status') ?? ''}`}>
        <button data-action="toggle" disabled={busy} onClick={() => writer?.update(view.key, { status: r.status === 'open' ? 'closed' : 'open' })}>
          <span data-field="status">{String(r.status ?? '')}</span>
        </button>
      </span>
      <div className="state-col">
        <StateCell view={view} onDismissRemoved={props.onDismiss} />
        {/* Слот дії «видалити» фіксований: поява/зникнення не зсуває комірку стану. */}
        <button data-action="delete" className={view.status.state === 'synced' ? '' : 'hidden'} onClick={() => writer?.remove(view.key)}>
          ×
        </button>
      </div>
    </div>
  )
})

/** Навмисні поломки показу для тесту оракула; без `?break` повертає view як є. */
export function useBrokenDisplay(view: RowView): RowView | null {
  const prevState = useRef(view.status.state)
  const lastSynced = useRef(view)
  const [hide, setHide] = useState(false)
  const [revert, setRevert] = useState<RowView | null>(null)
  const transition = prevState.current === 'pending' && view.status.state === 'synced'
  useLayoutEffect(() => {
    if (transition && breaks.has('flash')) setHide(true)
    if (transition && breaks.has('revert')) setRevert(lastSynced.current)
    prevState.current = view.status.state
    if (view.status.state === 'synced') lastSynced.current = view
  })
  useEffect(() => {
    if (hide) setTimeout(() => setHide(false), 30)
    if (revert) setTimeout(() => setRevert(null), 30)
  }, [hide, revert])
  if (hide) return null
  return revert ?? view
}
