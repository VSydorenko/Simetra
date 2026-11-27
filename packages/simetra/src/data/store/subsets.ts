import { failureOf, type Attempts, type SettleDetail } from "./attempts"
import {
  CommandFailure,
  type CatalogIndex,
  type CommandError,
} from "simetra/model"
import { DataError } from "../errors"
import type { Defects } from "./defects"
import { keyId } from "./epoch"
import { formOf, type Form, type ObjectState } from "./forms"
import { includeKeys, refsOf } from "./include"
import { changesObjectOf, lazyFieldStale, visibleRow } from "./object-store"
import { sectionLinesStale } from "./section-store"
import {
  diffOwn,
  readForm,
  readGated,
  readWindowMore,
  type GatedRead,
  type ReaderTarget,
  type StoreOps,
  type WriteReport,
} from "./readers"
import {
  EMPTY_WINDOW,
  cursorOf,
  keysOfPages,
  type WindowCursor,
  type WindowState,
} from "./window"
import { DISCARD_PAUSE_MS, type Scope, type Session } from "./session"
import {
  LOADING,
  purgedSnapshot,
  shareSnapshot,
  withRefs,
  type RowViews,
} from "./snapshot"
import { ReadLimiterClosed, type StoreSource } from "./source"
import { isPermit, type Flight, type Permit } from "./sync/flight"
import {
  rulesOf,
  settlePass,
  type SettleEntry,
  type SettleHooks,
} from "./sync/settle-pass"
import {
  changeVisibility,
  createTargetState,
  dropRequirementForDefect,
  isVisible,
  promisedFrom,
  requirementOf,
  settleFlight,
  slotChanged,
  startFlight,
  type TargetState,
} from "./sync/target-state"
import type {
  AdmissionCondition,
  ReadTarget,
  ReadWhy,
  SettleOutcome,
} from "./sync/vocabulary"
import type {
  CoreLimits,
  CoreLogEntry,
  Key,
  ObjectName,
  RowState,
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
  /**
   * The gate's query of `tab-hidden` (Р-SK1-8): the page settle point and the
   * public `needsRefresh` ask it, not the tab state.
   */
  readonly tabHidden: () => boolean
  /**
   * The gate's query of `closed` (Р-SK1-5): `preload` of a closed core is
   * refused before it holds a view, as a public call of a closed core.
   */
  readonly closed: () => boolean
  readonly source: StoreSource
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
  /** Objects whose stale-client mark changed in the current `commit`. */
  dirtyObjects(): ReadonlySet<ObjectName>
  /** Whether the object is marked stale-client (§10). */
  isStale(object: ObjectName): boolean
  /** The purged snapshot once the core closes. */
  closedSnapshot(): ViewSnapshot | undefined
  /** Deliberate defects of the model test's self-check. */
  readonly defects: Defects
  /** The monotonic clock in ms (`performance.now()`; a test substitutes it). */
  readonly now: () => number
  /** Diagnostics of the attempts to read a view (the `watchAttempts` events). */
  readonly attempts: Attempts
  /**
   * A view just became visible (a subscription or `setVisible(true)`): it is
   * read if it holds hydration-only rows (§6.6) or its composition is not
   * confirmed (`unconfirmedSince`, §8.4).
   */
  becameVisible(s: Subset): void
  /**
   * Reads the view when its requirement «composition not confirmed» is
   * pending (`requirementPending`, P4-B spec §8.4, item 7): the system
   * re-read that lifts it.
   */
  readRequirement(s: Subset): void
  /** The set of visible views changed: the scheduler re-plans its timer. */
  touchSchedule(): void
  /** A subset was created: the signal receiver re-plans its channels. */
  touchSubscriptions(): void
}

type Timer = ReturnType<typeof setTimeout>

/** A held view form. */
export interface Subset extends ReaderTarget {
  readonly form: Form
  /**
   * Opaque id of the target, stable for the life of the subset and the same
   * in the `watchReads` events and in `sync()` (diagnostics only; it never
   * decides anything).
   */
  readonly targetId: number
  readonly listeners: Set<{ readonly fn: () => void }>
  preloads: number
  readonly preloadTimers: Set<Timer>
  releaseTimer: Timer | undefined
  alive: boolean
  /** At least one load finished (or a card showed its stored row). */
  settled: boolean
  /** A load succeeded: a later read is `refreshing`, not `loading` (§6.5). */
  loaded: boolean
  /** The system re-reads started for this view; the model test counts them. */
  rereads: number
  status: "loading" | "ready" | "refreshing" | "error"
  error: CommandError | DataError | undefined
  /**
   * The user's refresh is due (the new-rows banner of a system re-read,
   * §6.5; a failed key read of the receiver). The snapshot's `needsRefresh`
   * also shows an unconfirmed composition (the requirement of the record, §8.4) of an
   * invisible view or of any view on a hidden tab: that part is derived, not
   * stored here.
   */
  needsRefresh: boolean
  hasNewRows: boolean
  waiters: Array<() => void>
  dirty: boolean
  snapshot: ViewSnapshot | undefined
  refViews: Map<Key, RowView>
  checkQueued: boolean
  /** The queued check comes from a hold without a listener (`preload`). */
  checkHeld: boolean
  /**
   * The key (card) or owner (section) was purged (§6.5): the view shows
   * `purged` and reads nothing until released.
   */
  purged: boolean
  /**
   * Taken from a core snapshot and not yet subscribed: the snapshot holds the
   * subset until the first subscription or `endHydration` (spec §6.6).
   */
  hydrated: boolean
}

/** The state of a view taken from a core snapshot (the hydration). */
export interface AdoptedView {
  /** The composition in list order: keys that have an entry in the store. */
  readonly layout: readonly Key[]
  /** Owned without being shown (a `full` filter drops them locally). */
  readonly unshown: readonly Key[]
  readonly window: WindowState | undefined
  readonly atEnd: boolean
  readonly truncated: boolean
  readonly ownerState: RowState | undefined
  /** The epoch of the hydration: the read epoch of a section it brings. */
  readonly at: number
}

