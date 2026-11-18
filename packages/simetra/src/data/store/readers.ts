import {
  CommandFailure,
  keysetFilter,
  type CatalogEntrySection,
} from "simetra/model"
import { DataError } from "../errors"
import type { Form, ObjectState } from "./forms"
import { nullableOf } from "./filter"
import { includeKeys, readIncluded, type Included } from "./include"
import { visibleRow, type PutResult, type RestoredRow } from "./object-store"
import type { OwnerScope, SectionEntry } from "./section-store"
import type { Scope, Session } from "./session"
import {
  readKeys,
  readOne,
  serverRow,
  tracked,
  type CoreSource,
} from "./source"
import {
  EMPTY_WINDOW,
  fetchPage,
  keysOfPages,
  cursorOf,
  type WindowCursor,
  type WindowLower,
  type WindowState,
} from "./window"
import type {
  GenerationToken,
  CoreLimits,
  CoreLogEntry,
  Key,
  ObjectName,
  SectionLine,
  ServerRow,
  Values,
  ViewSpec,
} from "./types"

/*
 * Читачі форм виглядів (спека П4-B §6.1, §6.2): кожен читає свою форму без
 * запису й повертає `apply`, який вигляд застосовує одним `commit` з
 * епохою старту першого запиту.
 */

/**
 * Store writes of the core: each keeps the row views and the dirty sections
 * in step with the store, so every write path (views, tail, the writer)
 * goes through them.
 */
export interface StoreOps {
  put(
    scope: Scope,
    o: ObjectState,
    row: ServerRow,
    readEpoch: number,
    lazyRead: boolean
  ): PutResult
  remove(scope: Scope, o: ObjectState, key: Key, readEpoch: number): void
  own(scope: Scope, o: ObjectState, key: Key): void
  disown(scope: Scope, o: ObjectState, key: Key): void
  putSection(
    scope: Scope,
    o: ObjectState,
    owner: Key,
    section: string,
    lines: readonly SectionLine[],
    ownerVersion: number,
    versionEpoch: string | null,
    readEpoch: number,
    ownerScope: OwnerScope
  ): void
  clearOwner(scope: Scope, o: ObjectState, owner: Key): void
  /** Puts a row of a core snapshot (the hydration); see `ObjectStore.restore`. */
  restore(scope: Scope, o: ObjectState, row: RestoredRow, at: number): void
  /** Puts the lines of a core snapshot (the hydration). */
  restoreSection(
    scope: Scope,
    o: ObjectState,
    owner: Key,
    section: string,
    entry: SectionEntry
  ): void
  /**
   * Drops the entries written in this `commit` that are left without an
   * owner (an `apply` that threw half-way): a row never outlives its commit
   * unowned.
   */
  sweep(scope: Scope): void
}

/** What the readers need from the core. */
export interface ReaderContext {
  readonly session: Pick<Session, "acceptEpoch" | "acceptEpochs">
  readonly source: CoreSource
  readonly limits: CoreLimits
  readonly strict: boolean
  readonly log: (entry: CoreLogEntry) => void
  readonly ops: StoreOps
  objectOf(name: ObjectName): ObjectState
}

/** The part of a subset a reader's `apply` writes. */
export interface ReaderTarget {
  readonly form: Form
  owned: Set<Key>
  included: Map<ObjectName, Set<Key>>
  layout: readonly Key[]
  layoutSet: ReadonlySet<Key>
  strategy: "full" | "window" | undefined
  truncated: boolean
  atEnd: boolean
  /**
   * The pages of a `window`, or of a `full` that went over its limit; the
   * layout is their keys in order. Undefined for every other form.
   */
  window: WindowState | undefined
  /**
   * Window pages being read next to an edge: one read per direction, by the
   * generation of the read (Р9). A new chain and a purge drop them, so the
   * answers in flight write nothing.
   */
  readonly paging: Map<"after" | "before", number>
  /**
   * The start epoch of the last section read the session accepted (section
   * form only): a `hide` of the owner after it makes the subset stale (plan
   * B3-3, Р11).
   */
  sectionRead: number | undefined
}

