// Фейкове серверне сховище полігона: ~10 тис. рядків на суб'єкта, детерміновано.
// Стан процесу — це «база», а не кеш клієнта: ядро клієнта на сервері
// створюється на запит (router.tsx), тут його немає.
import type { Line, Row } from '../core/types'

export const OBJECT = 'Item'
export const PAGE = 100
export const TOTAL = 10_000

interface Dataset {
  rows: Map<string, Row & { num: number; note: string }>
  lines: Map<string, Line[]>
  nextNum: number
}

const datasets = new Map<string, Dataset>()

function uuid(subject: string, n: number): string {
  // Детермінований UUID-подібний ключ: SSR і клієнт бачать ті самі ключі.
  const h = (subject.charCodeAt(0) * 7919 + n).toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${h.slice(-12)}`
}

function seed(subject: string): Dataset {
  const rows = new Map<string, Row & { num: number; note: string }>()
  const lines = new Map<string, Line[]>()
  const prefix = subject === 'bob' ? 'Bravo' : 'Alpha'
  for (let n = 1; n <= TOTAL; n++) {
    const id = uuid(subject, n)
    rows.set(id, {
      id,
      version: 1,
      num: n * 10,
      name: `${prefix} item ${n}`,
      amount: `${(n * 3.25).toFixed(2)}`,
      status: n % 7 === 0 ? 'closed' : 'open',
      note: `${prefix} note for item ${n}. Long text field loaded lazily.`,
    })
    lines.set(
      id,
      [1, 2, 3].map((ln) => ({ id: `${id}-l${ln}`, lineNumber: ln, product: `${prefix} product ${ln}`, qty: ln * n })),
    )
  }
  return { rows, lines, nextNum: TOTAL * 10 + 10 }
}

export function dataset(subject: string): Dataset {
  let d = datasets.get(subject)
  if (!d) {
    d = seed(subject)
    datasets.set(subject, d)
  }
  return d
}

export function resetDatasets() {
  datasets.clear()
}

/** Спискова форма: без лінивого `note`. */
export function listForm(r: Row & { note: string }): Row {
  const { note: _note, ...rest } = r
  return rest
}

function sorted(d: Dataset) {
  return [...d.rows.values()].sort((a, b) => a.num - b.num)
}

export function readPage(subject: string, after: number | null, limit = PAGE) {
  const all = sorted(dataset(subject))
  const start = after === null ? 0 : all.findIndex((r) => r.num > after)
  const page = start < 0 ? [] : all.slice(start, start + limit)
  return { rows: page.map(listForm), atEnd: start < 0 || start + limit >= all.length }
}

/** Перечитування вікна: усі рядки до останнього ключа вікна включно. */
export function readUpTo(subject: string, lastNum: number) {
  return sorted(dataset(subject)).filter((r) => r.num <= lastNum).map(listForm)
}

export function readCard(subject: string, id: string) {
  const d = dataset(subject)
  const row = d.rows.get(id)
  return row ? { row: { ...row } as Row, lines: d.lines.get(id) ?? [] } : undefined
}

export type Op =
  | { op: 'update'; id: string; patch: Record<string, unknown>; expectedVersion: number }
  | { op: 'create'; row: Row }
  | { op: 'delete'; id: string; expectedVersion: number }

export type WriteResult =
  | { ok: true; rows: Row[] }
  | { ok: false; error: { code: string; reason?: string; currentVersion?: number }; serverRow?: Row }

export function write(subject: string, ops: Op[]): WriteResult {
  const d = dataset(subject)
  const out: Row[] = []
  for (const o of ops) {
    if (o.op === 'create') {
      const num = typeof o.row.num === 'number' ? o.row.num : d.nextNum
      d.nextNum = Math.max(d.nextNum, num) + 10
      const row = { note: '', ...o.row, num, version: 1 } as Row & { num: number; note: string }
      d.rows.set(row.id, row)
      d.lines.set(row.id, [])
      out.push(listForm(row))
      continue
    }
    const cur = d.rows.get(o.id)
    if (!cur) return { ok: false, error: { code: 'command.conflict', reason: 'missing' } }
    if (cur.version !== o.expectedVersion)
      return { ok: false, error: { code: 'command.conflict', reason: 'version', currentVersion: cur.version }, serverRow: listForm(cur) }
    if (o.op === 'delete') {
      d.rows.delete(o.id)
      continue
    }
    const next = { ...cur, ...o.patch, version: cur.version + 1 }
    d.rows.set(o.id, next)
    out.push(listForm(next))
  }
  return { ok: true, rows: out }
}

/** Чужа зміна (інший користувач) — для сценаріїв конфлікту, removed, hasNewRows. */
export function foreign(subject: string, change: { kind: 'update'; id: string; patch: Record<string, unknown> } | { kind: 'delete'; id: string } | { kind: 'insert'; num: number; name: string }) {
  const d = dataset(subject)
  if (change.kind === 'update') {
    const cur = d.rows.get(change.id)
    if (cur) d.rows.set(change.id, { ...cur, ...change.patch, version: cur.version + 1 })
  } else if (change.kind === 'delete') d.rows.delete(change.id)
  else {
    const id = `00000000-0000-4000-9000-${(Date.now() % 1e12).toString(16).padStart(12, '0')}`
    d.rows.set(id, { id, version: 1, num: change.num, name: change.name, amount: '0.00', status: 'open', note: '' })
    d.lines.set(id, [])
  }
}

export { uuid as itemId }
