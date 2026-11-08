import { ZERO_UUID, channelTopic, type CatalogEntry } from "simetra/model"
import type { ObjectState } from "./forms"
import { includeKeys, readIncluded } from "./include"
import { visibleRow, type RowEntry } from "./object-store"
import {
  applyIncluded,
  fetchFull,
  readForm,
  type Apply,
  type ReaderContext,
} from "./readers"
import type { Scope, Session } from "./session"
import type { RowViews } from "./snapshot"
import { ReadLimiterClosed, readKeys } from "./source"
import { errorOf, type Subset, type SubsetRegistry } from "./subsets"
import type {
  ActiveView,
  GenerationToken,
  Key,
  ObjectName,
  ServerRow,
  ViewSpec,
  Writer,
} from "./types"

/*
 * API ядра для приймача сигналів (спека П4-B §8.4 «Ядро дає приймачу»):
 * `Writer` усередині `commit`, `purge` як виняток безпеки (§6.5), позначки,
 * перелік активних виглядів і двофазний `revalidate` (§6.3). Кожне
 * перечитування за ключем іде через `readKeys` — єдиний шлях.
 */

/** What the writer and `revalidate` need from the core. */
export interface WriterContext extends ReaderContext {
  readonly session: Session
  readonly registry: SubsetRegistry
  readonly rowViews: RowViews
  readonly objects: ReadonlyMap<ObjectName, ObjectState>
  /**
   * The purge generation of each object, raised by every `Writer.purge`: a
   * `revalidate` that started before it drops its results (П12).
   */
  readonly purges: Map<ObjectName, number>
  /** Invalidates the tail re-read of the object in flight and re-queues its keys (П12). */
  invalidateTail(o: ObjectState): void
}

/**
 * The change channel of a row (§8.3): `channelTopic` of the scope kind, the
 * row's stored scope and the object id; an unscoped object takes
 * `ZERO_UUID` for both the kind and the scope.
 */
export function channelOf(entry: CatalogEntry): (e: RowEntry) => string {
  const scoped = entry.scopeColumn !== undefined
  const scopeKindId = scoped ? (entry.scopeKindId ?? ZERO_UUID) : ZERO_UUID
  return (e) =>
    channelTopic({
      kind: "changes",
      scopeKindId,
      scope: scoped ? (e.scope ?? ZERO_UUID) : ZERO_UUID,
      object: entry.id,
    })
}

const isVisible = (s: Subset) => s.visible ?? s.listeners.size > 0

/** Held, not purged subsets of the object. */
function subsetsOf(ctx: WriterContext, o: ObjectState): Subset[] {
  return [...ctx.registry.subsets()].filter(
    (s) => s.form.object === o && s.alive && !s.purged
  )
}

function without(set: ReadonlySet<Key>, gone: ReadonlySet<Key>): Set<Key> {
  return new Set([...set].filter((key) => !gone.has(key)))
}

/**
 * Releases the `include` targets no row of the view refers to any more: the
 * rows that referred to them were purged.
 */
function releaseTargets(ctx: WriterContext, scope: Scope, s: Subset) {
  const o = s.form.object
  const still = includeKeys(
    s.form.include,
    [...s.owned].flatMap((key) => {
      const values = o.rows.get(key)?.row?.values
      return values === undefined ? [] : [values]
    })
  )
  for (const [name, keys] of s.included) {
    const keep = new Set(still.get(name) ?? [])
    const target = ctx.objectOf(name)
    const next = new Set<Key>()
    for (const key of keys) {
      if (keep.has(key)) next.add(key)
      else ctx.ops.disown(scope, target, key)
    }
    s.included.set(name, next)
  }
}

/**
 * Drops purged keys from every subset (§6.5): ownership, composition and
 * `include` targets (also those only the purged rows referred to); a card or
 * section of a purged key becomes `purged`. Loads in flight that may carry
 * rows of the object are invalidated and re-run after the purge (П12): their
 * answer would bring a row that was not in the store at the purge moment.
 */
