// Інтерфейс ядра v0 у прочитанні спайку 2 (ескіз — спільні правила спайків).
// Власник інтерфейсу — спайк 1; тут лише те, що потрібно шару UI. Після
// контрольної точки спайку 1 цей файл замінює його тип, а фейк — його ядро.

export type RowState = 'synced' | 'pending' | 'failed' | 'conflict' | 'stale' | 'removed' | 'unknown'

export interface Row {
  readonly id: string
  readonly version: number
  readonly [field: string]: unknown
}

export interface Line {
  readonly id: string
  readonly lineNumber: number
  readonly [field: string]: unknown
}

export interface MutationError {
  readonly code: string
  readonly reason?: string
  readonly currentVersion?: number
}

/** Рядок, як його бачить UI: підтверджена база + незавершені зміни. */
export interface RowView {
  readonly key: string
  readonly row: Row
  readonly state: RowState
  readonly pendingFields: readonly string[]
  /** Незавершена власна зміна — видалення (рядок на місці до підтвердження). */
  readonly pendingDelete: boolean
  /** Остання незавершена зміна рядка — ціль дій «повторити» / «скасувати». */
  readonly mutationId?: string
  readonly error?: MutationError
  /** Серверна версія рядка для `conflict`, якщо ядро її знає. */
  readonly serverRow?: Row
}

export type SelectionStatus = 'loading' | 'ready' | 'refreshing' | 'error'

export interface WindowSnapshot {
  readonly kind: 'window'
  readonly status: SelectionStatus
  readonly rows: readonly RowView[]
  readonly atEnd: boolean
  readonly loadingMore: boolean
  readonly hasNewRows: boolean
  readonly needsRefresh: boolean
  readonly error?: MutationError
}

export interface CardSnapshot {
  readonly kind: 'card'
  readonly status: SelectionStatus
  readonly row?: RowView
  readonly lines: readonly Line[]
  /** Ліниві поля й ТЧ завантажено (форма картки). */
  readonly complete: boolean
}

export type ViewSpec =
  | { readonly kind: 'window'; readonly object: string; readonly orderBy: string }
  | { readonly kind: 'card'; readonly object: string; readonly id: string }

export interface ViewHandle<S> {
  getSnapshot(): S
  release(): void
}

/** Що повертає сервер на читання або запис. */
export interface ServerRows {
  readonly object: string
  readonly rows: readonly Row[]
  /** Вікно: як ключі відповіді лягають у вікно. */
  readonly window?: {
    readonly spec: string
    readonly mode: 'replace' | 'append' | 'refresh'
    readonly atEnd: boolean
  }
  /** Форма картки: повний рядок і всі рядки ТЧ власника. */
  readonly card?: { readonly id: string; readonly lines: readonly Line[] }
}

export interface GenerationToken {
  readonly session: number
  readonly gen: number
}

export type TxOp =
  | { readonly op: 'update'; readonly object: string; readonly id: string; readonly patch: Record<string, unknown>; readonly expectedVersion: number }
  | { readonly op: 'create'; readonly object: string; readonly row: Row; readonly window?: string }
  | { readonly op: 'delete'; readonly object: string; readonly id: string; readonly expectedVersion: number }

export type SendResult =
  | { readonly ok: true; readonly rows: readonly Row[] }
  | { readonly ok: false; readonly error: MutationError; readonly serverRow?: Row }

export interface Tx {
  update(object: string, id: string, patch: Record<string, unknown>): Tx
  create(object: string, row: Row, opts?: { window?: string }): Tx
  delete(object: string, id: string): Tx
  commit(send: (ops: readonly TxOp[]) => Promise<SendResult>): Promise<SendResult>
}

export interface CoreSnapshot {
  readonly subject: string
  readonly rows: readonly Row[]
  readonly windows: readonly { spec: string; keys: readonly string[]; atEnd: boolean }[]
  readonly cards: readonly { id: string; lines: readonly Line[] }[]
}

export interface CoreSession {
  readonly subject: string
  readonly closed: boolean
  dispose(reason: unknown): void
  /** Пачка сповіщень — одна на мікрозадачу. */
  subscribe(listener: () => void): () => void
  view(spec: ViewSpec): ViewHandle<WindowSnapshot | CardSnapshot>
  token(spec: ViewSpec): GenerationToken
  apply(input: ServerRows, token: GenerationToken): boolean
  /** Позначки вибірки, що не є рядками: loading, refreshing, loadingMore, error. */
  mark(spec: ViewSpec, patch: { status?: SelectionStatus; loadingMore?: boolean; error?: MutationError }): void
  showNew(spec: ViewSpec): void
  markStale(object: string, ids: readonly string[]): void
  /** Видалення іншим (сигнал): рядок на місці зі станом `removed`. */
  markRemoved(object: string, ids: readonly string[]): void
  /** Дія користувача: прибрати `removed` і застосувати порядок/склад сервера. */
  dismissRemoved(spec: ViewSpec): void
  begin(): Tx
  cancel(mutationId: string): void
  retry(mutationId: string, send: (ops: readonly TxOp[]) => Promise<SendResult>, opts?: { overwrite?: boolean }): Promise<SendResult>
  dehydrate(): CoreSnapshot
  hydrate(snapshot: CoreSnapshot): void
}

export function specKey(spec: ViewSpec): string {
  return spec.kind === 'window' ? `w:${spec.object}:${spec.orderBy}` : `c:${spec.object}:${spec.id}`
}
