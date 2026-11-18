import { ZERO_UUID, channelTopic, type CatalogEntry } from "simetra/model"
import type { Defects } from "./defects"
import { effectiveEpoch, heldEpoch } from "./epoch"
import type { ObjectState } from "./forms"
import { includeKeys, readIncluded } from "./include"
import { visibleRow, type RowEntry } from "./object-store"
import {
  applyIncluded,
  fetchFull,
  gated,
  readFormWrite,
  type Apply,
  type ReaderContext,
  type Write,
} from "./readers"
import {
  dropKeys,
  keysOfPages,
  rereadPages,
  cursorOf,
  type WindowCursor,
  type WindowPage,
} from "./window"
import { DISCARD_PAUSE_MS, type Scope, type Session } from "./session"
import type { RowViews } from "./snapshot"
import { ReadLimiterClosed, readKeys, tracked } from "./source"
import {
  EPOCH_UNAVAILABLE,
  errorOf,
  type Subset,
  type SubsetRegistry,
} from "./subsets"
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
  /** Deliberate defects of the model test's self-check. */
  readonly defects: Defects
  /** The monotonic clock in ms (`performance.now()`; a test substitutes it). */
  readonly now: () => number
  /**
   * Keys `Writer.hide` hid, by object: the core re-reads the views that hold
   * them once the `commit` ends (`revalidateHolders`), not inside it.
   */
  readonly hiddenKeys: Map<ObjectName, Set<Key>>
  /**
   * The mutation journal: a purge erases the fields of the mutations it
   * touches in the same `commit` (plan B3-4-Л Р11).
   */
  readonly journal: {
    erase(object: ObjectName, key: Key): void
    eraseScope(object: ObjectName, scope: string | null): void
  }
}

/** The longest wait for a re-read the journal settles a mutation by (§7.2 step 4). */
export const REREAD_TIMEOUT_MS = 5_000

/**
 * The outcome of a re-read by key (plan B3-4-Л Р4): `read` — the answer
 * passed the epoch gate (`row` — the key's row, `undefined` when absent);
 * `failed` — the read failed or ran out of {@link REREAD_TIMEOUT_MS};
 * `discarded` — the answer came from an abandoned version epoch.
 */
export type RereadOutcome =
  | { readonly kind: "read"; readonly row: ServerRow | undefined }
  | { readonly kind: "failed" | "discarded" }

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
      if (!ctx.defects.has("purge-keeps-views")) {
        const any = ctx.defects.has("purge-marks-unrelated-views")
        if (spec.kind === "card" && (any || purged.has(spec.key)))
          s.purged = true
        if (spec.kind === "section" && (any || purged.has(spec.owner)))
          s.purged = true
      }
      s.owned = without(s.owned, dropped)
      if (
        spec.kind === "keys" ||
        spec.kind === "full" ||
        spec.kind === "window"
      ) {
        s.layout = s.layout.filter((key) => !dropped.has(key))
        s.layoutSet = new Set(s.layout)
        if (s.window !== undefined) s.window = dropKeys(s.window, dropped)
      }
    }
    const included = s.included.get(o.name)
    if (included !== undefined)
      s.included.set(o.name, without(included, dropped))
    if (own && s.form.include.length > 0) releaseTargets(ctx, scope, s)
    s.dirty = true
    // Читання сторінок вікна в польоті могло нести рядки, яких на мить
    // `purge` у сховищі не було: їхню відповідь відкинуто (Р9), наступну
    // сторінку читає дія користувача чи край списку.
    if ((own || target) && s.window !== undefined) s.paging.clear()
    if (
      (own || target) &&
      s.flight !== undefined &&
      !ctx.defects.has("purge-keeps-flights")
    ) {
      s.gen++
      s.trailing = true
    }
  }
}

// Запис відповіді приймача — лише через `Writer.apply`, після шлюзу епохи;
// поза цим модулем їх не викликає ніхто (`__tests__/writer-gate-guard.test.ts`).

