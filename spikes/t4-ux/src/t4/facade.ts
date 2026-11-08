// Фасад читання й запису над ядром: межа між серверними функціями хоста і
// ядром. Кожна відповідь застосовується лише до того ядра, з якого пішов
// запит (токен покоління), і лише якщо суб'єкт відповіді збігається.
import type { CoreSession, Row, SendResult, TxOp, ViewSpec, WindowSnapshot } from '../core/types'
import { OBJECT } from '../server/db'
import { fetchCard, fetchPage, fetchUpTo, runOps } from '../server/fns'
import { breaks } from './breaks'

export const LIST: ViewSpec = { kind: 'window', object: OBJECT, orderBy: 'num' }
export const LIST_KEY = 'w:Item:num'
export const cardSpec = (id: string): ViewSpec => ({ kind: 'card', object: OBJECT, id })

function windowOf(core: CoreSession): WindowSnapshot {
  return core.view(LIST).getSnapshot() as WindowSnapshot
}

function lastNum(core: CoreSession): number | null {
  const rows = windowOf(core).rows
  let max: number | null = null
  for (const r of rows) if (typeof r.row.num === 'number' && (max === null || r.row.num > max)) max = r.row.num
  return max
}

export async function ensureWindow(core: CoreSession): Promise<void> {
  if (windowOf(core).status !== 'loading') return
  const token = core.token(LIST)
  const res = await fetchPage({ data: { after: null } })
  if (res.subject !== core.subject) return
  core.apply({ object: OBJECT, rows: res.rows, window: { spec: LIST_KEY, mode: 'replace', atEnd: res.atEnd } }, token)
}

export async function loadMore(core: CoreSession, holder?: { core: CoreSession | null }): Promise<void> {
  const w = windowOf(core)
  if (w.loadingMore || w.atEnd || w.status === 'loading') return
  core.mark(LIST, { loadingMore: true })
  const token = core.token(LIST)
  const res = await fetchPage({ data: { after: lastNum(core) } })
  // Зламана реалізація для тесту оракула: застосувати до поточного ядра, а не до свого.
  const target = breaks.has('notoken') && holder?.core ? holder.core : core
  if (!breaks.has('notoken') && res.subject !== core.subject) return
  target.apply({ object: OBJECT, rows: res.rows, window: { spec: LIST_KEY, mode: 'append', atEnd: res.atEnd } }, breaks.has('notoken') ? target.token(LIST) : token)
}

/** Фонове перечитування: склад і порядок списку не змінюються. */
export async function refresh(core: CoreSession): Promise<void> {
  const last = lastNum(core)
  if (last === null) return
  core.mark(LIST, { status: 'refreshing' })
  const token = core.token(LIST)
  const res = await fetchUpTo({ data: { lastNum: last } })
  if (res.subject !== core.subject) return
  const mode = breaks.has('reorder') ? 'replace' : 'refresh'
  core.apply({ object: OBJECT, rows: res.rows, window: { spec: LIST_KEY, mode, atEnd: false } }, token)
  core.mark(LIST, { status: 'ready' })
}

/** Дія користувача «показати нові»: склад і порядок — за сервером. */
export async function reload(core: CoreSession): Promise<void> {
  const last = lastNum(core)
  core.dismissRemoved(LIST)
  core.mark(LIST, { status: 'refreshing' })
  const token = core.token(LIST)
  const res = await fetchUpTo({ data: { lastNum: last ?? 0 } })
  if (res.subject !== core.subject) return
  core.apply({ object: OBJECT, rows: res.rows, window: { spec: LIST_KEY, mode: 'replace', atEnd: windowOf(core).atEnd } }, token)
}

export async function loadCard(core: CoreSession, id: string): Promise<void> {
  const spec = cardSpec(id)
  const token = core.token(spec)
  const res = await fetchCard({ data: { id } })
  if (res.subject !== core.subject || !res.card) return
  core.apply({ object: OBJECT, rows: [res.card.row], card: { id, lines: res.card.lines } }, token)
}

function sender(core: CoreSession) {
  return async (ops: readonly TxOp[]): Promise<SendResult> => {
    const res = await runOps({
      data: ops.map((o) =>
        o.op === 'create'
          ? { op: 'create' as const, row: o.row }
          : o.op === 'delete'
            ? { op: 'delete' as const, id: o.id, expectedVersion: o.expectedVersion }
            : { op: 'update' as const, id: o.id, patch: o.patch, expectedVersion: o.expectedVersion },
      ),
    })
    if (res.subject !== core.subject) return { ok: false, error: { code: 'command.unauthenticated', reason: 'session-changed' } }
    if (res.ok) return { ok: true, rows: res.rows }
    return { ok: false, error: res.error, serverRow: res.serverRow }
  }
}

export function writerOf(core: CoreSession) {
  const send = sender(core)
  return {
    update: (id: string, patch: Record<string, unknown>) => core.begin().update(OBJECT, id, patch).commit(send),
    create: (fields: Record<string, unknown>) => {
      // id генерує клієнт (§7.1): ключ рядка стабільний від оптимістичного кадру до підтвердження.
      const row = { id: crypto.randomUUID(), version: 0, ...fields } as Row
      return core.begin().create(OBJECT, row, { window: LIST_KEY }).commit(send)
    },
    remove: (id: string) => core.begin().delete(OBJECT, id).commit(send),
    retry: (mutationId: string) => core.retry(mutationId, send),
    overwrite: (mutationId: string) => core.retry(mutationId, send, { overwrite: true }),
    cancel: (mutationId: string) => core.cancel(mutationId),
  }
}