/** Writes a read result inside one `commit`. */
export type Write = (scope: Scope) => void

/**
 * Applies a read result inside one `commit`; `false` — the session discarded
 * an epoch of the answer (P4-B spec §6.2) and nothing was written.
 */
export type Apply = (scope: Scope) => boolean

/**
 * Runs `read` over a source that records the epoch of every answer; the
 * returned `Apply` writes only after the session accepted each of them and
 * none is abandoned (`acceptEpochs` — the single check before a write).
 */
export async function gated<C extends ReaderContext>(
  ctx: C,
  readEpoch: number,
  read: (ctx: C) => Promise<Write>
): Promise<Apply> {
  const { source, epochs } = tracked(ctx.source)
  const write = await read({ ...ctx, source })
  return (scope) => {
    if (ctx.session.acceptEpochs(epochs, readEpoch) === "discard") return false
    write(scope)
    return true
  }
}

function lineOf(
  section: CatalogEntrySection,
  values: Record<string, unknown>
): SectionLine {
  const key = values[section.keyName]
  if (typeof key !== "string")
    throw new CommandFailure({ code: "command.internal" })
  return { key, values }
}

/** Owns `wanted` keys that have an entry, disowns the rest of `prev`. */
export function diffOwn(
  ops: StoreOps,
  scope: Scope,
  o: ObjectState,
  prev: ReadonlySet<Key>,
  wanted: Iterable<Key>
): Set<Key> {
  const next = new Set<Key>()
  for (const key of wanted) {
    if (next.has(key) || o.rows.get(key) === undefined) continue
    if (!prev.has(key)) ops.own(scope, o, key)
    next.add(key)
  }
  for (const key of prev) if (!next.has(key)) ops.disown(scope, o, key)
  return next
}

function setLayout(s: ReaderTarget, layout: readonly Key[]) {
  s.layout = layout
  s.layoutSet = new Set(layout)
}

/**
 * Читання за ключем не знайшло рядка: з шапкою — `removed` на місці; без
 * шапки сховище нічого не фіксує, але рядки ТЧ цього власника (вигляд ТЧ
 * писав їх за невідомим скоупом) показали б власника, якого сервер не
 * повертає (Р36).
 */
function missed(
  ops: StoreOps,
  scope: Scope,
  o: ObjectState,
  key: Key,
  readEpoch: number
) {
  if (o.rows.get(key) !== undefined) ops.remove(scope, o, key, readEpoch)
  else ops.clearOwner(scope, o, key)
}

/**
 * Writes the read targets of `include` and moves the view's target ownership
 * to them; `keep` only adds (the page of a window joins the held ones).
 */
export function applyIncluded(
  ctx: ReaderContext,
  scope: Scope,
  s: ReaderTarget,
  included: Included,
  readEpoch: number,
  keep = false
) {
  const { ops } = ctx
  const next = new Map<ObjectName, Set<Key>>()
  for (const [name, { keys, rows }] of included) {
    const target = ctx.objectOf(name)
    const got = new Set<Key>()
    for (const row of rows) {
      ops.put(scope, target, row, readEpoch, false)
      got.add(row.key)
    }
    // Зникла ціль — `removed` на місці; `refs` на неї — `null`.
    for (const key of keys) {
      if (!got.has(key)) missed(ops, scope, target, key, readEpoch)
    }
    const prev = s.included.get(name) ?? new Set<Key>()
    next.set(
      name,
      diffOwn(ops, scope, target, prev, keep ? [...prev, ...keys] : keys)
    )
  }
  for (const [name, keys] of s.included) {
    if (next.has(name)) continue
    if (keep) {
      next.set(name, keys)
      continue
    }
    const target = ctx.objectOf(name)
    for (const key of keys) ops.disown(scope, target, key)
  }
  s.included = next
}