/** Patches keys with an owner (§6.2): a signal brings no new key in. */
function patchRows(
  ctx: WriterContext,
  scope: Scope,
  o: ObjectState,
  rows: readonly ServerRow[],
  readEpoch: number,
  versionEpoch: string | null,
  lazyRead = false
) {
  for (const row of rows) {
    if ((o.rows.get(row.key)?.owners ?? 0) === 0) continue
    // Епоха рядка — епоха відповіді, яку щойно прийняла сесія.
    ctx.ops.put(
      scope,
      o,
      { ...row, versionEpoch: effectiveEpoch(versionEpoch, row.versionEpoch) },
      readEpoch,
      lazyRead
    )
  }
}

/** Keys the answer did not return become `removed` (§6.2, rule 5). */
function removeKeys(
  ctx: WriterContext,
  scope: Scope,
  o: ObjectState,
  keys: readonly Key[],
  readEpoch: number
) {
  for (const key of keys) ctx.ops.remove(scope, o, key, readEpoch)
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
    apply(object, answer, readEpoch, versionEpoch) {
      scope.assert()
      const o = ctx.objectOf(object)
      // Один шлюз на відповідь: і «рядка немає» без жодного рядка
      // проходить його, а відкинута відповідь не пише нічого й каже про це.
      // Шлюз бачить і епохи рядків: рядок пишеться з власною епохою, коли
      // параметр `null`, тож рядок покинутої епохи відкидає всю відповідь.
      const epochs = new Set<string | null>([versionEpoch])
      for (const row of answer.rows) epochs.add(row.versionEpoch ?? null)
      if (ctx.session.acceptEpochs(epochs, readEpoch) === "discard")
        return "discarded"
      patchRows(ctx, scope, o, answer.rows, readEpoch, versionEpoch)
      removeKeys(ctx, scope, o, answer.absent, readEpoch)
      return "applied"
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
      // Ключ, що переїхав у прибраний скоуп після старту спроби, прибрано
      // за збереженим скоупом: його поля стираються за ключем.
      if ("keys" in target)
        for (const key of target.keys) ctx.journal.erase(o.name, key)
      else {
        ctx.journal.eraseScope(o.name, target.scope)
        for (const key of dropped) ctx.journal.erase(o.name, key)
      }
      for (const key of [...purged, ...cleared]) ops.clearOwner(scope, o, key)
      for (const key of [...dropped, ...cleared]) rowViews.touch(o.name, key)
      forget(ctx, scope, o, new Set(dropped), new Set(purged))
      ctx.invalidateTail(o)
      ctx.purges.set(o.name, (ctx.purges.get(o.name) ?? 0) + 1)
    },

    writeBack(object, rows, epoch, readEpoch) {
      scope.assert()
      const o = ctx.objectOf(object)
      const skipped: Key[] = []
      for (const row of rows) {
        // Епоха рядка — епоха результату `run`, а не епоха читання; вона
        // непорожня, тож власна епоха рядка її не заміняє.
        const result = o.rows.writeBack(
          scope,
          { ...row, versionEpoch: effectiveEpoch(epoch, row.versionEpoch) },
          readEpoch
        )
        if (result === "skipped") skipped.push(row.key)
        else if (result === "written") rowViews.touch(o.name, row.key)
      }
      return skipped
    },

    hide(object, keys) {
      scope.assert()
      const o = ctx.objectOf(object)
      const hidden = o.rows.hideKeys(scope, keys)
      // Вигляд `section` ховає рядки ТЧ лише за позначкою шапки, а шапки в
      // сховищі може не бути (`disown`): збережені рядки ТЧ прибираємо самі
      // для кожного ключа, їх дочитує перечитування.
      for (const key of keys) ops.clearOwner(scope, o, key)
      for (const key of hidden) rowViews.touch(o.name, key)
      // ТЧ-підмножини сюди не входять: їх перечитує вигляд за правилом
      // свіжості (`sectionStale`) — на монтуванні, `preload` і після `commit`.
      if (hidden.length === 0) return
      const pending = ctx.hiddenKeys.get(o.name) ?? new Set<Key>()
      for (const key of hidden) pending.add(key)
      ctx.hiddenKeys.set(o.name, pending)
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

// Дефект самотесту «системне перечитування міняє склад»: склад будується
// заново за значеннями, як у завантаження.
function rebuildLayout(ctx: WriterContext, s: Subset) {
  if (!ctx.defects.has("reread-changes-layout")) return
  const { form } = s
  const live = s.layout.flatMap((key) => {
    const e = form.object.rows.get(key)
    const values = e === undefined ? undefined : visibleRow(e)
    return values !== undefined && form.test(values) ? [{ key, values }] : []
  })
  const compare = form.compare
  if (compare !== undefined) live.sort((a, b) => compare(a.values, b.values))
  s.layout = live.map((r) => r.key)
  s.layoutSet = new Set(s.layout)
}

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
): Write {
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
    if (s.form.spec.kind === "keys") rebuildLayout(ctx, s)
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
): Promise<Write> {
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
    // Цілі прочитано за складом на старті: склад змінило інше завантаження
    // (власник цілей — воно), тож застарілий список ключів їх би відібрав.
    const sameComposition =
      s.owned.size === composition.length &&
      composition.every((key) => s.owned.has(key))
    if (included !== undefined && sameComposition)
      applyIncluded(ctx, scope, s, included, startEpoch)
    if (fresh) s.hasNewRows = true
    if (outOfPlace(s) || [...moved].some((key) => s.layoutSet.has(key)))
      s.needsRefresh = true
    rebuildLayout(ctx, s)
  }
}

