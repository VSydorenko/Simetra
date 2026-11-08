import type { RowView } from "../core"
import { useWriter } from "../t4/hooks"

/** Комірка стану: та сама розмітка для всіх станів, змінюється лише вміст. */
export function StateCell({
  view,
  onDismissRemoved,
}: {
  view: RowView
  onDismissRemoved?: () => void
}) {
  const w = useWriter()
  const st = view.status
  const mid = st.mutations.at(-1)?.id
  let body: React.ReactNode = null
  switch (st.state) {
    case "pending":
      body = <span>{st.deleting ? "Видаляється…" : "Зберігається…"}</span>
      break
    case "unknown":
      body = <span>Перевіряємо результат…</span>
      break
    case "failed":
      body = (
        <>
          <span title={st.mutations.at(-1)?.error?.code}>Не збережено</span>
          <button
            data-action="retry"
            onClick={() => mid !== undefined && w?.retry(mid)}
          >
            Повторити
          </button>
          <button
            data-action="cancel"
            onClick={() => mid !== undefined && w?.cancel(mid)}
          >
            Скасувати
          </button>
        </>
      )
      break
    case "conflict":
      body = (
        <>
          <span>Змінено іншим</span>
          <button
            data-action="take-server"
            onClick={() => mid !== undefined && w?.cancel(mid)}
          >
            Взяти серверну
          </button>
          <button
            data-action="overwrite"
            onClick={() => mid !== undefined && w?.retry(mid)}
          >
            Перезаписати
          </button>
        </>
      )
      break
    case "stale":
      body = <span>Може бути застарілим</span>
      break
    case "removed":
      body = (
        <>
          <span>Видалено іншим</span>
          <button data-action="dismiss" onClick={onDismissRemoved}>
            Прибрати
          </button>
        </>
      )
      break
  }
  return (
    <div className="state" data-state={st.state}>
      {body}
    </div>
  )
}

export function stateClass(view: RowView): string {
  return `st-${view.status.state}${view.status.deleting ? " del" : ""}`
}