/** Лишає з прочитаних цілей лише ті, що потрібні живим рядкам читання. */
function aliveIncluded(
  included: Included,
  wanted: ReadonlyMap<ObjectName, readonly Key[]>
): Included {
  return new Map(
    [...included].map(([name, { rows }]) => {
      const keys = wanted.get(name) ?? []
      const set = new Set(keys)
      return [name, { keys, rows: rows.filter((r) => set.has(r.key)) }]
    })
  )
}

/** Склад `full`: локальний фільтр і порядок; `removed` тримає позицію. */
function fullLayout(s: ReaderTarget, fetched: ReadonlyMap<Key, Values>): Key[] {
  const { form } = s
  const live: { key: Key; values: Values }[] = []
  const removed: Key[] = []
  for (const key of s.owned) {
    const e = form.object.rows.get(key)
    if (e === undefined) continue
    if (e.removed !== undefined) {
      removed.push(key)
      continue
    }
    // Сховані горизонтом значення не показуються, але місце рядок бере за
    // значеннями цього ж читання.
    const values = visibleRow(e) ?? fetched.get(key)
    if (values !== undefined && form.test(values)) live.push({ key, values })
  }
  if (form.compare !== undefined) {
    const compare = form.compare
    live.sort((a, b) => compare(a.values, b.values))
  }
  const layout = live.map((r) => r.key)
  const at = new Map(s.layout.map((key, i) => [key, i]))
  removed
    .filter((key) => at.has(key))
    .sort((a, b) => at.get(a)! - at.get(b)!)
    .forEach((key) =>
      layout.splice(Math.min(at.get(key)!, layout.length), 0, key)
    )
  return layout
}

const NOTHING: Write = () => {}

/**
 * The keyset fetch of a `full` form (§6.1): pages in the view's order up to
 * `fullLimit`; `over` — the visible set is larger. `undefined` once `token`
 * is invalid: a released or re-requested view reads no further page.
 */
export async function fetchFull(
  ctx: ReaderContext,
  form: Form,
  token: GenerationToken
): Promise<{ rows: ServerRow[]; over: boolean } | undefined> {
  const { source, limits } = ctx
  const o = form.object
  const spec = form.spec as Extract<ViewSpec, { kind: "full" }>
  const orderBy = spec.orderBy ?? []
  const pages: { values: Record<string, unknown>; epoch: string | null }[] = []
  let last: Record<string, unknown> | undefined
  // Сторінки — поза сховищем до кінця вибірки; зупинка лише на сторінці
  // без `more` і коротшій за `limit` (§6.1).
  for (;;) {
    const where =
      last === undefined
        ? undefined
        : keysetFilter(
            orderBy,
            {
              values: last,
              key: last[o.entry.keyName] as string,
              direction: "after",
            },
            o.entry.keyName,
            nullableOf(o.info)
          )
    const page = await readOne(source, {
      object: o.ref,
      ...(orderBy.length === 0 ? {} : { orderBy }),
      ...(where === undefined ? {} : { where }),
      limit: limits.fullPageSize,
    })
    // Звільнений чи перезапитаний вигляд далі не читає: наступна сторінка
    // була б запитом, результат якого нікуди не запишеться.
    if (!token.valid) return undefined
    pages.push(...page.rows.map((values) => ({ values, epoch: page.epoch })))
    if (pages.length > limits.fullLimit) break
    const tail = page.rows.at(-1)
    if (tail === undefined) break
    if (page.more !== true && page.rows.length < limits.fullPageSize) break
    last = tail
  }
  return {
    rows: pages.map((p) => serverRow(o.entry, p.values, p.epoch)),
    over: pages.length > limits.fullLimit,
  }
}