/**
 * The system re-read of a window (P4-B spec §6.4, plan B3-3, Р14): every
 * own page again by a keyset from its lower bound, all in one call of the
 * source, without `known`. The composition stays: a value goes to its place,
 * a key that is not in the pages of the answer is read by key — absent is
 * `removed`, present is `needsRefresh` (it moved) — and a key the window
 * does not hold is only `hasNewRows`. The result is written only while the
 * window is in the same chain and every page keeps the generation it was
 * read with (Р9).
 */
async function readWindowAgain(
  ctx: WriterContext,
  s: Subset,
  startEpoch: number,
  token: GenerationToken
): Promise<Write> {
  const { form } = s
  const o = form.object
  const start = s.window!
  const chain = start.chain
  // Вікно без сторінок (фільтр нічого не знайшов) теж читає початок порядку:
  // перший рядок там — новий.
  const pages: readonly Pick<WindowPage, "keys" | "lower" | "generation">[] =
    start.pages.length > 0
      ? start.pages
      : [{ keys: [], lower: { kind: "start" }, generation: 0 }]
  const answers = await rereadPages(
    ctx.source,
    form,
    pages.map((page) => page.lower),
    token,
    ctx.limits.windowPage
  )
  if (answers === undefined) return () => {}
  const got = new Map(answers.flat().map((row) => [row.key, row] as const))
  const composition = keysOfPages(start.pages)
  const missing = composition.filter((key) => !got.has(key))
  const moved =
    missing.length === 0
      ? []
      : await readKeys(ctx.source, o.entry, missing, {
          keysPerRequest: ctx.limits.keysPerRequest,
        })
  const found = new Map(moved.map((row) => [row.key, row] as const))
  // Останню сторінку, коли край порядку ще не прочитано, читають із запасом
  // до розміру сторінки: рядки відповіді після останнього її ключа, що
  // лишився у відповіді, лежать за завантаженим діапазоном (сторінку
  // скоротив purge) — вони не нові. Порядок — серверний, клієнт не сортує.
  const beyond = new Set<Key>()
  const lastPage = start.pages.at(-1)
  if (lastPage !== undefined && !s.atEnd) {
    const answer = answers[start.pages.length - 1]!
    const mine = new Set(lastPage.keys)
    const at = answer.map((row) => mine.has(row.key)).lastIndexOf(true)
    for (const row of at < 0 ? [] : answer.slice(at + 1)) beyond.add(row.key)
  }
  // Перший рядок сторінки `from` лежить на її межі: keyset читає строго
  // після неї, тож він «випадає» завжди. На місці, якщо сортувальні колонки
  // ті самі, що в курсора, — тоді це не переїзд.
  const orderBy = (form.spec as { orderBy?: Parameters<typeof cursorOf>[0] })
    .orderBy
  const boundary = new Map<Key, WindowCursor>(
    start.pages.flatMap((page) =>
      page.lower.kind === "from"
        ? [[page.lower.cursor.key, page.lower.cursor]]
        : []
    )
  )
  const inPlace = (row: ServerRow) => {
    const edge = boundary.get(row.key)
    if (edge === undefined) return false
    const now = cursorOf(orderBy ?? [], o.entry.keyName, row.values)
    return Object.keys(edge.values).every((name) =>
      Object.is(edge.values[name], now.values[name])
    )
  }
  const wanted = includeKeys(
    form.include,
    composition.flatMap((key) => {
      const row = got.get(key) ?? found.get(key)
      return row !== undefined && form.test(row.values) ? [row.values] : []
    })
  )
  const included =
    form.include.length === 0
      ? undefined
      : await readIncluded(
          ctx.source,
          form.include,
          wanted,
          ctx.limits.keysPerRequest
        )
  return (scope) => {
    const now = s.window
    if (now === undefined) return
    if (!ctx.defects.has("page-without-generation")) {
      // Токен читання (Р9): той самий ланцюжок і те саме покоління кожної
      // сторінки; інакше відповідь нічого не пише.
      if (now.chain !== chain) return
      const alive = new Set(now.pages.map((page) => page.generation))
      if (
        start.pages.length === 0
          ? now.pages.length > 0
          : !pages.every((page) => alive.has(page.generation))
      )
        return
    }
    let fresh = false
    for (const row of got.values()) {
      if (s.owned.has(row.key)) ctx.ops.put(scope, o, row, startEpoch, false)
      else if (!beyond.has(row.key)) fresh = true
    }
    let needsRefresh = false
    for (const key of composition) {
      if (!s.owned.has(key) || got.has(key)) continue
      const row = found.get(key)
      if (row === undefined) {
        ctx.ops.remove(scope, o, key, startEpoch)
        continue
      }
      ctx.ops.put(scope, o, row, startEpoch, false)
      if (!inPlace(row)) needsRefresh = true
    }
    if (included !== undefined)
      applyIncluded(ctx, scope, s, included, startEpoch, true)
    if (fresh) s.hasNewRows = true
    if (needsRefresh) s.needsRefresh = true
    rebuildLayout(ctx, s)
  }
}

