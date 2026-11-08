// Правила оракула мерехтіння: чиста функція над журналом записувача.
// Сегмент — проміжок між двома позначками дії користувача (`__oracleMark`).
// Дія дозволяє лише те, що явно перелічено в `allow`; решта — заборонений кадр.

export type Allow =
  | 'clear' // зона може спорожніти (вихід, зміна рантайму)
  | 'reorder' // відносний порядок може змінитись (зміна сортування, showNew)
  | 'shift' // рядки можуть зсуватись довільно (navigate, showNew)
  | 'shift-once' // кожен рядок може зсунутись не більше одного разу (власне створення/видалення)
  | 'scroll' // прокрутка користувача: геометрія й присутність (віртуалізація) вільні
  | 'aba' // повернення значення дозволене (явна дія «скасувати» вже окремий сегмент)

export interface MarkOpts {
  allow?: Allow[]
  /** З цієї позначки й до кінця текст не сміє з'явитись у жодній зоні. */
  forbidText?: string
}

export interface RowSnap {
  key: string
  top: number
  h: number
  fields: Record<string, string | null>
  state: string | null
}
export interface RegionSnap {
  name: string
  rows: RowSnap[]
  skeleton: boolean
  scrollTop: number | null
  text: string
}
export interface Snap {
  i: number
  t: number
  frame: number
  reason: string
  seg: number
  regions: RegionSnap[]
}
export interface OracleLog {
  snaps: Snap[]
  marks: { name: string; opts: MarkOpts; t: number; at: number }[]
  shifts: { t: number; value: number; hadRecentInput: boolean; seg: number }[]
  appMutationsAfterParse: { t: number; type: string; target: string; attr: string | null }[]
  parsedAt: number | null
  hydratedAt?: number
  recoverable?: { message: string }[]
  shiftsUnsupported?: boolean
}

export type ViolationKind =
  | 'empty-after-data'
  | 'presence-aba'
  | 'value-aba'
  | 'reorder'
  | 'shift'
  | 'height'
  | 'scroll-jump'
  | 'layout-shift'
  | 'forbidden-text'
  | 'hydration-mutation'
  | 'hydration-error'

export interface Violation {
  kind: ViolationKind
  seg: number
  segName: string
  region?: string
  key?: string
  detail: string
  snap?: number
}

