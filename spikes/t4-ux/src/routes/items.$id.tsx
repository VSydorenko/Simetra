import { createFileRoute, Link, redirect } from '@tanstack/react-router'
import { Profiler, useState } from 'react'
import type { RowView } from '../core'
import { breaks } from '../t4/breaks'
import { cardSpec, linesSpec } from '../t4/facade'
import { useCard, useLines, useWriter } from '../t4/hooks'
import { StateCell, stateClass } from '../ui/StateCell'
import { onRegionRender, useBrokenDisplay } from './index'

export const Route = createFileRoute('/items/$id')({
  loader: async ({ context, params }) => {
    const core = context.holder.core
    if (!core) throw redirect({ to: '/login' })
    const card = core.preload(cardSpec(params.id))
    const lines = core.preload(linesSpec(params.id))
    // Сервер чекає повну форму для HTML. Клієнт не чекає: рядок уже у
    // сховищі зі списку — картка показується одразу, ліниві поля дотягуються.
    // Ядро v0 (958e32f2) дає рядок вигляду `card` лише після читання картки —
    // рядок зі сховища списку вигляд не показує. Поки так, клієнт чекає
    // (перехід без проміжного кадру, але з мережевою затримкою); вимогу
    // передано спайку 1. Коли вигляд показуватиме рядок одразу — не чекати.
    const inStore = core.view(cardSpec(params.id)).getSnapshot().rows.length > 0
    if (typeof window === 'undefined' || !inStore) await Promise.all([card, lines])
  },
  component: () => (
    <Profiler id="card" onRender={onRegionRender}>
      <CardPage />
    </Profiler>
  ),
})

const PLACEHOLDER = {
  key: '',
  version: 0,
  values: {},
  status: { state: 'synced', pendingFields: [], mutations: [], deleting: false, created: false },
} as unknown as RowView

function CardPage() {
  const { id } = Route.useParams()
  const snap = useCard(id)
  const lines = useLines(id)
  const view = snap.rows[0]
  const shown = useBrokenDisplay(view ?? PLACEHOLDER)
  if (!view || !shown) return <div data-region="card" className="placeholder">Не знайдено</div>
  const r = shown.values
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
          <Field id={id} name="name" value={String(r.name ?? '')} view={view} />
          <Field id={id} name="amount" value={String(r.amount ?? '')} view={view} />
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
        <table className="lines">
          <thead>
            <tr>
              <th>#</th>
              <th>product</th>
              <th>qty</th>
            </tr>
          </thead>
          <tbody>
            {(lines.section?.lines ?? []).map((l) => (
              <tr key={l.key} data-line-key={l.key}>
                <td>{String(l.values.lineNumber)}</td>
                <td>{String(l.values.product)}</td>
                <td>{String(l.values.qty)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Поле форми картки — чернетка поза ядром (політика картки). Чернетка
 * тримається до успішного осідання запису: за `await` сховище показує старе
 * значення до відповіді, тож без чернетки поле блимнуло б старим.
 */
function Field(props: { id: string; name: string; value: string; view: RowView }) {
  const writer = useWriter()
  const [draft, setDraft] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const failed = props.view.status.mutations.some((m) => m.fields.includes(props.name) && (m.state === 'failed' || m.state === 'conflict'))
  // Скасування мутації прибирає її з журналу — чернетка відпускається тим самим кадром.
  const inFlight = props.view.status.mutations.some((m) => m.fields.includes(props.name))
  const shown = editing || inFlight || failed ? (draft ?? props.value) : props.value
  const commit = async () => {
    setEditing(false)
    if (draft === null || draft === props.value || !writer) return setDraft(null)
    const m = writer.update(props.id, { [props.name]: draft })
    const out = await m.settled
    if (out.ok) setDraft(null)
  }
  return (
    <label>
      <span>{props.name}</span>
      <input
        data-field={props.name}
        className={props.view.status.pendingFields.includes(props.name) ? 'pf' : undefined}
        value={shown}
        onFocus={() => {
          setEditing(true)
          setDraft(null)
        }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
    </label>
  )
}