function readAgain(
  ctx: WriterContext,
  s: Subset,
  startEpoch: number,
  token: GenerationToken
): Promise<Apply> {
  return gated(ctx, startEpoch, (c) => writeAgain(c, s, startEpoch, token))
}

async function writeAgain(
  ctx: WriterContext,
  s: Subset,
  startEpoch: number,
  token: GenerationToken
): Promise<Write> {
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
      return readFormWrite(ctx, s, startEpoch, token)
    case "full":
      return readFullAgain(ctx, s, startEpoch, token)
    case "window":
      return readWindowAgain(ctx, s, startEpoch, token)
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
  options: { visibleOnly: boolean; minAgeMs?: number }
): Promise<void> {
  const o = ctx.objectOf(object)
  // Єдина ознака закриття — токен сесії: він недійсний уже з `closing`, коли
  // слухач purge-пачки ще бачить `closed === undefined`.
  if (!ctx.session.token().valid) return
  // Вигляд без жодного завантаження складу не має: його перше читання —
  // завантаження, а не системне перечитування. ТЧ — лише змонтовані.
  const targets = subsetsOf(ctx, o).filter(
    (s) =>
      s.loaded &&
      (!options.visibleOnly || isVisible(s)) &&
      // Відмітка свіжості (Р10): без неї вигляд вважається простроченим.
      (options.minAgeMs === undefined ||
        ctx.defects.has("min-age-ignored") ||
        (ctx.defects.has("min-age-ignored-sections") &&
          s.form.spec.kind === "section") ||
        s.refreshedAt === undefined ||
        (!ctx.defects.has("min-age-all-young") &&
          ctx.now() - s.refreshedAt >= options.minAgeMs)) &&
      (s.form.spec.kind !== "section" || s.listeners.size > 0)
  )
  await revalidateViews(ctx, o, targets)
}

