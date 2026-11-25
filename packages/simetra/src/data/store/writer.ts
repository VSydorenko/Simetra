import { failureOf, type Attempts, type SettleDetail } from "./attempts"
import type { Defects } from "./defects"
import { effectiveEpoch, heldEpoch, pairId } from "./epoch"
import type { ObjectState } from "./forms"
import {
  completeIncluded,
  includeKeys,
  readIncluded,
  type Included,
} from "./include"
import {
  changesObjectOf,
  channelOf,
  scopeOf,
  visibleRow,
  type RowEntry,
} from "./object-store"
import {
  aliveIncluded,
  applyIncluded,
  fetchFullAgain,
  gated,
  readFormWrite,
  requireConfirmation,
  type Apply,
  type ReaderHost,
  type Write,
  type WithSource,
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
import {
  ReadLimiterClosed,
  readKeys,
  settle,
  tracked,
  type BoundSource,
} from "./source"
import {
  EPOCH_UNAVAILABLE,
  errorOf,
  queueTrailing,
  settleRequirement,
  viewDueAt,
  type Subset,
  type SubsetRegistry,
} from "./subsets"
import type { Flight } from "./sync/flight"
import type { ReadCause, ReadWhy, SettleOutcome } from "./sync/vocabulary"
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
export interface WriterContext extends ReaderHost {
  readonly session: Session
  /**
   * Reads the view when its requirement «composition not confirmed» is
   * pending (`requirementPending`, P4-B spec §8.4, item 7).
   */
  readonly readRequirement: (s: Subset) => void
  /** The tab is visible (`suspend` / `resume`, §8.4). */
  readonly tabVisible: () => boolean
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
  /**
   * Called by every `Writer.purge` with its target: the signal receiver drops
   * the pending signals and re-reads of the purged pair or keys (§8.4).
   */
  onPurge(
    object: ObjectName,
    target: { keys: readonly Key[] } | { scope: string | null }
  ): void
  /** Deliberate defects of the model test's self-check. */
  readonly defects: Defects
  /** The monotonic clock in ms (`performance.now()`; a test substitutes it). */
  readonly now: () => number
  /** Diagnostics of the attempts to read a view (the `watchAttempts` events). */
  readonly attempts: Attempts
  /**
   * Write leases on rows of the object (§8.4, rule 2): a read issues one at
   * dispatch by its parts (own rows, `include` targets, receiver keys,
   * pages); the flight's `settle` releases it after the answer's `commit`.
   */
  readonly pendingWrites: (object: ObjectName) => number
  /**
   * Keys `Writer.hide` hid, by object: the core re-reads the views that hold
   * them once the `commit` ends (`revalidateHolders`), not inside it.
   */
  readonly hiddenKeys: Map<ObjectName, Set<Key>>
  /**
   * Sets the due time of the object in the scheduler (`now + delayMs`): the
   * re-read of `views` (all visible views of the object when unset) waits for
   * the tick, and on a hidden tab for `resume()` (§8.4).
   */
  schedule(
    object: ObjectName,
    delayMs: number,
    cause: ReadCause,
    views?: ReadonlySet<Subset>
  ): void
  /**
   * The mutation journal: a purge erases the fields of the mutations it
   * touches in the same `commit`.
   */
  readonly journal: {
    erase(object: ObjectName, key: Key): void
    eraseScope(object: ObjectName, scope: string | null): void
  }
}

/** The context a flight's readers get: its source carries the flight. */
type BoundWriter = WithSource<WriterContext, BoundSource>

/** The longest wait for a re-read the journal settles a mutation by (§7.2 step 4). */
export const REREAD_TIMEOUT_MS = 5_000

/**
 * The outcome of a re-read by key: `read` — the answer
 * passed the epoch gate (`row` — the key's row, `undefined` when absent);
 * `failed` — the read failed or ran out of {@link REREAD_TIMEOUT_MS};
 * `discarded` — the answer came from an abandoned version epoch.
 */
export type RereadOutcome =
  | { readonly kind: "read"; readonly row: ServerRow | undefined }
  | { readonly kind: "failed" | "discarded" }

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
    // `purge` у сховищі не було: їхню відповідь відкинуто, наступну
    // сторінку читає дія користувача чи край списку.
    if ((own || target) && s.window !== undefined) s.paging.clear()
    if (
      (own || target) &&
      s.flight !== undefined &&
      !ctx.defects.has("purge-keeps-flights")
    ) {
      s.gen++
      // Наступне завантаження після purge — `mount` (спека §5.3).
      queueTrailing(s, { reason: "mount" })
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

  const objectOfChannel = (channel: string): ObjectState | undefined => {
    const id = changesObjectOf(channel)
    for (const o of ctx.objects.values()) if (o.entry.id === id) return o
    return undefined
  }

  // Запис відпущеного каналу забувається, лише коли сховище не тримає жодного
  // його рядка І жоден живий вигляд об'єкта не лишається ним непідтвердженим:
  // порожній вигляд, що пропустив створення в розриві, інакше став би свіжим.
  // Запис тримається і поки існує оренда на запис рядків об'єкта: її видає
  // читання за своїми частинами, а знімає `settle` польоту вже після `commit`
  // відповіді, тож між відповіддю й записом проміжку немає. Інакше рядок із
  // читання до відпускання проживе період без нагляду, а повторна підписка
  // нічого не позначить (§8.4, правило 2).
  const forgettable = (o: ObjectState, channel: string): boolean =>
    !o.rows.holdsChannel(channelOf(o.entry), channel) &&
    ctx.pendingWrites(o.name) === 0 &&
    subsetsOf(ctx, o).every((s) =>
      ctx.session.epochs.channelProven(channel, s.okReadEpoch ?? -1)
    )
  const forgetChannel = (channel: string) => {
    ctx.session.epochs.forget(channel)
    ctx.registry.forgetChannel(channel)
  }

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

    purge(object, target, options) {
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
      ctx.onPurge(o.name, target)
      // Прохід заміни знімка прав ховає пару надгробком і бар'єром: читання,
      // що стартували раніше, не принесуть її рядків, а відповіді для
      // дозволених пар чинні — повторювати їх не треба.
      if (options?.rights !== true)
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

    hideByHorizon(object, keys) {
      scope.assert()
      const o = ctx.objectOf(object)
      for (const key of o.rows.hideByHorizon(scope, keys))
        rowViews.touch(o.name, key)
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
      ctx.session.epochs.gap(channel)
      const id = channel === undefined ? undefined : changesObjectOf(channel)
      for (const o of ctx.objects.values()) {
        // Об'єкт без сигналів каналу не має: розрив його не стосується.
        if (!o.entry.signal || (id !== undefined && o.entry.id !== id)) continue
        const of = channelOf(o.entry)
        o.rows.markDisconnected(scope, of, channel)
        touchMarked(o, (e) => channel === undefined || of(e) === channel)
        // Склад вигляду (`staleComposition`) обчислює знімок: порожній
        // вигляд рядків для `touch` не має.
        for (const s of subsetsOf(ctx, o)) s.dirty = true
      }
    },

    holdChannel(channel) {
      scope.assert()
      const at = ctx.session.epochs.hold(channel)
      const o = objectOfChannel(channel)
      if (at === undefined || o === undefined) return
      // Відпущений канал, рядки якого лишились у сховищі, приєднується після
      // розриву: правки між відпусканням і підпискою сигналу не мали.
      const of = channelOf(o.entry)
      o.rows.markChannel(scope, of, channel, at)
      touchMarked(o, (e) => of(e) === channel)
      for (const s of subsetsOf(ctx, o)) s.dirty = true
    },

    releaseChannel(channel) {
      scope.assert()
      const { epochs } = ctx.session
      epochs.release(channel)
      const o = objectOfChannel(channel)
      if (o === undefined) return forgetChannel(channel)
      // Відпущений канал судить вигляд точково: склад міг змінитися.
      for (const s of subsetsOf(ctx, o)) s.dirty = true
      if (forgettable(o, channel)) forgetChannel(channel)
    },

    forgetReleased() {
      scope.assert()
      const { epochs } = ctx.session
      for (const channel of [...epochs.released()]) {
        const o = objectOfChannel(channel)
        if (o !== undefined && !forgettable(o, channel)) continue
        forgetChannel(channel)
        // Забутий канал вигляду більше не судить.
        if (o !== undefined) for (const s of subsetsOf(ctx, o)) s.dirty = true
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
        if (flags.unconfirmedSince !== undefined)
          requireConfirmation(s, flags.unconfirmedSince)
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
  if (s === undefined) return
  s.visible = visible
  // Знімок показує непідтверджений склад залежно від видимості (§8.4, п. 7).
  if (s.unconfirmedSince !== undefined) s.dirty = true
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

// Рядок пари, поховану з моменту старту читання (надгробок purge чи бар'єр
// знімка прав): його не пише ні `put`, ні він не «новий» для вигляду, бо
// `hasNewRows` виказав би, що заборонений рядок існує.
const lostSince = (
  ctx: WriterContext,
  o: ObjectState,
  row: ServerRow,
  startEpoch: number
) =>
  ctx.session.epochs.buriedSince(
    pairId(o.name, scopeOf(o.entry, row.values)),
    startEpoch
  )

// Вікна, чий прохід нічого не записав, бо purge прибрав їхню сторінку.
const pageDropped = new WeakSet<Subset>()

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
      else if (!lostSince(ctx, o, row, startEpoch)) fresh = true
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

/** The `known` of a re-read by keys of the view's own rows (§6.7). */
const listKnown = (s: Subset) => (keys: readonly Key[]) =>
  s.form.object.rows.knownFor(keys, { owned: s.owned, form: "list" })

/**
 * The system re-read of the `include` targets of a view (Р8а): a `keys` part
 * per target, started in the same tick as the parts of the view, so both go in
 * one request. The keys are the ones the view holds plus the ones its
 * composition rows refer to now: a target the view never held a row for (the
 * snapshot of a hydration keeps none; a target the reader may not see) would
 * otherwise wait for the answer and cost a request of its own at every
 * re-read. `known` goes only for held rows. The view's own parts carry no
 * `include`: targets would come back whole every time.
 */
function readHeldTargets(
  ctx: BoundWriter,
  s: Subset,
  composition: readonly Key[]
): Promise<Included> {
  const o = s.form.object
  const referred = includeKeys(
    s.form.include,
    composition.flatMap((key) => {
      const e = o.rows.get(key)
      const values = e === undefined ? undefined : visibleRow(e)
      return values !== undefined && s.form.test(values) ? [values] : []
    })
  )
  const wanted = new Map<ObjectName, readonly Key[]>(
    s.form.include.map(({ target }) => [
      target,
      [
        ...new Set([
          ...(s.included.get(target) ?? []),
          ...(referred.get(target) ?? []),
        ]),
      ],
    ])
  )
  return readIncluded(
    ctx.source,
    s.form.include,
    wanted,
    ctx.limits.keysPerRequest,
    (name) => (keys) =>
      ctx.objectOf(name).rows.knownFor(keys, {
        owned: s.included.get(name) ?? new Set<Key>(),
        form: "list",
      })
  )
}

async function readFullAgain(
  ctx: BoundWriter,
  s: Subset,
  startEpoch: number,
  token: GenerationToken
): Promise<Write> {
  const { form } = s
  const o = form.object
  const { keysPerRequest } = ctx.limits
  const [fetched, held] = await Promise.all([
    fetchFullAgain(ctx, form, token, s),
    readHeldTargets(ctx, s, [...s.owned]),
  ])
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
      known: listKnown(s),
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
  // Цілі з відповіді, яких вигляд ще не тримав, — частиною наступного пакета.
  const included =
    form.include.length === 0
      ? undefined
      : await completeIncluded(
          ctx.source,
          form.include,
          wanted,
          held,
          keysPerRequest
        )
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
      } else if (
        (order.get(row.key) ?? Infinity) < cut &&
        !lostSince(ctx, o, row, startEpoch)
      )
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
 * The system re-read of a window (P4-B spec §6.4): every
 * own page again by a keyset from its lower bound, all in one call of the
 * source, with the `known` of its own keys (§6.7). The composition stays: a value goes to its place,
 * a key that is not in the pages of the answer is read by key — absent is
 * `removed`, present is `needsRefresh` (it moved) — and a key the window
 * does not hold is only `hasNewRows`. The result is written only while the
 * window is in the same chain and every page keeps the generation it was
 * read with.
 */
async function readWindowAgain(
  ctx: BoundWriter,
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
  const [answers, held] = await Promise.all([
    rereadPages(
      ctx.source,
      form,
      pages,
      listKnown(s),
      token,
      ctx.limits.windowPage
    ),
    readHeldTargets(ctx, s, keysOfPages(start.pages)),
  ])
  if (answers === undefined) return () => {}
  const got = new Map(answers.flat().map((row) => [row.key, row] as const))
  const composition = keysOfPages(start.pages)
  const missing = composition.filter((key) => !got.has(key))
  const moved =
    missing.length === 0
      ? []
      : await readKeys(ctx.source, o.entry, missing, {
          keysPerRequest: ctx.limits.keysPerRequest,
          known: listKnown(s),
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
      : await completeIncluded(
          ctx.source,
          form.include,
          wanted,
          held,
          ctx.limits.keysPerRequest
        )
  return (scope) => {
    const now = s.window
    if (now === undefined) return
    if (!ctx.defects.has("page-without-generation")) {
      // Токен читання: той самий ланцюжок і те саме покоління кожної
      // сторінки; інакше відповідь нічого не пише.
      if (now.chain !== chain) return
      const alive = new Set(now.pages.map((page) => page.generation))
      if (
        start.pages.length === 0
          ? now.pages.length > 0
          : !pages.every((page) => alive.has(page.generation))
      ) {
        // Сторінку, що лишилась порожньою після purge, прибрано з тим самим
        // ланцюжком: прохід нічого не писав, тож його повторює `revalidateViews`.
        if (start.pages.length > 0) pageDropped.add(s)
        return
      }
    }
    let fresh = false
    for (const row of got.values()) {
      if (s.owned.has(row.key)) ctx.ops.put(scope, o, row, startEpoch, false)
      else if (!beyond.has(row.key) && !lostSince(ctx, o, row, startEpoch))
        fresh = true
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
  token: GenerationToken,
  flight: Flight
): Promise<Apply> {
  return gated(
    ctx,
    startEpoch,
    (c) => writeAgain(c, s, startEpoch, token),
    flight
  )
}

async function writeAgain(
  ctx: BoundWriter,
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
        known: listKnown(s),
      })
      return applyKeys(ctx, s, s.form.keys, rows, startEpoch, true)
    }
    case "card": {
      // Шапка списочною формою; ліниві поля змонтованої картки дочитує
      // перевірка вигляду, коли версія рядка зросла (§6.2, правило 2).
      // Картка не має дії «показати нові»: `hasNewRows` їй не ставимо.
      const [rows, held] = await Promise.all([
        readKeys(ctx.source, o.entry, [spec.key], {
          keysPerRequest,
          known: listKnown(s),
        }),
        readHeldTargets(ctx, s, [spec.key]),
      ])
      const write = applyKeys(ctx, s, [spec.key], rows, startEpoch, false)
      if (s.form.include.length === 0) return write
      const row = rows.find((r) => r.key === spec.key)
      const included = await completeIncluded(
        ctx.source,
        s.form.include,
        includeKeys(s.form.include, row === undefined ? [] : [row.values]),
        held,
        keysPerRequest
      )
      return (scope) => {
        write(scope)
        // Рядок, чий `put` відхилено, лишається `removed`: його цілей не беремо.
        const alive = o.rows.get(spec.key)?.removed === undefined
        applyIncluded(
          ctx,
          scope,
          s,
          aliveIncluded(
            included,
            includeKeys(
              s.form.include,
              alive && row !== undefined ? [row.values] : []
            )
          ),
          startEpoch
        )
      }
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
  options: RevalidateOptions
): Promise<void> {
  const o = ctx.objectOf(object)
  // Єдина ознака закриття — токен сесії: він недійсний уже з `closing`, коли
  // слухач purge-пачки ще бачить `closed === undefined`.
  if (!ctx.session.token().valid) return
  const targets = revalidateTargets(ctx, object, options)
  if (options.minAgeMs !== undefined) {
    // Такт і звірка вигляд у польоті не беруть (§6.3, single-flight).
    await revalidateViews(
      ctx,
      o,
      readsOf(
        targets.filter(
          (s) =>
            !inFlight(s) &&
            (!unavailable(s) || ctx.defects.has("scheduler-reads-unavailable"))
        ),
        options.why
      )
    )
    return
  }
  await singleFlight(ctx, o, targets, options).done
}

/** The views `revalidate` of the object takes with these options. */
export function revalidateTargets(
  ctx: WriterContext,
  object: ObjectName,
  options: Eligibility
): Subset[] {
  // Вигляд без жодного завантаження складу не має: його перше читання —
  // завантаження, а не системне перечитування. ТЧ — лише змонтовані.
  return subsetsOf(ctx, ctx.objectOf(object)).filter((s) =>
    eligible(ctx, s, options)
  )
}

/**
 * The explicit-call path over a given view set (§6.3, single-flight): a view
 * not in flight is read once now, a view in flight gets the one shared tail.
 * `started` is the number of views read now.
 */
export function singleFlight(
  ctx: WriterContext,
  o: ObjectState,
  targets: readonly Subset[],
  options: RevalidateOptions
): { started: number; done: Promise<void> } {
  // Явний виклик: вигляд у польоті отримує один хвіст — ще один прохід після
  // осідання з новою епохою старту; наступні виклики чекають той самий хвіст.
  const tails = targets.filter(inFlight).map((s) => {
    // Хвіст, що вже чекає, бере суму викликів: `visibleOnly: false` перемагає,
    // `alsoViews` об'єднуються (інакше пізній виклик міг би загубитися).
    const pending = tailOptions.get(s)
    tailOptions.set(
      s,
      pending === undefined ? options : mergeOptions(pending, options)
    )
    s.rereadTail ??= tailPass(ctx, o, s, options.why)
    return s.rereadTail
  })
  const fresh = targets.filter((s) => !inFlight(s))
  return {
    started: fresh.length,
    done: Promise.all([
      revalidateViews(ctx, o, readsOf(fresh, options.why)),
      ...tails,
    ]).then(() => undefined),
  }
}

type Eligibility = {
  visibleOnly: boolean
  minAgeMs?: number
  /** Views the hydration brought: read although nobody is subscribed yet. */
  alsoViews?: ReadonlySet<Subset>
}

type RevalidateOptions = Eligibility & {
  /** The row of the inventory (Додаток Б) this system re-read comes from. */
  why: ReadWhy
}

/**
 * The session ran out of the discard limit (P4-B spec §6.2): every answer to
 * the view is discarded until a new session, so a read would only burn
 * requests without a pause.
 */
const unavailable = (s: Subset) =>
  s.status === "error" && s.error === EPOCH_UNAVAILABLE

/** The own load or a system re-read of the view is in flight. */
const inFlight = (s: Subset) =>
  s.flight !== undefined || s.rereadEpochs.length > 0

// Строк вигляду; дефект самотесту «без паузи» не бачить збоїв вигляду.
const dueOf = (ctx: WriterContext, s: Subset, ageMs?: number) =>
  viewDueAt(
    ctx.defects.has("scheduler-no-pause") ? { ...s, failures: 0 } : s,
    ctx.limits.revalidateIntervalMs,
    ageMs
  )

function eligible(ctx: WriterContext, s: Subset, options: Eligibility) {
  const { minAgeMs } = options
  return (
    s.alive &&
    !s.purged &&
    s.loaded &&
    (!options.visibleOnly ||
      isVisible(s) ||
      options.alsoViews?.has(s) === true) &&
    // Відмітка свіжості й пауза після збою: строк вигляду (§8.4); вигляд без
    // відмітки строку не має — його читає гідратація чи вигляд-носій рядка.
    (minAgeMs === undefined ||
      ctx.defects.has("min-age-ignored") ||
      (ctx.defects.has("min-age-ignored-sections") &&
        s.form.spec.kind === "section") ||
      (s.refreshedAt !== undefined && ctx.defects.has("min-age-all-young")
        ? false
        : ctx.now() >= dueOf(ctx, s, minAgeMs))) &&
    (s.form.spec.kind !== "section" ||
      s.listeners.size > 0 ||
      options.alsoViews?.has(s) === true)
  )
}

/**
 * The earliest due time of the object's views the interval tick would read
 * (P4-B spec §6.7): visible, loaded, not in flight, not out of the discard
 * limit — the same filter `revalidate` applies with `minAgeMs`, so the timer
 * never fires for a view the tick then skips.
 */
export function nextViewDue(
  ctx: WriterContext,
  object: ObjectName
): number | undefined {
  let due: number | undefined
  for (const s of subsetsOf(ctx, ctx.objectOf(object))) {
    const at = viewDue(ctx, s)
    if (at !== undefined && (due === undefined || at < due)) due = at
  }
  return due
}

/**
 * The due time of one view by the filter of {@link nextViewDue} (the tick
 * reads it then); `undefined` — the tick does not read it.
 */
export function viewDue(ctx: WriterContext, s: Subset): number | undefined {
  if (!eligible(ctx, s, { visibleOnly: true })) return undefined
  if (
    inFlight(s) ||
    (unavailable(s) && !ctx.defects.has("scheduler-reads-unavailable"))
  )
    return undefined
  const at = dueOf(ctx, s)
  // Вигляд, що ще не читався, строку не має.
  return Number.isFinite(at) ? at : undefined
}

/**
 * Test-only (`inspectCore().sync()`): the cause of the `revalidate` tail
 * waiting over the view, if any.
 */
export const tailCause = (s: Subset): ReadWhy | undefined =>
  tailOptions.get(s)?.why

/** The options of the tail waiting over a view: the sum of the calls that joined it. */
const tailOptions = new WeakMap<Subset, RevalidateOptions>()

function mergeOptions(
  a: RevalidateOptions,
  b: RevalidateOptions
): RevalidateOptions {
  const also = new Set([...(a.alsoViews ?? []), ...(b.alsoViews ?? [])])
  return {
    visibleOnly: a.visibleOnly && b.visibleOnly,
    // Хвіст, що зливає кілька викликів, лишає причину першого (Р4).
    why: a.why,
    ...(also.size === 0 ? {} : { alsoViews: also }),
  }
}

/**
 * Whether the interval tick reads a view of the object: the same filter
 * `revalidate` applies with `minAgeMs`.
 */
export function hasDueViews(
  ctx: WriterContext,
  object: ObjectName,
  minAgeMs?: number
): boolean {
  return subsetsOf(ctx, ctx.objectOf(object)).some(
    (s) =>
      eligible(
        ctx,
        s,
        minAgeMs === undefined
          ? { visibleOnly: true }
          : { visibleOnly: true, minAgeMs }
      ) &&
      !inFlight(s) &&
      !unavailable(s)
  )
}

/**
 * The tail of an explicit `revalidate` over a view in flight: waits until the
 * load and the system re-reads of the view settle, then re-reads it once with
 * a new start epoch, composition kept.
 */
async function tailPass(
  ctx: WriterContext,
  o: ObjectState,
  s: Subset,
  why: ReadWhy
): Promise<void> {
  try {
    // Перевірка шапки в черзі (`queueCheck`) — продовження завантаження:
    // вона може стартувати нове читання вже після того, як осідання
    // розбудило очікувачів, і хвіст, що прокинувся між ними, пропустив би
    // його (#312). Тому вона рахується польотом, а сама будить очікувачів,
    // коли нового читання не почала.
    while (
      (inFlight(s) || s.checkQueued) &&
      s.alive &&
      !s.purged &&
      ctx.session.token().valid
    ) {
      await new Promise<void>((resolve) =>
        (s.flight !== undefined || !inFlight(s)
          ? s.waiters
          : s.rereadWaiters
        ).push(resolve)
      )
    }
  } finally {
    s.rereadTail = undefined
  }
  const options = tailOptions.get(s) ?? { visibleOnly: false, why }
  tailOptions.delete(s)
  if (
    !ctx.session.token().valid ||
    unavailable(s) ||
    !eligible(ctx, s, options) ||
    ctx.defects.has("revalidate-no-tail")
  )
    return
  // Хвіст — читання, яке поставив виклик `options.why`, під кодом R15.
  await revalidateViews(ctx, o, readsOf([s], { ...options.why, site: "R15" }))
}

/**
 * The system re-read of one view over rows that only the hydration wrote, at
 * the moment it becomes visible (spec §6.6). A section is read
 * only while mounted, like in `revalidate`.
 */
export async function revalidateHydrated(
  ctx: WriterContext,
  s: Subset,
  why: ReadWhy
): Promise<void> {
  if (!ctx.session.token().valid) return
  if (!s.alive || s.purged || !s.loaded || s.flight !== undefined) return
  if (s.form.spec.kind === "section" && s.listeners.size === 0) return
  await revalidateViews(ctx, s.form.object, readsOf([s], why))
}

/**
 * The re-read of every view that holds one of the hidden keys, as an owned
 * row or an `include` target, invisible views included: the
 * values return only with a read that started after the `hide`. A failed
 * read leaves them hidden. A view of another object that includes the
 * object is re-read as its own object's view. Tabular section subsets are
 * not re-read here: they go stale by the hide epoch of their owner.
 */
export async function revalidateHolders(
  ctx: WriterContext,
  object: ObjectName,
  keys: ReadonlySet<Key>,
  why: ReadWhy
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
    [...groups].map(([o, targets]) =>
      revalidateViews(ctx, o, readsOf(targets, why))
    )
  )
}

/** A view with the row of the inventory it is read under; no view without one. */
type Read = readonly [Subset, ReadWhy]

const readsOf = (views: readonly Subset[], why: ReadWhy): Read[] =>
  views.map((s) => [s, why])

/**
 * One two-phase pass over `reads`; views dropped by a purge get another
 * pass. The views of one pass may come from different rows only in the
 * repeats below.
 */
export async function revalidateViews(
  ctx: WriterContext,
  o: ObjectState,
  reads: readonly Read[]
): Promise<void> {
  const targets = reads.map(([s]) => s)
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
  // Номер спроби кожного вигляду: його читання йдуть під ним (`watchAttempts`).
  const numbers = new Map<Subset, number>()
  const attemptTarget = (s: Subset) =>
    ({ kind: "view", object: o.name, id: s.targetId }) as const
  for (const [s, why] of reads) {
    s.rereads++
    s.rereadEpochs.push(startEpoch)
    numbers.set(s, ctx.attempts.start("reread", attemptTarget(s), why))
  }
  // Наслідок осідання кожного вигляду проходу (§5.5).
  const outcomes = new Map<Subset, readonly [SettleOutcome, SettleDetail?]>()
  const purgesAtStart = new Map(ctx.purges)
  const purgedSince = (name: ObjectName) =>
    (ctx.purges.get(name) ?? 0) !== (purgesAtStart.get(name) ?? 0)
  // Одна оренда на прохід: усі відповіді пише один `commit` нижче.
  const lease = ctx.source.lease()
  const results = await Promise.all(
    reads.map(([s, why]) => {
      const { site, ...cause } = why
      return readAgain(
        ctx,
        s,
        startEpoch,
        token,
        ctx.source.admit(cause, attemptTarget(s), site, {
          attempt: numbers.get(s),
          caller: s,
          lease,
        })
      ).then(
        (apply) => ({ s, why, apply }) as const,
        (error: unknown) => ({ s, why, error }) as const
      )
    })
  )
  for (const s of targets) {
    const at = s.rereadEpochs.indexOf(startEpoch)
    if (at >= 0) s.rereadEpochs.splice(at, 1)
  }
  // Повтор тим самим системним шляхом: рядок інвентаря — за причиною повтору.
  const again = new Map<Subset, ReadWhy>()
  const discarded: Subset[] = []
  // Вигляди, чию відповідь пропущено, бо їхнє завантаження осіло раніше.
  const skipped: Subset[] = []
  settle(lease, () => {
    const ran = session.commit(
      (scope) => {
        try {
          for (const result of results) {
            const { s } = result
            if (!s.alive) {
              outcomes.set(s, ["evicted"])
              continue
            }
            if (s.purged) {
              outcomes.set(s, ["after-purge"])
              continue
            }
            const atStart = loadsAtStart.get(s)
            if (atStart?.gen !== s.gen || atStart.flight !== s.flight) {
              outcomes.set(s, ["evicted"])
              skipped.push(s)
              continue
            }
            // purge після старту: відповідь могла нести рядки й рядки ТЧ, яких
            // на мить purge у сховищі не було (рядок у сховищі ще в старому
            // скоупі). Відкидаємо й перечитуємо тим самим системним шляхом:
            // склад і порядок змінює лише сам purge (§6.5), а не перечитування.
            if (
              purgedSince(o.name) ||
              s.form.include.some((step) => purgedSince(step.target))
            ) {
              outcomes.set(s, ["after-purge"])
              again.set(s, { reason: "retry", site: "R16" })
              continue
            }
            s.dirty = true
            if ("error" in result) {
              // Закритий обмежувач — сесію закрито: писати нікуди.
              if (result.error instanceof ReadLimiterClosed) {
                outcomes.set(s, ["closed"])
                continue
              }
              outcomes.set(s, ["failed", failureOf(result.error)])
              s.failures++
              s.failedAt = startedAt
              s.status = "error"
              s.error = errorOf(result.error)
              continue
            }
            try {
              if (!result.apply(scope)) {
                outcomes.set(s, ["discarded-by-epoch"])
                // Відкинута відповідь: перечитування з паузою, а після
                // межі відкинутих поспіль — `command.unavailable`.
                if (session.versions.unavailable()) {
                  s.status = "error"
                  s.error = EPOCH_UNAVAILABLE
                } else discarded.push(s)
                continue
              }
              if (pageDropped.delete(s)) {
                outcomes.set(s, ["after-purge"])
                again.set(s, { reason: "retry", site: "R17" })
                continue
              }
              outcomes.set(s, ["applied"])
              s.refreshedAt = startedAt
              s.okReadEpoch = startEpoch
              // Успішне системне читання, що стартувало з епохи вимоги,
              // підтверджує склад: нового рядка воно не ставить у склад, а дає
              // банер (§6.5). Правило зняття й повтору — те саме, що в
              // завантаження (§8.4, п. 7): вимога, що лишилась, бо прохід
              // стартував раніше за e, і яку ніхто інший не прочитає, — ще
              // один прохід тим самим системним шляхом, склад не змінюється.
              s.failures = 0
              s.failedAt = undefined
              if (s.status === "error") {
                s.status = "ready"
                s.error = undefined
              }
              if (
                settleRequirement(s, startEpoch, {
                  versions: session.versions,
                  tabVisible: ctx.tabVisible,
                })
              )
                again.set(s, { reason: "retry", site: "R18" })
            } catch (error) {
              outcomes.set(s, ["failed", failureOf(error)])
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
    // `commit` не пройшов — токен сесії недійсний: усе закрито.
    for (const s of targets)
      ctx.attempts.settle(
        numbers.get(s)!,
        "reread",
        attemptTarget(s),
        ...(ran ? (outcomes.get(s) ?? ["closed"]) : (["closed"] as const))
      )
  })
  // Прохід осів: хвіст явного `revalidate` може стартувати.
  for (const s of targets) {
    if (s.rereadEpochs.length === 0) {
      for (const resolve of s.rereadWaiters.splice(0)) resolve()
    }
  }
  // Пропущена відповідь — теж точка осідання (§8.4, п. 7): завантаження, що
  // осіло раніше, не повторилось, бо бачило цей прохід у польоті; вимогу, яку
  // тепер ніхто не прочитає, читає те саме правило, що й після сторінки.
  for (const s of skipped) ctx.readRequirement(s)
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
    // Не чекаємо паузи: `revalidate` завершується, а повтор — строк об'єкта в
    // планувальнику (на прихованій вкладці чекає `resume()`); іде тим самим
    // системним шляхом, склад не змінюється.
    ctx.schedule(o.name, pause, { reason: "retry" }, new Set(discarded))
  }
  // Дефект самотесту «системне перечитування через завантаження».
  if (ctx.defects.has("system-reread-via-load")) {
    for (const { s, why } of results) {
      if (s.alive && !s.purged) ctx.registry.load(s, why)
    }
  }
  // Вигляд із власним завантаженням у польоті (П12: його перезапускає purge)
  // оновить те завантаження; решта — новий прохід з новою епохою старту.
  await revalidateViews(
    ctx,
    o,
    [...again].filter(([s]) => s.alive && !s.purged && s.flight === undefined)
  )
}

/**
 * The re-read of one key after an own write (P4-B spec §7.2): by key through `readKeys` — the list form, or
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
    limit.abort()
    if (outcome.kind !== "read" && unconfirmed !== undefined) {
      o.rows.markUnconfirmed(scope, key, unconfirmed.version, unconfirmed.epoch)
      if (o.rows.get(key) !== undefined) ctx.rowViews.touch(o.name, key)
    }
    onCommit?.(outcome, scope)
  }
  // Межа часу (§7.2, крок 4): мутація не чекає перечитування без кінця.
  // Очікування — сон сесії: закриття будить його одразу й таймера не лишає.
  const limit = new AbortController()
  void session.sleep(REREAD_TIMEOUT_MS, limit.signal).then(() => {
    if (done || !token.valid) return
    session.commit(
      (scope) => fire({ kind: "failed" }, scope),
      token,
      "reread timeout"
    )
  })
  const lease = ctx.source.lease()
  const read = tracked(
    ctx.source,
    ctx.source.admit(
      { reason: "write-confirm" },
      { kind: "keys", object },
      "K4",
      { lease }
    )
  )
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
  settle(lease, () => {
    if (!token.valid) {
      limit.abort()
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
        const found = rows.find(
          (r) => r.key.toLowerCase() === key.toLowerCase()
        )
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
  })
}

/**
 * The pairs a rights snapshot replacement purges (P4-B spec §6.2 rule 4):
 * every pair (stored scope, object) of the store that `denies` gives — a
 * scope of a stored row, or of tabular section lines written with a known
 * owner scope. An object without a rights contract is not judged; the
 * journal values of a key without a stored row are not either.
 */
export function deniedPairs(
  ctx: WriterContext,
  denies: (object: ObjectName, scope: string | null) => boolean
): Array<{ object: ObjectName; scope: string | null }> {
  const pairs: Array<{ object: ObjectName; scope: string | null }> = []
  for (const o of ctx.objects.values()) {
    if (o.entry.rights === undefined) continue
    const scopes = new Set<string | null>()
    for (const key of o.rows.keys()) scopes.add(o.rows.get(key)!.scope)
    // Рядки ТЧ з невідомим скоупом власника прибирає будь-який purge пари
    // об'єкта (`SectionStore.purgeScope`).
    for (const owner of o.sections.owners()) {
      for (const section of o.entry.tabularSections) {
        const scope = o.sections.get(owner, section.name)?.scope
        if (scope !== undefined && scope !== "unknown") scopes.add(scope)
      }
    }
    for (const scope of scopes) {
      if (denies(o.name, scope)) pairs.push({ object: o.name, scope })
    }
  }
  return pairs
}

// Вигляд тримає рядки об'єкта: свої чи як ціль `include`.
const holds = (s: Subset, object: ObjectName) =>
  s.form.object.name === object ||
  s.form.include.some((step) => step.target === object)

/** The live views that may hold rows of the object: its own views and views whose `include` targets it. */
export function holdersOf(ctx: WriterContext, object: ObjectName): Subset[] {
  return [...ctx.registry.subsets()].filter(
    (s) => s.alive && !s.purged && holds(s, object)
  )
}

/**
 * Invalidates the first loads in flight of the views that started before
 * `before`: their answer may predate a narrowing of the read, and a view never
 * loaded has no re-read — the load runs again (П12). A load that started
 * later read under the new rights. See {@link revalidateNarrowed}.
 */
export function invalidateLoads(views: Iterable<Subset>, before: number) {
  for (const s of views) {
    if (!s.alive || s.purged || s.loaded || s.flight === undefined) continue
    if ((s.flightEpoch ?? before) >= before) continue
    s.gen++
    queueTrailing(s, { reason: "requirement", requirement: "access-narrowed" })
  }
}

/**
 * Re-reads the loaded views among `views` (P4-B spec §6.2 rule 4, «до B6»;
 * plan B5b-2 Р5, Р5а), invisible ones included: one single-flight pass per
 * object over the whole set, so a view that holds two narrowed objects is
 * read once (a view in flight gets the one tail). First loads in flight are
 * {@link invalidateLoads}'s.
 */
export function revalidateNarrowed(
  ctx: WriterContext,
  views: Iterable<Subset>,
  why: ReadWhy
): Promise<void> {
  if (!ctx.session.token().valid) return Promise.resolve()
  const groups = new Map<ObjectState, Subset[]>()
  for (const s of new Set(views)) {
    if (!eligible(ctx, s, { visibleOnly: false })) continue
    const group = groups.get(s.form.object) ?? []
    group.push(s)
    groups.set(s.form.object, group)
  }
  return Promise.all(
    [...groups].map(
      ([o, targets]) =>
        singleFlight(ctx, o, targets, { visibleOnly: false, why }).done
    )
  ).then(() => undefined)
}
