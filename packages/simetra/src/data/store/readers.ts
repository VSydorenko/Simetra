import {
  CommandFailure,
  keysetFilter,
  type CatalogEntrySection,
} from "simetra/model"
import { DataError } from "../errors"
import type { Form, ObjectState } from "./forms"
import { nullableOf } from "./filter"
import { includeKeys, readIncluded, type Included } from "./include"
import { visibleRow, type PutResult } from "./object-store"
import type { OwnerScope } from "./section-store"
import type { Scope } from "./session"
import { readKeys, readOne, serverRow, type CoreSource } from "./source"
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
 * in step with the store, so every write path (views, tail, Task 8 writer)
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
  /**
   * Drops the entries written in this `commit` that are left without an
   * owner (an `apply` that threw half-way): a row never outlives its commit
   * unowned.
   */
  sweep(scope: Scope): void
}

/** What the readers need from the core. */
export interface ReaderContext {
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
}

/** Applies a read result inside one `commit`. */
export type Apply = (scope: Scope) => void

/** The size of the first page of a truncated `full` (P4-B plan П5). */
const WINDOW_PAGE = 100

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

/** Writes the read targets of `include` and moves the view's target ownership to them. */
export function applyIncluded(
  ctx: ReaderContext,
  scope: Scope,
  s: ReaderTarget,
  included: Included,
  readEpoch: number
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
    next.set(
      name,
      diffOwn(ops, scope, target, s.included.get(name) ?? new Set(), keys)
    )
  }
  for (const [name, keys] of s.included) {
    if (next.has(name)) continue
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

const NOTHING: Apply = () => {}

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
): Promise<Apply> {
  const { limits, ops } = ctx
  const { form } = s
  const o = form.object
  const fetched = await fetchFull(ctx, form, token)
  if (fetched === undefined) return NOTHING
  const { rows, over } = fetched
  if (over && ctx.strict) throw new DataError("data.full-too-large")
  // Понад межу — перша сторінка вікна в серверному порядку (П5).
  const kept = over
    ? rows.filter((r) => form.test(r.values)).slice(0, WINDOW_PAGE)
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
    s.strategy = over ? "window" : "full"
    s.truncated = over
    s.atEnd = !over
    setLayout(
      s,
      over
        ? kept.map((r) => r.key).filter((k) => s.owned.has(k))
        : fullLayout(s, values)
    )
    if (over)
      ctx.log({
        kind: "full-truncated",
        object: o.name,
        limit: limits.fullLimit,
      })
  }
}

async function readKeysForm(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number
): Promise<Apply> {
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
): Promise<Apply> {
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
): Promise<Apply> {
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
 * Reads the form of `s`; the result is applied by one `commit`. A
 * multi-request read stops once `token` is invalid.
 */
export function readForm(
  ctx: ReaderContext,
  s: ReaderTarget,
  readEpoch: number,
  token: GenerationToken
): Promise<Apply> {
  switch (s.form.spec.kind) {
    case "keys":
      return readKeysForm(ctx, s, readEpoch)
    case "card":
      return readCard(ctx, s, readEpoch)
    case "section":
      return readSection(ctx, s, readEpoch)
    case "full":
      return readFull(ctx, s, readEpoch, token)
  }
}
