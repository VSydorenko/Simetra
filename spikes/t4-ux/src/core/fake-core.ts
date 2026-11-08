// Фейк ядра v0 для старту спайку 2. Не продукт: лише та семантика, яку
// перевіряє оракул (знімки незмінні й спільні за структурою, сповіщення
// пачкою за мікрозадачу, оверлей незавершених змін над підтвердженою базою,
// заморожений порядок вікна, ізоляція покоління).
import type {
  CardSnapshot,
  CoreSession,
  CoreSnapshot,
  GenerationToken,
  Line,
  MutationError,
  Row,
  RowState,
  RowView,
  SelectionStatus,
  SendResult,
  ServerRows,
  Tx,
  TxOp,
  ViewHandle,
  ViewSpec,
  WindowSnapshot,
} from './types'
import { specKey } from './types'

interface Mutation {
  id: string
  key: string
  object: string
  kind: 'update' | 'create' | 'delete'
  patch: Record<string, unknown>
  row?: Row
  window?: string
  status: 'pending' | 'failed' | 'conflict' | 'unknown'
  error?: MutationError
  serverRow?: Row
}

interface WindowState {
  keys: string[]
  keySet: Set<string>
  created: string[]
  atEnd: boolean
  status: SelectionStatus
  loadingMore: boolean
  hasNewRows: boolean
  needsRefresh: boolean
  error?: MutationError
  gen: number
  snap?: WindowSnapshot
}

interface CardState {
  lines: readonly Line[]
  complete: boolean
  status: SelectionStatus
  error?: MutationError
  snap?: CardSnapshot
}

let sessionSeq = 0
let mutationSeq = 0

const EMPTY_WINDOW: WindowSnapshot = Object.freeze({
  kind: 'window',
  status: 'loading',
  rows: Object.freeze([]) as readonly RowView[],
  atEnd: false,
  loadingMore: false,
  hasNewRows: false,
  needsRefresh: false,
})
const EMPTY_CARD: CardSnapshot = Object.freeze({
  kind: 'card',
  status: 'loading',
  lines: Object.freeze([]) as readonly Line[],
  complete: false,
})

function shallowEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a)
  if (ak.length !== Object.keys(b).length) return false
  return ak.every((k) => Object.is(a[k], b[k]))
}

