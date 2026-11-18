import type { Defects } from "./defects"
import { heldEpoch } from "./epoch"
import type { Form, ObjectState } from "./forms"
import { scopeOf, type RestoredRow, type RowEntry } from "./object-store"
import type { StoreOps } from "./readers"
import type { SectionEntry } from "./section-store"
import type { Scope, Session } from "./session"
import type { AdoptedView, Subset, SubsetRegistry } from "./subsets"
import {
  keysOfPages,
  type WindowCursor,
  type WindowLower,
  type WindowState,
} from "./window"
import type {
  CoreLimits,
  CoreSnapshot,
  CursorSnapshot,
  Key,
  LowerSnapshot,
  ObjectName,
  ObjectSnapshot,
  RowSlot,
  RowSlotExtra,
  SectionLine,
  SectionSnapshot,
  SubsetSnapshot,
  WindowSnapshot,
} from "./types"

/*
 * SSR-знімок ядра (спека П4-B §6.6): що ядро віддає на сервері й що клієнт
 * бере до першого рендера. Знімок — довірча межа: усе, що потрапило в нього,
 * потрапляє в HTML. Тому він збирається від готових утриманих підмножин, а не
 * обходом сховища, а слот без значень (`removed`, `hidden`) не несе жодного.
 */

/** What the snapshot and the hydration need from the core. */
export interface SsrContext {
  readonly session: Pick<Session, "epochs">
  readonly objects: ReadonlyMap<ObjectName, ObjectState>
  readonly registry: SubsetRegistry
  readonly ops: StoreOps
  readonly limits: CoreLimits
  /** Deliberate defects of the model test's self-check. */
  readonly defects: Defects
}

// ------------------------------------------------------------ знімок

// Готова утримана підмножина: завантажена, без помилки й без читання в
// польоті. `purged` показує знімок без рядків, тож у знімок не йде.
const isReady = (s: Subset) =>
  s.alive && !s.purged && s.loaded && s.status === "ready"

// Рядок, значень якого вигляд не показує: `removed`, схований позначкою чи
// гідрований слот без значень.
const hidesValues = (e: RowEntry) =>
  e.removed !== undefined || e.stale.hidden !== undefined || e.row === undefined

/**
 * Курсор несе значення сортувальних колонок рядка, що був на межі сторінки
 * під час читання. Рядок, чиїх значень вигляд уже не показує (схований,
 * `removed`, прибраний `purge`), цими значеннями в HTML не потрапляє.
 */
function leaksCursor(o: ObjectState, cursor: WindowCursor): boolean {
  const e = o.rows.get(cursor.key)
  return e === undefined || hidesValues(e)
}

function windowLeaks(s: Subset): boolean {
  const w = s.window
  if (w === undefined) return false
  const o = s.form.object
  const lowers = w.pages.flatMap((page) =>
    page.lower.kind === "start" ? [] : [page.lower.cursor]
  )
  const frontier = [w.frontier.after, w.frontier.before].filter(
    (c): c is WindowCursor => c !== undefined
  )
  return [...lowers, ...frontier].some((cursor) => leaksCursor(o, cursor))
}

// Ряд індексів у пари `[початок, довжина, …]`: склад вікна — переважно
// послідовний, тож пари майже не додають байтів до рядків.
function runsOf(indices: readonly number[]): number[] {
  const runs: number[] = []
  for (const i of indices) {
    const last = runs.length - 2
    if (last >= 0 && runs[last]! + runs[last + 1]! === i) runs[last + 1]!++
    else runs.push(i, 1)
  }
  return runs
}

const cursorSnapshot = (cursor: WindowCursor): CursorSnapshot => ({
  values: cursor.values,
  key: cursor.key,
})

function lowerSnapshot(lower: WindowLower): LowerSnapshot {
  return lower.kind === "start"
    ? { kind: "start" }
    : { kind: lower.kind, cursor: cursorSnapshot(lower.cursor) }
}

function windowSnapshot(w: WindowState): WindowSnapshot {
  return {
    pages: w.pages.map((page) => ({
      size: page.keys.length,
      lower: lowerSnapshot(page.lower),
      generation: page.generation,
    })),
    chain: w.chain,
    target: w.target,
    atStart: w.atStart,
    generation: w.generation,
    frontier: {
      ...(w.frontier.after === undefined
        ? {}
        : { after: cursorSnapshot(w.frontier.after) }),
      ...(w.frontier.before === undefined
        ? {}
        : { before: cursorSnapshot(w.frontier.before) }),
    },
  }
}