/** The view registry of a core. */
export interface SubsetRegistry {
  view(spec: ViewSpec): ViewHandle
  preload(spec: ViewSpec, options?: { ttlMs?: number }): Promise<void>
  subsets(): Iterable<Subset>
  /** A released signal channel was forgotten: its cached object id goes too. */
  forgetChannel(channel: string): void
  /** The held subset of a form, if any; throws on a refused form as `view` does. */
  find(spec: ViewSpec): Subset | undefined
  /** The validated form of a spec; throws on a refused form as `view` does. */
  formOf(spec: ViewSpec): Form
  /**
   * Creates the held subset of a form from a core snapshot, loaded and ready,
   * and owns its rows (the hydration, inside its `commit`). The snapshot holds
   * it until the first subscription.
   */
  adopt(scope: Scope, form: Form, state: AdoptedView): void
  /** Lets go of the subsets the snapshot still holds: released after the delay. */
  endHydration(): void
  /**
   * Starts a load (single-flight: merges into one trailing request); `why` is
   * the row of the inventory (Додаток Б) the read comes from.
   */
  load(s: Subset, why: ReadWhy): void
  /**
   * After a `commit`: marks the affected subsets dirty and returns the
   * subscribed ones whose snapshot changed.
   */
  afterCommit(closing: boolean): Subset[]
  /** Cancels every timer, resolves waiters and forgets every subset and handle. */
  close(): void
  /**
   * Test-only (`inspectCore().sync()`): the card or section is behind its
   * header — the condition under which a check reads it again (stale by
   * `cardStale` / `sectionStale`, and the header changed or the owner was
   * hidden since its last read).
   */
  behindHeader(s: Subset): boolean
}

const NO_LINES: readonly SectionLine[] = Object.freeze([])
// Лише для дефекту самотесту `window-copies-values`.
const COPIES = new WeakMap<Subset, Map<Key, RowView>>()
const copiesOf = (s: Subset): Map<Key, RowView> => {
  const found = COPIES.get(s) ?? new Map<Key, RowView>()
  COPIES.set(s, found)
  return found
}

/**
 * The pause after `failures` failed reads in a row (P4-B spec §6.7):
 * `min(I, 0.1 × I × 2^(n − 1))` from the start of the failed attempt.
 */
export const failurePause = (failures: number, intervalMs: number): number =>
  Math.min(intervalMs, 0.1 * intervalMs * 2 ** (failures - 1))

/**
 * The due time of a loaded view (one function for the `revalidate` filter and
 * the scheduler): after failures — the end of the pause, else
 * `refreshedAt + ageMs` (the interval by default). A view never read has no
 * due time: a card shown from the store freshens with the view that holds its
 * row, a hydrated view is read by the reconciliation of the hydration.
 */
export const viewDueAt = (
  state: TargetState,
  intervalMs: number,
  ageMs: number = intervalMs,
  /** Лише дефект самотесту `scheduler-no-pause`: строк не бачить збоїв. */
  ignoreFailures = false
): number =>
  !ignoreFailures && state.failures > 0 && state.failedAt !== undefined
    ? state.failedAt + failurePause(state.failures, intervalMs)
    : state.refreshedAt === undefined
      ? Number.POSITIVE_INFINITY
      : state.refreshedAt + ageMs

/**
 * The view requirement stands and waits for a read nobody else promises
 * (P4-B spec §8.4, item 7): the view is visible, no read of it started at the
 * requirement's epoch or later is in flight or queued after the current one
 * (a `revalidate` tail, a trailing load), it is not in the failure pause. The
 * hidden tab and the discard limit of the session are judged by the gate at
 * the read (§5.3, Р-SK1-7, Р-SK1-8).
 */
export function requirementPending(s: Subset): boolean {
  return requirementHold(s) === undefined
}

/**
 * Why the view requirement «composition not confirmed» is not read now — the
 * one decision of `requirementPending` and of the settle point, named by the
 * condition of the gate (§5.3); `undefined` — it is pending: read it now.
 * `"absent"` — no requirement. Test diagnostics (`sync()`) combine it with the
 * gate's `tab-hidden`.
 */
export function requirementHold(
  s: Subset
):
  | "absent"
  | Extract<AdmissionCondition, "target-invisible" | "promised" | "paused">
  | undefined {
  const state = s.targetState
  const since = requirementOf(state, "composition-unconfirmed")?.since
  if (since === undefined) return "absent"
  if (!isVisible(state)) return "target-invisible"
  // Читання зі стартом не раніше e летить, або хвіст `revalidate` чи
  // завантаження-наступник стартують після осідання поточного читання, тобто
  // з e чи пізніше: вимогу знімуть вони, повтор був би другим читанням того
  // самого.
  if (promisedFrom(state, since)) return "promised"
  // Збій читання повторює пауза збоїв (планувальник), не негайне коло.
  // Межу відкинутих і вкладку судить шлюз у мить читання (M7, R13, R18;
  // Р-SK1-7, Р-SK1-8).
  return state.failures > 0 ? "paused" : undefined
}

/**
 * Крок 7 проходу осідання (§5.5, Р-SK2-6) — єдиний шов стану цілі-вигляду для
 * завантаження, сторінки й системного перечитування. Другого тіла немає: лічильник
 * збоїв і відновлення `status` колись уже розійшлись у двох копіях. Правила —
 * клітинки виду польоту (`rulesOf`), а не гілки за точкою. Повертає, чи треба
 * повторити читання (вимога лишилась чи сторінка відхилена); яким повтором —
 * вирішує шлях. Перехід «політ осів» (`settleFlight`: строк, доказ, зняття
 * вимоги) кличе лише він.
 *
 * Завантаження підтверджує весь вигляд: знімає вимогу, а коли вона лишилась,
 * бо читання стартувало раніше за e, і її ніхто інший не прочитає, — той самий
 * політ читає ще раз (П15; на прихованій вкладці — `needsRefresh` і читання на
 * `resume()`). Сторінка підтверджує лише себе: повторюється тільки на власне
 * відхилення, а чужу вимогу читає механізм, що її поставив (`revalidate`).
 * Збій читання тут не повторює: його повторює пауза збоїв.
 */
