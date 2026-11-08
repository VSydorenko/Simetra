// Правила оракула мерехтіння: чиста функція над журналом записувача.
// Сегмент — проміжок між двома позначками дії користувача (`__oracleMark`).
// Дія дозволяє лише те, що явно перелічено в `allow`; решта — заборонений кадр.

export type Allow =
  | "clear" // зона може спорожніти (вихід, зміна рантайму)
  | "reorder" // відносний порядок може змінитись (зміна сортування, showNew)
  | "shift" // рядки можуть зсуватись довільно (navigate, showNew)
  | "shift-once" // кожен рядок може зсунутись не більше одного разу (власне створення/видалення)
  | "scroll" // прокрутка користувача: геометрія й присутність (віртуалізація) вільні
  | "aba" // повернення значення дозволене (явна дія «скасувати» вже окремий сегмент)

export interface MarkOpts {
  allow?: Allow[]
  /** З цієї позначки й до кінця текст не сміє з'явитись у жодній зоні. */
  forbidText?: string
}

export interface RowSnap {
  /** У видимій області прокрутки; правила геометрії — лише для видимих. */
  vis?: boolean
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
  /** Найдовша смуга видимої області прокрутки без рядка, px. */
  gap?: number | null
  text: string
}
export interface Snap {
  i: number
  t: number
  /** Сума колеса за останні 300 мс. */
  wheel?: number
  frame: number
  reason: string
  seg: number
  regions: RegionSnap[]
}
export interface OracleLog {
  snaps: Snap[]
  marks: { name: string; opts: MarkOpts; t: number; at: number }[]
  shifts: {
    t: number
    value: number
    hadRecentInput: boolean
    seg: number
    sources?: string[]
  }[]
  appMutationsAfterParse: {
    t: number
    type: string
    target: string
    attr: string | null
    added?: string
    removed?: string
  }[]
  parsedAt: number | null
  hydratedAt?: number
  recoverable?: { message: string }[]
  shiftsUnsupported?: boolean
}

