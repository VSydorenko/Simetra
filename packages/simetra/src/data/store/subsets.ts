import {
  CommandFailure,
  type CatalogEntry,
  type CatalogEntrySection,
  type CatalogIndex,
  type CommandError,
  type MetadataRef,
} from "simetra/model"
import { DataError } from "../errors"
import {
  checkFilterBudget,
  compareRows,
  compileFilter,
  keysetAfter,
  type FieldInfo,
} from "./filter"
import {
  includeKeys,
  includeSteps,
  readIncluded,
  refsOf,
  type IncludeStep,
  type Included,
} from "./include"
import { visibleRow, type ObjectStore, type PutResult } from "./object-store"
import type { OwnerScope, SectionStore } from "./section-store"
import type { Scope, Session } from "./session"
import { LOADING, shareSnapshot, withRefs, type RowViews } from "./snapshot"
import {
  ReadLimiterClosed,
  readKeys,
  serverRow,
  type CoreSource,
} from "./source"
import type {
  CoreLimits,
  CoreLogEntry,
  Key,
  ObjectName,
  RowView,
  SectionLine,
  ServerRow,
  Values,
  ViewHandle,
  ViewSnapshot,
  ViewSpec,
} from "./types"

/*
 * Реєстр виглядів (спека П4-B §6.1 «Вигляди й форми підмножин», §6.2, §6.3):
 * мемо хендлів за канонічним ключем форми, утримання (підписка, `preload`)
 * зі звільненням через `releaseDelayMs`, межа утриманих форм, single-flight
 * з одним хвостовим запитом і читання кожної форми з одним `commit`.
 */

/** The stores and catalog facts of one object. */
export interface ObjectState {
  readonly name: ObjectName
  readonly ref: MetadataRef
  readonly entry: CatalogEntry
  readonly info: FieldInfo
  readonly lazyFields: readonly string[]
  readonly rows: ObjectStore
  readonly sections: SectionStore
}

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
    readEpoch: number,
    ownerScope: OwnerScope
  ): void
  clearOwner(scope: Scope, o: ObjectState, owner: Key): void
}

export interface RegistryContext {
  readonly session: Session
  readonly source: CoreSource
  readonly index: CatalogIndex
  readonly limits: CoreLimits
  readonly strict: boolean
  readonly filterCollator: Intl.Collator
  readonly userCollator: Intl.Collator
  readonly log: (entry: CoreLogEntry) => void
  readonly ops: StoreOps
  readonly rowViews: RowViews
  objectOf(name: ObjectName): ObjectState
  dirtySections(): ReadonlyMap<ObjectName, ReadonlySet<Key>>
  /** The purged snapshot once the core closes. */
  closedSnapshot(): ViewSnapshot | undefined
}

/** A validated view form: what every subset and handle of it shares. */
interface Form {
  readonly spec: ViewSpec
  readonly specKey: string
  readonly object: ObjectState
  readonly keys: readonly Key[]
  readonly test: (values: Values) => boolean
  readonly compare: ((a: Values, b: Values) => number) | undefined
  readonly include: readonly IncludeStep[]
}

type Timer = ReturnType<typeof setTimeout>

/** A held view form. */
export interface Subset {
  readonly form: Form
  readonly listeners: Set<{ readonly fn: () => void }>
  preloads: number
  readonly preloadTimers: Set<Timer>
  releaseTimer: Timer | undefined
  alive: boolean
  /** Generation of loads: a load writes only while it is current. */
  gen: number
  /** The generation of the load in flight. */
  flight: number | undefined
  trailing: boolean
  /** At least one load finished (or a card showed its stored row). */
  settled: boolean
  /** A load succeeded: a later read is `refreshing`, not `loading` (§6.5). */
  loaded: boolean
  owned: Set<Key>
  included: Map<ObjectName, Set<Key>>
  /** Composition and order; changes only on a load (§6.5). */
  layout: readonly Key[]
  layoutSet: ReadonlySet<Key>
  status: "loading" | "ready" | "refreshing" | "error"
  error: CommandError | DataError | undefined
  needsRefresh: boolean
  hasNewRows: boolean
  strategy: "full" | "window" | undefined
  truncated: boolean
  atEnd: boolean
  waiters: Array<() => void>
  dirty: boolean
  snapshot: ViewSnapshot | undefined
  refViews: Map<Key, RowView>
  /** The header revision at the start of the last card or section read. */
  readRevision: number | undefined
  checkQueued: boolean
}

