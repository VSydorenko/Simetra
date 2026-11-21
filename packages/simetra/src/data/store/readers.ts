import {
  CommandFailure,
  keysetFilter,
  type CatalogEntrySection,
} from "simetra/model"
import { DataError } from "../errors"
import type { Form, ObjectState } from "./forms"
import { nullableOf } from "./filter"
import {
  completeIncluded,
  includeKeys,
  includedFrom,
  type IncludeStep,
  type Included,
} from "./include"
import { differentEpochs } from "./epoch"
import { visibleRow, type PutResult, type RestoredRow } from "./object-store"
import type { OwnerScope, SectionEntry } from "./section-store"
import type { Scope, Session } from "./session"
import type { Subset } from "./subsets"
import {
  readKeys,
  readOne,
  readRows,
  rowsOf,
  tracked,
  type StoreSource,
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
  RowState,
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
  ): "barred" | undefined
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
  readonly source: StoreSource
  readonly limits: CoreLimits
  readonly strict: boolean
  readonly log: (entry: CoreLogEntry) => void
  readonly ops: StoreOps
  objectOf(name: ObjectName): ObjectState
  /** Whether the object is marked stale-client (§10): nothing of it is written. */
  isStale(object: ObjectName): boolean
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
   * generation of the read. A new chain and a purge drop them, so the
   * answers in flight write nothing.
   */
  readonly paging: Map<"after" | "before", number>
  /**
   * The start epoch of the last section read the session accepted (section
   * form only): a `hide` of the owner after it makes the subset stale.
   */
  sectionRead: number | undefined
  /**
   * Section form only: the owner state a snapshot brought for a header the
   * store does not hold; any accepted read of the section drops it.
   */
  headerState: RowState | undefined
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
  read: (ctx: C) => Promise<Write>,
  caller?: Subset
): Promise<Apply> {
  const { source, epochs } = tracked(ctx.source, caller)
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
    // Несумісна ціль (§10) — на мить застосування, а не лише запиту: вона
    // могла стати такою, поки відповідь летіла. Нічого не пишемо, ключі не
    // стають `removed`, утримане лишається за виглядом.
    if (ctx.isStale(name)) {
      next.set(name, s.included.get(name) ?? new Set<Key>())
      continue
    }
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

/**
 * Лишає з прочитаних цілей лише ті, що потрібні живим рядкам читання; ключі —
 * ті з них, на які читання відповідало.
 */
export function aliveIncluded(
  included: Included,
  wanted: ReadonlyMap<ObjectName, readonly Key[]>
): Included {
  return new Map(
    [...included].map(([name, { keys, rows }]) => {
      const alive = new Set(wanted.get(name))
      return [
        name,
        {
          keys: keys.filter((key) => alive.has(key)),
          rows: rows.filter((r) => alive.has(r.key)),
        },
      ]
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
 * is invalid: a released or re-requested view reads no further page. `own`
 * — the keys the view holds (§6.7): each page carries the `known` of those
 * the earlier pages did not answer, the view's order first, so a page
 * without changes comes back as markers.
 */
export async function fetchFull(
  ctx: ReaderContext,
  form: Form,
  token: GenerationToken,
  own?: Pick<ReaderTarget, "owned" | "layout">,
  include: readonly IncludeStep[] = [],
  prefix: readonly ServerRow[] = []
): Promise<
  { rows: ServerRow[]; over: boolean; included: Included } | undefined
> {
  const { source, limits } = ctx
  const o = form.object
  const spec = form.spec as Extract<ViewSpec, { kind: "full" }>
  const orderBy = spec.orderBy ?? []
  // `prefix` — страницы, які вже прочитано й прийнято: вибірка продовжується
  // keyset-ом від останнього рядка.
  const pages: ServerRow[] = [...prefix]
  const answered = new Set<Key>(prefix.map((r) => r.key))
  // Цілі `include` просить лише перша сторінка (§6.7): наступні дочитує
  // частина `keys` наступного пакета.
  let included: Included = includedFrom(include, [], undefined, null)
  let last: Record<string, unknown> | undefined = prefix.at(-1)?.values
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
    const waiting =
      own === undefined
        ? []
        : [...own.layout, ...own.owned].filter((key) => !answered.has(key))
    const page = await readRows(
      source,
      o.entry,
      {
        object: o.ref,
        ...(orderBy.length === 0 ? {} : { orderBy }),
        ...(where === undefined ? {} : { where }),
        limit: limits.fullPageSize,
        ...(last === undefined && include.length > 0
          ? { include: include.map((step) => step.attribute) }
          : {}),
      },
      own === undefined
        ? undefined
        : o.rows.knownFor(waiting, { owned: own.owned, form: "list" })
    )
    // Звільнений чи перезапитаний вигляд далі не читає: наступна сторінка
    // була б запитом, результат якого нікуди не запишеться.
    if (!token.valid) return undefined
    if (last === undefined)
      included = includedFrom(
        include,
        page.rows.map((r) => r.values),
        page.included,
        page.epoch
      )
    pages.push(...page.rows)
    for (const row of page.rows) answered.add(row.key)
    if (pages.length > limits.fullLimit) break
    const tail = page.rows.at(-1)
    if (tail === undefined) break
    if (!page.more && page.rows.length < limits.fullPageSize) break
    last = tail.values
  }
  return { rows: pages, over: pages.length > limits.fullLimit, included }
}

/**
 * The system re-read of a `full` view (§6.7, Рд41): the pages go as parts of
 * ONE package, each from the stored bound of the composition (the stored last
 * row of the previous page, in the view's order) and with the `known` of its
 * own stored keys, so an unchanged list is one request of markers. A page
 * counts only while the last row of the answer is the stored bound of the
 * page: otherwise the answers of the pages after it are dropped (their
 * boundaries are stale — a gap or a duplicate) and the read goes on
 * sequentially from the last row of the page that did not match, as
 * {@link fetchFull} does. A short page ends the read.
 */
export async function fetchFullAgain(
  ctx: ReaderContext,
  form: Form,
  token: GenerationToken,
  own: Pick<ReaderTarget, "owned" | "layout">
): ReturnType<typeof fetchFull> {
  const { source, limits } = ctx
  const o = form.object
  const size = limits.fullPageSize
  const spec = form.spec as Extract<ViewSpec, { kind: "full" }>
  const orderBy = spec.orderBy ?? []
  // Склад у серверному порядку: лише рядки, чиї значення відомі.
  const stored: { key: Key; values: Values }[] = []
  for (const key of own.owned) {
    const e = o.rows.get(key)
    const values = e === undefined ? undefined : visibleRow(e)
    if (values !== undefined) stored.push({ key, values })
  }
  if (form.compare === undefined || stored.length <= size)
    return fetchFull(ctx, form, token, own)
  const compare = form.compare
  stored.sort((a, b) => compare(a.values, b.values))
  const pages = Array.from(
    { length: Math.ceil(stored.length / size) },
    (_, i) => stored.slice(i * size, (i + 1) * size)
  )
  const snapshots = pages.map((page) =>
    o.rows.knownFor(
      page.map((r) => r.key),
      { owned: own.owned, form: "list" }
    )
  )
  const { items } = await source.read(
    pages.map((_, i) => {
      const bound = i === 0 ? undefined : stored[i * size - 1]!.values
      const where =
        bound === undefined
          ? undefined
          : keysetFilter(
              orderBy,
              {
                ...cursorOf(orderBy, o.entry.keyName, bound),
                direction: "after",
              },
              o.entry.keyName,
              nullableOf(o.info)
            )
      return {
        type: "query" as const,
        query: {
          object: o.ref,
          ...(orderBy.length === 0 ? {} : { orderBy }),
          ...(where === undefined ? {} : { where }),
          limit: size,
        },
        ...(snapshots[i] === undefined ? {} : { known: snapshots[i]!.known }),
      }
    })
  )
  if (!token.valid) return undefined
  const accepted: ServerRow[] = []
  let ended = false
  for (const [i, item] of items.entries()) {
    if (!item.ok) throw new CommandFailure(item.error)
    if (!("rows" in item))
      throw new CommandFailure({ code: "command.internal" })
    const got = rowsOf(o.entry, item.rows.rows, item.epoch, snapshots[i])
    accepted.push(...got)
    if (!(item.rows.more === true) && got.length < size) {
      ended = true
      break
    }
    // Не остання сторінка: її кінець мусить бути збереженою межею.
    if (i < pages.length - 1 && got.at(-1)?.key !== pages[i]!.at(-1)!.key) {
      break
    }
  }
  if (ended)
    return {
      rows: accepted,
      over: accepted.length > limits.fullLimit,
      included: includedFrom([], [], undefined, null),
    }
  return fetchFull(ctx, form, token, own, [], accepted)
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
  const fetched = await fetchFull(ctx, form, token, s, form.include)
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
  const included = await completeIncluded(
    ctx.source,
    form.include,
    wanted,
    fetched.included,
    limits.keysPerRequest
  )
  const values = new Map(kept.map((r) => [r.key, r.values] as const))
  return (scope) => {
    // Понад межу `full` стає справжнім вікном: перша сторінка — початок
    // серверного порядку, далі читають `loadAfter`/`loadBefore`.
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
 * store's ordinary ways, the window keeps only the keys and the place.
 * A new chain (`replace`) owns its rows before the old one lets go, in this
 * same `commit`; a page joins the edge with the rows the window does not
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
  s: ReaderTarget,
  rows: readonly ServerRow[],
  token: GenerationToken,
  covered: Included,
  skipHeld: boolean
): Promise<Included | undefined> {
  const { form } = s
  // Ціль, яку вигляд уже тримає, не дочитується (§6.7): наступна сторінка
  // просить лише відсутні.
  const held = (name: ObjectName) =>
    skipHeld ? s.included.get(name) : undefined
  const wanted = new Map(
    [
      ...includeKeys(
        form.include,
        rows.map((row) => row.values)
      ),
    ].map(([name, keys]) => [name, keys.filter((key) => !held(name)?.has(key))])
  )
  if (!token.valid) return undefined
  return completeIncluded(
    ctx.source,
    form.include,
    wanted,
    covered,
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
    ctx.limits.windowPage,
    s.form.include
  )
  if (fetched === undefined) return NOTHING
  const included = await readWindowIncluded(
    ctx,
    s,
    fetched.rows,
    token,
    fetched.included,
    false
  )
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
  const included = await readWindowIncluded(
    ctx,
    s,
    fetched.rows,
    token,
    fetched.included,
    true
  )
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
    known: (keys) => o.rows.knownFor(keys, { owned: s.owned, form: "list" }),
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
  const { ops, limits } = ctx
  const { form } = s
  const o = form.object
  const key = form.keys[0]!
  // Картка просить `include` тим самим запитом (§6.7); читання за id — та сама
  // форма картки, що й читання за ключем.
  const answer = await readRows(
    ctx.source,
    o.entry,
    {
      object: o.ref,
      id: key,
      ...(form.include.length === 0
        ? {}
        : { include: form.include.map((step) => step.attribute) }),
    },
    o.rows.knownFor([key], { owned: s.owned, form: "card" })
  )
  const row = answer.rows.find((r) => r.key === key)
  const included = await completeIncluded(
    ctx.source,
    form.include,
    includeKeys(form.include, row === undefined ? [] : [row.values]),
    includedFrom(
      form.include,
      answer.rows.map((r) => r.values),
      answer.included,
      answer.epoch
    ),
    limits.keysPerRequest
  )
  return (scope) => {
    if (row !== undefined) ops.put(scope, o, row, readEpoch, true)
    else missed(ops, scope, o, key, readEpoch)
    s.owned = diffOwn(ops, scope, o, s.owned, [key])
    if (form.include.length === 0) return
    // Рядок, чий `put` відхилено, лишається `removed`: його цілей не беремо.
    const alive = o.rows.get(key)?.removed === undefined && row !== undefined
    applyIncluded(
      ctx,
      scope,
      s,
      aliveIncluded(
        included,
        includeKeys(form.include, alive ? [row.values] : [])
      ),
      readEpoch
    )
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
    // рядки: свіжість ТЧ-підмножини міряється епохою цього читання. Крім
    // відмови бар'єра знімка прав: таку ТЧ вигляд ще читатиме (нижче).
    const before = s.sectionRead
    s.sectionRead = readEpoch
    s.headerState = undefined
    // Невидимий власник — рядків ТЧ не показуємо.
    if (result.ownerVersion === undefined) {
      ops.clearOwner(scope, o, spec.owner)
      return
    }
    // Скоуп власника відомий лише з шапки не старшої за версію власника ТЧ і
    // тієї самої епохи версій (правило `sectionLinesStale`): новіша версія
    // могла переїхати в інший скоуп, а версії різних епох не впорядковані,
    // тож така шапка пари не підтверджує — рядки судяться як без шапки
    // (§6.2 правило 4). Об'єкт без колонки скоупу має один скоуп, `null`,
    // відомий і без шапки: інакше «невідомий» скоуп обминав би бар'єр
    // знімка й надгробок пари `(об'єкт, null)`, які судять лише скоуплені.
    const header = o.rows.get(spec.owner)
    const barred = ops.putSection(
      scope,
      o,
      spec.owner,
      spec.section,
      lines,
      result.ownerVersion,
      result.epoch,
      readEpoch,
      o.entry.scopeColumn === undefined
        ? null
        : header === undefined ||
            differentEpochs(result.epoch, header.versionEpoch) ||
            header.version < result.ownerVersion
          ? "unknown"
          : header.scope
    )
    // ТЧ, відкинута бар'єром знімка, не рухає `sectionRead`: її змонтований
    // вигляд читає її ще раз, уже після знімка (§6.2 правило 4).
    if (barred === "barred") s.sectionRead = before
  }
}

/**
 * Reads the form of `s`; the result is applied by one `commit`, gated by the
 * epochs of its answers. A multi-request read stops once `token` is invalid.
 */
export function readForm(
  ctx: ReaderContext,
  s: Subset,
  readEpoch: number,
  token: GenerationToken
): Promise<Apply> {
  return gated(ctx, readEpoch, (c) => readFormWrite(c, s, readEpoch, token), s)
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