async function readFull(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number,
  token: GenerationToken
): Promise<Write> {
  const { limits, ops } = ctx
  const { form } = s
  const o = form.object
  const fetched = await fetchFull(ctx, form, token)
  if (fetched === undefined) return NOTHING
  const { rows, over } = fetched
  if (over && ctx.strict) throw new DataError("data.full-too-large")
  // Понад межу — перша сторінка вікна в серверному порядку (П5).
  const kept = over
    ? rows.filter((r) => form.test(r.values)).slice(0, limits.windowPage)
    : rows
  // Цілі — з усіх відфільтрованих рядків читання, зокрема з тих, чий слот
  // зараз `removed`: це читання може його воскресити в тій самій пачці
  // застосування, а цілі, прочитані пізніше, вже не доберуться.
  const shown = over ? kept : kept.filter((r) => form.test(r.values))
  const wanted = includeKeys(
    form.include,
    shown.map((r) => r.values)
  )
  if (!token.valid) return NOTHING
  const included = await readIncluded(
    ctx.source,
    form.include,
    wanted,
    limits.keysPerRequest
  )
  const values = new Map(kept.map((r) => [r.key, r.values] as const))
  return (scope) => {
    // Понад межу `full` стає справжнім вікном: перша сторінка — початок
    // серверного порядку, далі читають `loadAfter`/`loadBefore` (Р1).
    if (over) {
      writePage(ctx, scope, s, {
        rows: kept,
        included,
        position: "replace",
        lower: () => ({ kind: "start" }),
        end: false,
        readEpoch,
      })
      s.truncated = true
      ctx.log({
        kind: "full-truncated",
        object: o.name,
        limit: limits.fullLimit,
      })
      return
    }
    for (const row of kept) ops.put(scope, o, row, readEpoch, false)
    s.owned = diffOwn(ops, scope, o, s.owned, values.keys())
    // Рядок, чий `put` відхилено, лишається `removed`: його цілі не беремо
    // (§6.2, правило 5). Рядок, якого це читання щойно відновило, тут уже живий.
    const alive = shown.filter((r) => o.rows.get(r.key)?.removed === undefined)
    applyIncluded(
      ctx,
      scope,
      s,
      aliveIncluded(
        included,
        includeKeys(
          form.include,
          alive.map((r) => r.values)
        )
      ),
      readEpoch
    )
    s.strategy = "full"
    s.truncated = false
    s.atEnd = true
    s.window = undefined
    setLayout(s, fullLayout(s, values))
  }
}

/** One page of a window to write inside a `commit`. */
interface PageWrite {
  readonly rows: readonly ServerRow[]
  readonly included: Included
  readonly position: "replace" | "append" | "prepend"
  /** The lower bound of the page, from its first row that joins the window. */
  readonly lower: (first: ServerRow | undefined) => WindowLower
  /** The read went past the order's end in its direction. */
  readonly end: boolean
  readonly readEpoch: number
}

/**
 * Writes a page of a window: the rows and their `include` targets go the
 * store's ordinary ways, the window keeps only the keys and the place (Р8).
 * A new chain (`replace`) owns its rows before the old one lets go, in this
 * same `commit` (Р9); a page joins the edge with the rows the window does not
 * already hold.
 */