// Чотири позначки `stale` рядка (§6.1) не переносяться — їхні епохи належать
// серверній сесії; рядок іде з однією ознакою.
const outdated = (e: RowEntry) =>
  e.stale.minVersion !== undefined ||
  e.stale.disconnect !== undefined ||
  e.stale.epoch !== undefined

function slotOf(
  o: ObjectState,
  key: Key,
  e: RowEntry,
  epoch: string | null,
  defects: Defects
): RowSlot {
  if (e.removed !== undefined) return { key, state: "removed", scope: e.scope }
  if (hidesValues(e)) {
    return {
      key,
      state: "hidden",
      scope: e.scope,
      version: e.version,
      epoch: e.versionEpoch,
      ...(outdated(e) ? { stale: true as const } : {}),
      // Дефект самотесту: слот `hidden` несе значення свого рядка.
      ...(defects.has("hidden-values-in-snapshot")
        ? { values: e.row?.values }
        : {}),
    }
  }
  const row = e.row!
  const { keyName, versionName } = o.entry
  // Ключ і версія рядка — поля його значень; розбіжність (не очікується)
  // виправляється тут, а не переноситься в знімок.
  const values =
    row.values[keyName] === key && row.values[versionName] === e.version
      ? row.values
      : { ...row.values, [keyName]: key, [versionName]: e.version }
  const lazy: Record<string, number> = {}
  const lazyIn: Record<string, string | null> = {}
  for (const [field, version] of e.lazyVersions) {
    lazy[field] = version
    const own = e.lazyEpochs.get(field) ?? null
    if (own !== e.versionEpoch) lazyIn[field] = own
  }
  const extra: RowSlotExtra = {
    ...(e.versionEpoch === epoch ? {} : { epoch: e.versionEpoch }),
    ...(e.lazyVersions.size === 0 ? {} : { lazy }),
    ...(Object.keys(lazyIn).length === 0 ? {} : { lazyIn }),
    ...(outdated(e) ? { stale: true as const } : {}),
  }
  return Object.keys(extra).length === 0 ? [values] : [values, extra]
}

/**
 * The snapshot of a core (P4-B spec §6.6): the ready held views with the
 * rows they own, in the composition they show. Rows nobody owns, the journal
 * of mutations, listeners and the epochs of the session stay out.
 */
export function dehydrate(ctx: SsrContext): CoreSnapshot {
  const ready = [...ctx.registry.subsets()].filter(
    (s) => isReady(s) && !windowLeaks(s)
  )
  // Рядки по об'єктах у порядку першої появи: індекс слота — місце в масиві.
  const placed = new Map<ObjectName, Map<Key, number>>()
  const place = (o: ObjectState, key: Key): number | undefined => {
    if (o.rows.get(key) === undefined) return undefined
    const index = placed.get(o.name) ?? new Map<Key, number>()
    placed.set(o.name, index)
    const found = index.get(key)
    if (found !== undefined) return found
    index.set(key, index.size)
    return index.size - 1
  }
  const indicesOf = (o: ObjectState, keys: Iterable<Key>) =>
    [...keys].flatMap((key) => {
      const i = place(o, key)
      return i === undefined ? [] : [i]
    })

  const subsets: SubsetSnapshot[] = []
  const sections: Record<ObjectName, SectionSnapshot[]> = {}
  for (const s of ready) {
    const { spec } = s.form
    const o = s.form.object
    if (spec.kind === "section") {
      const entry = o.sections.get(spec.owner, spec.section)
      const header = o.rows.get(spec.owner)
      // Власник `removed` чи схований рядків ТЧ не показує (правило
      // `ViewSnapshot`): вони можуть лишатись у сховищі, у знімок не йдуть.
      const shown = header === undefined || !hidesValues(header)
      if (entry !== undefined && shown) {
        const list = sections[o.name] ?? []
        sections[o.name] = list
        list.push({
          owner: spec.owner,
          section: spec.section,
          lines: entry.lines.map((line) => line.values),
          ownerVersion: entry.ownerVersion,
          epoch: entry.versionEpoch,
          complete: entry.complete,
          scope: entry.scope,
          ...(entry.staleEpoch === true ? { stale: true as const } : {}),
        })
      }
      subsets.push({ spec })
      continue
    }
    const layoutKeys =
      s.window === undefined ? s.layout : keysOfPages(s.window.pages)
    const layout = indicesOf(o, layoutKeys)
    const shownKeys = new Set(layoutKeys)
    const unshown = indicesOf(
      o,
      [...s.owned].filter((key) => !shownKeys.has(key))
    )
    // Цілі `include` — не окремий перелік: їх дають значення рядків. Їхні
    // рядки йдуть у знімок, бо вигляд їх тримає.
    for (const [name, keys] of s.included)
      indicesOf(ctx.objects.get(name)!, keys)
    subsets.push({
      spec,
      ...(layout.length === 0 ? {} : { layout: runsOf(layout) }),
      ...(unshown.length === 0 ? {} : { unshown: runsOf(unshown) }),
      ...(s.window === undefined ? {} : { window: windowSnapshot(s.window) }),
      ...(spec.kind === "full" || spec.kind === "window"
        ? { atEnd: s.atEnd }
        : {}),
      ...(s.truncated ? { truncated: true as const } : {}),
    })
  }

  const objects: Record<ObjectName, ObjectSnapshot> = {}
  for (const [name, index] of placed) {
    const o = ctx.objects.get(name)!
    const entries = [...index.keys()].map(
      (key) => [key, o.rows.get(key)!] as const
    )
    // Епоха версій, у якій більшість рядків, не повторюється в кожному.
    const epoch =
      entries.find(([, e]) => e.removed === undefined)?.[1].versionEpoch ?? null
    objects[name] = {
      epoch,
      slots: entries.map(([key, e]) => slotOf(o, key, e, epoch, ctx.defects)),
    }
  }
  return { format: 1, objects, sections, subsets }
}