/**
 * The re-read of every view that holds one of the hidden keys, as an owned
 * row or an `include` target, invisible views included (plan B3-3, Р11): the
 * values return only with a read that started after the `hide`. A failed
 * read leaves them hidden. A view of another object that includes the
 * object is re-read as its own object's view. Tabular section subsets are
 * not re-read here: they go stale by the hide epoch of their owner.
 */
export async function revalidateHolders(
  ctx: WriterContext,
  object: ObjectName,
  keys: ReadonlySet<Key>
): Promise<void> {
  if (!ctx.session.token().valid) return
  const groups = new Map<ObjectState, Subset[]>()
  for (const s of ctx.registry.subsets()) {
    if (!s.alive || s.purged || !s.loaded) continue
    // ТЧ-підмножину перечитує сам вигляд за правилом свіжості
    // (`sectionStale`): один механізм для змонтованої, утримуваної й тієї,
    // чиє перше читання було в польоті.
    if (s.form.spec.kind === "section") continue
    const included = s.included.get(object)
    const holds =
      (s.form.object.name === object &&
        [...keys].some((k) => s.owned.has(k))) ||
      (included !== undefined && [...keys].some((k) => included.has(k)))
    if (!holds) continue
    const group = groups.get(s.form.object) ?? []
    group.push(s)
    groups.set(s.form.object, group)
  }
  await Promise.all(
    [...groups].map(([o, targets]) => revalidateViews(ctx, o, targets))
  )
}