function writePage(
  ctx: ReaderContext,
  scope: Scope,
  s: ReaderTarget,
  page: PageWrite
) {
  const { ops } = ctx
  const { form } = s
  const o = form.object
  const prev = s.window ?? EMPTY_WINDOW
  const replace = page.position === "replace"
  for (const row of page.rows) ops.put(scope, o, row, page.readEpoch, false)
  const fresh = replace
    ? [...page.rows]
    : page.rows.filter((row) => !s.layoutSet.has(row.key))
  s.owned = diffOwn(ops, scope, o, s.owned, [
    ...(replace ? [] : s.owned),
    ...fresh.map((row) => row.key),
  ])
  const alive = page.rows.filter(
    (row) => o.rows.get(row.key)?.removed === undefined
  )
  applyIncluded(
    ctx,
    scope,
    s,
    aliveIncluded(
      page.included,
      includeKeys(
        form.include,
        alive.map((row) => row.values)
      )
    ),
    page.readEpoch,
    !replace
  )
  const keys = fresh.map((row) => row.key).filter((key) => s.owned.has(key))
  const generation = prev.generation + 1
  const added =
    keys.length === 0 ? [] : [{ keys, lower: page.lower(fresh[0]), generation }]
  const pages = replace
    ? added
    : page.position === "append"
      ? [...prev.pages, ...added]
      : [...added, ...prev.pages]
  // Прочитане, що нічого не додало (усі рядки вже у вікні), зсуває курсор
  // напрямку на серверну позицію, інакше наступне читання повторило б запит.
  const direction = page.position === "prepend" ? "before" : "after"
  const orderBy = (form.spec as Extract<ViewSpec, { kind: "full" | "window" }>)
    .orderBy
  const edge = direction === "after" ? page.rows.at(-1) : page.rows[0]
  const frontier = replace
    ? {}
    : keys.length === 0 && edge !== undefined
      ? {
          ...prev.frontier,
          [direction]: cursorOf(orderBy ?? [], o.entry.keyName, edge.values),
        }
      : { ...prev.frontier, [direction]: undefined }
  s.window = {
    frontier,
    pages,
    chain: replace ? prev.chain + 1 : prev.chain,
    target: replace ? "start" : prev.target,
    atStart: replace
      ? true
      : page.position === "prepend"
        ? page.end
        : prev.atStart,
    generation: keys.length === 0 ? prev.generation : generation,
  }
  // Читання сторінок старого ланцюжка вже нічого не напишуть: їхні позначки
  // не мають блокувати читання нового.
  if (replace) s.paging.clear()
  if (page.position !== "prepend") s.atEnd = page.end
  s.strategy = "window"
  s.truncated = false
  setLayout(s, keysOfPages(pages))
}

async function readWindowIncluded(
  ctx: ReaderContext,
  form: Form,
  rows: readonly ServerRow[],
  token: GenerationToken
): Promise<Included | undefined> {
  const wanted = includeKeys(
    form.include,
    rows.map((row) => row.values)
  )
  if (!token.valid) return undefined
  return readIncluded(
    ctx.source,
    form.include,
    wanted,
    ctx.limits.keysPerRequest
  )
}

/** The first page of a window: a new chain from the start of the order. */
async function readWindowFirst(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number,
  token: GenerationToken
): Promise<Write> {
  const fetched = await fetchPage(
    ctx.source,
    s.form,
    { direction: "after" },
    token,
    ctx.limits.windowPage
  )
  if (fetched === undefined) return NOTHING
  const included = await readWindowIncluded(ctx, s.form, fetched.rows, token)
  if (included === undefined) return NOTHING
  return (scope) =>
    writePage(ctx, scope, s, {
      rows: fetched.rows,
      included,
      position: "replace",
      lower: () => ({ kind: "start" }),
      end: fetched.end,
      readEpoch,
    })
}

/**
 * The page next to an edge of the window (`loadAfter` / `loadBefore`): read
 * from `cursor`, the visible value of the edge row. A page read backwards
 * knows no previous page, so its lower bound is its own first row.
 */
export async function readWindowMore(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number,
  token: GenerationToken,
  direction: "after" | "before",
  cursor: WindowCursor | undefined
): Promise<Write> {
  const { form } = s
  const fetched = await fetchPage(
    ctx.source,
    form,
    { direction, cursor },
    token,
    ctx.limits.windowPage
  )
  if (fetched === undefined) return NOTHING
  const included = await readWindowIncluded(ctx, form, fetched.rows, token)
  if (included === undefined) return NOTHING
  const spec = form.spec as Extract<ViewSpec, { kind: "full" | "window" }>
  const keyName = form.object.entry.keyName
  return (scope) =>
    writePage(ctx, scope, s, {
      rows: fetched.rows,
      included,
      position: direction === "after" ? "append" : "prepend",
      lower: (first) =>
        first === undefined
          ? { kind: "start" }
          : direction === "after"
            ? cursor === undefined
              ? { kind: "start" }
              : { kind: "after", cursor }
            : {
                kind: "from",
                cursor: cursorOf(spec.orderBy ?? [], keyName, first.values),
              },
      end: fetched.end,
      readEpoch,
    })
}