/** The view registry of a core. */
export interface SubsetRegistry {
  view(spec: ViewSpec): ViewHandle
  preload(spec: ViewSpec, options?: { ttlMs?: number }): Promise<void>
  subsets(): Iterable<Subset>
  /** Starts a load (single-flight: merges into one trailing request). */
  load(s: Subset): void
  /**
   * After a `commit`: marks the affected subsets dirty and returns the
   * subscribed ones whose snapshot changed.
   */
  afterCommit(closing: boolean): Subset[]
  /** Cancels every timer, resolves waiters and forgets every subset and handle. */
  close(): void
}

/** The size of the first page of a truncated `full` (P4-B plan П5). */
const WINDOW_PAGE = 100
const NO_LINES: readonly SectionLine[] = Object.freeze([])

// Канонічний JSON: рівні фільтри з різним порядком полів — одна форма.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

const errorOf = (error: unknown): CommandError | DataError => {
  if (error instanceof CommandFailure) return error.error
  if (error instanceof DataError) return error
  return { code: "command.internal" }
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

export function createRegistry(ctx: RegistryContext): SubsetRegistry {
  const { session, source, limits, ops, rowViews } = ctx
  const subsets = new Map<string, Subset>()
  // Мемо хендлів з межею: хендл шукає підмножину за ключем форми, тож новий
  // хендл після витіснення під'єднується до тієї самої підмножини.
  const handles = new Map<string, ViewHandle>()
  const isClosed = () => ctx.closedSnapshot() !== undefined

  // ------------------------------------------------------------ форми

  function formOf(spec: ViewSpec): Form {
    const object = ctx.objectOf(spec.object)
    const { entry } = object
    const all = () => true
    switch (spec.kind) {
      case "keys": {
        const keys = [...new Set(spec.keys)]
        return {
          spec,
          specKey: canonical([spec.kind, spec.object, keys]),
          object,
          keys,
          test: all,
          compare: undefined,
          include: [],
        }
      }
      case "card":
        return {
          spec,
          specKey: canonical([spec.kind, spec.object, spec.key]),
          object,
          keys: [spec.key],
          test: all,
          compare: undefined,
          include: [],
        }
      case "section":
        if (!entry.tabularSections.some((s) => s.name === spec.section)) {
          throw new TypeError(`${spec.object}: unknown section ${spec.section}`)
        }
        return {
          spec,
          specKey: canonical([
            spec.kind,
            spec.object,
            spec.owner,
            spec.section,
          ]),
          object,
          keys: [],
          test: all,
          compare: undefined,
          include: [],
        }
      case "full": {
        // Усі відмови — тут, до запиту (§6.1 «Предикати», §6.4 «Бюджет фільтра»).
        const orderBy = spec.orderBy ?? []
        const test =
          spec.where === undefined
            ? all
            : compileFilter(spec.where, object.info, ctx.filterCollator)
        const compare = compareRows(
          orderBy,
          object.info,
          entry.keyName,
          ctx.userCollator
        )
        const sample: Record<string, unknown> = { [entry.keyName]: "x" }
        for (const part of orderBy) sample[part.attribute] = "x"
        const keyset = keysetAfter(orderBy, sample, entry.keyName)
        checkFilterBudget(
          spec.where === undefined ? keyset : { and: [spec.where, keyset] }
        )
        const include = includeSteps(
          spec.object,
          entry,
          ctx.index,
          spec.include
        )
        return {
          spec,
          specKey: canonical([
            spec.kind,
            spec.object,
            spec.where ?? null,
            orderBy,
            include.map((s) => s.attribute).sort(),
          ]),
          object,
          keys: [],
          test,
          compare,
          include,
        }
      }
    }
  }

  // ------------------------------------------------------------ власність

  /** Owns `wanted` keys that have an entry, disowns the rest of `prev`. */
  function diffOwn(
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

  function setLayout(s: Subset, layout: readonly Key[]) {
    s.layout = layout
    s.layoutSet = new Set(layout)
  }

  function applyIncluded(
    scope: Scope,
    s: Subset,
    included: Included,
    readEpoch: number
  ) {
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
        if (!got.has(key) && target.rows.get(key) !== undefined)
          ops.remove(scope, target, key, readEpoch)
      }
      next.set(
        name,
        diffOwn(scope, target, s.included.get(name) ?? new Set(), keys)
      )
    }
    for (const [name, keys] of s.included) {
      if (next.has(name)) continue
      const target = ctx.objectOf(name)
      for (const key of keys) ops.disown(scope, target, key)
    }
    s.included = next
  }

  // ------------------------------------------------------------ читання форм

  /** Склад `full`: локальний фільтр і порядок; `removed` тримає позицію. */
  function fullLayout(s: Subset, fetched: ReadonlyMap<Key, Values>): Key[] {
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

  async function fetchFull(s: Subset, readEpoch: number) {
    const { form } = s
    const o = form.object
    const spec = form.spec as Extract<ViewSpec, { kind: "full" }>
    const orderBy = spec.orderBy ?? []
    const pages: Record<string, unknown>[] = []
    let last: Record<string, unknown> | undefined
    // Сторінки — поза сховищем до кінця вибірки; зупинка лише на сторінці
    // без `more` і коротшій за `limit` (§6.1).
    for (;;) {
      const where =
        last === undefined
          ? undefined
          : keysetAfter(orderBy, last, o.entry.keyName)
      const page = await source.read({
        object: o.ref,
        ...(orderBy.length === 0 ? {} : { orderBy }),
        ...(where === undefined ? {} : { where }),
        limit: limits.fullPageSize,
      })
      pages.push(...page.rows)
      if (pages.length > limits.fullLimit) break
      const tail = page.rows.at(-1)
      if (tail === undefined) break
      if (page.more !== true && page.rows.length < limits.fullPageSize) break
      last = tail
    }
    const over = pages.length > limits.fullLimit
    if (over && ctx.strict) throw new DataError("data.full-too-large")
    const rows = pages.map((values) => serverRow(o.entry, values))
    // Понад межу — перша сторінка вікна в серверному порядку (П5).
    const kept = over
      ? rows.filter((r) => form.test(r.values)).slice(0, WINDOW_PAGE)
      : rows
    // Цілі — лише з відфільтрованих рядків; слот `removed` цілей не дає (§6.2,
    // правило 5).
    const shown = (
      over ? kept : kept.filter((r) => form.test(r.values))
    ).filter((r) => o.rows.get(r.key)?.removed === undefined)
    const wanted = includeKeys(
      form.include,
      shown.map((r) => r.values)
    )
    const included = await readIncluded(
      source,
      form.include,
      wanted,
      limits.keysPerRequest
    )
    const fetched = new Map(kept.map((r) => [r.key, r.values] as const))
    return (scope: Scope) => {
      for (const row of kept) ops.put(scope, o, row, readEpoch, false)
      s.owned = diffOwn(scope, o, s.owned, fetched.keys())
      applyIncluded(scope, s, included, readEpoch)
      s.strategy = over ? "window" : "full"
      s.truncated = over
      s.atEnd = !over
      setLayout(
        s,
        over
          ? kept.map((r) => r.key).filter((k) => s.owned.has(k))
          : fullLayout(s, fetched)
      )
      if (over)
        ctx.log({
          kind: "full-truncated",
          object: o.name,
          limit: limits.fullLimit,
        })
    }
  }

  async function fetchKeys(s: Subset, readEpoch: number) {
    const { form } = s
    const o = form.object
    const rows = await readKeys(source, o.entry, form.keys, {
      keysPerRequest: limits.keysPerRequest,
    })
    return (scope: Scope) => {
      const got = new Set<Key>()
      for (const row of rows) {
        ops.put(scope, o, row, readEpoch, false)
        got.add(row.key)
      }
      // Перечитування за ключем без рядка — `removed` на місці (§6.2, правило 5).
      for (const key of form.keys) {
        if (!got.has(key) && o.rows.get(key) !== undefined)
          ops.remove(scope, o, key, readEpoch)
      }
      s.owned = diffOwn(scope, o, s.owned, form.keys)
      setLayout(
        s,
        form.keys.filter((k) => s.owned.has(k))
      )
    }
  }

  async function fetchCard(s: Subset, readEpoch: number) {
    const o = s.form.object
    const key = s.form.keys[0]!
    const rows = await readKeys(source, o.entry, [key], { form: "card" })
    return (scope: Scope) => {
      const row = rows.find((r) => r.key === key)
      if (row !== undefined) ops.put(scope, o, row, readEpoch, true)
      else if (o.rows.get(key) !== undefined)
        ops.remove(scope, o, key, readEpoch)
      s.owned = diffOwn(scope, o, s.owned, [key])
    }
  }

  async function fetchSection(s: Subset, readEpoch: number) {
    const o = s.form.object
    const spec = s.form.spec as Extract<ViewSpec, { kind: "section" }>
    const section = o.entry.tabularSections.find(
      (t) => t.name === spec.section
    )!
    const result = await source.read({
      object: o.ref,
      tabularSection: spec.section,
      owner: spec.owner,
    })
    const lines = result.rows.map((values) => lineOf(section, values))
    return (scope: Scope) => {
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
        readEpoch,
        header === undefined ? "unknown" : header.scope
      )
    }
  }

  function fetchOf(
    s: Subset,
    readEpoch: number
  ): Promise<(scope: Scope) => void> {
    switch (s.form.spec.kind) {
      case "keys":
        return fetchKeys(s, readEpoch)
      case "card":
        return fetchCard(s, readEpoch)
      case "section":
        return fetchSection(s, readEpoch)
      case "full":
        return fetchFull(s, readEpoch)
    }
  }

  // ------------------------------------------------------------ завантаження

  const headerKey = (s: Subset): Key | undefined => {
    const spec = s.form.spec
    return spec.kind === "card"
      ? spec.key
      : spec.kind === "section"
        ? spec.owner
        : undefined
  }

  const hasData = (s: Subset) =>
    s.layout.some((key) => s.form.object.rows.get(key) !== undefined) ||
    (s.form.spec.kind === "section" &&
      s.form.object.sections.get(s.form.spec.owner, s.form.spec.section) !==
        undefined)

  function resolveWaiters(s: Subset) {
    for (const resolve of s.waiters.splice(0)) resolve()
  }

  function load(s: Subset) {
    if (!s.alive || isClosed()) return
    if (s.flight !== undefined) {
      s.trailing = true
      return
    }
    const gen = ++s.gen
    s.flight = gen
    // Токен покоління: недійсний після звільнення й нового запиту (§6.1).
    const token = session.childToken(() => s.alive && s.gen === gen)
    const what = `view ${s.form.specKey}`
    const readEpoch = session.epochs.now()
    const header = headerKey(s)
    if (header !== undefined)
      s.readRevision = rowViews.revision(s.form.object.name, header)
    session.commit(
      () => {
        s.status = hasData(s) || s.loaded ? "refreshing" : "loading"
        s.dirty = true
      },
      token,
      what
    )
    fetchOf(s, readEpoch)
      .then(
        (apply) => {
          session.commit(
            (scope) => {
              apply(scope)
              s.loaded = true
              s.status = "ready"
              s.error = undefined
              s.needsRefresh = false
              s.hasNewRows = false
              s.dirty = true
            },
            token,
            what
          )
        },
        (error: unknown) => {
          // Закритий обмежувач — сесію закрито: писати нікуди.
          if (error instanceof ReadLimiterClosed) return
          session.commit(
            () => {
              s.status = "error"
              s.error = errorOf(error)
              s.dirty = true
            },
            token,
            what
          )
        }
      )
      .finally(() => {
        if (s.flight !== gen) return
        s.flight = undefined
        s.settled = true
        resolveWaiters(s)
        if (s.trailing && s.alive && !isClosed()) {
          s.trailing = false
          load(s)
        }
      })
  }

  /** Mounted card: lazy fields absent or read with an older row version. */
  function cardStale(s: Subset): boolean {
    const o = s.form.object
    const key = s.form.keys[0]!
    const e = o.rows.get(key)
    if (e === undefined || e.removed !== undefined || e.row === undefined)
      return false
    if (e.stale.seen !== undefined) return false
    const values = e.row.values
    return o.lazyFields.some(
      (f) =>
        !Object.hasOwn(values, f) ||
        (e.lazyVersions.get(f) ?? -Infinity) < e.version
    )
  }

  /** Mounted section: no lines yet or an `ownerVersion` below the header version. */
  function sectionStale(s: Subset): boolean {
    const spec = s.form.spec
    if (spec.kind !== "section") return false
    const e = s.form.object.rows.get(spec.owner)
    if (
      e === undefined ||
      e.removed !== undefined ||
      e.stale.seen !== undefined
    )
      return false
    const lines = s.form.object.sections.get(spec.owner, spec.section)
    return lines === undefined || lines.ownerVersion < e.version
  }

  /**
   * Дочитування змонтованого вигляду (§6.2, правило 2): лише коли шапка
   * змінилась після останнього читання — відкинута відповідь не крутить
   * повторів.
   */
  function check(s: Subset) {
    if (!s.alive || s.flight !== undefined || s.listeners.size === 0) return
    const header = headerKey(s)
    if (header === undefined) return
    const stale = s.form.spec.kind === "card" ? cardStale(s) : sectionStale(s)
    if (!stale) return
    if (rowViews.revision(s.form.object.name, header) === s.readRevision) return
    load(s)
  }

  /** The first hold starts the subset; a card with a stored row shows it without a read. */
  function start(s: Subset, mounted: boolean) {
    if (s.gen > 0 || s.settled) {
      if (mounted) check(s)
      return
    }
    const spec = s.form.spec
    if (
      spec.kind === "card" &&
      s.form.object.rows.get(spec.key) !== undefined
    ) {
      const token = session.childToken(() => s.alive)
      session.commit(
        (scope) => {
          s.owned = diffOwn(scope, s.form.object, s.owned, [spec.key])
          s.loaded = true
          s.status = "ready"
          s.dirty = true
        },
        token,
        `view ${s.form.specKey}`
      )
      s.settled = true
      resolveWaiters(s)
      if (mounted) check(s)
      return
    }
    load(s)
  }

  // ------------------------------------------------------------ утримання

  function cancelTimers(s: Subset) {
    if (s.releaseTimer !== undefined) clearTimeout(s.releaseTimer)
    s.releaseTimer = undefined
    for (const timer of s.preloadTimers) clearTimeout(timer)
    s.preloadTimers.clear()
  }

  const otherSection = (s: Subset, owner: Key) =>
    [...subsets.values()].some(
      (x) =>
        x !== s &&
        x.form.spec.kind === "section" &&
        x.form.object === s.form.object &&
        x.form.spec.owner === owner
    )

  function release(s: Subset) {
    if (!s.alive) return
    cancelTimers(s)
    const o = s.form.object
    session.commit(
      (scope) => {
        s.alive = false
        subsets.delete(s.form.specKey)
        for (const key of s.owned) ops.disown(scope, o, key)
        for (const [name, keys] of s.included) {
          const target = ctx.objectOf(name)
          for (const key of keys) ops.disown(scope, target, key)
        }
        s.owned = new Set()
        s.included = new Map()
        const spec = s.form.spec
        // Останній вигляд ТЧ власника забирає його рядки ТЧ (§6.2 «картка»).
        if (spec.kind === "section" && !otherSection(s, spec.owner))
          ops.clearOwner(scope, o, spec.owner)
      },
      session.token(),
      "release"
    )
    resolveWaiters(s)
  }

  function idle(s: Subset) {
    return s.listeners.size === 0 && s.preloads === 0
  }

  function scheduleRelease(s: Subset) {
    if (s.releaseTimer !== undefined) clearTimeout(s.releaseTimer)
    s.releaseTimer = setTimeout(() => {
      s.releaseTimer = undefined
      if (idle(s)) release(s)
    }, limits.releaseDelayMs)
  }

  /**
   * The subset of a form, created on its first hold. A new held form over
   * `viewsMax` first releases a hold without a subscription (preload,
   * release delay), oldest first, then refuses synchronously (П16).
   */
  function acquire(form: Form): Subset {
    const found = subsets.get(form.specKey)
    if (found !== undefined) return found
    if (subsets.size >= limits.viewsMax) {
      const spare = [...subsets.values()].find((x) => x.listeners.size === 0)
      if (spare === undefined) throw new DataError("data.views-limit")
      release(spare)
    }
    const s: Subset = {
      form,
      listeners: new Set(),
      preloads: 0,
      preloadTimers: new Set(),
      releaseTimer: undefined,
      alive: true,
      gen: 0,
      flight: undefined,
      trailing: false,
      settled: false,
      loaded: false,
      owned: new Set(),
      included: new Map(),
      layout: form.spec.kind === "card" ? [form.spec.key] : [],
      layoutSet: new Set(form.spec.kind === "card" ? [form.spec.key] : []),
      status: "loading",
      error: undefined,
      needsRefresh: false,
      hasNewRows: false,
      strategy: form.spec.kind === "full" ? "full" : undefined,
      truncated: false,
      atEnd: form.spec.kind === "full",
      waiters: [],
      dirty: true,
      // Знімок без утримання — той самий LOADING: перша підписка не дає
      // зайвого кадру з рівним знімком.
      snapshot: form.spec.kind === "card" ? undefined : LOADING,
      refViews: new Map(),
      readRevision: undefined,
      checkQueued: false,
    }
    subsets.set(form.specKey, s)
    return s
  }

  // ------------------------------------------------------------ знімки

  const viewOf = (o: ObjectState, key: Key) =>
    rowViews.get(o.name, key, o.rows.get(key), o.lazyFields)

  function computeSnapshot(s: Subset): ViewSnapshot {
    const closed = ctx.closedSnapshot()
    if (closed !== undefined) return closed
    const { form } = s
    const o = form.object
    const rows: RowView[] = []
    let section: ViewSnapshot["section"]
    const spec = form.spec
    if (spec.kind === "section") {
      const entry = o.sections.get(spec.owner, spec.section)
      section = {
        ownerVersion: entry?.ownerVersion,
        complete: entry?.complete ?? false,
        lines: entry?.lines ?? NO_LINES,
      }
    } else {
      const refViews = new Map<Key, RowView>()
      for (const key of s.layout) {
        const base = viewOf(o, key)
        if (base === undefined) continue
        if (form.include.length === 0 || base.state === "removed") {
          rows.push(base)
          continue
        }
        const refs = refsOf(form.include, base.values, (name, k) =>
          viewOf(ctx.objectOf(name), k)
        )
        const shown = withRefs(base, refs, s.refViews.get(key))
        refViews.set(key, shown)
        rows.push(shown)
      }
      s.refViews = refViews
    }
    // `loading` — лише без даних (§6.5): картка зі сховища — одразу рядок.
    const data = rows.length > 0 || section?.ownerVersion !== undefined
    return shareSnapshot(s.snapshot, {
      status: s.status === "loading" && data ? "refreshing" : s.status,
      ...(s.error === undefined ? {} : { error: s.error }),
      rows,
      hasNewRows: s.hasNewRows,
      needsRefresh: s.needsRefresh,
      ...(section === undefined ? {} : { section }),
      ...(spec.kind === "full"
        ? { strategy: s.strategy, truncated: s.truncated, atEnd: s.atEnd }
        : {}),
    })
  }

  function snapshotOf(s: Subset): ViewSnapshot {
    if (s.dirty || s.snapshot === undefined) {
      s.snapshot = computeSnapshot(s)
      s.dirty = false
    }
    return s.snapshot
  }

  function affected(s: Subset): boolean {
    const o = s.form.object
    const rows = rowViews.dirty()
    const spec = s.form.spec
    if (spec.kind === "section") {
      return (
        ctx.dirtySections().get(o.name)?.has(spec.owner) === true ||
        rows.get(o.name)?.has(spec.owner) === true
      )
    }
    const own = rows.get(o.name)
    if (own !== undefined) {
      for (const key of own) if (s.layoutSet.has(key)) return true
    }
    // Цілі `include`: зміна будь-якого рядка цільового об'єкта.
    return s.form.include.some((step) => (rows.get(step.target)?.size ?? 0) > 0)
  }

  function queueCheck(s: Subset) {
    if (s.checkQueued || headerKey(s) === undefined) return
    s.checkQueued = true
    // Не з середини сповіщення: дочитування — власний `commit`.
    queueMicrotask(() => {
      s.checkQueued = false
      if (!isClosed()) check(s)
    })
  }

  // ------------------------------------------------------------ хендли

  function idleSnapshot(
    form: Form,
    prev: { snapshot?: ViewSnapshot }
  ): ViewSnapshot {
    const spec = form.spec
    if (spec.kind !== "card") return LOADING
    // Картка без утримання показує рядок зі сховища, якщо він є (§6.5).
    const row = viewOf(form.object, spec.key)
    if (row === undefined) return LOADING
    prev.snapshot = shareSnapshot(prev.snapshot, {
      status: "ready",
      rows: [row],
      hasNewRows: false,
      needsRefresh: false,
    })
    return prev.snapshot
  }

  const closedHandle = (): ViewHandle => ({
    getSnapshot: () => ctx.closedSnapshot()!,
    subscribe: () => () => {},
    refresh() {},
    showNew() {},
  })

  function makeHandle(form: Form): ViewHandle {
    const idleCache: { snapshot?: ViewSnapshot } = {}
    const live = () => subsets.get(form.specKey)
    return {
      getSnapshot() {
        const closed = ctx.closedSnapshot()
        if (closed !== undefined) return closed
        const s = live()
        return s === undefined ? idleSnapshot(form, idleCache) : snapshotOf(s)
      },
      subscribe(listener) {
        if (isClosed()) return () => {}
        const s = acquire(form)
        const entry = { fn: listener }
        s.listeners.add(entry)
        if (s.releaseTimer !== undefined) clearTimeout(s.releaseTimer)
        s.releaseTimer = undefined
        // Перша підписка знімає утримання `preload`.
        s.preloads = 0
        for (const timer of s.preloadTimers) clearTimeout(timer)
        s.preloadTimers.clear()
        start(s, true)
        let done = false
        return () => {
          if (done) return
          done = true
          s.listeners.delete(entry)
          if (s.alive && idle(s) && !isClosed()) scheduleRelease(s)
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
    }
  }

  return {
    view(spec) {
      if (isClosed()) return closedHandle()
      const form = formOf(spec)
      const found = handles.get(form.specKey)
      if (found !== undefined) {
        handles.delete(form.specKey)
        handles.set(form.specKey, found)
        return found
      }
      const handle = makeHandle(form)
      handles.set(form.specKey, handle)
      if (handles.size > limits.viewsMax) {
        const oldest = handles.keys().next()
        if (!oldest.done) handles.delete(oldest.value)
      }
      return handle
    },

    preload(spec, options) {
      if (isClosed()) return Promise.resolve()
      const s = acquire(formOf(spec))
      if (s.listeners.size === 0) {
        s.preloads++
        if (s.releaseTimer !== undefined) clearTimeout(s.releaseTimer)
        s.releaseTimer = undefined
        const timer = setTimeout(() => {
          s.preloadTimers.delete(timer)
          if (!s.alive || s.preloads === 0) return
          s.preloads--
          if (idle(s)) release(s)
        }, options?.ttlMs ?? limits.preloadTtlMs)
        s.preloadTimers.add(timer)
      }
      start(s, false)
      if (s.settled || !s.alive) return Promise.resolve()
      return new Promise((resolve) => s.waiters.push(resolve))
    },

    subsets: () => subsets.values(),
    load,

    afterCommit(closing) {
      const notify: Subset[] = []
      for (const s of subsets.values()) {
        if (!closing && !s.dirty && !affected(s)) continue
        s.dirty = true
        if (s.listeners.size === 0) continue
        const before = s.snapshot
        if (snapshotOf(s) !== before) notify.push(s)
        if (!closing) queueCheck(s)
      }
      return notify
    },

    close() {
      for (const s of subsets.values()) {
        s.alive = false
        s.listeners.clear()
        cancelTimers(s)
        resolveWaiters(s)
      }
      subsets.clear()
      handles.clear()
    },
  }
}