function forget(
  ctx: WriterContext,
  scope: Scope,
  o: ObjectState,
  dropped: ReadonlySet<Key>,
  purged: ReadonlySet<Key>
) {
  for (const s of ctx.registry.subsets()) {
    const spec = s.form.spec
    const own = s.form.object === o
    const target = s.form.include.some((step) => step.target === o.name)
    if (!own && !target && !s.included.has(o.name)) continue
    if (own) {
      if (spec.kind === "card" && purged.has(spec.key)) s.purged = true
      if (spec.kind === "section" && purged.has(spec.owner)) s.purged = true
      s.owned = without(s.owned, dropped)
      if (spec.kind === "keys" || spec.kind === "full") {
        s.layout = s.layout.filter((key) => !dropped.has(key))
        s.layoutSet = new Set(s.layout)
      }
    }
    const included = s.included.get(o.name)
    if (included !== undefined)
      s.included.set(o.name, without(included, dropped))
    if (own && s.form.include.length > 0) releaseTargets(ctx, scope, s)
    s.dirty = true
    if ((own || target) && s.flight !== undefined) {
      s.gen++
      s.trailing = true
    }
  }
}

/** The writer of one `commit`: every method refuses once the commit ended. */
export function createWriter(ctx: WriterContext, scope: Scope): Writer {
  const { ops, rowViews } = ctx

  function touchMarked(o: ObjectState, marked: (e: RowEntry) => boolean) {
    for (const key of o.rows.keys()) {
      if (marked(o.rows.get(key)!)) rowViews.touch(o.name, key)
    }
  }

  return {
    patch(object, rows, readEpoch) {
      scope.assert()
      const o = ctx.objectOf(object)
      // Перечитування лише латає ключі з власником (§6.2): нового ключа
      // сигнал у сховище не вносить.
      for (const row of rows) {
        if ((o.rows.get(row.key)?.owners ?? 0) > 0)
          ops.put(scope, o, row, readEpoch, false)
      }
    },

    remove(object, keys, readEpoch) {
      scope.assert()
      const o = ctx.objectOf(object)
      for (const key of keys) ops.remove(scope, o, key, readEpoch)
    },

    purge(object, target) {
      scope.assert()
      const o = ctx.objectOf(object)
      let dropped: Key[]
      let purged: Key[]
      // Власники, чиї рядки ТЧ прибрано, хоча їхня шапка доступна: вигляд ТЧ
      // не `purged`, а перечитує рядки (ревізія шапки змінюється нижче).
      let cleared: Key[] = []
      if ("keys" in target) {
        dropped = o.rows.purgeKeys(scope, target.keys)
        purged = [...target.keys]
      } else {
        // Пари ховає лише `purgeScope` (через `Epochs.buryPair`): власник ТЧ
        // з невідомим скоупом перевіряється за останнім похованням пари.
        dropped = o.rows.purgeScope(scope, target.scope)
        // Рядки ТЧ з невідомим скоупом прибираються на будь-якому purge
        // скоупу. Прибраним для своїх виглядів власник стає лише тоді, коли
        // шапки в сховищі немає (доступ не підтверджено); шапка в іншому
        // скоупі доступна — її картка й ТЧ не втрачають доступу хибно.
        const wiped = o.sections.purgeScope(scope, target.scope)
        const headerless = wiped.filter((key) => o.rows.get(key) === undefined)
        cleared = wiped.filter((key) => o.rows.get(key) !== undefined)
        purged = [...new Set([...dropped, ...headerless])]
      }
      // ТЧ записано зі скоупом шапки на мить запису: шапка, що відтоді
      // переїхала в прибраний скоуп, лишила б рядки ТЧ без `clearOwner`.
      for (const key of [...purged, ...cleared]) ops.clearOwner(scope, o, key)
      for (const key of [...dropped, ...cleared]) rowViews.touch(o.name, key)
      forget(ctx, scope, o, new Set(dropped), new Set(purged))
      ctx.invalidateTail(o)
      ctx.purges.set(o.name, (ctx.purges.get(o.name) ?? 0) + 1)
    },

    markStale(object, keys, minVersion) {
      scope.assert()
      const o = ctx.objectOf(object)
      o.rows.markStale(scope, keys, minVersion)
      for (const key of keys) {
        if (o.rows.get(key) !== undefined) rowViews.touch(o.name, key)
      }
    },

    markDisconnected(channel) {
      scope.assert()
      for (const o of ctx.objects.values()) {
        const of = channelOf(o.entry)
        o.rows.markDisconnected(scope, of, channel)
        touchMarked(o, (e) => channel === undefined || of(e) === channel)
      }
    },

    clearDisconnected(channel) {
      scope.assert()
      for (const o of ctx.objects.values()) {
        touchMarked(o, (e) => e.stale.disconnect?.has(channel) === true)
        o.rows.clearDisconnected(scope, channel)
      }
    },

    markViews(object, flags, spec) {
      scope.assert()
      const o = ctx.objectOf(object)
      const found = spec === undefined ? undefined : ctx.registry.find(spec)
      const targets =
        spec === undefined
          ? subsetsOf(ctx, o)
          : found !== undefined && found.form.object === o && !found.purged
            ? [found]
            : []
      for (const s of targets) {
        if (flags.needsRefresh !== undefined)
          s.needsRefresh = flags.needsRefresh
        if (flags.hasNewRows !== undefined) s.hasNewRows = flags.hasNewRows
        s.dirty = true
      }
    },
  }
}