async function readKeysForm(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number
): Promise<Write> {
  const { ops } = ctx
  const { form } = s
  const o = form.object
  const rows = await readKeys(ctx.source, o.entry, form.keys, {
    keysPerRequest: ctx.limits.keysPerRequest,
  })
  return (scope) => {
    const got = new Set<Key>()
    for (const row of rows) {
      ops.put(scope, o, row, readEpoch, false)
      got.add(row.key)
    }
    // Перечитування за ключем без рядка — `removed` на місці (§6.2, правило 5).
    for (const key of form.keys) {
      if (!got.has(key)) missed(ops, scope, o, key, readEpoch)
    }
    s.owned = diffOwn(ops, scope, o, s.owned, form.keys)
    setLayout(
      s,
      form.keys.filter((k) => s.owned.has(k))
    )
  }
}

async function readCard(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number
): Promise<Write> {
  const { ops } = ctx
  const o = s.form.object
  const key = s.form.keys[0]!
  const rows = await readKeys(ctx.source, o.entry, [key], { form: "card" })
  return (scope) => {
    const row = rows.find((r) => r.key === key)
    if (row !== undefined) ops.put(scope, o, row, readEpoch, true)
    else missed(ops, scope, o, key, readEpoch)
    s.owned = diffOwn(ops, scope, o, s.owned, [key])
  }
}

async function readSection(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number
): Promise<Write> {
  const { ops } = ctx
  const o = s.form.object
  const spec = s.form.spec as Extract<ViewSpec, { kind: "section" }>
  const section = o.entry.tabularSections.find((t) => t.name === spec.section)!
  const result = await readOne(ctx.source, {
    object: o.ref,
    tabularSection: spec.section,
    owner: spec.owner,
  })
  const lines = result.rows.map((values) => lineOf(section, values))
  return (scope) => {
    // Читання прийнято (шлюз епохи пройдено), навіть коли сховище відкине
    // рядки: свіжість ТЧ-підмножини міряється епохою цього читання.
    s.sectionRead = readEpoch
    // Невидимий власник — рядків ТЧ не показуємо.
    if (result.ownerVersion === undefined) {
      ops.clearOwner(scope, o, spec.owner)
      return
    }
    const header = o.rows.get(spec.owner)
    ops.putSection(
      scope,
      o,
      spec.owner,
      spec.section,
      lines,
      result.ownerVersion,
      result.epoch,
      readEpoch,
      header === undefined ? "unknown" : header.scope
    )
  }
}

/**
 * Reads the form of `s`; the result is applied by one `commit`, gated by the
 * epochs of its answers. A multi-request read stops once `token` is invalid.
 */
export function readForm(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number,
  token: GenerationToken
): Promise<Apply> {
  return gated(ctx, readEpoch, (c) => readFormWrite(c, s, readEpoch, token))
}

/** {@link readForm} without the epoch gate: the caller gates the whole read. */
export function readFormWrite(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number,
  token: GenerationToken
): Promise<Write> {
  switch (s.form.spec.kind) {
    case "keys":
      return readKeysForm(ctx, s, readEpoch)
    case "card":
      return readCard(ctx, s, readEpoch)
    case "section":
      return readSection(ctx, s, readEpoch)
    case "full":
      return readFull(ctx, s, readEpoch, token)
    case "window":
      return readWindowFirst(ctx, s, readEpoch, token)
  }
}