/** One two-phase pass over `targets`; views dropped by a purge get another pass. */
async function revalidateViews(
  ctx: WriterContext,
  o: ObjectState,
  targets: readonly Subset[]
): Promise<void> {
  const { session } = ctx
  if (targets.length === 0 || !session.token().valid) return
  const startEpoch = session.epochs.now()
  const token = session.token()
  // Завантаження, що стартувало чи завершилось після старту, свіжіше за це
  // перечитування: воно вже оновило склад і цілі `include` (так само, як
  // purge відкидає відповіді).
  const loadsAtStart = new Map(
    targets.map((s) => [s, { gen: s.gen, flight: s.flight }] as const)
  )
  const startedAt = ctx.now()
  for (const s of targets) s.rereads++
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
  const discarded: Subset[] = []
  session.commit(
    (scope) => {
      try {
        for (const result of results) {
          const { s } = result
          if (!s.alive || s.purged) continue
          const atStart = loadsAtStart.get(s)
          if (atStart?.gen !== s.gen || atStart.flight !== s.flight) continue
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
            if (!result.apply(scope)) {
              // Відкинута відповідь: перечитування з паузою, а після
              // межі відкинутих поспіль — `command.unavailable`.
              if (session.versions.unavailable()) {
                s.status = "error"
                s.error = EPOCH_UNAVAILABLE
              } else discarded.push(s)
              continue
            }
            s.refreshedAt = startedAt
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
  // Цей прохід вичерпав межу (лічильник рухається після commit): повтору
  // не буде, відкинуті вигляди — `command.unavailable`.
  if (discarded.length > 0 && session.versions.unavailable()) {
    session.commit(
      () => {
        for (const s of discarded) {
          if (!s.alive || s.purged) continue
          s.status = "error"
          s.error = EPOCH_UNAVAILABLE
          s.dirty = true
        }
      },
      token,
      `revalidate ${o.name}`
    )
  } else if (discarded.length > 0) {
    const pause =
      DISCARD_PAUSE_MS * 2 ** Math.max(0, session.versions.discards() - 1)
    // Не чекаємо паузи: `revalidate` завершується, а повтор іде тим самим
    // системним шляхом (склад не змінюється).
    setTimeout(() => {
      revalidateViews(
        ctx,
        o,
        discarded.filter((s) => s.alive && !s.purged)
      ).catch((error: unknown) => ctx.log({ kind: "listener-failed", error }))
    }, pause)
  }
  // Дефект самотесту «системне перечитування через завантаження».
  if (ctx.defects.has("system-reread-via-load")) {
    for (const { s } of results) {
      if (s.alive && !s.purged) ctx.registry.load(s)
    }
  }
  // Вигляд із власним завантаженням у польоті (П12: його перезапускає purge)
  // оновить те завантаження; решта — новий прохід з новою епохою старту.
  await revalidateViews(
    ctx,
    o,
    again.filter((s) => s.alive && !s.purged && s.flight === undefined)
  )
}

/**
 * The re-read of one key after an own write (plan B3-4-Л Р4, the architect
 * answer to the re-read fork): by key through `readKeys` — the list form, or
 * the card form with lazy columns for a lazy-field edit — never a re-read of
 * the views that hold it. The answer passes the same epoch gate as
 * `Writer.apply` and is written with its start epoch only into slots with an
 * owner (`hidden` and tombstones hold); an absent key becomes `removed`.
 * `onCommit` runs once inside that `commit`; on a failure, a discarded answer
 * or after {@link REREAD_TIMEOUT_MS}, in a `commit` of its own. An answer
 * after the limit is still written. On a failure `unconfirmed` — the version
 * and epoch of an own write the store did not take — marks the key `stale`
 * (§7.2 step 4).
 */
export async function rereadKey(
  ctx: WriterContext,
  object: ObjectName,
  key: Key,
  options: {
    readonly form: "list" | "card"
    readonly unconfirmed?: { readonly version: number; readonly epoch: string }
    readonly onCommit?: (outcome: RereadOutcome, scope: Scope) => void
  }
): Promise<void> {
  const { form, unconfirmed, onCommit } = options
  const { session } = ctx
  if (!session.token().valid) return
  const o = ctx.objectOf(object)
  const startEpoch = session.epochs.now()
  const token = session.token()
  let done = false
  const fire = (outcome: RereadOutcome, scope: Scope) => {
    if (done) return
    done = true
    clearTimeout(timer)
    if (outcome.kind !== "read" && unconfirmed !== undefined) {
      o.rows.markUnconfirmed(scope, key, unconfirmed.version, unconfirmed.epoch)
      if (o.rows.get(key) !== undefined) ctx.rowViews.touch(o.name, key)
    }
    onCommit?.(outcome, scope)
  }
  // Межа часу (§7.2, крок 4): мутація не чекає перечитування без кінця.
  const timer = setTimeout(() => {
    if (done || !token.valid) return
    session.commit(
      (scope) => fire({ kind: "failed" }, scope),
      token,
      "reread timeout"
    )
  }, REREAD_TIMEOUT_MS)
  const read = tracked(ctx.source)
  let rows: readonly ServerRow[] | undefined
  try {
    rows = await readKeys(
      read.source,
      o.entry,
      [key],
      form === "card"
        ? { form: "card" }
        : { keysPerRequest: ctx.limits.keysPerRequest }
    )
  } catch {
    rows = undefined
  }
  if (!token.valid) {
    clearTimeout(timer)
    return
  }
  session.commit(
    (scope) => {
      if (rows === undefined) {
        fire({ kind: "failed" }, scope)
        return
      }
      // Шлюз відповіді — той самий, що в `Writer.apply`: епохи частин і
      // рядків; відкинута відповідь не пише нічого.
      const epochs = new Set<string | null>(read.epochs)
      for (const row of rows) epochs.add(row.versionEpoch ?? null)
      if (session.acceptEpochs(epochs, startEpoch) === "discard") {
        fire({ kind: "discarded" }, scope)
        return
      }
      patchRows(ctx, scope, o, rows, startEpoch, null, form === "card")
      const found = rows.find((r) => r.key.toLowerCase() === key.toLowerCase())
      if (found === undefined && (o.rows.get(key)?.owners ?? 0) > 0)
        removeKeys(ctx, scope, o, [key], startEpoch)
      // Підсумок несе рядок відповіді з його власною епохою, як він прийшов:
      // у сховище цей рядок уже записав `patchRows` за правилом епох.
      const answer =
        found === undefined
          ? undefined
          : { ...found, versionEpoch: heldEpoch(found.versionEpoch) }
      fire({ kind: "read", row: answer }, scope)
    },
    token,
    `reread ${o.name}`
  )
}