/** Active views of the object, visible first (§8.4). */
export function activeViews(
  ctx: WriterContext,
  object: ObjectName
): ActiveView[] {
  const views = subsetsOf(ctx, ctx.objectOf(object)).map((s) => {
    const spec = s.form.spec
    const keys =
      spec.kind === "card"
        ? [spec.key]
        : spec.kind === "section"
          ? [spec.owner]
          : [...s.layout]
    return { spec, keys, visible: isVisible(s) }
  })
  return [...views.filter((v) => v.visible), ...views.filter((v) => !v.visible)]
}

/** Sets the visibility of a held view; a form without a held subset is ignored. */
export function setVisible(
  ctx: WriterContext,
  spec: ViewSpec,
  visible: boolean
) {
  const s = ctx.registry.find(spec)
  if (s !== undefined) s.visible = visible
}

// ------------------------------------------------------------ revalidate

/**
 * Перечитування вигляду за правилом стабільності (§6.5): `apply` пише лише
 * ключі складу на мить `commit`, зниклі — `removed` з епохою старту, ключі
 * поза складом лише ставлять `hasNewRows`.
 */
function applyKeys(
  ctx: WriterContext,
  s: Subset,
  requested: readonly Key[],
  rows: readonly ServerRow[],
  startEpoch: number,
  marksNew: boolean
): Apply {
  const o = s.form.object
  return (scope) => {
    const got = new Set<Key>()
    let fresh = false
    for (const row of rows) {
      got.add(row.key)
      if (s.owned.has(row.key)) ctx.ops.put(scope, o, row, startEpoch, false)
      else fresh = true
    }
    for (const key of requested) {
      if (!got.has(key) && s.owned.has(key))
        ctx.ops.remove(scope, o, key, startEpoch)
    }
    if (fresh && marksNew) s.hasNewRows = true
  }
}

/** A composition row out of the filter or the order: the list changed (§6.5). */
function outOfPlace(s: Subset): boolean {
  const { form } = s
  let prev: ReturnType<typeof visibleRow>
  for (const key of s.layout) {
    const e = form.object.rows.get(key)
    const values = e === undefined ? undefined : visibleRow(e)
    if (values === undefined) continue
    if (!form.test(values)) return true
    // Вікно понад межу тримає серверний порядок: локальний компаратор міг
    // би розійтися з ним у колації.
    if (form.compare !== undefined && !s.truncated && prev !== undefined) {
      if (form.compare(prev, values) > 0) return true
    }
    prev = values
  }
  return false
}