export function createFakeCore(subject: string): CoreSession {
  const sessionId = ++sessionSeq
  let closed = false
  const rows = new Map<string, Row>()
  const mutations = new Map<string, Mutation>()
  const byKey = new Map<string, string[]>()
  const stale = new Set<string>()
  const removed = new Set<string>()
  const windows = new Map<string, WindowState>()
  const cards = new Map<string, CardState>()
  const viewCache = new Map<string, RowView | null>()
  const listeners = new Set<() => void>()
  let scheduled = false

  function notify() {
    if (scheduled || closed) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (closed) return
      for (const l of [...listeners]) l()
    })
  }

  // Інвалідація синхронна (getSnapshot завжди бачить поточний стан), а
  // сповіщення — пачкою: React отримує одну зміну на мікрозадачу.
  function touch(key: string) {
    viewCache.delete(key)
    for (const w of windows.values()) if (w.keySet.has(key) || w.created.includes(key)) w.snap = undefined
    const c = cards.get(key)
    if (c) c.snap = undefined
    notify()
  }

  function rowView(key: string): RowView | undefined {
    const cached = viewCache.get(key)
    if (cached !== undefined) return cached ?? undefined
    const base = rows.get(key)
    const muts = (byKey.get(key) ?? []).map((id) => mutations.get(id)!)
    let row: Row | undefined = base
    const pendingFields = new Set<string>()
    let state: RowState = removed.has(key) ? 'removed' : stale.has(key) ? 'stale' : 'synced'
    let pendingDelete = false
    let last: Mutation | undefined
    for (const m of muts) {
      if (m.kind === 'create') row = { ...m.row!, ...(base ?? {}) } as Row
      else if (m.kind === 'delete') pendingDelete = true
      else if (row) row = { ...row, ...m.patch } as Row
      for (const f of Object.keys(m.kind === 'update' ? m.patch : {})) pendingFields.add(f)
      last = m
    }
    if (!row) {
      viewCache.set(key, null)
      return undefined
    }
    if (muts.some((m) => m.status === 'unknown')) state = 'unknown'
    else if (muts.some((m) => m.status === 'failed')) state = 'failed'
    else if (muts.some((m) => m.status === 'conflict')) state = 'conflict'
    else if (muts.length > 0) state = 'pending'
    const view: RowView = Object.freeze({
      key,
      row,
      state,
      pendingFields: Object.freeze([...pendingFields]),
      pendingDelete,
      mutationId: last?.id,
      error: last?.error,
      serverRow: last?.serverRow,
    })
    viewCache.set(key, view)
    return view
  }

  function windowState(key: string): WindowState {
    let w = windows.get(key)
    if (!w) {
      w = { keys: [], keySet: new Set(), created: [], atEnd: false, status: 'loading', loadingMore: false, hasNewRows: false, needsRefresh: false, gen: 0 }
      windows.set(key, w)
    }
    return w
  }

  function cardState(id: string): CardState {
    let c = cards.get(id)
    if (!c) {
      c = { lines: [], complete: false, status: 'loading' }
      cards.set(id, c)
    }
    return c
  }

  function windowSnapshot(key: string): WindowSnapshot {
    if (closed) return EMPTY_WINDOW
    const w = windowState(key)
    if (w.snap) return w.snap
    const list: RowView[] = []
    for (const k of w.created) {
      const v = rowView(k)
      if (v) list.push(v)
    }
    for (const k of w.keys) {
      if (w.created.includes(k)) continue
      const v = rowView(k)
      if (v) list.push(v)
    }
    // Рядки без змін зберігають ідентичність — React не перерендерює їх.
    const status: SelectionStatus = w.status === 'loading' && list.length > 0 ? 'ready' : w.status
    w.snap = Object.freeze({
      kind: 'window',
      status,
      rows: Object.freeze(list),
      atEnd: w.atEnd,
      loadingMore: w.loadingMore,
      hasNewRows: w.hasNewRows,
      needsRefresh: w.needsRefresh,
      error: w.error,
    })
    return w.snap
  }

  function cardSnapshot(id: string): CardSnapshot {
    if (closed) return EMPTY_CARD
    const c = cardState(id)
    if (c.snap) return c.snap
    const row = rowView(id)
    c.snap = Object.freeze({
      kind: 'card',
      status: row ? (c.status === 'loading' ? 'ready' : c.status) : c.status,
      row,
      lines: c.lines,
      complete: c.complete,
    })
    return c.snap
  }

  function mergeRow(r: Row) {
    const existing = rows.get(r.id)
    // Версія не зменшується (Рд24): старіша відповідь не перетирає новішу.
    if (existing && r.version < existing.version) return
    const merged = existing ? ({ ...existing, ...r } as Row) : r
    const wasStale = [stale.delete(r.id), removed.delete(r.id)].some(Boolean)
    if (existing && shallowEqual(existing, merged) && !wasStale) return
    rows.set(r.id, merged)
    touch(r.id)
  }

  function addMutation(m: Mutation) {
    mutations.set(m.id, m)
    byKey.set(m.key, [...(byKey.get(m.key) ?? []), m.id])
    touch(m.key)
  }

  function removeMutation(id: string) {
    const m = mutations.get(id)
    if (!m) return
    mutations.delete(id)
    const rest = (byKey.get(m.key) ?? []).filter((x) => x !== id)
    if (rest.length) byKey.set(m.key, rest)
    else byKey.delete(m.key)
    touch(m.key)
  }

  // Рядок зникає зі списку лише після підтвердженого власного видалення
  // або дією користувача над `removed`.
  function dropKey(key: string) {
    rows.delete(key)
    removed.delete(key)
    stale.delete(key)
    for (const w of windows.values()) {
      if (w.keySet.delete(key)) w.keys = w.keys.filter((k) => k !== key)
      w.created = w.created.filter((k) => k !== key)
      w.snap = undefined
    }
    touch(key)
  }

  function settle(muts: Mutation[], result: SendResult) {
    if (closed) return
    if (result.ok) {
      for (const r of result.rows) mergeRow(r)
      for (const m of muts) {
        if (m.kind === 'delete') dropKey(m.key)
        removeMutation(m.id)
      }
      return
    }
    const conflict = result.error.code === 'command.conflict'
    // Результат невідомий: зміну не прибрано й не підтверджено; фасад перечитує ключ.
    const unknown = result.error.code === 'command.unavailable' || result.error.code === 'command.timeout'
    for (const m of muts) {
      m.status = unknown ? 'unknown' : conflict ? 'conflict' : 'failed'
      m.error = result.error
      m.serverRow = result.serverRow
      touch(m.key)
    }
  }

  function opsOf(muts: Mutation[]): TxOp[] {
    return muts.map((m) =>
      m.kind === 'create'
        ? { op: 'create', object: m.object, row: m.row!, window: m.window }
        : m.kind === 'delete'
          ? { op: 'delete', object: m.object, id: m.key, expectedVersion: rows.get(m.key)?.version ?? 0 }
          : { op: 'update', object: m.object, id: m.key, patch: m.patch, expectedVersion: rows.get(m.key)?.version ?? 0 },
    )
  }

  async function run(muts: Mutation[], send: (ops: readonly TxOp[]) => Promise<SendResult>): Promise<SendResult> {
    let result: SendResult
    try {
      result = await send(opsOf(muts))
    } catch (cause) {
      result = { ok: false, error: { code: 'command.unavailable', reason: String(cause) } }
    }
    settle(muts, result)
    return result
  }

  const core: CoreSession = {
    subject,
    get closed() {
      return closed
    },
    dispose() {
      if (closed) return
      closed = true
      rows.clear()
      mutations.clear()
      byKey.clear()
      stale.clear()
      removed.clear()
      windows.clear()
      cards.clear()
      viewCache.clear()
      // Підписники отримують останнє сповіщення синхронно: знімки вже порожні.
      const ls = [...listeners]
      listeners.clear()
      for (const l of ls) l()
    },
    subscribe(listener) {
      if (closed) return () => {}
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    view(spec): ViewHandle<WindowSnapshot | CardSnapshot> {
      const key = specKey(spec)
      return {
        getSnapshot: () => (spec.kind === 'window' ? windowSnapshot(key) : cardSnapshot(spec.id)),
        release: () => {},
      }
    },
    token(spec): GenerationToken {
      return { session: sessionId, gen: spec.kind === 'window' ? windowState(specKey(spec)).gen : 0 }
    },
    apply(input: ServerRows, token: GenerationToken): boolean {
      if (closed || token.session !== sessionId) return false
      if (input.window) {
        const w = windowState(input.window.spec)
        if (token.gen !== w.gen) return false
      }
      for (const r of input.rows) mergeRow(r)
      if (input.window) {
        const w = windowState(input.window.spec)
        const ids = input.rows.map((r) => r.id)
        if (input.window.mode === 'replace') {
          w.keys = ids
          w.keySet = new Set(ids)
          w.created = w.created.filter((k) => !w.keySet.has(k))
          w.hasNewRows = false
          w.needsRefresh = false
          w.gen++
        } else if (input.window.mode === 'append') {
          for (const id of ids) if (!w.keySet.has(id) && !w.created.includes(id)) {
            w.keys.push(id)
            w.keySet.add(id)
          }
        } else {
          const got = new Set(ids)
          if (ids.some((id) => !w.keySet.has(id) && !w.created.includes(id))) w.hasNewRows = true
          // Правило стабільності: перечитування не прибирає й не переставляє
          // рядків. Зниклий — `removed` на місці; інший порядок — `needsRefresh`.
          for (const k of w.keys) if (!got.has(k) && !removed.has(k)) {
            removed.add(k)
            touch(k)
          }
          const serverOrder = ids.filter((id) => w.keySet.has(id))
          const localOrder = w.keys.filter((k) => got.has(k))
          if (serverOrder.some((id, i) => id !== localOrder[i])) w.needsRefresh = true
        }
        w.atEnd = input.window.mode === 'refresh' ? w.atEnd : input.window.atEnd
        w.status = 'ready'
        w.loadingMore = false
        w.error = undefined
        w.snap = undefined
        notify()
      }
      if (input.card) {
        const c = cardState(input.card.id)
        c.lines = Object.freeze([...input.card.lines])
        c.complete = true
        c.status = 'ready'
        c.snap = undefined
        notify()
      }
      return true
    },
    mark(spec, patch) {
      if (closed) return
      const s = spec.kind === 'window' ? windowState(specKey(spec)) : cardState(spec.id)
      if (patch.status) s.status = patch.status
      if ('error' in patch) s.error = patch.error
      if (spec.kind === 'window' && patch.loadingMore !== undefined) (s as WindowState).loadingMore = patch.loadingMore
      s.snap = undefined
      notify()
    },
    showNew(spec) {
      // Склад оновлює наступне читання `replace` (дія користувача).
      const w = windowState(specKey(spec))
      w.snap = undefined
      notify()
    },
    markRemoved(_object, ids) {
      for (const id of ids) if (rows.has(id)) {
        removed.add(id)
        touch(id)
      }
    },
    dismissRemoved(spec) {
      const w = windowState(specKey(spec))
      for (const k of [...w.keys]) if (removed.has(k)) dropKey(k)
    },
    markStale(_object, ids) {
      for (const id of ids) if (rows.has(id)) {
        stale.add(id)
        touch(id)
      }
    },
    begin(): Tx {
      const ops: Array<Omit<Mutation, 'id' | 'status'>> = []
      const tx: Tx = {
        update(object, id, patch) {
          ops.push({ key: id, object, kind: 'update', patch })
          return tx
        },
        delete(object, id) {
          ops.push({ key: id, object, kind: 'delete', patch: {} })
          return tx
        },
        create(object, row, opts) {
          ops.push({ key: row.id, object, kind: 'create', patch: {}, row, window: opts?.window })
          return tx
        },
        async commit(send) {
          if (closed) return { ok: false, error: { code: 'command.unavailable', reason: 'disposed' } }
          const muts = ops.map((o) => ({ ...o, id: `m${++mutationSeq}`, status: 'pending' as const }))
          for (const m of muts) {
            if (m.kind === 'create' && m.window) {
              const w = windowState(m.window)
              w.created = [m.key, ...w.created]
              w.snap = undefined
            }
            addMutation(m)
          }
          return run(muts, send)
        },
      }
      return tx
    },
    cancel(mutationId) {
      const m = mutations.get(mutationId)
      if (!m || m.status === 'pending') return
      if (m.kind === 'create') for (const w of windows.values()) if (w.created.includes(m.key)) {
        w.created = w.created.filter((k) => k !== m.key)
        w.snap = undefined
      }
      removeMutation(mutationId)
    },
    async retry(mutationId, send, opts) {
      const m = mutations.get(mutationId)
      if (!m || m.status === 'pending' || closed) return { ok: false, error: { code: 'command.invalid', reason: 'no-mutation' } }
      if (opts?.overwrite && m.serverRow) mergeRow(m.serverRow)
      m.status = 'pending'
      m.error = undefined
      m.serverRow = undefined
      touch(m.key)
      return run([m], send)
    },
    dehydrate(): CoreSnapshot {
      return {
        subject,
        rows: [...rows.values()],
        windows: [...windows.entries()].filter(([, w]) => w.status !== 'loading').map(([spec, w]) => ({ spec, keys: [...w.keys], atEnd: w.atEnd })),
        cards: [...cards.entries()].filter(([, c]) => c.complete).map(([id, c]) => ({ id, lines: [...c.lines] })),
      }
    },
    hydrate(snapshot) {
      // Знімок чужого суб'єкта не приймається ніколи (критерій 4).
      if (snapshot.subject !== subject) throw new Error('core.hydrate: subject mismatch')
      for (const r of snapshot.rows) rows.set(r.id, r)
      for (const w of snapshot.windows) {
        const s = windowState(w.spec)
        s.keys = [...w.keys]
        s.keySet = new Set(w.keys)
        s.atEnd = w.atEnd
        s.status = 'ready'
        s.snap = undefined
      }
      for (const c of snapshot.cards) {
        const s = cardState(c.id)
        s.lines = Object.freeze([...c.lines])
        s.complete = true
        s.status = 'ready'
        s.snap = undefined
      }
    },
  }
  return core
}
