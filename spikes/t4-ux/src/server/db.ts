// Серверна «база» полігона — FakeServer спайку 1 на суб'єкта (~10 тис.
// рядків, детерміновано). Стан процесу — це база, а не кеш клієнта: ядро
// клієнта на сервері створюється на запит (router.tsx), тут його немає.
import { FakeServer, ITEM, itemSpec } from '../core'

export const TOTAL = 10_000
const servers = new Map<string, FakeServer>()

export function itemId(subject: string, n: number): string {
  const h = ((subject.startsWith('bob') ? 2 : 1) * 0x100000 + n).toString(16).padStart(12, '0')
  return `00000000-0000-4000-8000-${h}`
}

export function serverOf(subject: string): FakeServer {
  let s = servers.get(subject)
  if (s) return s
  s = new FakeServer([itemSpec])
  const prefix = subject.startsWith('bob') ? 'Bravo' : 'Alpha'
  const total = subject.includes('-full') ? 5000 : TOTAL
  const rows = []
  for (let n = 1; n <= total; n++)
    rows.push({
      id: itemId(subject, n),
      num: n * 10,
      name: `${prefix} item ${n}`,
      amount: (n * 3.25).toFixed(2),
      status: n % 7 === 0 ? 'closed' : 'open',
      note: `${prefix} note for item ${n}. Long text field loaded lazily.`,
    })
  s.seed(ITEM, rows)
  for (let n = 1; n <= Math.min(total, 300); n++)
    s.seedLines(ITEM, itemId(subject, n), 'lines', [1, 2, 3].map((ln) => ({ id: `${itemId(subject, n)}-${ln}`, lineNumber: ln, product: `${prefix} product ${ln}`, qty: ln * n })))
  servers.set(subject, s)
  return s
}
