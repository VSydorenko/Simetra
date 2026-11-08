import {
  CommandFailure,
  LIMIT_REASONS,
  type CommandError,
  type Filter,
  type MetadataRef,
  type Operation,
  type ReadQuery,
  type ReadRows,
} from "simetra/model"
import { keysetAfter, matches, rowComparator } from "./filter"
import type {
  ActionPolicy,
  CoreLogEntry,
  CoreOptions,
  CoreSession,
  CoreSnapshot,
  GenerationToken,
  Key,
  Mutation,
  MutationId,
  MutationInfo,
  MutationOutcome,
  MutationState,
  ObjectName,
  ObjectSpec,
  RowState,
  RowStatus,
  RowView,
  SectionLine,
  SectionLineView,
  ServerRow,
  Tx,
  TxOptions,
  Values,
  ViewHandle,
  ViewSnapshot,
  ViewSpec,
  ViewStatus,
  Writer,
} from "./types"

/*
 * Ядро T4 (спайк 1). Будова, що робить клас «запис після dispose() / старе
 * покоління» неможливим:
 *
 * 1. Будь-яка зміна стану — лише всередині `commit(fn, token)`; методи сховищ
 *    вимагають відкритої області запису `Scope`, яку створює лише `commit`
 *    і закриває після `fn`. Збережена область після `commit` кидає.
 * 2. `commit` спершу перевіряє `token.valid`: сесія відкрита й покоління
 *    поточне (підмножина жива й не перезапитана, спроба мутації та сама).
 *    Пізня відповідь просто не має чим писати.
 * 3. Сповіщення — після `fn`, одна пачка на `commit`.
 */

const DISPOSED: CommandError = {
  code: "command.unavailable",
  reason: LIMIT_REASONS.disposed,
}

const SECTION_REFETCH_MS = 5_000
const AUTO_REBASE_MAX = 3

/** Область запису: існує лише під час `fn` одного `commit`. */
class Scope {
  #open = true
  assert(): void {
    if (!this.#open) throw new Error("write scope is closed")
  }
  close(): void {
    this.#open = false
  }
}

interface Entry {
  row: ServerRow
  owners: number
  stale: boolean
  /** `stale` знімає лише підтверджений рядок з версією ≥ цієї. */
  staleUntil: number
  removed: boolean
}

interface SectionEntry {
  ownerVersion: number
  lines: SectionLine[]
  complete: boolean
}

interface ObjState {
  readonly name: ObjectName
  readonly spec: ObjectSpec
  readonly rows: Map<Key, Entry>
  /** Реєстр власних створень (Рд7): власник рядка до першої підмножини. */
  readonly own: Set<Key>
}

type LineDelta =
  | { t: "add"; line: SectionLine }
  | { t: "update"; key: Key; values: Values }
  | { t: "remove"; key: Key }

type Op =
  | { k: "create"; obj: ObjectName; key: Key; values: Values }
  | {
      k: "update"
      obj: ObjectName
      key: Key
      values: Values
      /** База полів, що прийшла з сервера (не з власних попередніх мутацій). */
      base: Values
      /** Підтверджена версія ключа на мить дії. */
      baseVersion: number | undefined
      /** Перед дією вже були власні живі мутації ключа: база — своя. */
      chained: boolean
    }
  | { k: "delete"; obj: ObjectName; key: Key }
  | {
      k: "line"
      obj: ObjectName
      owner: Key
      section: string
      d: LineDelta
    }

interface Rec {
  readonly id: MutationId
  ops: Op[]
  state: MutationState
  error?: CommandError
  attempt: number
  rebases: number
  readonly policy: ActionPolicy
  /** Версії ключів, з якими пішла остання спроба (`expectedVersion`). */
  sent: Map<string, number>
  abort?: AbortController
  resolve: (outcome: MutationOutcome) => void
  settled: Promise<MutationOutcome>
}

interface Subset {
  readonly id: number
  readonly specKey: string
  readonly spec: ViewSpec
  readonly obj: ObjState
  /** Утримання: підписки, попередні завантаження, знімок SSR. */
  holds: number
  preloads: number
  releaseTimer?: ReturnType<typeof setTimeout>
  /** Очікувачі першого завершення завантаження (`preload`). */
  waiters: (() => void)[]
  alive: boolean
  gen: number
  /** Рядки, якими підмножина володіє (шапки). */
  owned: Set<Key>
  /** Склад і порядок показу; змінюється лише дією (правило стабільності). */
  layout: Key[]
  layoutSet: Set<Key>
  status: ViewStatus
  error?: CommandError
  loading: boolean
  trailing: boolean
  abort?: AbortController
  needsRefresh: boolean
  hasNewRows: boolean
  atEnd: boolean
  truncated: boolean
  /** Курсор вікна: останній рядок, прочитаний разом зі сторінкою. */
  cursor?: { key: Key; values: Values }
  dirty: boolean
  snapshot?: ViewSnapshot
  readonly listeners: Set<() => void>
}

const sectionId = (obj: ObjectName, owner: Key, section: string) =>
  `${obj}\u0000${owner}\u0000${section}`
const rowId = (obj: ObjectName, key: Key) => `${obj}\u0000${key}`
const refName = (ref: MetadataRef): ObjectName => `${ref.kind}.${ref.name}`

function specKeyOf(spec: ViewSpec): string {
  switch (spec.kind) {
    case "keys":
      return JSON.stringify([spec.kind, spec.object, spec.keys])
    case "card":
      return JSON.stringify([spec.kind, spec.object, spec.key])
    case "section":
      return JSON.stringify([spec.kind, spec.object, spec.owner, spec.section])
    case "full":
      return JSON.stringify([
        spec.kind,
        spec.object,
        spec.where ?? null,
        spec.orderBy ?? null,
      ])
    case "window":
      return JSON.stringify([
        spec.kind,
        spec.object,
        spec.where ?? null,
        spec.orderBy,
        spec.pageSize ?? 100,
      ])
  }
}

function equalValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false
  }
  // Значення полів — JSON (декодований рядок); рівність структурна.
  return JSON.stringify(a) === JSON.stringify(b)
}

function equalValues(a: Values, b: Values): boolean {
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (const k of ka) {
    if (!(k in b) || !equalValue(a[k], b[k])) return false
  }
  return true
}

/** Рядок результату T0 → рядок ядра: `id` і `version` — окремо. */
function toServerRow(row: Record<string, unknown>): ServerRow {
  const { id, version, ...values } = row
  return { key: id as Key, version: version as number, values }
}

function toLine(row: Record<string, unknown>): SectionLine {
  const { id, ...values } = row
  return { key: id as Key, values }
}

/**
 * Правило версії (Рд24) — одна функція: менша версія відкидається
 * (`undefined`); рівна чи більша зливається частково — відсутнє поле
 * (ліниве) лишається, явний `null` пишеться.
 */
export function mergeVersioned(
  current: ServerRow | undefined,
  incoming: ServerRow
): ServerRow | undefined {
  if (current === undefined) return incoming
  if (incoming.version < current.version) return undefined
  return {
    key: current.key,
    version: incoming.version,
    values: { ...current.values, ...incoming.values },
  }
}

const isCommandFailure = (e: unknown): e is CommandFailure =>
  e instanceof CommandFailure

function errorOf(e: unknown): CommandError {
  if (isCommandFailure(e)) return e.error
  return { code: "command.internal" }
}

/** Внутрішній стан для тестів (не публічний API). */
export interface CoreInspection {
  rows(obj: ObjectName): ReadonlyMap<
    Key,
    {
      version: number
      owners: number
      removed: boolean
      stale: boolean
      own: boolean
      heldByLog: boolean
    }
  >
  /** Підтверджений рядок (без оптимістичного шару). */
  row(obj: ObjectName, key: Key): ServerRow | undefined
  sectionCount(): number
  logLength(): number
  subsetCount(): number
  /** Чи тримає рядок хтось: підмножина, реєстр створень чи журнал. */
  violations(): string[]
}

const inspections = new WeakMap<CoreSession, CoreInspection>()

export function inspectCore(session: CoreSession): CoreInspection {
  const found = inspections.get(session)
  if (found === undefined) throw new Error("not a core session")
  return found
}