// ------------------------------------------------------------ гідратація

const bad = (what: string): never => {
  throw new TypeError(`invalid core snapshot: ${what}`)
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x)

const isEpoch = (x: unknown): x is string | null =>
  x === null || typeof x === "string"

const isInt = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x >= 0

function parseCursor(raw: unknown): WindowCursor {
  if (!isRecord(raw) || !isRecord(raw.values) || typeof raw.key !== "string")
    return bad("a window cursor")
  return { values: raw.values, key: raw.key }
}

function parseLower(raw: unknown): WindowLower {
  if (!isRecord(raw)) return bad("a page lower bound")
  if (raw.kind === "start") return { kind: "start" }
  if (raw.kind === "after" || raw.kind === "from")
    return { kind: raw.kind, cursor: parseCursor(raw.cursor) }
  return bad("a page lower bound")
}

/** A snapshot checked and resolved; nothing of the core is touched until it exists. */
export interface ParsedSnapshot {
  readonly rows: readonly (readonly [object: ObjectState, row: RestoredRow])[]
  readonly sections: readonly {
    readonly object: ObjectState
    readonly owner: Key
    readonly section: string
    readonly entry: SectionEntry
  }[]
  readonly subsets: readonly {
    readonly form: Form
    readonly state: Omit<AdoptedView, "at">
  }[]
}

function parseSlot(
  o: ObjectState,
  raw: unknown,
  epoch: string | null
): RestoredRow {
  const { keyName, versionName } = o.entry
  if (Array.isArray(raw)) {
    const [values, extra = {}] = raw as [unknown, unknown?]
    if (!isRecord(values) || !isRecord(extra)) return bad("a row slot")
    const key = values[keyName]
    const version = values[versionName]
    if (typeof key !== "string" || typeof version !== "number")
      return bad("a row without its key or version")
    const own = extra.epoch === undefined ? epoch : extra.epoch
    if (!isEpoch(own)) return bad("a row epoch")
    const lazy = extra.lazy ?? {}
    const lazyIn = extra.lazyIn ?? {}
    if (!isRecord(lazy) || !isRecord(lazyIn)) return bad("lazy fields")
    const lazyVersions = new Map<string, number>()
    const lazyOwn = new Map<string, string | null>()
    for (const [field, v] of Object.entries(lazy)) {
      if (typeof v !== "number") return bad("a lazy field version")
      lazyVersions.set(field, v)
      const e = lazyIn[field]
      if (e !== undefined && !isEpoch(e)) return bad("a lazy field epoch")
      lazyOwn.set(field, e === undefined ? own : e)
    }
    const restored: RestoredRow = {
      key,
      state: "row",
      row: { key, version, versionEpoch: heldEpoch(own), values },
      scope: scopeOf(o.entry, values),
      version,
      versionEpoch: heldEpoch(own),
      lazyVersions,
      lazyIn: lazyOwn,
      stale: extra.stale === true,
    }
    return restored
  }
  if (!isRecord(raw) || typeof raw.key !== "string") return bad("a row slot")
  const scope = raw.scope
  if (scope !== null && typeof scope !== "string") return bad("a slot scope")
  if (raw.state === "removed") {
    const restored: RestoredRow = {
      key: raw.key,
      state: "removed",
      row: undefined,
      scope,
      version: 0,
      versionEpoch: heldEpoch(null),
      lazyVersions: new Map(),
      lazyIn: new Map(),
      stale: false,
    }
    return restored
  }
  if (raw.state === "hidden") {
    if (typeof raw.version !== "number" || !isEpoch(raw.epoch))
      return bad("a hidden slot")
    // Значення такого слота не читаються, навіть коли їх дописали.
    const restored: RestoredRow = {
      key: raw.key,
      state: "hidden",
      row: undefined,
      scope,
      version: raw.version,
      versionEpoch: heldEpoch(raw.epoch),
      lazyVersions: new Map(),
      lazyIn: new Map(),
      stale: raw.stale === true,
    }
    return restored
  }
  return bad("a slot state")
}