export function settleTarget(
  s: Subset,
  flight: Flight,
  outcome: SettleOutcome,
  failure: { readonly error: unknown } | undefined,
  context: {
    /** Збій самого читання, а не дефект застосування: лише він рахує паузу. */
    readonly readFailed: boolean
    /** Потрібна лише сторінці: системне перечитування вкладку не судить. */
    readonly tabHidden?: () => boolean
    /** Звіт запису кроку 5 (епоха читання ТЧ, яку взяло сховище). */
    readonly report?: WriteReport
  }
): boolean {
  const rules = rulesOf(flight)
  // Поля запису цілі (вимоги, доказ, строк) пише перехід «політ осів»; тут —
  // лише ознаки реєстру (`loaded`, `status`, `error`, банери).
  // Час старту потрібен лише тому осіданню, що рухає строк чи паузу збоїв.
  const counts = (applied: boolean) =>
    applied
      ? rules.successMovesDeadline
      : context.readFailed &&
        (rules.failureCounts === "always" ||
          (rules.failureCounts === "if-loaded" && s.loaded))
  const settle = (applied: boolean) =>
    settleFlight(s.targetState, {
      outcome: applied ? "applied" : "failed",
      flight: required(flight.kind, "its kind"),
      evidence: applied
        ? {
            kind: "session-start",
            epoch: required(flight.epoch, "its start epoch"),
          }
        : undefined,
      own: true,
      startedAt: counts(applied)
        ? required(flight.startedAt, "its start time")
        : (flight.startedAt ?? 0),
      loaded: s.loaded,
      applyFailed: !context.readFailed,
      ...(context.report?.sectionRead === undefined
        ? {}
        : { sectionRead: context.report.sectionRead }),
    })
  if (outcome === "applied") {
    // `loaded` ставить лише завантаження: системне перечитування його не
    // чіпає (R12 перечитує й ТЧ, що не завантажилась).
    if (
      rules.successMovesDeadline &&
      rules.confirms === "view-with-composition"
    )
      s.loaded = true
    s.targetState = settle(true)
    // Підтверджене завантаженням — весь вигляд готовий; сторінка й системне
    // читання лише виправляють помилку, яку лишила попередниця.
    if (rules.confirms === "view-with-composition" || s.status === "error") {
      s.status = "ready"
      s.error = undefined
    }
    if (rules.liftsBanners) {
      s.needsRefresh = false
      s.hasNewRows = false
    }
    // Вимогу, що лишилась (читання стартувало раніше за e) і яку ніхто інший
    // не прочитає, той самий політ читає ще раз; на прихованій вкладці
    // повтор відкладає шлюз, а знімок виводить `needsRefresh` з вимоги.
    if (rules.confirms !== "own-page") return requirementPending(s)
    if (
      requirementOf(s.targetState, "composition-unconfirmed") === undefined ||
      !s.answerRejected ||
      !isVisible(s.targetState)
    )
      return false
    // Прихована вкладка й тут — гілка невидимого (§12, Р8): без запиту;
    // `needsRefresh` знімок виводить із вимоги, а `resume()` читає вигляд.
    // Іменована перевірка, наслідок осідання (рішення архітекторки 25.11): вона
    // судить не читання, а мить зняття позначки сторінки — у цьому `commit`.
    return !required(context.tabHidden, "its tab check")()
  }
  if (outcome === "failed" && failure !== undefined) {
    // Паузу збоїв рахує лише збій самого читання (для завантаження — вже
    // завантаженого вигляду): дефект застосування її не веде.
    s.targetState = settle(false)
    s.status = "error"
    s.error = errorOf(failure.error)
  }
  return false
}

// Дочитування картки чи ТЧ, яке запускає підписка чи `preload` (рядок M3), і
// дія користувача над завантаженням (рядок M5).
const CHECK_ON_MOUNT: ReadWhy = { reason: "mount", site: "M3" }
const CHECK_AFTER_COMMIT: ReadWhy = {
  reason: "requirement",
  requirement: "target-behind-header",
  site: "M4",
}
const USER_LOAD: ReadWhy = { reason: "user", site: "M5" }
const USER_PAGE: ReadWhy = { reason: "user", site: "P1" }

const ACCESS_CHANGED = purgedSnapshot("access-changed")

/**
 * The error of a view once the session discarded too many answers in a row
 * (P4-B spec §6.2): the database keeps answering from an epoch the
 * session left; only a new session reads again.
 */
export const EPOCH_UNAVAILABLE: CommandError = Object.freeze({
  code: "command.unavailable",
})

/** The error a view shows for a failed read. */
export const errorOf = (error: unknown): CommandError | DataError => {
  if (error instanceof CommandFailure) return error.error
  if (error instanceof DataError) return error
  return { code: "command.internal" }
}

/**
 * Осідання вигляду чи сторінки: політ і те, що прохід віддає шляху. `verdict` —
 * не стан читання (його несе політ), а результат проходу: політ замінений
 * замороженим значенням, а обидва рішення ухвалює область запису в свою мить
 * (`versions.unavailable()` і `confirm` після запису), тож шлях не може
 * перерахувати їх після неї.
 */
interface ViewEntry extends SettleEntry {
  readonly number: number
  readonly read?: GatedRead
  /** Звіт запису кроку 5 для кроку 7 (завантаження). */
  readonly report?: WriteReport
  readonly verdict: { again: boolean; discarded: boolean }
}

/** Поле польоту, яке шлях вигляду мусив видати: його відсутність — дефект. */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`a view flight carries ${what}`)
  return value
}

// Покоління читань сторінок вікна: одне число на ядро, тож жодне не повторюється.
let pageGenerations = 0

