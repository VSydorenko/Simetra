import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { breaks } from '../t4/breaks'
import { cardSpec, loadCard } from '../t4/facade'
import { useRow, useWriter } from '../t4/hooks'
import { StateCell, stateClass } from '../ui/StateCell'
import { useBrokenDisplay } from './index'

export const Route = createFileRoute('/items/$id')({
  loader: async ({ context, params }) => {
    const core = context.holder.core
    if (!core) throw redirect({ to: '/login' })
    const snap = core.view(cardSpec(params.id)).getSnapshot()
    if (snap.kind === 'card' && snap.complete) return
    const load = loadCard(core, params.id)
    // Клієнт: рядок уже є у сховищі зі списку — картка показується одразу,
    // ліниві поля дотягуються фоном. Сервер: чекаємо повну форму для HTML.
    if (typeof window === 'undefined' || !(snap.kind === 'card' && snap.row)) await load
  },
  component: CardPage,
})

function CardPage() {
  const { id } = Route.useParams()
  const snap = useRow(id)
  const view = snap.row
  const shown = useBrokenDisplay(view ?? PLACEHOLDER)
  if (!view || !shown) return <div data-region="card" className="placeholder">Не знайдено</div>
  const r = shown.row
  return (
    <div data-region="card">
      <div className="toolbar">
        <Link to="/" data-action="back">
          ← До списку
        </Link>
        <StateCell view={view} />
      </div>
      <div className={`card ${stateClass(view)}`}>
        {/* Зона рядка — фіксованої висоти; ТЧ нижче росте вниз і нічого не зсуває. */}
        <div data-row-key={view.key}>
        <Field id={id} name="name" value={String(r.name ?? '')} pending={view.pendingFields.includes('name')} />
        <Field id={id} name="amount" value={String(r.amount ?? '')} pending={view.pendingFields.includes('amount')} />
        <label>
          <span>status</span>
          <span data-field="status">{String(r.status ?? '')}</span>
        </label>
        <label style={breaks.has('lazyshift') ? { height: 'auto' } : undefined}>
          <span>note</span>
          {/* Ліниве поле: місце зарезервоване, поява значення не зсуває розмітку. */}
          <div className="note" data-field="note" style={breaks.has('lazyshift') ? { height: 'auto', minHeight: 0 } : undefined}>
            {typeof r.note === 'string' ? r.note : ''}
          </div>
        </label>
        </div>
        <table className="lines" data-region-part="lines">
          <thead>
            <tr>
              <th>#</th>
              <th>product</th>
              <th>qty</th>
            </tr>
          </thead>
          <tbody>
            {snap.lines.map((l) => (
              <tr key={l.id} data-line-key={l.id}>
                <td>{l.lineNumber}</td>
                <td>{String(l.product)}</td>
                <td>{String(l.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

const PLACEHOLDER = { key: '', row: { id: '', version: 0 }, state: 'synced', pendingFields: [], pendingDelete: false } as const

function Field(props: { id: string; name: string; value: string; pending: boolean }) {
  const writer = useWriter()
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft !== null && draft !== props.value) void writer?.update(props.id, { [props.name]: draft })
    setDraft(null)
  }
  return (
    <label>
      <span>{props.name}</span>
      <input
        data-field={props.name}
        className={props.pending ? 'pf' : undefined}
        value={draft ?? props.value}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}