export type ViolationKind =
  | "empty-after-data"
  | "presence-aba"
  | "value-aba"
  | "reorder"
  | "shift"
  | "height"
  | "scroll-jump"
  | "layout-shift"
  | "forbidden-text"
  | "hydration-mutation"
  | "hydration-error"
  | "blank"
  | "scroll-rigid"

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
  const segName = (seg: number) =>
    seg === 0 ? "load" : (log.marks[seg - 1]?.name ?? `seg${seg}`)
  const allows = (seg: number, a: Allow) =>
    seg === 0 ? false : (log.marks[seg - 1]?.opts.allow ?? []).includes(a)
  const push = (v: Omit<Violation, "segName">) =>
    out.push({ ...v, segName: segName(v.seg) })

  // Гідратація: після розбору серверного HTML до першої дії користувача DOM
  // застосунку не змінюється (React гідратує без жодної мутації).
  const firstMarkT = log.marks[0]?.t ?? Infinity
  for (const m of log.appMutationsAfterParse)
    if (m.t < firstMarkT)
      push({
        kind: "hydration-mutation",
        seg: 0,
        detail: `${m.type} ${m.target}${m.attr ? `@${m.attr}` : ""} +[${m.added ?? ""}] -[${m.removed ?? ""}]`,
      })
  for (const e of log.recoverable ?? [])
    push({ kind: "hydration-error", seg: 0, detail: e.message })

  for (const s of log.shifts)
    if (!s.hadRecentInput && s.value > 0)
      push({
        kind: "layout-shift",
        seg: s.seg,
        detail: `CLS entry ${s.value.toFixed(4)} ${(s.sources ?? []).join(" | ")}`,
      })

  // Заборонений текст: з позначки й до кінця журналу.
  log.marks.forEach((m, idx) => {
    const text = m.opts.forbidText
    if (!text) return
    for (const s of log.snaps)
      if (s.seg >= idx + 1)
        for (const r of s.regions)
          if (r.text.includes(text)) {
            push({
              kind: "forbidden-text",
              seg: s.seg,
              region: r.name,
              detail: `"${text}" visible`,
              snap: s.i,
            })
            return
          }
  })

  const hadData = new Set<string>()
  type Track = {
    seg: number
    presence: boolean[]
    values: Map<string, string[]>
    shifts: number
  }
  const tracks = new Map<string, Track>()
  let prev: Snap | undefined

  for (const s of log.snaps) {
    // До першого rendering update (жодного rAF) браузер нічого не малював:
    // стан frame 0, змінений ще до першого кадру, — проміжний стан розбору
    // HTML (WebKit вимірює його інакше), не кадр. Останній стан frame 0
    // малюється першим кадром. Після нього — суворо: стан після кожної задачі.
    const next = log.snaps[log.snaps.indexOf(s) + 1]
    if (s.frame === 0 && next && next.frame === 0) continue
    for (const r of s.regions) {
      // Порожня зона чи скелет, коли дані вже були показані в цій зоні.
      if (
        (r.rows.length === 0 || r.skeleton) &&
        hadData.has(r.name) &&
        !allows(s.seg, "clear")
      )
        push({
          kind: "empty-after-data",
          seg: s.seg,
          region: r.name,
          detail: r.skeleton ? "skeleton" : "no rows",
          snap: s.i,
        })
      if (r.rows.length > 0 && !r.skeleton) hadData.add(r.name)
      // Порожня смуга у видимій області, коли дані вже були (прокрутка
      // в тому числі): рядки не встигли за прокруткою чи вивантажені.
      if (
        hadData.has(r.name) &&
        r.gap !== undefined &&
        r.gap !== null &&
        r.gap > 2 &&
        !allows(s.seg, "clear")
      )
        push({
          kind: "blank",
          seg: s.seg,
          region: r.name,
          detail: `${r.gap}px without rows`,
          snap: s.i,
        })

      const pr = prev?.regions.find((x) => x.name === r.name)
      const scrolling = allows(s.seg, "scroll")

      // Стрибок прокрутки — зміна scrollTop без дії, від якої видимі рядки
      // зрушили. Корекція якоря (scrollTop змінено, видимі рядки на місці,
      // бо вміст над ними змінився) — не стрибок: її доводить незмінна
      // геометрія видимих рядків нижче (правило shift).
      if (
        pr &&
        pr.scrollTop !== null &&
        r.scrollTop !== null &&
        pr.scrollTop !== r.scrollTop &&
        !scrolling &&
        !anchored(pr, r)
      )
        push({
          kind: "scroll-jump",
          seg: s.seg,
          region: r.name,
          detail: `${pr.scrollTop} → ${r.scrollTop}`,
          snap: s.i,
        })

      if (pr) {
        const prevIdx = new Map(pr.rows.map((x, i) => [x.key, i]))
        const common = r.rows.filter((x) => prevIdx.has(x.key))
        // Геометрія — лише того, що видно в обох станах: запас віртуалізатора
        // поза видимою областю користувач не бачить.
        const seen = common.filter(
          (x) => x.vis !== false && pr.rows[prevIdx.get(x.key)!]!.vis !== false
        )
        if (!allows(s.seg, "reorder"))
          for (let i = 1; i < common.length; i++)
            if (
              prevIdx.get(common[i - 1]!.key)! > prevIdx.get(common[i]!.key)!
            ) {
              push({
                kind: "reorder",
                seg: s.seg,
                region: r.name,
                key: common[i]!.key,
                detail: "relative order inverted",
                snap: s.i,
              })
              break
            }
        // Прокрутка рухає весь вміст як одне ціле: спільні рядки зсуваються
        // на одну величину — 0 (якір, корекція) чи −Δ прокрутки. Інше —
        // стрибок, якого не дає жоден рух користувача.
        if (scrolling && !allows(s.seg, "shift") && seen.length > 0) {
          const dScroll =
            pr.scrollTop !== null && r.scrollTop !== null
              ? r.scrollTop - pr.scrollTop
              : 0
          const deltas = seen.map(
            (row) => row.top - pr.rows[prevIdx.get(row.key)!]!.top
          )
          const d0 = deltas[0]!
          // Допуск 2px: дробові висоти рядків змінної висоти округлюються.
          const rigid = deltas.every((d) => Math.abs(d - d0) <= 2)
          // Складений рух: корекція якоря в той самий інтервал, що й
          // прокрутка колесом. Рядки можуть зрушити лише в межах недавнього
          // введення і проти його напрямку (колесо вниз — рядки вгору).
          const wheel = s.wheel ?? 0
          const byInput =
            wheel !== 0 &&
            Math.sign(d0) === -Math.sign(wheel) &&
            Math.abs(d0) <= Math.abs(wheel) + 2
          const fits =
            Math.abs(d0) <= 2 || Math.abs(d0 + dScroll) <= 2 || byInput
          if (!rigid || !fits)
            push({
              kind: "scroll-rigid",
              seg: s.seg,
              region: r.name,
              detail: `rows moved by ${[...new Set(deltas.map(Math.round))].slice(0, 4).join(",")} at scroll Δ${dScroll}`,
              snap: s.i,
            })
        }
        for (const row of seen) {
          const p = pr.rows[prevIdx.get(row.key)!]!
          if (p.h !== row.h)
            push({
              kind: "height",
              seg: s.seg,
              region: r.name,
              key: row.key,
              detail: `${p.h} → ${row.h}`,
              snap: s.i,
            })
          // Менше пікселя — субпіксельний залишок якоря, не видимий зсув.
          if (
            Math.abs(p.top - row.top) >= 1 &&
            !scrolling &&
            !allows(s.seg, "shift")
          ) {
            const t = track(r.name, row.key, s.seg)
            t.shifts++
            if (!allows(s.seg, "shift-once") || t.shifts > 1)
              push({
                kind: "shift",
                seg: s.seg,
                region: r.name,
                key: row.key,
                detail: `top ${p.top} → ${row.top}`,
                snap: s.i,
              })
          }
        }
      }

      // ABA присутності й значень у межах сегмента.
      // Присутність — лише видимих рядків: запас віртуалізатора поза
      // видимою областю з'являється й зникає без жодного кадру для ока.
      const present = new Set(
        r.rows.filter((x) => x.vis !== false).map((x) => x.key)
      )
      for (const [id, t] of tracks) {
        const [region, key] = splitId(id)
        if (region !== r.name || t.seg !== s.seg) continue
        if (!present.has(key)) t.presence.push(false)
      }
      for (const row of r.rows) {
        if (row.vis === false) continue
        const t = track(r.name, row.key, s.seg)
        const pres = t.presence
        if (
          pres.length >= 2 &&
          pres[pres.length - 1] === false &&
          pres.includes(true) &&
          !scrolling
        )
          push({
            kind: "presence-aba",
            seg: s.seg,
            region: r.name,
            key: row.key,
            detail: "row vanished and reappeared",
            snap: s.i,
          })
        pres.push(true)
        for (const [f, v] of Object.entries(row.fields)) {
          const hist = t.values.get(f) ?? []
          const val = v ?? ""
          if (hist.length === 0 || hist[hist.length - 1] !== val) {
            if (hist.slice(0, -1).includes(val) && !allows(s.seg, "aba"))
              push({
                kind: "value-aba",
                seg: s.seg,
                region: r.name,
                key: row.key,
                detail: `${f}: ${hist.join(" → ")} → ${val}`,
                snap: s.i,
              })
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
  const i = id.indexOf("\u0000")
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
  return vs
    .map(
      (v) =>
        `[${v.kind}] seg=${v.seg}(${v.segName}) ${v.region ?? ""} ${v.key ?? ""} ${v.detail}`
    )
    .join("\n")
}

/** Спільні видимі рядки є й не зрушили: зміна прокрутки — корекція якоря. */
function anchored(pr: RegionSnap, r: RegionSnap): boolean {
  const prev = new Map(
    pr.rows.filter((x) => x.vis !== false).map((x) => [x.key, x])
  )
  const common = r.rows.filter((x) => x.vis !== false && prev.has(x.key))
  return (
    common.length > 0 &&
    common.every((x) => Math.abs(x.top - prev.get(x.key)!.top) <= 2)
  )
}
