import {
  CommandFailure,
  type CatalogIndex,
  type CommandError,
} from "simetra/model"
import { DataError } from "../errors"
import { formOf, type Form, type ObjectState } from "./forms"
import { refsOf } from "./include"
import { lazyFieldStale } from "./object-store"
import { sectionLinesStale } from "./section-store"
import { diffOwn, readForm, type ReaderTarget, type StoreOps } from "./readers"
import type { Session } from "./session"
import {
  LOADING,
  purgedSnapshot,
  shareSnapshot,
  withRefs,
  type RowViews,
} from "./snapshot"
import { ReadLimiterClosed, type CoreSource } from "./source"
import type {
  CoreLimits,
  CoreLogEntry,
  Key,
  ObjectName,
  RowView,
  SectionLine,
  ViewHandle,
  ViewSnapshot,
  ViewSpec,
} from "./types"

/*
 * Реєстр виглядів (спека П4-B §6.1 «Вигляди й форми підмножин», §6.2, §6.3):
 * мемо хендлів за канонічним ключем форми, утримання (підписка, `preload`)
 * зі звільненням через `releaseDelayMs`, межа утриманих форм, single-flight
 * з одним хвостовим запитом і знімки виглядів. Форми — `forms.ts`, читання
 * форм — `readers.ts`.
 */

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

type Timer = ReturnType<typeof setTimeout>

/** A held view form. */
export interface Subset extends ReaderTarget {
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
  status: "loading" | "ready" | "refreshing" | "error"
  error: CommandError | DataError | undefined
  needsRefresh: boolean
  hasNewRows: boolean
  waiters: Array<() => void>
  dirty: boolean
  snapshot: ViewSnapshot | undefined
  refViews: Map<Key, RowView>
  /** The header revision at the start of the last card or section read. */
  readRevision: number | undefined
  checkQueued: boolean
  /** A re-read check found a load in flight: check again when it ends. */
  recheck: boolean
  /**
   * The key (card) or owner (section) was purged (§6.5): the view shows
   * `purged` and reads nothing until released.
   */
  purged: boolean
  /** Set by `setVisible`; unset — visible while subscribed. */
  visible: boolean | undefined
}

/** The view registry of a core. */
export interface SubsetRegistry {
  view(spec: ViewSpec): ViewHandle
  preload(spec: ViewSpec, options?: { ttlMs?: number }): Promise<void>
  subsets(): Iterable<Subset>
  /** The held subset of a form, if any; throws on a refused form as `view` does. */
  find(spec: ViewSpec): Subset | undefined
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

const NO_LINES: readonly SectionLine[] = Object.freeze([])
const ACCESS_CHANGED = purgedSnapshot("access-changed")

/** The error a view shows for a failed read. */
export const errorOf = (error: unknown): CommandError | DataError => {
  if (error instanceof CommandFailure) return error.error
  if (error instanceof DataError) return error
  return { code: "command.internal" }
}

export function createRegistry(ctx: RegistryContext): SubsetRegistry {
  const { session, limits, ops, rowViews } = ctx
  const subsets = new Map<string, Subset>()
  // Мемо хендлів з межею: хендл шукає підмножину за ключем форми, тож новий
  // хендл після витіснення під'єднується до тієї самої підмножини.
  const handles = new Map<string, ViewHandle>()
  // Кеш знімка картки без утримання — на хендл мемо; закриття його чистить.
  const idleCaches = new Map<string, { snapshot?: ViewSnapshot }>()
  const isClosed = () => ctx.closedSnapshot() !== undefined

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
    if (!s.alive || isClosed() || s.purged) return
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
    readForm(ctx, s, readEpoch, token)
      .then(
        (apply) => {
          session.commit(
            (scope) => {
              try {
                apply(scope)
                s.loaded = true
                s.status = "ready"
                s.error = undefined
                s.needsRefresh = false
                s.hasNewRows = false
              } catch (error) {
                // Дефект застосування — вигляд у `error`, рядки без власника
                // прибирає `sweep`; відмова не стає необробленою.
                ctx.log({ kind: "listener-failed", error })
                s.status = "error"
                s.error = errorOf(error)
              } finally {
                ops.sweep(scope)
                s.dirty = true
              }
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
        // Шапка змінилась під час польоту: перевірка, відкладена до кінця
        // читання, не губиться (захист ревізією — від повторів).
        if (s.recheck) {
          s.recheck = false
          if (s.alive && !isClosed() && s.listeners.size > 0) queueCheck(s)
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
      (f) => !Object.hasOwn(values, f) || lazyFieldStale(e, f)
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
    return lines === undefined || sectionLinesStale(lines, e)
  }

  /**
   * Дочитування змонтованого вигляду (§6.2, правило 2): лише коли шапка
   * змінилась після останнього читання — відкинута відповідь не крутить
   * повторів.
   */
  function check(s: Subset) {
    if (!s.alive || s.listeners.size === 0 || s.purged) return
    if (s.flight !== undefined) {
      s.recheck = true
      return
    }
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
          s.owned = diffOwn(ops, scope, s.form.object, s.owned, [spec.key])
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
      recheck: false,
      purged: false,
      visible: undefined,
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
    if (s.purged) return ACCESS_CHANGED
    const { form } = s
    const o = form.object
    const rows: RowView[] = []
    let section: ViewSnapshot["section"]
    const spec = form.spec
    if (spec.kind === "section") {
      const entry = o.sections.get(spec.owner, spec.section)
      const header = viewOf(o, spec.owner)
      // Власник `removed` чи схований горизонтом рядків не показує: у
      // другому випадку вони лишаються в сховищі, а вирішує хвіст (Р36).
      const hidden =
        header?.state === "removed" ||
        o.rows.get(spec.owner)?.stale.seen !== undefined
      section = {
        ownerVersion: hidden ? undefined : entry?.ownerVersion,
        complete: hidden ? false : (entry?.complete ?? false),
        lines: hidden ? NO_LINES : (entry?.lines ?? NO_LINES),
        // Без шапки в сховищі стан власника невідомий.
        ownerState: header?.state ?? "unknown",
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
    idleCaches.set(form.specKey, idleCache)
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
      const form = formOf(ctx, spec)
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
        if (!oldest.done) {
          handles.delete(oldest.value)
          // Хендл поза мемо тримає лише власний кеш; закриття його не бачить.
          idleCaches.delete(oldest.value)
        }
      }
      return handle
    },

    preload(spec, options) {
      if (isClosed()) return Promise.resolve()
      const s = acquire(formOf(ctx, spec))
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
    find: (spec) => subsets.get(formOf(ctx, spec).specKey),
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
      // Жодне значення рядка не переживає закриття навіть у пам'яті
      // підмножин чи хендлів, на які ще тримають посилання.
      for (const s of subsets.values()) {
        s.alive = false
        s.listeners.clear()
        cancelTimers(s)
        resolveWaiters(s)
        s.snapshot = undefined
        s.refViews.clear()
        s.owned = new Set()
        s.included = new Map()
        s.layout = []
        s.layoutSet = new Set()
      }
      for (const cache of idleCaches.values()) delete cache.snapshot
      idleCaches.clear()
      subsets.clear()
      handles.clear()
    },
  }
}