async function readFullAgain(
  ctx: WriterContext,
  s: Subset,
  startEpoch: number,
  token: GenerationToken
): Promise<Apply> {
  const { form } = s
  const o = form.object
  const { keysPerRequest } = ctx.limits
  const fetched = await fetchFull(ctx, form, token)
  if (fetched === undefined) return () => {}
  const got = new Map(fetched.rows.map((r) => [r.key, r] as const))
  const composition = [...s.owned]
  // Ключ складу, якого немає у сторінках, не обов'язково зник: рядок міг
  // змінити поле сортування між читаннями сторінок і проскочити keyset.
  // Підтверджуємо за ключем; лише відсутній — `removed` (§6.2, правило 5).
  const missing = composition.filter((k) => !got.has(k))
  const moved = new Set<Key>()
  if (missing.length > 0) {
    const rows = await readKeys(ctx.source, o.entry, missing, {
      keysPerRequest,
    })
    for (const row of rows) {
      got.set(row.key, row)
      moved.add(row.key)
    }
  }
  // Понад межу вікно тримає лише початок серверного порядку: нові — лише
  // рядки до останнього ключа складу, решта — просто поза вікном.
  const order = new Map(fetched.rows.map((r, i) => [r.key, i] as const))
  let cut = fetched.rows.length
  if (fetched.over) {
    cut = -1
    fetched.rows.forEach((r, i) => {
      if (s.layoutSet.has(r.key)) cut = i
    })
  }
  const wanted = includeKeys(
    form.include,
    composition.flatMap((key) => {
      const row = got.get(key)
      return row !== undefined && form.test(row.values) ? [row.values] : []
    })
  )
  const included =
    form.include.length === 0
      ? undefined
      : await readIncluded(ctx.source, form.include, wanted, keysPerRequest)
  return (scope) => {
    let fresh = false
    for (const row of got.values()) {
      if (s.owned.has(row.key)) {
        ctx.ops.put(scope, o, row, startEpoch, false)
        const e = o.rows.get(row.key)
        const values = e === undefined ? undefined : visibleRow(e)
        // Рядок у власності, але поза складом, увійшов у фільтр — новий.
        if (!s.layoutSet.has(row.key) && values !== undefined)
          fresh ||= form.test(values)
      } else if ((order.get(row.key) ?? Infinity) < cut)
        fresh ||= form.test(row.values)
    }
    for (const key of composition) {
      if (!got.has(key) && s.owned.has(key))
        ctx.ops.remove(scope, o, key, startEpoch)
    }
    if (included !== undefined)
      applyIncluded(ctx, scope, s, included, startEpoch)
    if (fresh) s.hasNewRows = true
    if (outOfPlace(s) || [...moved].some((key) => s.layoutSet.has(key)))
      s.needsRefresh = true
  }
}

async function readAgain(
  ctx: WriterContext,
  s: Subset,
  startEpoch: number,
  token: GenerationToken
): Promise<Apply> {
  const spec = s.form.spec
  const o = s.form.object
  const { keysPerRequest } = ctx.limits
  switch (spec.kind) {
    case "keys": {
      const rows = await readKeys(ctx.source, o.entry, s.form.keys, {
        keysPerRequest,
      })
      return applyKeys(ctx, s, s.form.keys, rows, startEpoch, true)
    }
    case "card": {
      // Шапка списочною формою; ліниві поля змонтованої картки дочитує
      // перевірка вигляду, коли версія рядка зросла (§6.2, правило 2).
      // Картка не має дії «показати нові»: `hasNewRows` їй не ставимо.
      const rows = await readKeys(ctx.source, o.entry, [spec.key], {
        keysPerRequest,
      })
      return applyKeys(ctx, s, [spec.key], rows, startEpoch, false)
    }
    case "section":
      return readForm(ctx, s, startEpoch, token)
    case "full":
      return readFullAgain(ctx, s, startEpoch, token)
  }
}

