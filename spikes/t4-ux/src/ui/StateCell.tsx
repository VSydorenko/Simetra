import type { RowView } from '../core/types'
import { useWriter } from '../t4/hooks'

/** Комірка стану: та сама розмітка для всіх станів, змінюється лише вміст. */
export function StateCell({ view, onDismissRemoved }: { view: RowView; onDismissRemoved?: () => void }) {
  const w = useWriter()
  const mid = view.mutationId
  let body: React.ReactNode = null
  switch (view.state) {
    case 'pending':
      body = <span>{view.pendingDelete ? 'Видаляється…' : 'Зберігається…'}</span>
      break
    case 'unknown':
      body = <span>Перевіряємо результат…</span>
      break
    case 'failed':
      body = (
        <>
          <span title={view.error?.code}>Не збережено</span>
          <button data-action="retry" onClick={() => mid && w?.retry(mid)}>Повторити</button>
          <button data-action="cancel" onClick={() => mid && w?.cancel(mid)}>Скасувати</button>
        </>
      )
      break
    case 'conflict':
      body = (
        <>
          <span>Змінено іншим</span>
          <button data-action="take-server" onClick={() => mid && w?.cancel(mid)}>Взяти серверну</button>
          <button data-action="overwrite" onClick={() => mid && w?.overwrite(mid)}>Перезаписати</button>
        </>
      )
      break
    case 'stale':
      body = <span>Може бути застарілим</span>
      break
    case 'removed':
      body = (
        <>
          <span>Видалено іншим</span>
          <button data-action="dismiss" onClick={onDismissRemoved}>Прибрати</button>
        </>
      )
      break
  }
  return (
    <div className="state" data-state={view.state}>
      {body}
    </div>
  )
}

export function stateClass(view: RowView): string {
  return `st-${view.state}${view.pendingDelete ? ' del' : ''}`
}