export function createRegistry(ctx: RegistryContext): SubsetRegistry {
  const { session, limits, ops, rowViews } = ctx
  const subsets = new Map<string, Subset>()
  let nextTargetId = 0
  // Мемо хендлів з межею: хендл шукає підмножину за ключем форми, тож новий
  // хендл після витіснення під'єднується до тієї самої підмножини.
  const handles = new Map<string, ViewHandle>()
  // Кеш знімка картки без утримання — на хендл мемо; закриття його чистить.
  const idleCaches = new Map<string, { snapshot?: ViewSnapshot }>()
  const isClosed = () => ctx.closedSnapshot() !== undefined
  // Рішення читати вигляд чи сторінку — шлюзу (§5.3), не шляху.
  const admitView = (why: ReadWhy, target: ReadTarget) => {
    const { site, ...cause } = why
    return ctx.source.admit(cause, target, site)
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

  /**
   * Осідання відповіді вигляду чи сторінки одним проходом (§5.5). Спільне для
   * обох точок — тут; відмінності — клітинки виду (`rulesOf`) і гачки `extra`.
   * Стан читання (епоха, час старту, токен, оренда) бере з польоту.
   */
  function settleView(
    s: Subset,
    target: Extract<ReadTarget, { kind: "view" | "page" }>,
    what: string,
    entry: ViewEntry,
    extra: Pick<
      SettleHooks<ViewEntry, SettleDetail>,
      "beforeGate" | "apply"
    > & {
      finish(scope: Scope): void
    }
  ) {
    const { flight, verdict } = entry
    const kind = required(flight.kind, "its kind")
    if (kind !== "load" && kind !== "page")
      throw new Error("a view settles as a load or a page")
    const epoch = required(flight.epoch, "its start epoch")
    return settlePass<ViewEntry, SettleDetail>(session, [entry], {
      token: required(flight.token, "its token"),
      what,
      lost: () =>
        !session.token().valid
          ? "closed"
          : !s.alive
            ? "evicted"
            : "after-purge",
      refused: (error) => error instanceof ReadLimiterClosed,
      failureDetail: failureOf,
      beforeGate: extra.beforeGate,
      gate: (e) =>
        session.acceptEpochs(required(e.read, "its answer").epochs, epoch) ===
        "discard"
          ? "discard"
          : "apply",
      // Відповідь відкинута: поки межа не вичерпана, шлях повторить її після
      // паузи; інакше вигляд — `command.unavailable`.
      discarded: () => {
        verdict.discarded = !session.versions.unavailable()
        if (!verdict.discarded) {
          s.status = "error"
          s.error = EPOCH_UNAVAILABLE
        }
      },
      apply: extra.apply,
      // Дефект застосування — вигляд у `error`, рядки без власника прибирає
      // `sweep`; відмова не стає необробленою.
      applyFailed: (_e, error) => ctx.log({ kind: "listener-failed", error }),
      settleTarget: (f, outcome, _evidence, failure) => {
        const again = settleTarget(s, f, outcome, failure, {
          readFailed: entry.failure !== undefined,
          tabHidden: ctx.tabHidden,
          ...(entry.report === undefined ? {} : { report: entry.report }),
        })
        if (outcome === "applied") verdict.again = again
      },
      sweep: ops.sweep,
      finish: (_e, _outcome, scope) => extra.finish(scope),
      // Відмова після відкинутого регіону лишає код збою в діагностиці, як
      // на `main`; закритий обмежувач коду не має.
      settled: (e, outcome, detail) =>
        ctx.attempts.settle(
          e.number,
          kind,
          target,
          outcome,
          detail ??
            (e.failure !== undefined &&
            !(e.failure.error instanceof ReadLimiterClosed)
              ? failureOf(e.failure.error)
              : undefined)
        ),
    })
  }

  function resolveWaiters(s: Subset) {
    for (const resolve of s.waiters.splice(0)) resolve()
  }

  // Число підписників — вхід ефективної видимості запису: одна точка на
  // кожну зміну `listeners`.
  function subscribersChanged(s: Subset) {
    s.targetState = changeVisibility(s.targetState, {
      subscribers: s.listeners.size,
    })
  }

  function load(s: Subset, why: ReadWhy) {
    if (!s.alive || s.purged) return
    const target = {
      kind: "view",
      object: s.form.object.name,
      id: s.targetId,
    } as const
    // Рішення читати — шлюзу (§5.3): закрита сесія відмовляє тут, до черги
    // `trailing` і до будь-якого запису стану.
    const admitted = admitView(why, target)
    if (!isPermit(admitted)) return
    // Політ стоїть: запит зливається в чергу (рядок M6), черга пам'ятає
    // перший виклик, що її поставив (Р4).
    if (s.targetState.flight !== undefined) {
      s.targetState = startFlight(s.targetState, { kind: "load", cause: why })
      return
    }
    {
      const { site, ...cause } = why
      void site
      s.targetState = startFlight(s.targetState, { kind: "load", cause })
    }
    const gen = s.targetState.gen
    // Токен покоління: недійсний після звільнення й нового запиту (§6.1).
    const token = session.childToken(() => s.alive && s.targetState.gen === gen)
    const what = `view ${s.form.specKey}`
    const header = headerKey(s)
    session.commit(
      () => {
        s.status = hasData(s) || s.loaded ? "refreshing" : "loading"
        s.dirty = true
      },
      token,
      what
    )
    // Відкинута відповідь — те саме завантаження з паузою, що зростає:
    // покоління й політ не змінюються, тож це й далі дія, що його почала.
    // Повтор тієї самої дії питає шлюз у мить рішення, після дочірнього токена.
    const retry = (site: "M7" | "M8") => {
      const again = admitView({ reason: "retry", site }, target)
      return isPermit(again) ? attempt(again) : undefined
    }
    const attempt = (permit: Permit): Promise<void> => {
      const { why } = permit
      const lease = ctx.source.lease()
      const number = ctx.attempts.start("load", target, why)
      const flight = permit.flight({
        attempt: number,
        caller: s,
        lease,
        kind: "load",
        token,
      })
      const readEpoch = required(flight.epoch, "its start epoch")
      // Спроба польоту, що стоїть: її відповідь ще може писати рядки. Доказ
      // шапки — на старті спроби, як на `main` (рядок 20; знімає задача 9).
      s.targetState = startFlight(s.targetState, {
        kind: "load",
        cause: why,
        epoch: readEpoch,
        retry: true,
        proofAtStart: true,
        ...(header === undefined
          ? {}
          : { headerRevision: rowViews.revision(s.form.object.name, header) }),
      })
      const verdict = { again: false, discarded: false }
      const settleLoad = (entry: ViewEntry) => {
        try {
          settleView(s, target, what, entry, {
            apply: (e, scope) =>
              required(e.read, "its answer").write(scope, e.report),
            finish: () => {
              s.dirty = true
            },
          })
        } finally {
          // Остання спроба осіла: політ лишається до свого `finally`, але
          // рядків не принесе (#465); прохід синхронний, тож `purge` не
          // втискається між областю запису й цим скиданням.
          s.targetState = slotChanged(s.targetState, { kind: "answered" })
        }
      }
      return readForm(ctx, s, readEpoch, token, flight).then(
        (read) => {
          settleLoad({ flight, number, read, verdict, report: {} })
          // Вимога стала, поки летіло читання (M7): повтор тієї самої дії.
          if (verdict.again && token.valid) return retry("M7")
          if (!verdict.discarded || !token.valid) return
          // Цей прохід вичерпав межу (лічильник рухається після commit):
          // повтору не буде, вигляд — `command.unavailable`. Наслідок осідання
          // за межею (Р-SK1-7); повтор M8 після паузи судить шлюз.
          if (ctx.source.settledPastBound()) {
            session.commit(
              () => {
                s.status = "error"
                s.error = EPOCH_UNAVAILABLE
                s.dirty = true
              },
              token,
              what
            )
            return
          }
          // Мутація самотесту: відкинуте за епохою завантаження не повторюється.
          if (ctx.defects.has("discard-no-retry")) return
          if (rulesOf(flight).discardedAnswer !== "pause-then-retry") return
          const pause =
            DISCARD_PAUSE_MS * 2 ** Math.max(0, session.versions.discards() - 1)
          s.targetState = slotChanged(s.targetState, {
            kind: "paused",
            retryAt: ctx.now() + pause,
          })
          // Мутація самотесту: пауза не кінчається.
          const slept = ctx.defects.has("retry-sleeps-forever")
            ? new Promise<void>(() => {})
            : session.sleep(pause)
          return slept.then(() => {
            s.targetState = slotChanged(s.targetState, { kind: "pause-ended" })
            return token.valid ? retry("M8") : undefined
          })
        },
        (error: unknown) => {
          settleLoad({
            flight,
            number,
            verdict,
            failure: { error },
            report: {},
          })
        }
      )
    }
    // Відмову читання обробляє `attempt`, тож ланцюг не відхиляється.
    void attempt(admitted).finally(() => {
      if (s.targetState.flight !== gen) return
      // Кінець ланцюга: місце вільне; черга й відкладена перевірка — забрані
      // (наступне завантаження — лише живої цілі), їх запускає код нижче.
      const queued = s.targetState.trailing
      const rechecked = s.targetState.recheck
      s.targetState = slotChanged(s.targetState, {
        kind: "freed",
        alive: s.alive,
      })
      // Вигляд у польоті — не ціль планувальника: `commit` відповіді був до
      // цього рядка, тож перепланування потрібне й тут.
      ctx.touchSchedule()
      s.settled = true
      resolveWaiters(s)
      // Закриття гасить `alive` (`close()` реєстру), а `closed` наступного
      // завантаження судить шлюз у `load`.
      if (queued !== undefined && s.alive) load(s, { ...queued, site: "M6" })
      // Шапка змінилась під час польоту: перевірка, відкладена до кінця
      // читання, не губиться (захист ревізією — від повторів). Її ставив і
      // `preload` без слухачів (`hide` власника в польоті першого
      // завантаження ТЧ), тож слухачі тут не умова: інакше ТЧ лишається
      // порожньою й `ready` до монтування.
      if (rechecked !== undefined) {
        if (
          s.alive &&
          (s.listeners.size > 0 || !ctx.defects.has("recheck-needs-listeners"))
        )
          queueCheck(s, true, rechecked)
      }
    })
  }

  /**
   * The cursor of a window edge: the visible value of the edge row, or of
   * the nearest row inward when the edge row shows no value (removed,
   * hidden). `undefined` — no row shows a value, so there is nothing to
   * continue from.
   */
  function edgeCursor(
    s: Subset,
    direction: "after" | "before"
  ): { cursor: WindowCursor | undefined } | undefined {
    if (s.window === undefined) return undefined
    const o = s.form.object
    const spec = s.form.spec
    if (spec.kind !== "full" && spec.kind !== "window") return undefined
    const frontier = s.window.frontier[direction]
    if (frontier !== undefined) return { cursor: frontier }
    const keys = keysOfPages(s.window.pages)
    // Вікно без рядків, що не дійшло до кінця (фільтр нічого не знайшов у
    // першому читанні, чи сторінки спорожнив purge), іде далі від початку
    // порядку: сторінка читає серверний фільтр.
    // Лише завершене й не перезапущене читання: до першого завантаження
    // (чи після його відмови) це було б другим читанням того самого.
    if (keys.length === 0)
      return direction === "after" &&
        s.loaded &&
        s.targetState.flight === undefined
        ? { cursor: undefined }
        : undefined
    if (direction === "after") keys.reverse()
    for (const key of keys) {
      const e = o.rows.get(key)
      const values =
        e === undefined || e.removed !== undefined ? undefined : visibleRow(e)
      if (values !== undefined)
        return {
          cursor: cursorOf(spec.orderBy ?? [], o.entry.keyName, values),
        }
    }
    return undefined
  }

  /**
   * Reads the page next to an edge of the window (a user action or a host
   * reaching the edge). One read per direction; its generation lives in
   * `s.paging` and the result is written only while it is still there: a new
   * chain or a purge takes it away. A read whose answer the session
   * discarded repeats after a growing pause, as a load.
   */
  function loadMore(s: Subset, direction: "after" | "before") {
    const w = s.window
    if (w === undefined || !s.alive || s.purged) return
    const target = {
      kind: "page",
      object: s.form.object.name,
      id: s.targetId,
    } as const
    const admitted = admitView(USER_PAGE, target)
    if (!isPermit(admitted)) return
    if (direction === "after" ? s.atEnd : w.atStart) return
    if (s.paging.has(direction)) return
    const edge = edgeCursor(s, direction)
    if (edge === undefined) return
    const { cursor } = edge
    // Токен читання сторінки: покоління цього читання. Новий ланцюжок
    // чи `purge` прибирає його з `paging`, і пізня відповідь нічого не пише:
    // вона могла б принести рядок, якого на мить `purge` у сховищі не було.
    const generation = ++pageGenerations
    s.paging.set(direction, generation)
    const token = session.childToken(
      () =>
        s.alive &&
        (ctx.defects.has("page-without-generation") ||
          s.paging.get(direction) === generation)
    )
    const what = `view ${s.form.specKey} page ${direction}`
    // Позначку знімаємо всередині `commit`, що пише результат, — до
    // сповіщення: підписник цієї сторінки може одразу просити наступну.
    // Покоління нового ланцюжка чи `purge` вона не чіпає.
    const release = () => {
      if (s.paging.get(direction) === generation) s.paging.delete(direction)
    }
    // Сторінка, яку записала попередня спроба цього читання: повтор за
    // вимогою «склад не підтверджено» (П15) стає на її місце.
    let written: number | undefined
    // Повтор сторінки питає шлюз у мить рішення, після дочірнього токена.
    const retry = (site: "P2" | "P3") => {
      const again = admitView({ reason: "retry", site }, target)
      return isPermit(again) ? attempt(again) : undefined
    }
    const attempt = (permit: Permit): Promise<void> => {
      const { why } = permit
      const lease = ctx.source.lease()
      const number = ctx.attempts.start("page", target, why)
      const flight = permit.flight({
        attempt: number,
        caller: s,
        lease,
        kind: "page",
        token,
      })
      const readEpoch = required(flight.epoch, "its start epoch")
      const verdict = { again: false, discarded: false }
      const settlePage = (entry: ViewEntry) =>
        settleView(s, target, what, entry, {
          // Відповідь, що вже відкинута чи ще не застосована, вимогу не
          // тримає: прапорець скидає лише ця спроба, до брами епох.
          beforeGate: () => {
            s.answerRejected = false
          },
          apply: ({ read }, scope) => {
            const before = s.window?.generation
            required(read, "its answer").write(scope)
            if (s.window?.generation !== before) written = s.window?.generation
            // Мутація самотесту: осідання сторінки знімає чужу вимогу «склад не
            // підтверджено», яку може зняти лише читання всього вигляду.
            if (ctx.defects.has("page-drops-requirement"))
              s.targetState = dropRequirementForDefect(
                s.targetState,
                "composition-unconfirmed"
              )
          },
          finish: () => {
            s.dirty = true
            // Відкинуте читання чи повтор за вимогою ще піде: позначка
            // тримає дублікати.
            if (!verdict.discarded && !verdict.again) release()
          },
        })
      return readGated(
        ctx,
        (c) =>
          readWindowMore(c, s, readEpoch, token, direction, cursor, written),
        flight
      ).then(
        (read) => {
          settlePage({ flight, number, read, verdict })
          if (verdict.again) {
            // Вимогу поставила власна відповідь сторінки (П15): P3.
            if (token.valid) {
              const repeated = retry("P3")
              if (repeated !== undefined) return repeated
            }
            release()
            return
          }
          // Сторінка вимоги не знімає (вона підтверджує лише себе), тож та сама
          // умова, що й після завантаження (§8.4, п. 7): вимога стоїть, і її
          // ніхто інший не прочитає — сторінка кличе системне перечитування
          // вигляду; склад змінює лише воно, як для завантаження. Токен
          // сторінки тут уже недійсний (позначку знято в `commit`): живість
          // вигляду й сесії перевіряє саме перечитування.
          if (!verdict.discarded) {
            ctx.readRequirement(s)
            return
          }
          if (!token.valid) return
          if (rulesOf(flight).discardedAnswer !== "pause-then-retry") return
          const pause =
            DISCARD_PAUSE_MS * 2 ** Math.max(0, session.versions.discards() - 1)
          return session
            .sleep(pause)
            .then(() => (token.valid ? retry("P2") : undefined))
        },
        (error: unknown) => {
          settlePage({ flight, number, verdict, failure: { error } })
        }
      )
    }
    // Відмову читання обробляє `attempt`, тож ланцюг не відхиляється.
    void attempt(admitted)
  }

  /** Mounted card: lazy fields absent or read with an older row version. */
  function cardStale(s: Subset): boolean {
    const o = s.form.object
    const key = s.form.keys[0]!
    const e = o.rows.get(key)
    if (e === undefined || e.removed !== undefined || e.row === undefined)
      return false
    if (e.stale.hidden !== undefined) return false
    const values = e.row.values
    return o.lazyFields.some(
      (f) => !Object.hasOwn(values, f) || lazyFieldStale(e, f)
    )
  }

  /**
   * The owner was hidden by `hide` after `epoch`: `hiddenAt` of its header,
   * or the mark of the key, which outlives the entry. A horizon mark is not
   * one: the tail re-read of the header resolves it, and the section follows
   * the header revision (Р36).
   */
  function hiddenAfter(o: ObjectState, owner: Key, epoch: number): boolean {
    return (
      (o.rows.get(owner)?.hiddenAt ?? -1) > epoch ||
      session.epochs.hiddenSince(keyId(o.name, owner), epoch)
    )
  }

  /**
   * A held section is stale (the single decision point for
   * mount, `preload` and the check after a `commit`): its owner was hidden
   * after the last accepted section read, there is neither a header nor
   * lines in the store, or the lines are older than the header.
   */
  function sectionStale(s: Subset): boolean {
    const spec = s.form.spec
    if (spec.kind !== "section") return false
    const o = s.form.object
    const e = o.rows.get(spec.owner)
    // Власник `removed` рядків не показує, і читання ТЧ їх не поверне (§6.2,
    // правило 5): перечитувати нічого.
    if (e?.removed !== undefined) return false
    // `hide` прибрав рядки ТЧ (`clearOwner`), а вентиль сховища відкидає
    // рядки з читання, старшого за позначку: значення повертає лише нове
    // читання ТЧ — хоч власника тримає вигляд без шапки в сховищі, хоч
    // перше завантаження було в польоті під час `hide`.
    if (
      !ctx.defects.has("section-ignores-hide") &&
      hiddenAfter(o, spec.owner, s.targetState.sectionRead ?? -1)
    )
      return true
    const lines = o.sections.get(spec.owner, spec.section)
    // Без шапки й без рядків стан ТЧ невідомий: позначку `hide` могло
    // витіснити (`tombstonesMax`), а рядки прибрано.
    if (e === undefined) return lines === undefined
    if (e.stale.hidden !== undefined) return false
    return (
      lines === undefined ||
      lines.staleEpoch === true ||
      sectionLinesStale(lines, e)
    )
  }

  /**
   * A `hide` of the section's owner (or an evicted mark that might have
   * been one) came after the start of its last read: the read cannot have
   * seen it, so the re-read is not a repeat of a discarded answer.
   */
  function hiddenSinceRead(s: Subset): boolean {
    const spec = s.form.spec
    if (spec.kind !== "section") return false
    const o = s.form.object
    const start = s.targetState.readStart ?? -1
    return (
      hiddenAfter(o, spec.owner, start) ||
      session.epochs.evictedSince(keyId(o.name, spec.owner), start)
    )
  }

  /**
   * Дочитування змонтованого вигляду (§6.2, правило 2): лише коли шапка
   * змінилась після останнього читання — відкинута відповідь не крутить
   * повторів. ТЧ-підмножину перечитує й `hide` власника, новіший за
   * останнє читання: шапки без запису ревізія не бачить. `held` — перевірка
   * з `preload`, без слухача.
   */
  function check(s: Subset, held: boolean, why: ReadWhy) {
    if (!s.alive || s.purged) return
    if (!held && s.listeners.size === 0) return
    if (s.targetState.flight !== undefined) {
      s.targetState = slotChanged(s.targetState, { kind: "recheck", why })
      return
    }
    if (behindHeader(s)) load(s, why)
  }

  /**
   * Картка чи ТЧ відстала від шапки (вимога «ціль відстала від шапки»): одне
   * означення для перевірки й для діагностики `sync()`.
   */
  function behindHeader(s: Subset): boolean {
    const header = headerKey(s)
    if (header === undefined) return false
    const stale = s.form.spec.kind === "card" ? cardStale(s) : sectionStale(s)
    if (!stale) return false
    return (
      rowViews.revision(s.form.object.name, header) !==
        s.targetState.readRevision || hiddenSinceRead(s)
    )
  }

  /**
   * The first hold starts the subset; a card with a stored row shows it
   * without a read. A held subset is checked on mount, and a section on
   * `preload` too: a stale section (`sectionStale`) is re-read once observed.
   */
  function start(s: Subset, mounted: boolean) {
    if (s.targetState.gen > 0 || s.settled) {
      if (mounted) check(s, false, CHECK_ON_MOUNT)
      else if (s.form.spec.kind === "section") check(s, true, CHECK_ON_MOUNT)
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
      if (mounted) check(s, false, CHECK_ON_MOUNT)
      return
    }
    load(s, { reason: "mount", site: mounted ? "M1" : "M2" })
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
    return s.listeners.size === 0 && s.preloads === 0 && !s.hydrated
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
      targetId: nextTargetId++,
      listeners: new Set(),
      preloads: 0,
      preloadTimers: new Set(),
      releaseTimer: undefined,
      alive: true,
      targetState: createTargetState(),
      settled: false,
      loaded: false,
      rereads: 0,
      owned: new Set(),
      included: new Map(),
      layout: form.spec.kind === "card" ? [form.spec.key] : [],
      layoutSet: new Set(form.spec.kind === "card" ? [form.spec.key] : []),
      status: "loading",
      error: undefined,
      needsRefresh: false,
      hasNewRows: false,
      strategy:
        form.spec.kind === "full"
          ? "full"
          : form.spec.kind === "window"
            ? "window"
            : undefined,
      truncated: false,
      atEnd: form.spec.kind === "full",
      window: form.spec.kind === "window" ? EMPTY_WINDOW : undefined,
      paging: new Map(),
      waiters: [],
      dirty: true,
      // Знімок без утримання — той самий LOADING: перша підписка не дає
      // зайвого кадру з рівним знімком.
      snapshot: form.spec.kind === "card" ? undefined : LOADING,
      refViews: new Map(),
      checkQueued: false,
      checkHeld: false,
      purged: false,
      hydrated: false,
      headerState: undefined,
      answerRejected: false,
    }
    subsets.set(form.specKey, s)
    ctx.touchSubscriptions()
    return s
  }

  // ------------------------------------------------------------ знімки

  const viewOf = (o: ObjectState, key: Key) =>
    rowViews.get(o.name, key, o.rows.get(key), o.lazyFields)

  // Об'єкт каналу — з топіка, один розбір на канал.
  const channelObjects = new Map<string, string | undefined>()
  // Склад вигляду після розриву (§8.4): кожен утримуваний канал його об'єкта
  // доведено читанням, що успішно осіло й почалось не раніше приєднання після
  // останнього розриву; відпущений з записом — точково (`channelProven`).
  // Вимога «склад не підтверджено з e» (§8.4, п. 7) — той самий факт: поки
  // вона стоїть, склад не підтверджено в будь-якого вигляду, видимого чи ні.
  // Похідна від епох і вимоги, без власного стану.
  function staleComposition(s: Subset): boolean {
    if (requirementOf(s.targetState, "composition-unconfirmed") !== undefined)
      return true
    const { epochs } = session
    if (!epochs.gapped()) return false
    const id = s.form.object.entry.id
    const read = s.targetState.okReadEpoch ?? -1
    const unproven = (channel: string) => {
      let object = channelObjects.get(channel)
      if (object === undefined && !channelObjects.has(channel)) {
        object = changesObjectOf(channel)
        channelObjects.set(channel, object)
      }
      return object === id && !epochs.channelProven(channel, read)
    }
    for (const channel of epochs.heldChannels())
      if (unproven(channel)) return true
    for (const channel of epochs.released()) if (unproven(channel)) return true
    return false
  }

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
        o.rows.get(spec.owner)?.stale.hidden !== undefined
      section = {
        ownerVersion: hidden ? undefined : entry?.ownerVersion,
        complete: hidden ? false : (entry?.complete ?? false),
        lines: hidden ? NO_LINES : (entry?.lines ?? NO_LINES),
        // Без шапки в сховищі стан власника невідомий.
        ownerState: header?.state ?? s.headerState ?? "unknown",
      }
    } else {
      const refViews = new Map<Key, RowView>()
      for (const key of s.layout) {
        let base = viewOf(o, key)
        // Дефект самотесту: вікно тримає копію показаних значень і показує
        // її, коли сховище значень уже не дає (копія значень у вікні заборонена, Рд20).
        if (ctx.defects.has("window-copies-values") && s.window !== undefined) {
          const kept = copiesOf(s)
          if (
            base !== undefined &&
            base.state !== "removed" &&
            base.hidden !== true
          )
            kept.set(key, base)
          else if (kept.has(key)) base = kept.get(key)
        }
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
      // Невидимий вигляд читає непідтверджений склад лише на переході у
      // видимість, а будь-який на прихованій вкладці — на `resume()` (§8.4,
      // п. 7): до того знімок це показує. Це вивід із вимоги, не збережена
      // ознака: її знімає те саме читання, що знімає вимогу.
      needsRefresh:
        s.needsRefresh ||
        (requirementOf(s.targetState, "composition-unconfirmed") !==
          undefined &&
          (!isVisible(s.targetState) || ctx.tabHidden())),
      ...(ctx.isStale(o.name) ? { isStale: true } : {}),
      ...(staleComposition(s) ? { staleComposition: true } : {}),
      ...(section === undefined ? {} : { section }),
      ...(spec.kind === "full" || spec.kind === "window"
        ? { strategy: s.strategy, truncated: s.truncated, atEnd: s.atEnd }
        : {}),
      ...(s.window === undefined
        ? {}
        : {
            atStart: s.window.atStart,
            chain: s.window.chain,
            target: s.window.target,
          }),
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
    if (ctx.dirtyObjects().has(o.name)) return true
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

  function queueCheck(s: Subset, held: boolean, why: ReadWhy) {
    if (held) s.checkHeld = true
    if (s.checkQueued || headerKey(s) === undefined) return
    s.checkQueued = true
    // Не з середини сповіщення: дочитування — власний `commit`.
    queueMicrotask(() => {
      s.checkQueued = false
      const heldCheck = s.checkHeld
      s.checkHeld = false
      try {
        // `why` — виклику, що поставив перевірку в чергу: наступні виклики до
        // мікрозадачі вже вийшли на `checkQueued`.
        // Закриття гасить `alive` раніше, ніж біжить мікрозадача: `closed`
        // завантаження судить шлюз у `load`.
        check(s, heldCheck, why)
      } finally {
        // Хвіст `revalidate` чекав цю перевірку як продовження польоту: без
        // нового читання його будимо тут (#312), зокрема й після винятку.
        if (s.targetState.flight === undefined) resolveWaiters(s)
      }
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
      ...(ctx.isStale(form.object.name) ? { isStale: true } : {}),
    })
    return prev.snapshot
  }

  const closedHandle = (): ViewHandle => ({
    getSnapshot: () => ctx.closedSnapshot()!,
    subscribe: () => () => {},
    refresh() {},
    showNew() {},
    loadBefore() {},
    loadAfter() {},
    setVisibleRange() {},
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
        subscribersChanged(s)
        // Знімок показує непідтверджений склад залежно від видимості.
        if (
          requirementOf(s.targetState, "composition-unconfirmed") !== undefined
        )
          s.dirty = true
        if (s.releaseTimer !== undefined) clearTimeout(s.releaseTimer)
        s.releaseTimer = undefined
        // Перша підписка знімає утримання `preload` і знімка гідратації.
        s.preloads = 0
        s.hydrated = false
        for (const timer of s.preloadTimers) clearTimeout(timer)
        s.preloadTimers.clear()
        start(s, true)
        ctx.becameVisible(s)
        ctx.touchSchedule()
        let done = false
        return () => {
          if (done) return
          done = true
          s.listeners.delete(entry)
          subscribersChanged(s)
          if (
            requirementOf(s.targetState, "composition-unconfirmed") !==
            undefined
          )
            s.dirty = true
          ctx.touchSchedule()
          if (s.alive && idle(s) && !isClosed()) scheduleRelease(s)
        }
      },
      // Несумісний об'єкт не читається (§10): `load` питає шлюз (M5), і
      // вигляд лишається `isStale`.
      refresh() {
        const s = live()
        if (s !== undefined) load(s, USER_LOAD)
      },
      showNew() {
        const s = live()
        if (s !== undefined) load(s, USER_LOAD)
      },
      loadBefore() {
        const s = live()
        if (s !== undefined) loadMore(s, "before")
      },
      loadAfter() {
        const s = live()
        if (s !== undefined) loadMore(s, "after")
      },
      // Без дії в М3: яруси, які він веде, — #206.
      setVisibleRange() {},
    }
  }

  return {
    behindHeader: (s) => s.alive && !s.purged && behindHeader(s),
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
      // Публічний виклик закритого ядра (рішення архітекторки 26.11): без
      // відмови тут `acquire` тримав би вигляд після закриття, а `load`, якому
      // шлюз відмовляє, не осідає — обіцянка не виконалась би.
      if (ctx.closed()) return Promise.resolve()
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
    formOf: (spec) => formOf(ctx, spec),
    load,

    adopt(scope, form, state) {
      const s = acquire(form)
      const o = form.object
      const spec = form.spec
      s.owned = diffOwn(ops, scope, o, new Set(), [
        ...state.layout,
        ...state.unshown,
      ])
      // Картка тримає склад із ключа форми, ТЧ складу не має.
      if (spec.kind !== "card" && spec.kind !== "section") {
        s.layout = state.layout.filter((key) => s.owned.has(key))
        s.layoutSet = new Set(s.layout)
      }
      if (form.include.length > 0) {
        const wanted = includeKeys(
          form.include,
          s.layout.flatMap((key) => {
            const e = o.rows.get(key)
            const values = e === undefined ? undefined : visibleRow(e)
            return values === undefined ? [] : [values]
          })
        )
        s.included = new Map(
          [...wanted].map(([name, keys]) => [
            name,
            diffOwn(ops, scope, ctx.objectOf(name), new Set(), keys),
          ])
        )
      }
      if (spec.kind === "full" || spec.kind === "window") {
        s.window = state.window
        s.strategy = state.window === undefined ? "full" : "window"
        s.atEnd = state.atEnd
        s.truncated = state.truncated
      }
      if (spec.kind === "section") {
        // Читання ТЧ, що пройшло до знімка, свіже на мить гідратації: `hide`
        // власника лише після неї вимагає перечитування. Запис — новий:
        // гідратація відмовляє ядру, що вже тримає вигляди (`hydrate`).
        s.targetState = createTargetState({
          sectionRead: state.at,
          readStart: state.at,
        })
        s.headerState = state.ownerState
      }
      s.loaded = true
      s.settled = true
      s.status = "ready"
      s.snapshot = undefined
      s.dirty = true
      s.hydrated = true
    },

    endHydration() {
      for (const s of subsets.values()) {
        if (!s.hydrated) continue
        s.hydrated = false
        if (idle(s)) scheduleRelease(s)
      }
    },

    afterCommit(closing) {
      const notify: Subset[] = []
      for (const s of subsets.values()) {
        if (!closing && !s.dirty && !affected(s)) continue
        s.dirty = true
        if (s.listeners.size === 0) continue
        const before = s.snapshot
        if (snapshotOf(s) !== before) notify.push(s)
        // Пачка закриття теж ставить перевірку: її мікрозадача біжить уже
        // після `close()` реєстру й бачить `alive === false`; `closed`
        // дочитування судить шлюз у `load`.
        queueCheck(s, false, CHECK_AFTER_COMMIT)
      }
      return notify
    },

    forgetChannel(channel) {
      channelObjects.delete(channel)
    },

    close() {
      channelObjects.clear()
      // Жодне значення рядка не переживає закриття навіть у пам'яті
      // підмножин чи хендлів, на які ще тримають посилання.
      for (const s of subsets.values()) {
        s.alive = false
        s.listeners.clear()
        subscribersChanged(s)
        cancelTimers(s)
        resolveWaiters(s)
        s.snapshot = undefined
        s.refViews.clear()
        s.owned = new Set()
        s.included = new Map()
        s.layout = []
        s.layoutSet = new Set()
        s.window = undefined
        s.paging.clear()
      }
      for (const cache of idleCaches.values()) delete cache.snapshot
      idleCaches.clear()
      subsets.clear()
      handles.clear()
    },
  }
}