export function createCoreSession(options: CoreOptions): CoreSession {
  const { subject, source } = options
  const fullLimit = options.fullLimit ?? 5_000
  const keysPerRequest = options.keysPerRequest ?? 200
  const log = (entry: CoreLogEntry) => {
    try {
      options.log?.(entry)
    } catch {
      // Журнал недоступний — результат від нього не залежить.
    }
  }

  const objects = new Map<ObjectName, ObjState>()
  for (const spec of options.objects) {
    const name = refName(spec.ref)
    objects.set(name, { name, spec, rows: new Map(), own: new Set() })
  }
  const objOf = (name: ObjectName): ObjState => {
    const o = objects.get(name)
    if (o === undefined) throw new TypeError(`unknown object ${name}`)
    return o
  }

  const sections = new Map<string, SectionEntry>()
  const subsets = new Map<string, Subset>()
  const hydrated = new Set<Subset>()
  const releaseDelayMs = options.releaseDelayMs ?? 1_000
  let nextSubsetId = 1

  const mutLog: Rec[] = []
  let nextMutationId = 1

  let closed = false
  const abort = new AbortController()
  const listeners = new Set<() => void>()
  let inCommit = false

  // Брудні рядки й ТЧ за ревізією: кеш показаного рядка знає, чи він свіжий.
  const rowRev = new Map<string, number>()
  const rowCache = new Map<string, { rev: number; view: RowView | undefined }>()
  const sectionRev = new Map<string, number>()
  const dirtyRows = new Set<string>()
  const dirtySections = new Set<string>()
  const dirtySubsets = new Set<Subset>()
  let changed = false

  const touchRow = (obj: ObjectName, key: Key) => {
    const id = rowId(obj, key)
    rowRev.set(id, (rowRev.get(id) ?? 0) + 1)
    dirtyRows.add(id)
    changed = true
  }
  const touchSection = (sid: string) => {
    sectionRev.set(sid, (sectionRev.get(sid) ?? 0) + 1)
    dirtySections.add(sid)
    changed = true
  }
  const touchSubset = (s: Subset) => {
    dirtySubsets.add(s)
    changed = true
  }

  // ------------------------------------------------------------ покоління

  const sessionToken: GenerationToken = {
    get valid() {
      return !closed
    },
  }
  const subsetToken = (s: Subset, gen: number): GenerationToken => ({
    get valid() {
      return !closed && s.alive && s.gen === gen
    },
  })
  const recToken = (rec: Rec, attempt: number): GenerationToken => ({
    get valid() {
      return !closed && rec.attempt === attempt && mutLog.includes(rec)
    },
  })

  /** Єдина точка змін. */
  function commitInternal(
    fn: (scope: Scope) => void,
    token: GenerationToken
  ): boolean {
    if (inCommit) throw new Error("nested commit")
    if (!token.valid) return false
    const scope = new Scope()
    inCommit = true
    try {
      fn(scope)
    } finally {
      scope.close()
      inCommit = false
    }
    flush()
    if (staleInserts.size > 0) {
      const pending = [...staleInserts]
      staleInserts.clear()
      for (const [obj, keys] of pending) void refetchKeys(obj, [...keys])
    }
    return true
  }

  // ------------------------------------------------------------ сховища

  function heldByLog(obj: ObjectName, key: Key): boolean {
    return mutLog.some((r) =>
      r.ops.some((op) =>
        op.k === "line"
          ? op.obj === obj && op.owner === key
          : op.obj === obj && op.key === key
      )
    )
  }

  /** Прибрати рядок, якого ніхто не тримає (межа пам'яті). */
  function collect(scope: Scope, o: ObjState, key: Key) {
    scope.assert()
    const e = o.rows.get(key)
    if (e === undefined) return
    if (e.owners > 0 || o.own.has(key) || heldByLog(o.name, key)) return
    remember(o.name, e.row)
    o.rows.delete(key)
    touchRow(o.name, key)
    rowCache.delete(rowId(o.name, key))
  }

  /**
   * Найбільші версії вивантажених ключів (обмежено `SEEN_MAX`, найстаріші
   * витісняються). Без неї застаріла відповідь, надіслана до вивантаження,
   * повернула б ключ старшою версією, ніж користувач уже бачив (Рд24 між
   * появами ключа; знайдено модельним тестом).
   */
  const seen = new Map<string, number>()
  const SEEN_MAX = 10_000
  const remember = (obj: ObjectName, row: ServerRow) => {
    const id = rowId(obj, row.key)
    seen.delete(id)
    seen.set(id, row.version)
    if (seen.size > SEEN_MAX) {
      const oldest = seen.keys().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
  }
  const staleInserts = new Map<ObjectName, Set<Key>>()

  /** Записати рядок з результату підмножини за правилом версії. */
  function putRow(scope: Scope, o: ObjState, row: ServerRow) {
    scope.assert()
    const e = o.rows.get(row.key)
    if (e === undefined) {
      const known = seen.get(rowId(o.name, row.key)) ?? 0
      // Старше за бачене: показ без приховування, але `stale` до
      // перечитування (ставиться в чергу після commit).
      const stale = row.version < known
      o.rows.set(row.key, {
        row,
        owners: 0,
        stale,
        staleUntil: stale ? known : 0,
        removed: false,
      })
      if (stale) {
        const set = staleInserts.get(o.name) ?? new Set()
        set.add(row.key)
        staleInserts.set(o.name, set)
      }
      touchRow(o.name, row.key)
      return
    }
    const merged = mergeVersioned(e.row, row)
    if (merged === undefined) return
    e.row = merged
    if (e.stale && merged.version >= e.staleUntil) e.stale = false
    e.removed = false
    touchRow(o.name, row.key)
  }

  function own(scope: Scope, s: Subset, keys: Iterable<Key>) {
    scope.assert()
    const next = new Set(keys)
    for (const key of next) {
      if (s.owned.has(key)) continue
      const e = s.obj.rows.get(key)
      if (e === undefined) continue
      e.owners++
      // Перший результат, що повернув власне створення, дає йому власника.
      s.obj.own.delete(key)
    }
    const prev = s.owned
    s.owned = new Set([...next].filter((k) => s.obj.rows.has(k)))
    for (const key of prev) {
      if (next.has(key)) continue
      const e = s.obj.rows.get(key)
      if (e !== undefined) e.owners--
      collect(scope, s.obj, key)
    }
  }

  function setLayout(scope: Scope, s: Subset, layout: Key[]) {
    scope.assert()
    s.layout = layout
    s.layoutSet = new Set(layout)
    touchSubset(s)
  }

  function removeSectionsOf(scope: Scope, obj: ObjectName, owner: Key) {
    scope.assert()
    for (const [sid, entry] of sections) {
      if (!sid.startsWith(`${obj}\u0000${owner}\u0000`)) continue
      entry.lines = []
      entry.complete = false
      touchSection(sid)
    }
  }

  // ------------------------------------------------------------ показ

  function liveRecsOf(obj: ObjectName, key: Key): Rec[] {
    return mutLog.filter((r) =>
      r.ops.some((op) => op.k !== "line" && op.obj === obj && op.key === key)
    )
  }

  function computeRow(
    obj: ObjectName,
    key: Key,
    prev: RowView | undefined
  ): RowView | undefined {
    const o = objOf(obj)
    const e = o.rows.get(key)
    const recs = liveRecsOf(obj, key)
    let values: Record<string, unknown> | undefined =
      e === undefined ? undefined : { ...e.row.values }
    let deleting = false
    let created = false
    const pending = new Set<string>()
    const infos: MutationInfo[] = []
    let anyConflict = false
    let anyFailed = false
    let anyLive = false
    let anyUnknown = false
    for (const r of recs) {
      const fields: string[] = []
      let opKind: MutationInfo["op"] = "update"
      // `await`: значення не змінюється до відповіді `run`, лише стан.
      const predict = r.policy === "predict"
      for (const op of r.ops) {
        if (op.k === "line" || op.obj !== obj || op.key !== key) continue
        if (!predict) {
          fields.push(...fieldsOf(op))
          if (op.k === "delete") {
            deleting = true
            opKind = "delete"
          } else if (op.k === "create") opKind = "create"
          continue
        }
        if (op.k === "create") {
          created = e === undefined
          values = { ...(values ?? {}), ...op.values }
          fields.push(...Object.keys(op.values))
          opKind = "create"
        } else if (op.k === "update") {
          if (values === undefined) continue
          values = { ...values, ...op.values }
          fields.push(...Object.keys(op.values))
        } else {
          deleting = true
          opKind = "delete"
        }
      }
      if (r.state === "queued" || r.state === "sending") {
        anyLive = true
        for (const f of fields) pending.add(f)
      }
      if (r.state === "conflict") anyConflict = true
      if (r.state === "failed") anyFailed = true
      if (r.state === "unknown") anyUnknown = true
      infos.push({
        id: r.id,
        state: r.state,
        fields,
        op: opKind,
        policy: r.policy,
        ...(r.error === undefined ? {} : { error: r.error }),
      })
    }
    if (values === undefined) return undefined
    const state: RowState = e?.removed
      ? "removed"
      : anyConflict
        ? "conflict"
        : anyFailed
          ? "failed"
          : anyUnknown
            ? "unknown"
            : anyLive || (deleting && !anyFailed)
              ? "pending"
              : e?.stale
                ? "stale"
                : "synced"
    const status: RowStatus = {
      state,
      pendingFields: [...pending].sort(),
      mutations: infos,
      deleting,
      created,
      ...(anyConflict && e !== undefined ? { server: e.row } : {}),
    }
    const version = created ? undefined : e?.row.version
    // Структурне спільне використання: та сама посилка значень і стану,
    // поки показане не змінилось (критерій 2: pending → synced без кадру).
    const sameValues = prev !== undefined && equalValues(prev.values, values)
    const nextValues = sameValues ? prev.values : Object.freeze(values)
    const nextStatus =
      prev !== undefined && equalStatus(prev.status, status)
        ? prev.status
        : status
    if (
      prev !== undefined &&
      nextValues === prev.values &&
      nextStatus === prev.status &&
      prev.version === version
    ) {
      return prev
    }
    return Object.freeze({
      key,
      version,
      values: nextValues,
      status: nextStatus,
    })
  }

  function equalStatus(a: RowStatus, b: RowStatus): boolean {
    return (
      a.state === b.state &&
      a.deleting === b.deleting &&
      a.created === b.created &&
      a.server === b.server &&
      a.pendingFields.join() === b.pendingFields.join() &&
      a.mutations.length === b.mutations.length &&
      a.mutations.every((m, i) => {
        const n = b.mutations[i]
        return (
          n !== undefined &&
          m.id === n.id &&
          m.state === n.state &&
          m.error === n.error &&
          m.op === n.op &&
          m.policy === n.policy &&
          m.fields.join() === n.fields.join()
        )
      })
    )
  }

  function rowView(obj: ObjectName, key: Key): RowView | undefined {
    const id = rowId(obj, key)
    const rev = rowRev.get(id) ?? 0
    const cached = rowCache.get(id)
    if (cached !== undefined && cached.rev === rev) return cached.view
    const view = computeRow(obj, key, cached?.view)
    rowCache.set(id, { rev, view })
    return view
  }

  function sectionLines(
    obj: ObjectName,
    owner: Key,
    section: string
  ): SectionLineView[] {
    const entry = sections.get(sectionId(obj, owner, section))
    const lines: SectionLineView[] = (entry?.lines ?? []).map((l) => ({
      key: l.key,
      values: l.values,
      pending: false,
      removing: false,
    }))
    for (const r of mutLog) {
      if (r.policy !== "predict") continue
      const live = r.state === "queued" || r.state === "sending"
      for (const op of r.ops) {
        if (
          op.k !== "line" ||
          op.obj !== obj ||
          op.owner !== owner ||
          op.section !== section
        )
          continue
        const d = op.d
        if (d.t === "add") {
          lines.push({
            key: d.line.key,
            values: d.line.values,
            pending: live,
            removing: false,
          })
        } else {
          const i = lines.findIndex((l) => l.key === d.key)
          const line = lines[i]
          if (line === undefined) continue
          lines[i] =
            d.t === "update"
              ? {
                  ...line,
                  values: { ...line.values, ...d.values },
                  pending: line.pending || live,
                }
              : { ...line, pending: line.pending || live, removing: true }
        }
      }
    }
    return lines
  }

  function computeSnapshot(s: Subset): ViewSnapshot {
    const prev = s.snapshot
    const obj = s.obj.name
    const rows: RowView[] = []
    if (s.spec.kind !== "section") {
      for (const key of s.layout) {
        const view = rowView(obj, key)
        if (view !== undefined) rows.push(view)
      }
    }
    let section: ViewSnapshot["section"]
    if (s.spec.kind === "section") {
      const sid = sectionId(obj, s.spec.owner, s.spec.section)
      const entry = sections.get(sid)
      const lines = sectionLines(obj, s.spec.owner, s.spec.section)
      const prevLines = prev?.section?.lines
      const sameLines =
        prevLines !== undefined &&
        prevLines.length === lines.length &&
        prevLines.every((l, i) => {
          const n = lines[i]
          return (
            n !== undefined &&
            l.key === n.key &&
            l.pending === n.pending &&
            l.removing === n.removing &&
            equalValues(l.values, n.values)
          )
        })
      section = {
        ownerVersion: entry?.ownerVersion,
        complete: entry?.complete ?? false,
        lines: sameLines ? prevLines : lines,
      }
      if (
        prev?.section !== undefined &&
        prev.section.ownerVersion === section.ownerVersion &&
        prev.section.complete === section.complete &&
        prev.section.lines === section.lines
      ) {
        section = prev.section
      }
    }
    const sameRows =
      prev !== undefined &&
      prev.rows.length === rows.length &&
      prev.rows.every((r, i) => r === rows[i])
    const next: ViewSnapshot = {
      status: s.status,
      ...(s.error === undefined ? {} : { error: s.error }),
      rows: sameRows ? prev.rows : Object.freeze(rows),
      hasNewRows: s.hasNewRows,
      needsRefresh: s.needsRefresh,
      ...(section === undefined ? {} : { section }),
      ...(s.spec.kind === "window" ? { window: { atEnd: s.atEnd } } : {}),
      ...(s.spec.kind === "full" ? { truncated: s.truncated } : {}),
    }
    if (
      prev !== undefined &&
      prev.status === next.status &&
      prev.error === next.error &&
      prev.rows === next.rows &&
      prev.hasNewRows === next.hasNewRows &&
      prev.needsRefresh === next.needsRefresh &&
      prev.section === next.section &&
      prev.window?.atEnd === next.window?.atEnd &&
      prev.truncated === next.truncated
    ) {
      return prev
    }
    return Object.freeze(next)
  }

  function snapshotOf(s: Subset): ViewSnapshot {
    if (s.snapshot === undefined || s.dirty) {
      s.snapshot = computeSnapshot(s)
      s.dirty = false
    }
    return s.snapshot
  }

  function affected(s: Subset): boolean {
    if (dirtySubsets.has(s)) return true
    const obj = s.obj.name
    if (s.spec.kind === "section") {
      return (
        dirtySections.has(sectionId(obj, s.spec.owner, s.spec.section)) ||
        dirtyRows.has(rowId(obj, s.spec.owner))
      )
    }
    for (const id of dirtyRows) {
      const sep = id.indexOf("\u0000")
      if (id.slice(0, sep) === obj && s.layoutSet.has(id.slice(sep + 1)))
        return true
    }
    return false
  }

  /** Після `fn` коміту: свіжість ТЧ, знімки виглядів, одна пачка сповіщень. */
  function flush() {
    if (!changed) return
    const toNotify: Subset[] = []
    for (const s of subsets.values()) {
      if (!affected(s)) continue
      if (s.spec.kind === "section") checkSectionFreshness(s)
      s.dirty = true
      if (s.listeners.size > 0) {
        const before = s.snapshot
        if (snapshotOf(s) !== before) toNotify.push(s)
      }
    }
    dirtyRows.clear()
    dirtySections.clear()
    dirtySubsets.clear()
    changed = false
    for (const s of toNotify) for (const l of [...s.listeners]) call(l)
    for (const l of [...listeners]) call(l)
  }

  function call(listener: () => void) {
    try {
      listener()
    } catch (error) {
      log({ kind: "listener-failed", error })
    }
  }

  /** Свіжість ТЧ (Рд27): шапка новіша за `ownerVersion` — перезапит. */
  function checkSectionFreshness(s: Subset) {
    if (s.spec.kind !== "section") return
    const entry = sections.get(
      sectionId(s.obj.name, s.spec.owner, s.spec.section)
    )
    const header = s.obj.rows.get(s.spec.owner)
    if (entry === undefined || header === undefined) return
    if (header.row.version > entry.ownerVersion && !s.needsRefresh) {
      s.needsRefresh = true
      if (s.listeners.size > 0) queueMicrotask(() => load(s))
    }
  }

  // ------------------------------------------------------------ джерело

  /** Виклик джерела з сигналом; `session-changed` закриває сесію. */
  async function read(
    query: ReadQuery,
    signal: AbortSignal
  ): Promise<ReadRows> {
    try {
      return await source.read(query, signal)
    } catch (e) {
      if (
        isCommandFailure(e) &&
        e.error.code === "command.unauthenticated" &&
        e.error.reason === LIMIT_REASONS.sessionChanged
      ) {
        dispose()
      }
      throw e
    }
  }

  const linked = (): AbortController => {
    const c = new AbortController()
    if (abort.signal.aborted) c.abort()
    else abort.signal.addEventListener("abort", () => c.abort(), { once: true })
    return c
  }

  /** Читання за ключами: по `keysPerRequest`, на `response-too-large` — навпіл. */
  async function readKeys(
    o: ObjState,
    keys: readonly Key[],
    signal: AbortSignal
  ): Promise<ServerRow[]> {
    const out: ServerRow[] = []
    const chunks: Key[][] = []
    for (let i = 0; i < keys.length; i += keysPerRequest) {
      chunks.push(keys.slice(i, i + keysPerRequest))
    }
    const one = async (chunk: readonly Key[]): Promise<ServerRow[]> => {
      try {
        const res = await read(
          {
            object: o.spec.ref,
            where: { attribute: "id", op: "in", value: [...chunk] },
            limit: chunk.length,
          },
          signal
        )
        return res.rows.map(toServerRow)
      } catch (e) {
        if (
          isCommandFailure(e) &&
          e.error.reason === LIMIT_REASONS.responseTooLarge &&
          chunk.length > 1
        ) {
          const half = Math.ceil(chunk.length / 2)
          const [a, b] = await Promise.all([
            one(chunk.slice(0, half)),
            one(chunk.slice(half)),
          ])
          return [...a, ...b]
        }
        throw e
      }
    }
    for (const rows of await Promise.all(chunks.map(one))) out.push(...rows)
    return out
  }

  // ------------------------------------------------------------ підмножини

  type LoadResult = (scope: Scope) => void

  async function fetchSubset(
    s: Subset,
    signal: AbortSignal,
    mode: "load" | "more"
  ): Promise<LoadResult> {
    const o = s.obj
    const spec = s.spec
    switch (spec.kind) {
      case "keys": {
        const rows = await readKeys(o, spec.keys, signal)
        return (scope) => {
          for (const r of rows) putRow(scope, o, r)
          own(
            scope,
            s,
            rows.map((r) => r.key)
          )
          setLayout(
            scope,
            s,
            spec.keys.filter((k) => o.rows.has(k))
          )
        }
      }
      case "card": {
        const res = await read({ object: o.spec.ref, id: spec.key }, signal)
        const rows = res.rows.map(toServerRow)
        return (scope) => {
          for (const r of rows) putRow(scope, o, r)
          own(
            scope,
            s,
            rows.map((r) => r.key)
          )
          setLayout(scope, s, [spec.key])
        }
      }
      case "section": {
        const res = await read(
          {
            object: o.spec.ref,
            tabularSection: spec.section,
            owner: spec.owner,
          },
          signal
        )
        const ownerVersion = res.ownerVersion ?? 0
        const lines = res.rows.map(toLine)
        return (scope) =>
          applySection(
            scope,
            o.name,
            spec.owner,
            spec.section,
            ownerVersion,
            lines
          )
      }
      case "full": {
        // Уся видима множина keyset-ом за ключем, сторінками по 200.
        const rows: ServerRow[] = []
        let last: Key | undefined
        let truncated = false
        for (;;) {
          const res = await read(
            {
              object: o.spec.ref,
              orderBy: [{ attribute: "id", direction: "asc" }],
              limit: 200,
              ...(last === undefined
                ? {}
                : { where: { attribute: "id", op: "gt", value: last } }),
            },
            signal
          )
          rows.push(...res.rows.map(toServerRow))
          if (rows.length > fullLimit) {
            truncated = true
            rows.length = fullLimit
            break
          }
          if (res.rows.length < 200 && res.more !== true) break
          last = rows[rows.length - 1]?.key
        }
        return (scope) => {
          for (const r of rows) putRow(scope, o, r)
          own(
            scope,
            s,
            rows.map((r) => r.key)
          )
          s.truncated = truncated
          setLayout(scope, s, computeFullLayout(s))
        }
      }
      case "window": {
        const size = spec.pageSize ?? 100
        const after = mode === "more" ? s.cursor : undefined
        const where: Filter | undefined =
          after === undefined
            ? spec.where
            : spec.where === undefined
              ? keysetAfter(spec.orderBy, after)
              : { and: [spec.where, keysetAfter(spec.orderBy, after)] }
        const res = await read(
          {
            object: o.spec.ref,
            orderBy: spec.orderBy,
            limit: size,
            ...(where === undefined ? {} : { where }),
          },
          signal
        )
        const rows = res.rows.map(toServerRow)
        const atEnd = rows.length < size && res.more !== true
        const lastRow = rows[rows.length - 1]
        return (scope) => {
          for (const r of rows) putRow(scope, o, r)
          const keys = rows.map((r) => r.key)
          const prevKeys =
            mode === "more" ? s.layout.filter((k) => !keys.includes(k)) : []
          // Власні створення, вже показані на початку, лишаються там.
          const created =
            mode === "load"
              ? s.layout.filter((k) => o.own.has(k) && !keys.includes(k))
              : []
          own(scope, s, [...(mode === "more" ? s.owned : []), ...keys])
          s.atEnd = atEnd
          if (lastRow !== undefined)
            s.cursor = { key: lastRow.key, values: lastRow.values }
          setLayout(scope, s, [...created, ...prevKeys, ...keys])
        }
      }
    }
  }

  /** Склад `full`: локальний фільтр і сортування над показаними значеннями. */
  function computeFullLayout(s: Subset): Key[] {
    if (s.spec.kind !== "full") return []
    const { where, orderBy } = s.spec
    const fields = s.obj.spec.fields
    const items: { key: Key; values: Values }[] = []
    const consider = (key: Key) => {
      const view = rowView(s.obj.name, key)
      if (view !== undefined && matches(fields, view.values, where)) {
        items.push({ key, values: view.values })
      }
    }
    for (const key of s.owned) consider(key)
    for (const key of s.obj.own) if (!s.owned.has(key)) consider(key)
    items.sort(rowComparator(fields, orderBy))
    return items.map((i) => i.key)
  }

  function applySection(
    scope: Scope,
    obj: ObjectName,
    owner: Key,
    section: string,
    ownerVersion: number,
    lines: SectionLine[]
  ) {
    scope.assert()
    const sid = sectionId(obj, owner, section)
    const entry = sections.get(sid)
    if (entry === undefined) {
      sections.set(sid, { ownerVersion, lines, complete: true })
      touchSection(sid)
      return
    }
    // Рд24 для ТЧ: результат з меншою `ownerVersion` відкидається цілком.
    if (ownerVersion < entry.ownerVersion) return
    entry.ownerVersion = ownerVersion
    entry.lines = lines
    entry.complete = true
    touchSection(sid)
  }

  /** Завантаження чи перезапит підмножини: single-flight з одним хвостом. */
  function load(s: Subset, mode: "load" | "more" = "load") {
    if (!s.alive || closed) return
    if (s.loading) {
      s.trailing = true
      return
    }
    s.loading = true
    const gen = ++s.gen
    const token = subsetToken(s, gen)
    const controller = linked()
    s.abort = controller
    commitInternal(() => {
      const hasData = s.layout.length > 0 || s.status === "ready"
      s.status = hasData ? "refreshing" : "loading"
      touchSubset(s)
    }, token)
    fetchSubset(s, controller.signal, mode)
      .then(
        (apply) => {
          const wrote = commitInternal((scope) => {
            apply(scope)
            s.status = "ready"
            delete s.error
            s.needsRefresh = false
            if (mode === "load") s.hasNewRows = false
            touchSubset(s)
          }, token)
          if (!wrote) log({ kind: "late-response", what: s.specKey })
        },
        (e: unknown) => {
          commitInternal(() => {
            s.status = "error"
            s.error = errorOf(e)
            touchSubset(s)
          }, token)
        }
      )
      .finally(() => {
        if (s.gen !== gen) return
        for (const w of s.waiters.splice(0)) w()
        s.loading = false
        if (s.trailing && s.alive && !closed) {
          s.trailing = false
          load(s)
        }
      })
  }

  /** Звільнення підмножини — теж зміна стану, тож через `commit` сесії. */
  function release(s: Subset) {
    if (!s.alive) return
    commitInternal((scope) => {
      s.alive = false
      s.abort?.abort()
      subsets.delete(s.specKey)
      own(scope, s, [])
      const spec = s.spec
      if (spec.kind === "section") {
        const sid = sectionId(s.obj.name, spec.owner, spec.section)
        // ТЧ тримають лише дельти рядків цієї ТЧ у журналі, не правки шапки.
        const held = mutLog.some((r) =>
          r.ops.some(
            (op) =>
              op.k === "line" &&
              op.obj === s.obj.name &&
              op.owner === spec.owner &&
              op.section === spec.section
          )
        )
        if (sections.has(sid) && !held) {
          sections.delete(sid)
          touchSection(sid)
        }
      }
    }, sessionToken)
    for (const w of s.waiters.splice(0)) w()
  }

  function makeSubset(spec: ViewSpec, specKey: string): Subset {
    const made: Subset = {
      id: nextSubsetId++,
      specKey,
      spec,
      obj: objOf(spec.object),
      holds: 0,
      preloads: 0,
      alive: true,
      gen: 0,
      owned: new Set(),
      layout: [],
      layoutSet: new Set(),
      status: "loading",
      loading: false,
      trailing: false,
      needsRefresh: false,
      hasNewRows: false,
      atEnd: false,
      truncated: false,
      dirty: true,
      listeners: new Set(),
      waiters: [],
    }
    subsets.set(specKey, made)
    return made
  }

  /**
   * Утримання підмножини (підписка, попереднє завантаження, знімок SSR).
   * Перше утримання створює підмножину й завантажує її.
   */
  function hold(spec: ViewSpec, specKey: string): Subset {
    let s = subsets.get(specKey)
    if (s === undefined) {
      s = makeSubset(spec, specKey)
      load(s)
    }
    if (s.releaseTimer !== undefined) {
      clearTimeout(s.releaseTimer)
      delete s.releaseTimer
    }
    s.holds++
    return s
  }

  /**
   * Останнє утримання відпущено: звільнення відкладене на `releaseDelayMs`,
   * щоб повторне монтування (StrictMode, перехід) не перезавантажувало дані
   * й не давало «пропало-з'явилось».
   */
  function unhold(s: Subset) {
    s.holds--
    if (s.holds > 0 || !s.alive) return
    if (releaseDelayMs <= 0) {
      release(s)
      return
    }
    s.releaseTimer = setTimeout(() => {
      delete s.releaseTimer
      if (s.holds === 0) release(s)
    }, releaseDelayMs)
  }

  const handles = new Map<string, ViewHandle>()

  /**
   * Чиста функція: мемоізований хендл за канонічним ключем форми. Нічого не
   * завантажує й не володіє — власність дає `subscribe`.
   */
  function view(spec: ViewSpec): ViewHandle {
    objOf(spec.object)
    const specKey = specKeyOf(spec)
    const found = handles.get(specKey)
    if (found !== undefined) return found
    const idle: ViewSnapshot = Object.freeze({
      status: "loading",
      rows: Object.freeze([]),
      hasNewRows: false,
      needsRefresh: false,
    })
    const live = () => subsets.get(specKey)
    const handle: ViewHandle = {
      getSnapshot() {
        const s = live()
        return s === undefined ? idle : snapshotOf(s)
      },
      subscribe(listener) {
        if (closed) return () => {}
        const s = hold(spec, specKey)
        s.listeners.add(listener)
        // Перша підписка відпускає утримання попереднього завантаження.
        while (s.preloads > 0) {
          s.preloads--
          unhold(s)
        }
        // Невидима ТЧ з `needsRefresh` оновлюється, щойно стає видимою.
        if (s.needsRefresh && s.spec.kind === "section") load(s)
        let done = false
        return () => {
          if (done) return
          done = true
          s.listeners.delete(listener)
          if (!closed) unhold(s)
        }
      },
      refresh() {
        const s = live()
        if (s !== undefined) load(s)
      },
      showNew() {
        const s = live()
        if (s !== undefined) load(s)
      },
      loadAfter() {
        const s = live()
        if (s !== undefined && s.spec.kind === "window" && !s.atEnd)
          load(s, "more")
      },
    }
    handles.set(specKey, handle)
    return handle
  }

  /** Попереднє завантаження (loader роутера): власне утримання з строком. */
  function preload(
    spec: ViewSpec,
    options?: { ttlMs?: number }
  ): Promise<void> {
    if (closed) return Promise.resolve()
    const specKey = specKeyOf(spec)
    const s = hold(spec, specKey)
    s.preloads++
    setTimeout(() => {
      if (s.preloads === 0 || !s.alive) return
      s.preloads--
      unhold(s)
    }, options?.ttlMs ?? 5_000)
    if (s.status !== "loading") return Promise.resolve()
    return new Promise((resolve) => s.waiters.push(resolve))
  }

  // ------------------------------------------------------------ мутації

  function fieldsOf(op: Op): string[] {
    return op.k === "create" || op.k === "update" ? Object.keys(op.values) : []
  }

  /** Поля ключа, які пишуть живі власні мутації журналу (база — своя). */
  function ownFieldsBefore(obj: ObjectName, key: Key): Set<string> {
    const out = new Set<string>()
    for (const r of liveRecsOf(obj, key)) {
      for (const op of r.ops) {
        if (op.k !== "line" && op.obj === obj && op.key === key) {
          for (const f of fieldsOf(op)) out.add(f)
        }
      }
    }
    return out
  }

  function begin(txOptions?: TxOptions): Tx {
    const policy: ActionPolicy = txOptions?.policy ?? "await"
    const ops: Op[] = []
    let done = false
    const guard = () => {
      if (done) throw new Error("transaction is committed")
    }
    const tx: Tx = {
      create(object, key, values) {
        guard()
        objOf(object)
        ops.push({ k: "create", obj: object, key, values })
        return tx
      },
      update(object, key, values) {
        guard()
        const o = objOf(object)
        const own = ownFieldsBefore(object, key)
        for (const op of ops) {
          if (op.k !== "line" && op.obj === object && op.key === key) {
            for (const f of fieldsOf(op)) own.add(f)
          }
        }
        const confirmed = o.rows.get(key)?.row.values ?? {}
        const base: Record<string, unknown> = {}
        for (const f of Object.keys(values)) {
          if (!own.has(f)) base[f] = confirmed[f]
        }
        ops.push({
          k: "update",
          obj: object,
          key,
          values,
          base,
          baseVersion: o.rows.get(key)?.row.version,
          chained: own.size > 0,
        })
        return tx
      },
      delete(object, key) {
        guard()
        objOf(object)
        ops.push({ k: "delete", obj: object, key })
        return tx
      },
      addLine(object, owner, section, line) {
        guard()
        ops.push({
          k: "line",
          obj: object,
          owner,
          section,
          d: { t: "add", line },
        })
        return tx
      },
      updateLine(object, owner, section, line, values) {
        guard()
        ops.push({
          k: "line",
          obj: object,
          owner,
          section,
          d: { t: "update", key: line, values },
        })
        return tx
      },
      removeLine(object, owner, section, line) {
        guard()
        ops.push({
          k: "line",
          obj: object,
          owner,
          section,
          d: { t: "remove", key: line },
        })
        return tx
      },
      commit() {
        guard()
        done = true
        return enqueue(ops, policy)
      },
    }
    return tx
  }

  function newRec(ops: Op[], policy: ActionPolicy): Rec {
    let resolve!: (o: MutationOutcome) => void
    const settled = new Promise<MutationOutcome>((r) => {
      resolve = r
    })
    return {
      id: nextMutationId++,
      ops,
      state: "queued",
      attempt: 0,
      rebases: 0,
      policy,
      sent: new Map(),
      resolve,
      settled,
    }
  }

  function enqueue(ops: Op[], policy: ActionPolicy): Mutation {
    const rec = newRec(ops, policy)
    if (closed || ops.length === 0) {
      rec.resolve(
        closed ? { ok: false, error: DISPOSED } : { ok: true, rows: [] }
      )
      return { id: rec.id, settled: rec.settled }
    }
    commitInternal((scope) => {
      scope.assert()
      mutLog.push(rec)
      touchRec(rec)
      // Власне створення — один раз, на початку виглядів, яким воно підходить.
      for (const op of ops) {
        if (op.k !== "create") continue
        for (const s of subsets.values()) {
          if (s.obj.name !== op.obj || s.layoutSet.has(op.key)) continue
          if (s.spec.kind === "full" || s.spec.kind === "window") {
            if (matches(s.obj.spec.fields, op.values, s.spec.where)) {
              setLayout(scope, s, [op.key, ...s.layout])
            }
          }
        }
      }
    }, sessionToken)
    pump()
    return { id: rec.id, settled: rec.settled }
  }

  function touchRec(rec: Rec) {
    for (const op of rec.ops) {
      if (op.k === "line") {
        touchSection(sectionId(op.obj, op.owner, op.section))
        touchRow(op.obj, op.owner)
      } else touchRow(op.obj, op.key)
    }
  }

  const recKeys = (rec: Rec) =>
    rec.ops.map((op) =>
      op.k === "line" ? rowId(op.obj, op.owner) : rowId(op.obj, op.key)
    )

  /** Черга ключа (§7.1): мутація стартує, коли попередні того ключа осіли. */
  function pump() {
    if (closed) return
    for (let i = 0; i < mutLog.length; i++) {
      const rec = mutLog[i]
      if (rec === undefined || rec.state !== "queued") continue
      const keys = new Set(recKeys(rec))
      const blocked = mutLog
        .slice(0, i)
        .some(
          (r) =>
            (r.state === "queued" ||
              r.state === "sending" ||
              r.state === "unknown") &&
            recKeys(r).some((k) => keys.has(k))
        )
      if (!blocked) void send(rec)
    }
  }

  type Built =
    | {
        kind: "send"
        operations: Operation[]
        touchedSections: { obj: ObjectName; owner: Key; section: string }[]
      }
    | { kind: "local"; error: CommandError; conflict: boolean }
    | { kind: "noop" }

  function build(rec: Rec): Built {
    const operations: Operation[] = []
    const touchedSections: { obj: ObjectName; owner: Key; section: string }[] =
      []
    const updates = new Map<
      string,
      {
        obj: ObjectName
        key: Key
        values: Record<string, unknown>
        sections: Record<string, Record<string, unknown>[]>
      }
    >()
    const updateOf = (obj: ObjectName, key: Key) => {
      const id = rowId(obj, key)
      let u = updates.get(id)
      if (u === undefined) {
        u = { obj, key, values: {}, sections: {} }
        updates.set(id, u)
      }
      return u
    }
    const sectionArrays = new Map<string, SectionLine[]>()
    for (const op of rec.ops) {
      const o = objOf(op.obj)
      if (op.k === "create") {
        operations.push({
          action: "create",
          object: o.spec.ref,
          id: op.key,
          values: { ...op.values },
        })
        continue
      }
      if (op.k === "delete") {
        const e = o.rows.get(op.key)
        if (e === undefined)
          return {
            kind: "local",
            error: { code: "command.conflict", reason: "no-base" },
            conflict: true,
          }
        operations.push({
          action: "delete",
          object: o.spec.ref,
          id: op.key,
          expectedVersion: e.row.version,
        })
        continue
      }
      if (op.k === "update") {
        const e = o.rows.get(op.key)
        if (e === undefined)
          return {
            kind: "local",
            error: { code: "command.conflict", reason: "no-base" },
            conflict: true,
          }
        // Розбіжність полів: сервер змінив поле, яке ми правимо, після нашої бази.
        for (const [f, v] of Object.entries(op.base)) {
          if (!equalValue(e.row.values[f], v)) {
            return {
              kind: "local",
              error: { code: "command.conflict", reason: "version" },
              conflict: true,
            }
          }
        }
        // `await` (команди, проведення): зміна версії після дії — конфлікт,
        // без перебазування: правило команди могло залежати від зміненого.
        if (
          rec.policy === "await" &&
          !op.chained &&
          e.row.version !== op.baseVersion
        ) {
          return {
            kind: "local",
            error: { code: "command.conflict", reason: "version" },
            conflict: true,
          }
        }
        const u = updateOf(op.obj, op.key)
        for (const [f, v] of Object.entries(op.values)) {
          if (!equalValue(e.row.values[f], v)) u.values[f] = v
          else delete u.values[f]
        }
        continue
      }
      // Дельта рядка ТЧ: повний масив бази ключа.
      const sid = sectionId(op.obj, op.owner, op.section)
      let lines = sectionArrays.get(sid)
      if (lines === undefined) {
        const entry = sections.get(sid)
        const header = o.rows.get(op.owner)
        if (entry === undefined || !entry.complete || header === undefined) {
          return {
            kind: "local",
            error: { code: "command.invalid", reason: "tabular-incomplete" },
            conflict: false,
          }
        }
        if (entry.ownerVersion !== header.row.version) {
          return {
            kind: "local",
            error: { code: "command.conflict", reason: "version" },
            conflict: true,
          }
        }
        lines = [...entry.lines]
        sectionArrays.set(sid, lines)
        touchedSections.push({
          obj: op.obj,
          owner: op.owner,
          section: op.section,
        })
      }
      const d = op.d
      if (d.t === "add") lines.push(d.line)
      else {
        const i = lines.findIndex((l) => l.key === d.key)
        const line = lines[i]
        if (line === undefined) {
          return {
            kind: "local",
            error: { code: "command.conflict", reason: "line-missing" },
            conflict: true,
          }
        }
        if (d.t === "update")
          lines[i] = { key: line.key, values: { ...line.values, ...d.values } }
        else lines.splice(i, 1)
      }
      updateOf(op.obj, op.owner).sections[op.section] = lines.map((l) => ({
        id: l.key,
        ...l.values,
      }))
    }
    for (const u of updates.values()) {
      const o = objOf(u.obj)
      const e = o.rows.get(u.key)
      if (e === undefined) continue
      if (
        Object.keys(u.values).length === 0 &&
        Object.keys(u.sections).length === 0
      )
        continue
      operations.push({
        action: "update",
        object: o.spec.ref,
        id: u.key,
        expectedVersion: e.row.version,
        ...(Object.keys(u.values).length === 0 ? {} : { values: u.values }),
        ...(Object.keys(u.sections).length === 0
          ? {}
          : { tabularSections: u.sections }),
      })
    }
    return operations.length === 0
      ? { kind: "noop" }
      : { kind: "send", operations, touchedSections }
  }

  async function send(rec: Rec) {
    const attempt = ++rec.attempt
    const token = recToken(rec, attempt)
    const built = build(rec)
    if (built.kind === "local") {
      settleFailure(rec, token, built.error, built.conflict)
      return
    }
    if (built.kind === "noop") {
      commitInternal((scope) => settleSuccess(scope, rec, []), token)
      return
    }
    rec.sent = new Map(
      built.operations.flatMap((op) =>
        op.action === "create"
          ? []
          : [[rowId(refName(op.object), op.id), op.expectedVersion] as const]
      )
    )
    const controller = linked()
    rec.abort = controller
    commitInternal(() => {
      rec.state = "sending"
      touchRec(rec)
    }, token)
    let result
    try {
      result = await source.run(built.operations, controller.signal)
    } catch (e) {
      if (closed) return
      const error = errorOf(e)
      if (
        error.code === "command.unauthenticated" &&
        error.reason === LIMIT_REASONS.sessionChanged
      ) {
        dispose()
        return
      }
      if (
        error.code === "command.conflict" &&
        rec.rebases < AUTO_REBASE_MAX &&
        headerOnly(rec)
      ) {
        // Конфлікт версії без розбіжності полів: перечитати й перебазувати.
        await refetchKeys(...firstObjKeys(rec))
        if (!token.valid) return
        const diverged = build(rec)
        if (diverged.kind === "send" || diverged.kind === "noop") {
          commitInternal(() => {
            rec.rebases++
            rec.state = "queued"
            touchRec(rec)
          }, token)
          pump()
          return
        }
        settleFailure(rec, token, error, true)
        return
      }
      if (
        error.code === "command.unavailable" ||
        error.code === "command.timeout"
      ) {
        await resolveUnknown(rec, token, error)
        return
      }
      settleFailure(rec, token, error, error.code === "command.conflict")
      if (["command.conflict", "command.forbidden"].includes(error.code)) {
        void refetchAll(rec)
      }
      return
    }
    // Перечитування ТЧ після запису: осідання й нові рядки ТЧ — один commit.
    const sectionResults = await Promise.all(
      built.touchedSections.map(async (t) => {
        const o = objOf(t.obj)
        try {
          const res = await Promise.race([
            read(
              { object: o.spec.ref, tabularSection: t.section, owner: t.owner },
              controller.signal
            ),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("timeout")), SECTION_REFETCH_MS)
            ),
          ])
          return {
            t,
            ok: true as const,
            ownerVersion: res.ownerVersion ?? 0,
            lines: res.rows.map(toLine),
          }
        } catch {
          return { t, ok: false as const }
        }
      })
    )
    const rows = result.rows.map((r) =>
      typeof r.version === "number" ? toServerRow(r) : undefined
    )
    const wrote = commitInternal((scope) => {
      built.operations.forEach((operation, i) => {
        const row = rows[i]
        const o = objOf(refName(operation.object))
        if (operation.action === "delete") {
          const id = operation.id
          if (o.rows.delete(id)) touchRow(o.name, id)
          o.own.delete(id)
          rowCache.delete(rowId(o.name, id))
          removeSectionsOf(scope, o.name, id)
          return
        }
        if (row === undefined) return
        if (operation.action === "create") {
          if (!o.rows.has(row.key)) o.own.add(row.key)
          putRow(scope, o, row)
        } else if (o.rows.has(row.key)) {
          putRow(scope, o, row)
        } else {
          log({
            kind: "write-back-skipped",
            object: o.name,
            key: row.key,
            why: "absent",
          })
        }
      })
      for (const r of sectionResults) {
        if (r.ok)
          applySection(
            scope,
            r.t.obj,
            r.t.owner,
            r.t.section,
            r.ownerVersion,
            r.lines
          )
        else markSectionViews(r.t.obj, r.t.owner, r.t.section)
      }
      settleSuccess(scope, rec, rows)
    }, token)
    if (wrote) {
      pump()
      const missing = built.operations.filter(
        (op, i) => op.action !== "delete" && rows[i] === undefined
      )
      for (const op of missing) {
        if (op.action !== "delete" && op.id !== undefined)
          void refetchKeys(refName(op.object), [op.id])
      }
    }
  }

  /**
   * Результат невідомий: показ з позначкою `unknown`, перечитування ключів,
   * потім `synced` (зміна застосована), `failed` (не застосована) чи
   * `conflict` (рядок змінився інакше). Автоповтору немає.
   */
  async function resolveUnknown(
    rec: Rec,
    token: GenerationToken,
    error: CommandError
  ) {
    const marked = commitInternal(() => {
      rec.state = "unknown"
      rec.error = error
      touchRec(rec)
    }, token)
    if (!marked) return
    await refetchAll(rec, true)
    type Verdict = "applied" | "not-applied" | "conflict"
    let verdict = "applied" as Verdict
    for (const op of rec.ops) {
      const o = objOf(op.obj)
      const key = op.k === "line" ? op.owner : op.key
      const e = o.rows.get(key)
      const sentVersion = rec.sent.get(rowId(op.obj, key))
      let v: Verdict
      if (op.k === "create")
        v = e !== undefined && !e.removed ? "applied" : "not-applied"
      else if (op.k === "delete")
        v =
          e === undefined || e.removed
            ? "applied"
            : e.row.version === sentVersion
              ? "not-applied"
              : "conflict"
      else if (e === undefined || e.removed) v = "conflict"
      else if (e.row.version === sentVersion) v = "not-applied"
      else if (
        op.k === "update" &&
        Object.entries(op.values).every(([f, x]) =>
          equalValue(e.row.values[f], x)
        )
      )
        v = "applied"
      // Дельта ТЧ: версія власника зросла — вважаємо застосованою; рядки ТЧ
      // перечитує свіжість (Рд27).
      else v = op.k === "line" ? "applied" : "conflict"
      if (v === "conflict" || (v === "not-applied" && verdict === "applied"))
        verdict = v
    }
    if (verdict === "applied") {
      const wrote = commitInternal((scope) => {
        for (const op of rec.ops) {
          if (op.k !== "delete") continue
          const o = objOf(op.obj)
          if (o.rows.delete(op.key)) touchRow(o.name, op.key)
          o.own.delete(op.key)
          removeSectionsOf(scope, o.name, op.key)
        }
        for (const op of rec.ops) {
          if (op.k === "create") {
            const o = objOf(op.obj)
            const e = o.rows.get(op.key)
            if (e !== undefined && e.owners === 0) o.own.add(op.key)
          }
        }
        settleSuccess(scope, rec, [])
      }, token)
      if (wrote) pump()
      return
    }
    settleFailure(rec, token, error, verdict === "conflict")
  }

  // Автоперебазування — лише `predict` над простими правками атрибутів.
  const headerOnly = (rec: Rec) =>
    rec.policy === "predict" && rec.ops.every((op) => op.k === "update")
  const firstObjKeys = (rec: Rec): [ObjectName, Key[]] => {
    const first = rec.ops[0]
    const obj = first === undefined ? "" : first.obj
    return [
      obj,
      rec.ops
        .filter((op) => op.obj === obj)
        .map((op) => (op.k === "line" ? op.owner : op.key)),
    ]
  }

  async function refetchAll(rec: Rec, withCreates = false) {
    const byObj = new Map<ObjectName, Set<Key>>()
    for (const op of rec.ops) {
      if (op.k === "create" && !withCreates) continue
      const set = byObj.get(op.obj) ?? new Set()
      set.add(op.k === "line" ? op.owner : op.key)
      byObj.set(op.obj, set)
    }
    await Promise.all(
      [...byObj].map(([obj, keys]) => refetchKeys(obj, [...keys]))
    )
  }

  function markSectionViews(obj: ObjectName, owner: Key, section: string) {
    const s = subsets.get(
      specKeyOf({ kind: "section", object: obj, owner, section })
    )
    if (s === undefined) return
    s.needsRefresh = true
    touchSubset(s)
  }

  /** Осідання успіху: мутація зникає з журналу в тому самому commit, що write-back. */
  function settleSuccess(
    scope: Scope,
    rec: Rec,
    rows: readonly (ServerRow | undefined)[]
  ) {
    scope.assert()
    const i = mutLog.indexOf(rec)
    if (i < 0) return
    mutLog.splice(i, 1)
    touchRec(rec)
    // Пізніша успішна правка перекриває ті самі поля раніших відмовлених.
    const written = new Map<string, Set<string>>()
    for (const op of rec.ops) {
      if (op.k === "line") continue
      const id = rowId(op.obj, op.key)
      const set = written.get(id) ?? new Set()
      for (const f of fieldsOf(op)) set.add(f)
      written.set(id, set)
    }
    for (const earlier of mutLog.slice(0, i)) {
      if (earlier.state !== "failed" && earlier.state !== "conflict") continue
      earlier.ops = earlier.ops.flatMap((op): Op[] => {
        if (op.k !== "update") return [op]
        const fields = written.get(rowId(op.obj, op.key))
        if (fields === undefined) return [op]
        const values = Object.fromEntries(
          Object.entries(op.values).filter(([f]) => !fields.has(f))
        )
        if (Object.keys(values).length === 0) return []
        const base = Object.fromEntries(
          Object.entries(op.base).filter(([f]) => !fields.has(f))
        )
        return [{ ...op, values, base }]
      })
      touchRec(earlier)
    }
    for (let j = mutLog.length - 1; j >= 0; j--) {
      const r = mutLog[j]
      if (r !== undefined && r.ops.length === 0) mutLog.splice(j, 1)
    }
    for (const op of rec.ops) {
      const o = objOf(op.obj)
      collect(scope, o, op.k === "line" ? op.owner : op.key)
    }
    rec.resolve({ ok: true, rows })
  }

  function settleFailure(
    rec: Rec,
    token: GenerationToken,
    error: CommandError,
    conflict: boolean
  ) {
    const wrote = commitInternal(() => {
      rec.state = conflict ? "conflict" : "failed"
      rec.error = error
      touchRec(rec)
    }, token)
    if (wrote) {
      rec.resolve({ ok: false, error })
      pump()
    }
  }

  function retry(id: MutationId): Mutation | undefined {
    const rec = mutLog.find((r) => r.id === id)
    if (rec === undefined || closed) return undefined
    if (rec.state !== "failed" && rec.state !== "conflict") return undefined
    const next = newRec([], rec.policy)
    commitInternal((scope) => {
      scope.assert()
      const i = mutLog.indexOf(rec)
      mutLog.splice(i, 1)
      const later = new Map<string, Set<string>>()
      for (const r of mutLog.slice(i)) {
        for (const op of r.ops) {
          if (op.k === "line") continue
          const set = later.get(rowId(op.obj, op.key)) ?? new Set()
          for (const f of fieldsOf(op)) set.add(f)
          later.set(rowId(op.obj, op.key), set)
        }
      }
      // Повтор — нова дія користувача: стає в кінець журналу, база — поточна.
      next.ops = rec.ops.flatMap((op): Op[] => {
        if (op.k !== "update") return [op]
        const shadow = later.get(rowId(op.obj, op.key)) ?? new Set<string>()
        const values = Object.fromEntries(
          Object.entries(op.values).filter(([f]) => !shadow.has(f))
        )
        if (Object.keys(values).length === 0) return []
        const confirmed = objOf(op.obj).rows.get(op.key)?.row.values ?? {}
        const base = Object.fromEntries(
          Object.keys(values).map((f) => [f, confirmed[f]])
        )
        return [
          {
            ...op,
            values,
            base,
            baseVersion: objOf(op.obj).rows.get(op.key)?.row.version,
            chained: false,
          },
        ]
      })
      touchRec(rec)
      if (next.ops.length > 0) {
        mutLog.push(next)
        touchRec(next)
      }
      for (const op of rec.ops)
        collect(scope, objOf(op.obj), op.k === "line" ? op.owner : op.key)
    }, sessionToken)
    if (next.ops.length === 0) next.resolve({ ok: true, rows: [] })
    pump()
    return { id: next.id, settled: next.settled }
  }

  function cancel(id: MutationId) {
    const rec = mutLog.find((r) => r.id === id)
    if (
      rec === undefined ||
      (rec.state !== "failed" && rec.state !== "conflict")
    )
      return
    commitInternal((scope) => {
      mutLog.splice(mutLog.indexOf(rec), 1)
      touchRec(rec)
      for (const s of subsets.values()) {
        // Скасоване власне створення не лишає місця в складі.
        for (const op of rec.ops) {
          if (
            op.k === "create" &&
            s.layoutSet.has(op.key) &&
            !s.obj.rows.has(op.key)
          ) {
            setLayout(
              scope,
              s,
              s.layout.filter((k) => k !== op.key)
            )
          }
        }
      }
      for (const op of rec.ops)
        collect(scope, objOf(op.obj), op.k === "line" ? op.owner : op.key)
    }, sessionToken)
  }

  // ------------------------------------------------------------ сигнали

  function writerFor(scope: Scope): Writer {
    return {
      patch(object, rows) {
        scope.assert()
        const o = objOf(object)
        for (const row of rows) {
          if (o.rows.has(row.key)) putRow(scope, o, row)
        }
      },
      remove(object, keys) {
        scope.assert()
        const o = objOf(object)
        for (const key of keys) {
          const e = o.rows.get(key)
          if (e === undefined || e.removed) continue
          e.removed = true
          touchRow(object, key)
        }
      },
      markStale(object, keys, minVersion) {
        scope.assert()
        const o = objOf(object)
        for (const key of keys) {
          const e = o.rows.get(key)
          if (e === undefined) continue
          if (minVersion !== undefined && e.row.version >= minVersion) continue
          e.staleUntil = Math.max(e.staleUntil, minVersion ?? e.row.version + 1)
          if (e.stale) continue
          e.stale = true
          touchRow(object, key)
        }
      },
      purge(object, keys) {
        scope.assert()
        const o = objOf(object)
        const gone = new Set(keys)
        for (const key of keys) {
          if (o.rows.delete(key)) touchRow(object, key)
          o.own.delete(key)
          rowCache.delete(rowId(object, key))
          for (const [sid] of sections) {
            if (sid.startsWith(`${object}\u0000${key}\u0000`)) {
              sections.delete(sid)
              touchSection(sid)
            }
          }
        }
        for (const s of subsets.values()) {
          if (s.obj !== o) continue
          if (s.spec.kind === "section" && gone.has(s.spec.owner)) {
            s.needsRefresh = true
            touchSubset(s)
          }
          if (![...s.layoutSet].some((k) => gone.has(k))) continue
          s.owned = new Set([...s.owned].filter((k) => !gone.has(k)))
          setLayout(
            scope,
            s,
            s.layout.filter((k) => !gone.has(k))
          )
        }
        // Мутації над недоступними рядками нікому показувати й слати.
        for (let i = mutLog.length - 1; i >= 0; i--) {
          const r = mutLog[i]
          if (r === undefined) continue
          const hit = r.ops.some(
            (op) =>
              op.obj === object && gone.has(op.k === "line" ? op.owner : op.key)
          )
          if (!hit) continue
          mutLog.splice(i, 1)
          r.abort?.abort()
          r.resolve({ ok: false, error: { code: "command.forbidden" } })
        }
      },
      markViews(object, flags) {
        scope.assert()
        for (const s of subsets.values()) {
          if (s.obj.name !== object) continue
          if (flags.needsRefresh) s.needsRefresh = true
          if (
            flags.hasNewRows &&
            (s.spec.kind === "full" || s.spec.kind === "window")
          )
            s.hasNewRows = true
          touchSubset(s)
        }
      },
    }
  }

  async function refetchKeys(
    object: ObjectName,
    keys: readonly Key[]
  ): Promise<void> {
    // Ключ власного створення, якого ще немає в сховищі (результат невідомий),
    // теж латається: рядок тримає журнал мутацій.
    if (closed || keys.length === 0) return
    const o = objOf(object)
    let rows: ServerRow[]
    try {
      rows = await readKeys(o, keys, abort.signal)
    } catch {
      return
    }
    const got = new Set(rows.map((r) => r.key))
    commitInternal((scope) => {
      const w = writerFor(scope)
      w.patch(object, rows)
      for (const row of rows) {
        if (!o.rows.has(row.key) && heldByLog(object, row.key))
          putRow(scope, o, row)
      }
      w.remove(
        object,
        keys.filter((k) => !got.has(k))
      )
    }, sessionToken)
  }

  // ------------------------------------------------------------ SSR

  function dehydrate(): CoreSnapshot {
    const objs: Record<ObjectName, ServerRow[]> = {}
    for (const o of objects.values()) {
      objs[o.name] = [...o.rows.values()]
        .filter((e) => !e.removed)
        .map((e) => e.row)
    }
    const secs: CoreSnapshot["sections"][number][] = []
    for (const [sid, entry] of sections) {
      const [object, owner, section] = sid.split("\u0000") as [
        string,
        string,
        string,
      ]
      secs.push({
        object,
        owner,
        section,
        ownerVersion: entry.ownerVersion,
        lines: entry.lines,
      })
    }
    return {
      format: 1,
      subject,
      objects: objs,
      sections: secs,
      subsets: [...subsets.values()]
        .filter((s) => s.status === "ready")
        .map((s) => ({ spec: s.spec, keys: [...s.layout], atEnd: s.atEnd })),
    }
  }

  function hydrate(snapshot: CoreSnapshot) {
    if (snapshot.subject !== subject)
      throw new Error("snapshot of another subject")
    if (subsets.size > 0) throw new Error("hydrate before the first view")
    // Без commit і без сповіщень: слухачів ще немає, а показ має збігтися
    // з серверним першим кадром.
    for (const [name, rows] of Object.entries(snapshot.objects)) {
      const o = objOf(name)
      for (const row of rows) {
        o.rows.set(row.key, {
          row,
          owners: 0,
          stale: false,
          staleUntil: 0,
          removed: false,
        })
      }
    }
    for (const sec of snapshot.sections) {
      sections.set(sectionId(sec.object, sec.owner, sec.section), {
        ownerVersion: sec.ownerVersion,
        lines: [...sec.lines],
        complete: true,
      })
    }
    for (const sub of snapshot.subsets) {
      // Підмножина знімка: готова, утримана до `endHydration()`.
      const s = makeSubset(sub.spec, specKeyOf(sub.spec))
      const o = s.obj
      s.holds = 1
      s.status = "ready"
      s.layout = [...sub.keys]
      s.layoutSet = new Set(s.layout)
      s.atEnd = sub.atEnd ?? false
      s.owned = new Set(sub.keys.filter((k) => o.rows.has(k)))
      for (const key of s.owned) {
        const e = o.rows.get(key)
        if (e !== undefined) e.owners++
      }
      if (sub.spec.kind === "window") {
        const lastKey = s.layout[s.layout.length - 1]
        const last = lastKey === undefined ? undefined : o.rows.get(lastKey)
        if (last !== undefined)
          s.cursor = { key: last.row.key, values: last.row.values }
      }
      hydrated.add(s)
    }
  }

  function endHydration() {
    if (closed) return
    for (const s of hydrated) unhold(s)
    hydrated.clear()
  }

  // ------------------------------------------------------------ закриття

  function dispose() {
    if (closed) return
    closed = true
    abort.abort()
    for (const s of subsets.values()) {
      s.alive = false
      s.listeners.clear()
      if (s.releaseTimer !== undefined) clearTimeout(s.releaseTimer)
      for (const w of s.waiters.splice(0)) w()
    }
    handles.clear()
    subsets.clear()
    hydrated.clear()
    for (const o of objects.values()) {
      o.rows.clear()
      o.own.clear()
    }
    sections.clear()
    for (const rec of mutLog.splice(0))
      rec.resolve({ ok: false, error: DISPOSED })
    listeners.clear()
    rowCache.clear()
  }

  const session: CoreSession = {
    subject,
    get closed() {
      return closed
    },
    signal: abort.signal,
    dispose,
    subscribe(listener) {
      if (closed) return () => {}
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    view,
    preload,
    begin,
    retry,
    cancel,
    token: () => sessionToken,
    commit: (fn, token) =>
      commitInternal((scope) => fn(writerFor(scope)), token),
    confirmedVersion: (object, key) => objOf(object).rows.get(key)?.row.version,
    refetchKeys,
    ownCreates: (object) => [...objOf(object).own],
    dehydrate,
    hydrate,
    endHydration,
  }

  inspections.set(session, {
    rows(obj) {
      const o = objOf(obj)
      return new Map(
        [...o.rows].map(([k, e]) => [
          k,
          {
            version: e.row.version,
            owners: e.owners,
            removed: e.removed,
            stale: e.stale,
            own: o.own.has(k),
            heldByLog: heldByLog(obj, k),
          },
        ])
      )
    },
    row: (obj, key) => objOf(obj).rows.get(key)?.row,
    sectionCount: () => sections.size,
    logLength: () => mutLog.length,
    subsetCount: () => subsets.size,
    violations() {
      const out: string[] = []
      for (const o of objects.values()) {
        for (const [key, e] of o.rows) {
          let owners = 0
          for (const s of subsets.values())
            if (s.obj === o && s.owned.has(key)) owners++
          if (owners !== e.owners)
            out.push(`${o.name}/${key}: owners ${e.owners} != ${owners}`)
          if (owners === 0 && !o.own.has(key) && !heldByLog(o.name, key)) {
            out.push(`${o.name}/${key}: held by nobody`)
          }
        }
      }
      return out
    },
  })
  return session
}