export function analyze(log: OracleLog): Violation[] {
  const out: Violation[] = []
  const segName = (seg: number) => (seg === 0 ? 'load' : (log.marks[seg - 1]?.name ?? `seg${seg}`))
  const allows = (seg: number, a: Allow) => (seg === 0 ? false : (log.marks[seg - 1]?.opts.allow ?? []).includes(a))
  const push = (v: Omit<Violation, 'segName'>) => out.push({ ...v, segName: segName(v.seg) })

  // Гідратація: після розбору серверного HTML до першої дії користувача DOM
  // застосунку не змінюється (React гідратує без жодної мутації).
  const firstMarkT = log.marks[0]?.t ?? Infinity
  for (const m of log.appMutationsAfterParse)
    if (m.t < firstMarkT) push({ kind: 'hydration-mutation', seg: 0, detail: `${m.type} ${m.target}${m.attr ? `@${m.attr}` : ''}` })
  for (const e of log.recoverable ?? []) push({ kind: 'hydration-error', seg: 0, detail: e.message })

  for (const s of log.shifts)
    if (!s.hadRecentInput && s.value > 0) push({ kind: 'layout-shift', seg: s.seg, detail: `CLS entry ${s.value.toFixed(4)}` })

  // Заборонений текст: з позначки й до кінця журналу.
  log.marks.forEach((m, idx) => {
    const text = m.opts.forbidText
    if (!text) return
    for (const s of log.snaps)
      if (s.seg >= idx + 1)
        for (const r of s.regions)
          if (r.text.includes(text)) {
            push({ kind: 'forbidden-text', seg: s.seg, region: r.name, detail: `"${text}" visible`, snap: s.i })
            return
          }
  })

  const hadData = new Set<string>()
  type Track = { seg: number; presence: boolean[]; values: Map<string, string[]>; shifts: number }
  const tracks = new Map<string, Track>()
  let prev: Snap | undefined

  for (const s of log.snaps) {
    for (const r of s.regions) {
      // Порожня зона чи скелет, коли дані вже були показані в цій зоні.
      if ((r.rows.length === 0 || r.skeleton) && hadData.has(r.name) && !allows(s.seg, 'clear'))
        push({ kind: 'empty-after-data', seg: s.seg, region: r.name, detail: r.skeleton ? 'skeleton' : 'no rows', snap: s.i })
      if (r.rows.length > 0 && !r.skeleton) hadData.add(r.name)

      const pr = prev?.regions.find((x) => x.name === r.name)
      const scrolling = allows(s.seg, 'scroll')

      if (pr && pr.scrollTop !== null && r.scrollTop !== null && pr.scrollTop !== r.scrollTop && !scrolling)
        push({ kind: 'scroll-jump', seg: s.seg, region: r.name, detail: `${pr.scrollTop} → ${r.scrollTop}`, snap: s.i })

      if (pr) {
        const prevIdx = new Map(pr.rows.map((x, i) => [x.key, i]))
        const common = r.rows.filter((x) => prevIdx.has(x.key))
        if (!allows(s.seg, 'reorder'))
          for (let i = 1; i < common.length; i++)
            if (prevIdx.get(common[i - 1]!.key)! > prevIdx.get(common[i]!.key)!) {
              push({ kind: 'reorder', seg: s.seg, region: r.name, key: common[i]!.key, detail: 'relative order inverted', snap: s.i })
              break
            }
        for (const row of common) {
          const p = pr.rows[prevIdx.get(row.key)!]!
          if (p.h !== row.h)
            push({ kind: 'height', seg: s.seg, region: r.name, key: row.key, detail: `${p.h} → ${row.h}`, snap: s.i })
          if (p.top !== row.top && !scrolling && !allows(s.seg, 'shift')) {
            const t = track(r.name, row.key, s.seg)
            t.shifts++
            if (!allows(s.seg, 'shift-once') || t.shifts > 1)
              push({ kind: 'shift', seg: s.seg, region: r.name, key: row.key, detail: `top ${p.top} → ${row.top}`, snap: s.i })
          }
        }
      }

      // ABA присутності й значень у межах сегмента.
      const present = new Set(r.rows.map((x) => x.key))
      for (const [id, t] of tracks) {
        const [region, key] = splitId(id)
        if (region !== r.name || t.seg !== s.seg) continue
        if (!present.has(key)) t.presence.push(false)
      }
      for (const row of r.rows) {
        const t = track(r.name, row.key, s.seg)
        const pres = t.presence
        if (pres.length >= 2 && pres[pres.length - 1] === false && pres.includes(true) && !scrolling)
          push({ kind: 'presence-aba', seg: s.seg, region: r.name, key: row.key, detail: 'row vanished and reappeared', snap: s.i })
        pres.push(true)
        for (const [f, v] of Object.entries(row.fields)) {
          const hist = t.values.get(f) ?? []
          const val = v ?? ''
          if (hist.length === 0 || hist[hist.length - 1] !== val) {
            if (hist.slice(0, -1).includes(val) && !allows(s.seg, 'aba'))
              push({ kind: 'value-aba', seg: s.seg, region: r.name, key: row.key, detail: `${f}: ${hist.join(' → ')} → ${val}`, snap: s.i })
            hist.push(val)
            t.values.set(f, hist)
          }
        }
      }
    }
    prev = s
  }
  return dedupe(out)

  function track(region: string, key: string, seg: number): Track {
    const id = `${region}\u0000${key}`
    let t = tracks.get(id)
    if (!t || t.seg !== seg) {
      t = { seg, presence: [], values: new Map(), shifts: 0 }
      tracks.set(id, t)
    }
    return t
  }
}

function splitId(id: string): [string, string] {
  const i = id.indexOf('\u0000')
  return [id.slice(0, i), id.slice(i + 1)]
}

function dedupe(vs: Violation[]): Violation[] {
  const seen = new Set<string>()
  return vs.filter((v) => {
    const k = `${v.kind}|${v.seg}|${v.region}|${v.key}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

export function format(vs: Violation[]): string {
  return vs.map((v) => `[${v.kind}] seg=${v.seg}(${v.segName}) ${v.region ?? ''} ${v.key ?? ''} ${v.detail}`).join('\n')
}