function parseRuns(raw: unknown, keys: readonly Key[], what: string): Key[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw) || raw.length % 2 !== 0) return bad(what)
  const out: Key[] = []
  for (let i = 0; i < raw.length; i += 2) {
    const start: unknown = raw[i]
    const length: unknown = raw[i + 1]
    if (!isInt(start) || !isInt(length) || start + length > keys.length)
      return bad(what)
    for (let at = start; at < start + length; at++) out.push(keys[at]!)
  }
  return out
}

function parseWindow(raw: unknown, layout: readonly Key[]): WindowState {
  if (!isRecord(raw) || !Array.isArray(raw.pages)) return bad("a window")
  let from = 0
  const pages = (raw.pages as unknown[]).map((page) => {
    if (!isRecord(page) || !isInt(page.size) || !isInt(page.generation))
      return bad("a window page")
    const keys = layout.slice(from, from + page.size)
    from += page.size
    if (keys.length !== page.size) return bad("a window page size")
    return { keys, lower: parseLower(page.lower), generation: page.generation }
  })
  if (from !== layout.length) return bad("window pages and layout differ")
  if (
    !isInt(raw.chain) ||
    !isInt(raw.generation) ||
    (raw.target !== "start" && raw.target !== "end" && raw.target !== "keep") ||
    typeof raw.atStart !== "boolean" ||
    !isRecord(raw.frontier)
  )
    return bad("a window")
  const { after, before } = raw.frontier
  return {
    pages,
    chain: raw.chain,
    target: raw.target,
    atStart: raw.atStart,
    generation: raw.generation,
    frontier: {
      ...(after === undefined ? {} : { after: parseCursor(after) }),
      ...(before === undefined ? {} : { before: parseCursor(before) }),
    },
  }
}

/**
 * Checks a snapshot and resolves it against the catalog of the core; a
 * snapshot that is not one this core can take is a `TypeError`, thrown
 * before anything is written.
 */