/**
 * The system re-read of the object's views (§8.4), in two phases (§6.3):
 * every read first — through the shared limiter — then one `commit` applying
 * every result to the composition at commit time. A failed read sets its
 * view to `error` and stops no other view. Disconnect marks stay. Views that
 * never loaded are skipped. A purge of the object (or of an `include`
 * target) after the start drops the results and re-runs the re-read of those
 * views with a new start epoch, composition kept; a view whose own load was
 * invalidated by the purge is refreshed by that load instead (П12).
 */
export async function revalidate(
  ctx: WriterContext,
  object: ObjectName,
  options: { visibleOnly: boolean }
): Promise<void> {
  const o = ctx.objectOf(object)
  if (ctx.session.closed !== undefined) return
  // Вигляд без жодного завантаження складу не має: його перше читання —
  // завантаження, а не системне перечитування. ТЧ — лише змонтовані.
  const targets = subsetsOf(ctx, o).filter(
    (s) =>
      s.loaded &&
      (!options.visibleOnly || isVisible(s)) &&
      (s.form.spec.kind !== "section" || s.listeners.size > 0)
  )
  await revalidateViews(ctx, o, targets)
}

/** One two-phase pass over `targets`; views dropped by a purge get another pass. */
async function revalidateViews(
  ctx: WriterContext,
  o: ObjectState,
  targets: readonly Subset[]
): Promise<void> {
  const { session } = ctx
  if (targets.length === 0 || session.closed !== undefined) return
  const startEpoch = session.epochs.now()
  const token = session.token()
  const purgesAtStart = new Map(ctx.purges)
  const purgedSince = (name: ObjectName) =>
    (ctx.purges.get(name) ?? 0) !== (purgesAtStart.get(name) ?? 0)
  const results = await Promise.all(
    targets.map((s) =>
      readAgain(ctx, s, startEpoch, token).then(
        (apply) => ({ s, apply }) as const,
        (error: unknown) => ({ s, error }) as const
      )
    )
  )
  const again: Subset[] = []
  session.commit(
    (scope) => {
      try {
        for (const result of results) {
          const { s } = result
          if (!s.alive || s.purged) continue
          // purge після старту: відповідь могла нести рядки й рядки ТЧ, яких
          // на мить purge у сховищі не було (рядок у сховищі ще в старому
          // скоупі). Відкидаємо й перечитуємо тим самим системним шляхом:
          // склад і порядок змінює лише сам purge (§6.5), а не перечитування.
          if (
            purgedSince(o.name) ||
            s.form.include.some((step) => purgedSince(step.target))
          ) {
            again.push(s)
            continue
          }
          s.dirty = true
          if ("error" in result) {
            // Закритий обмежувач — сесію закрито: писати нікуди.
            if (result.error instanceof ReadLimiterClosed) continue
            s.status = "error"
            s.error = errorOf(result.error)
            continue
          }
          try {
            result.apply(scope)
            if (s.status === "error") {
              s.status = "ready"
              s.error = undefined
            }
          } catch (error) {
            ctx.log({ kind: "listener-failed", error })
            s.status = "error"
            s.error = errorOf(error)
          }
        }
      } finally {
        ctx.ops.sweep(scope)
      }
    },
    token,
    `revalidate ${o.name}`
  )
  // Вигляд із власним завантаженням у польоті (П12: його перезапускає purge)
  // оновить те завантаження; решта — новий прохід з новою епохою старту.
  await revalidateViews(
    ctx,
    o,
    again.filter((s) => s.alive && !s.purged && s.flight === undefined)
  )
}