export function parseSnapshot(
  ctx: SsrContext,
  snapshot: CoreSnapshot
): ParsedSnapshot {
  if (!isRecord(snapshot) || snapshot.format !== 1) return bad("format")
  const { objects: rawObjects, sections: rawSections, subsets } = snapshot
  if (
    !isRecord(rawObjects) ||
    !isRecord(rawSections) ||
    !Array.isArray(subsets)
  )
    return bad("shape")
  if (subsets.length > ctx.limits.viewsMax) return bad("too many views")
  const objectOf = (name: string): ObjectState =>
    ctx.objects.get(name) ?? bad(`unknown object ${name}`)

  const rows: [ObjectState, RestoredRow][] = []
  const keysOf = new Map<ObjectName, readonly Key[]>()
  for (const [name, group] of Object.entries(rawObjects)) {
    const o = objectOf(name)
    if (
      !isRecord(group) ||
      !isEpoch(group.epoch) ||
      !Array.isArray(group.slots)
    )
      return bad(`objects.${name}`)
    const keys: Key[] = []
    const seen = new Set<Key>()
    for (const raw of group.slots as unknown[]) {
      const row = parseSlot(o, raw, group.epoch)
      if (seen.has(row.key)) return bad(`a key twice in ${name}`)
      seen.add(row.key)
      keys.push(row.key)
      rows.push([o, row])
    }
    keysOf.set(name, keys)
  }

  const forms = new Map<string, { form: Form; raw: SubsetSnapshot }>()
  const parsedSubsets: {
    form: Form
    state: Omit<AdoptedView, "at">
  }[] = []
  for (const raw of subsets as unknown[]) {
    if (!isRecord(raw) || !isRecord(raw.spec)) return bad("a view")
    const sub = raw as unknown as SubsetSnapshot
    let form: Form
    try {
      form = ctx.registry.formOf(sub.spec)
    } catch {
      return bad("a view form")
    }
    if (forms.has(form.specKey)) return bad("a view twice")
    forms.set(form.specKey, { form, raw: sub })
    const { spec } = form
    const keys = keysOf.get(form.object.name) ?? []
    const layout = parseRuns(sub.layout, keys, "a layout")
    const unshown = parseRuns(sub.unshown, keys, "an unshown list")
    if (
      new Set([...layout, ...unshown]).size !==
      layout.length + unshown.length
    )
      return bad("a row twice in a view")
    if (spec.kind === "section" && (layout.length > 0 || unshown.length > 0))
      return bad("rows in a section view")
    if (spec.kind === "card" && (unshown.length > 0 || layout.length > 1))
      return bad("a card with several rows")
    if (spec.kind === "card" && layout.length === 1 && layout[0] !== spec.key)
      return bad("a card of another key")
    const listed = spec.kind === "full" || spec.kind === "window"
    if (sub.window !== undefined && !listed) return bad("a window of a view")
    if (spec.kind === "window" && sub.window === undefined)
      return bad("a window without pages")
    if (listed && typeof sub.atEnd !== "boolean") return bad("atEnd")
    parsedSubsets.push({
      form,
      state: {
        layout,
        unshown,
        window:
          sub.window === undefined
            ? undefined
            : parseWindow(sub.window, layout),
        atEnd: sub.atEnd === true,
        truncated: sub.truncated === true,
      },
    })
  }

  const sections: ParsedSnapshot["sections"][number][] = []
  for (const [name, list] of Object.entries(rawSections)) {
    const o = objectOf(name)
    if (!Array.isArray(list)) return bad(`sections.${name}`)
    for (const raw of list as unknown[]) {
      if (!isRecord(raw)) return bad("a section")
      const section = o.entry.tabularSections.find(
        (s) => s.name === raw.section
      )
      if (
        typeof raw.owner !== "string" ||
        section === undefined ||
        !Array.isArray(raw.lines) ||
        typeof raw.ownerVersion !== "number" ||
        !isEpoch(raw.epoch) ||
        typeof raw.complete !== "boolean" ||
        (raw.scope !== null && typeof raw.scope !== "string")
      )
        return bad("a section")
      const owner = raw.owner
      // Рядки ТЧ без вигляду, що їх тримає, лишились би в сховищі назавжди.
      const held = [...forms.values()].some(
        ({ form: { spec } }) =>
          spec.kind === "section" &&
          spec.object === name &&
          spec.owner === owner &&
          spec.section === section.name
      )
      if (!held) return bad("lines of a section nobody holds")
      const lines: SectionLine[] = (raw.lines as unknown[]).map((values) => {
        const key = isRecord(values) ? values[section.keyName] : undefined
        if (!isRecord(values) || typeof key !== "string")
          return bad("a section line")
        return { key, values }
      })
      sections.push({
        object: o,
        owner,
        section: section.name,
        entry: {
          ...(raw.stale === true ? { staleEpoch: true as const } : {}),
          lines,
          ownerVersion: raw.ownerVersion,
          versionEpoch: heldEpoch(raw.epoch),
          complete: raw.complete,
          scope: raw.scope,
        },
      })
    }
  }
  return { rows, sections, subsets: parsedSubsets }
}

/**
 * Writes a parsed snapshot into an empty core, inside one `commit`: the
 * rows and lines first, then the views that own them. A key without a view
 * owning it is left without an owner for the caller's `sweep`.
 */
export function applySnapshot(
  ctx: SsrContext,
  scope: Scope,
  parsed: ParsedSnapshot
) {
  const at = ctx.session.epochs.next()
  for (const [object, row] of parsed.rows)
    ctx.ops.restore(scope, object, row, at)
  for (const { object, owner, section, entry } of parsed.sections)
    ctx.ops.restoreSection(scope, object, owner, section, entry)
  for (const { form, state } of parsed.subsets)
    ctx.registry.adopt(scope, form, { ...state, at })
}
