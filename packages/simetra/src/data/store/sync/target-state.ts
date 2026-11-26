import type { Evidence } from "./evidence"
import { FLIGHT_KIND_RULES, type FlightKind } from "./flight-kinds"
import type {
  ReadCause,
  ReadWhy,
  RequirementKind,
  SettleOutcome,
} from "./vocabulary"

/*
 * Стан цілі (спека ядра синхронізації §5.6, Р-SK3-1…6): свіжість цілі — одне
 * незмінне значення з групами «вимоги», «доказ», «польоти», «строк»,
 * «видимість», «ревізія». Модуль не знає рядків, сховищ і транспорту: входи
 * переходів — значення, які шлях рахує зі сховищ (повнота цілі за
 * предикатом, годинник, пауза відкинутих). Переходи — чисті
 * `(стан, вхід) → стан`; інших способів змінити запис немає. Власник запису
 * (вигляд, ядро для службових цілей, черга ключів об'єкта) лише зберігає
 * результат переходу.
 */

/**
 * Види вимог, що живуть у записі цілі. «Шапка власника» ще не в словнику:
 * вид додає задача 10 плану SK-3, тоді `Extract` лишається без другого
 * доданка.
 */
export type StoredRequirementKind =
  | Extract<RequirementKind, "composition-unconfirmed" | "target-behind-header">
  | "owner-header"

interface RequirementBase {
  readonly kind: StoredRequirementKind
  /** Епоха сесії в мить постановки; доказ має стартувати не раніше неї. */
  readonly since: number
}

/** Склад вигляду не підтверджено з `since` (§5.2). */
export interface CompositionRequirement extends RequirementBase {
  readonly kind: "composition-unconfirmed"
}

/**
 * Ціль відстала від шапки (рядок 20): `barrier` — вимогу поставив бар'єр
 * знімка, тож її знімає системне перечитування, а не завантаження цілі.
 */
export interface BehindHeaderRequirement extends RequirementBase {
  readonly kind: "target-behind-header"
  readonly barrier: boolean
}

/**
 * Шапка власника ТЧ (рядок 22): `mark` — ідентифікатор позначки `removed`,
 * що її породила; повторна позначка того самого ідентифікатора зсуває
 * `since`, а не ставить нової вимоги.
 */
export interface OwnerHeaderRequirement extends RequirementBase {
  readonly kind: "owner-header"
  readonly mark: number
}

export type Requirement =
  CompositionRequirement | BehindHeaderRequirement | OwnerHeaderRequirement

/** Запис цілі. Поля `readonly`: змінює їх лише перехід цього файлу. */
export interface TargetState {
  // вимоги
  /** Не більше однієї вимоги кожного виду. */
  readonly requirements: readonly Requirement[]

  // доказ
  /** Старт останнього застосованого читання, що підтверджує ціль. */
  readonly okReadEpoch: number | undefined
  /** Ревізія шапки на старті останнього застосованого завантаження картки чи ТЧ. */
  readonly readRevision: number | undefined
  /** Епоха старту того завантаження. */
  readonly readStart: number | undefined
  /** Епоха старту останнього застосованого читання ТЧ. */
  readonly sectionRead: number | undefined
  /** Епоха старту останнього застосованого завантаження ТЧ з частиною шапки. */
  readonly ownerHeaderRead: number | undefined

  // польоти
  /** Покоління завантажень: пише лише поточне. */
  readonly gen: number
  /** Покоління польоту в польоті (завантаження, службове читання, хвіст ключів). */
  readonly flight: number | undefined
  /** Епоха старту польоту в польоті. */
  readonly flightEpoch: number | undefined
  /** Причина польоту в польоті: лише діагностика. */
  readonly flightCause: ReadCause | undefined
  /** Ревізія шапки на старті завантаження в польоті. */
  readonly flightRevision: number | undefined
  /** Наступне завантаження в черзі й причина першого запиту злитої черги. */
  readonly trailing: ReadCause | undefined
  /** Перевірка, що чекає кінця польоту, під рядком першої, що її відклала. */
  readonly recheck: ReadWhy | undefined
  /** Епохи старту системних перечитувань у польоті. */
  readonly rereadEpochs: readonly number[]
  /** Хвіст явного перечитування, що чекає цілі в польоті. */
  readonly rereadTail: Promise<void> | undefined
  /** Ті, хто чекає осідання системного перечитування. */
  readonly rereadWaiters: readonly (() => void)[]

  // строк
  /** Старт останнього застосованого читання, що рухає строк. */
  readonly refreshedAt: number | undefined
  /** Збої поспіль; успіх скидає. Відкинуте збоєм не є. */
  readonly failures: number
  readonly failedAt: number | undefined
  /** Пробудження паузи відкинутих (облік `sync()`): політ тоді ще стоїть. */
  readonly retryAt: number | undefined

  // видимість
  /** Явна видимість (`setVisible`); без неї ціль видима, поки є підписники. */
  readonly visible: boolean | undefined
  readonly subscribers: number

  // ревізія
  /** Лічильник змін входів похідних свіжості; кеш знімка тримає свою. */
  readonly revision: number
}

/** Початковий запис: ціль без вимог, доказів і польотів. */
export function createTargetState(): TargetState {
  return {
    requirements: [],
    okReadEpoch: undefined,
    readRevision: undefined,
    readStart: undefined,
    sectionRead: undefined,
    ownerHeaderRead: undefined,
    gen: 0,
    flight: undefined,
    flightEpoch: undefined,
    flightCause: undefined,
    flightRevision: undefined,
    trailing: undefined,
    recheck: undefined,
    rereadEpochs: [],
    rereadTail: undefined,
    rereadWaiters: [],
    refreshedAt: undefined,
    failures: 0,
    failedAt: undefined,
    retryAt: undefined,
    visible: undefined,
    subscribers: 0,
    revision: 0,
  }
}

/** Вимога виду, якщо стоїть. */
export function requirementOf<K extends StoredRequirementKind>(
  state: TargetState,
  kind: K
): Extract<Requirement, { kind: K }> | undefined {
  return state.requirements.find(
    (r): r is Extract<Requirement, { kind: K }> => r.kind === kind
  )
}

/** Ефективна видимість: явна, інакше «є підписники» (одна функція запису). */
export function isVisible(state: TargetState): boolean {
  return state.visible ?? state.subscribers > 0
}

/*
 * Ревізія (Р-SK3-6): її рухає зміна входу похідних — вимоги складу, доказу
 * `okReadEpoch` і ефективної видимості, коли вимога складу стоїть. Вимоги
 * рядків 20 і 22 у похідні не входять і ревізії не рухають.
 */
const derivedInputs = (state: TargetState) =>
  [
    requirementOf(state, "composition-unconfirmed")?.since,
    state.okReadEpoch,
    requirementOf(state, "composition-unconfirmed") === undefined
      ? undefined
      : isVisible(state),
  ] as const

function withRevision(prev: TargetState, next: TargetState): TargetState {
  const a = derivedInputs(prev)
  const b = derivedInputs(next)
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
    ? next
    : { ...next, revision: prev.revision + 1 }
}

// ---------------------------------------------------------------------------
// Перехід 1: «політ стартував»
// ---------------------------------------------------------------------------

export interface FlightStart {
  readonly kind: FlightKind
  /** Епоха сесії в мить допуску. */
  readonly epoch: number
  readonly cause: ReadCause
  /** Ревізія шапки на старті (завантаження картки чи ТЧ). */
  readonly headerRevision?: number
  /** Перевірка, яку відкладає цей політ (`reread`: далі — після осідання). */
  readonly recheck?: ReadWhy
  /** Хвіст явного перечитування, що чекає цього польоту. */
  readonly tail?: Promise<void>
  /** Той, хто чекає осідання системного перечитування. */
  readonly waiter?: () => void
}

/**
 * Політ стартував. Завантаження, службове читання й хвіст ключів мають одне
 * місце польоту: коли воно зайняте, запит зливається в чергу (`trailing`,
 * причина першого запиту), а не стартує другий політ. Системні перечитування
 * летять разом; сторінка стану цілі не міняє (її позначки — власні).
 */
export function startFlight(
  state: TargetState,
  start: FlightStart
): TargetState {
  const withWaiters: TargetState = {
    ...state,
    ...(start.recheck !== undefined && state.recheck === undefined
      ? { recheck: start.recheck }
      : {}),
    ...(start.tail === undefined ? {} : { rereadTail: start.tail }),
    ...(start.waiter === undefined
      ? {}
      : { rereadWaiters: [...state.rereadWaiters, start.waiter] }),
  }
  switch (start.kind) {
    case "page":
      return withWaiters
    case "reread":
      return {
        ...withWaiters,
        // Старт перечитування й є тією перевіркою, що чекала.
        recheck: start.recheck === undefined ? undefined : withWaiters.recheck,
        rereadEpochs: [...state.rereadEpochs, start.epoch],
      }
    case "load":
    case "service":
    case "keys": {
      if (state.flight !== undefined)
        return {
          ...withWaiters,
          trailing: state.trailing ?? start.cause,
        }
      const gen = state.gen + 1
      return {
        ...withWaiters,
        gen,
        flight: gen,
        flightEpoch: start.epoch,
        flightCause: start.cause,
        flightRevision: start.headerRevision,
        trailing: undefined,
        retryAt: undefined,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Перехід 2: «політ осів з наслідком»
// ---------------------------------------------------------------------------

export interface SettleInput {
  readonly outcome: SettleOutcome
  readonly flight: FlightKind
  /** Доказ осідання; `undefined` там, де відповіді не було. */
  readonly evidence: Evidence | undefined
  /** Політ — читання самої цілі, а не чужий політ, що її покриває. */
  readonly own: boolean
  /** Покоління польоту (завантаження, службове, хвіст): чужого не знімаємо. */
  readonly gen?: number
  /** Епоха старту польоту: вона ж ключ системного перечитування. */
  readonly epoch: number
  /** Монотонний годинник на старті й на осіданні (строк, пауза збоїв). */
  readonly startedAt: number
  readonly now: number
  /** Ціль уже читалась успішно: збій завантаження рахує паузу лише тоді. */
  readonly loaded: boolean
  /** Пробудження паузи відкинутих, пораховане шляхом (сесійний лічильник відкинутих). */
  readonly retryAt?: number
  /** Ревізія шапки на старті: є в завантаження картки чи ТЧ. */
  readonly headerRevision?: number
  /** Завантаження ТЧ (пише `sectionRead`). */
  readonly section?: boolean
  /** Завантаження ТЧ несло частину шапки власника. */
  readonly carriedHeader?: boolean
  /** Чужий політ покриває ключ шапки цієї цілі. */
  readonly coversHeader?: boolean
  /** Після цього читання ціль повна за предикатом `cardStale`/`sectionStale`. */
  readonly complete?: boolean
}

/** Старт, який доказ підтверджує; `undefined` — доказ старту не дає. */
function startOf(evidence: Evidence | undefined): number | undefined {
  return evidence?.kind === "session-start" ? evidence.epoch : undefined
}

/**
 * Чи доказ і вид польоту знімають вимогу (колонки «Чим виконується» та «Яким
 * польотом» §5.2). Старт «не раніше» постановки: `start >= since`; на
 * `since − 1` вимога стоїть.
 */
function lifts(requirement: Requirement, input: SettleInput): boolean {
  if (input.outcome !== "applied") return false
  const start = startOf(input.evidence)
  if (start === undefined || start < requirement.since) return false
  switch (requirement.kind) {
    case "composition-unconfirmed":
      // Усе вигляд підтверджують лише його завантаження й системне
      // перечитування; сторінка підтверджує лише себе.
      return (
        input.own &&
        (input.flight === "load" || input.flight === "reread") &&
        FLIGHT_KIND_RULES[input.flight].confirms !== "own-page"
      )
    case "target-behind-header": {
      const own =
        input.own &&
        (input.flight === "load" ||
          (requirement.barrier && input.flight === "reread"))
      // Читання іншого польоту, що покриває ключ шапки, знімає вимогу лише
      // коли після нього ціль повна (так `main` не шле зайвого читання).
      const other =
        !input.own && input.coversHeader === true && input.complete === true
      return own || other
    }
    case "owner-header":
      return (
        input.own && input.flight === "load" && input.carriedHeader === true
      )
  }
}

/**
 * Політ осів. Вимоги знімає лише застосоване читання з доказом потрібного
 * виду польоту й старту (`lifts`); збій, відкинуте за епохою, `evicted`,
 * `after-purge` і `closed` вимог не знімають і доказу не пишуть. Місце
 * польоту звільняється, крім відкинутого завантаження чи сторінки: політ тоді
 * стоїть під паузою `retryAt`, поки його не повторить `retry`.
 */
export function settleFlight(
  state: TargetState,
  input: SettleInput
): TargetState {
  const rules = FLIGHT_KIND_RULES[input.flight]
  const applied = input.outcome === "applied"
  const start = startOf(input.evidence)
  const discardedWithPause =
    input.outcome === "discarded-by-epoch" &&
    (rules.discarded === "pause-then-retry" ||
      rules.discarded === "pause-then-deadline")

  let next: TargetState = {
    ...state,
    requirements: state.requirements.filter((r) => !lifts(r, input)),
  }

  // Місце польоту.
  if (input.flight === "reread") {
    const at = next.rereadEpochs.indexOf(input.epoch)
    if (at !== -1)
      next = {
        ...next,
        rereadEpochs: next.rereadEpochs.filter((_, i) => i !== at),
      }
  } else if (input.flight !== "page") {
    const keepsFlight =
      discardedWithPause && rules.discarded === "pause-then-retry"
    if (!keepsFlight && input.gen === next.flight)
      next = {
        ...next,
        flight: undefined,
        flightEpoch: undefined,
        flightCause: undefined,
        flightRevision: undefined,
      }
  }

  // Пауза відкинутих; будь-яке інше осідання її скасовує.
  next = {
    ...next,
    retryAt: discardedWithPause ? input.retryAt : undefined,
  }

  if (applied && input.own && start !== undefined) {
    // Доказ ціли: лише вперед, пізніше застосоване раніше стартоване не
    // зсуває його назад.
    if (
      rules.confirms === "view-with-composition" ||
      rules.confirms === "view-stable" ||
      rules.confirms === "service"
    )
      next = { ...next, okReadEpoch: Math.max(next.okReadEpoch ?? -1, start) }
    if (input.flight === "load" && input.headerRevision !== undefined) {
      if (next.readStart === undefined || start >= next.readStart)
        next = {
          ...next,
          readStart: start,
          readRevision: input.headerRevision,
        }
      if (input.section === true)
        next = {
          ...next,
          sectionRead: Math.max(next.sectionRead ?? -1, start),
        }
    }
    if (input.flight === "load" && input.carriedHeader === true)
      next = {
        ...next,
        ownerHeaderRead: Math.max(next.ownerHeaderRead ?? -1, start),
      }
  }

  // Строк: успіх рухає його, збій рахує паузу збоїв за правилом виду.
  if (applied && input.own && rules.successMovesDeadline)
    next = {
      ...next,
      refreshedAt: input.startedAt,
      failures: 0,
      failedAt: undefined,
    }
  if (
    input.outcome === "failed" &&
    (rules.failureCounts === "always" ||
      (rules.failureCounts === "if-loaded" && input.loaded))
  )
    next = { ...next, failures: next.failures + 1, failedAt: input.now }

  return withRevision(state, next)
}

// ---------------------------------------------------------------------------
// Перехід 3: «поставлено вимогу»
// ---------------------------------------------------------------------------

/**
 * Вимога поставлена. Нова не знижує вже стоячої того ж виду: `since` — більше
 * з двох. Вимога «шапка власника» з іншим ідентифікатором позначки — нова
 * вимога; з тим самим — повторна позначка, що зсуває лише епоху. Вимога
 * бар'єра лишається вимогою бар'єра, доки шапка не змінила її на сувору.
 */
export function addRequirement(
  state: TargetState,
  requirement: Requirement
): TargetState {
  const stands = requirementOf(state, requirement.kind)
  let merged: Requirement = requirement
  if (stands !== undefined) {
    const since = Math.max(stands.since, requirement.since)
    if (stands.kind === "target-behind-header") {
      merged = {
        ...stands,
        since,
        barrier:
          stands.barrier && (requirement as BehindHeaderRequirement).barrier,
      }
    } else if (
      stands.kind === "owner-header" &&
      requirement.kind === "owner-header" &&
      stands.mark === requirement.mark
    ) {
      merged = { ...stands, since }
    } else if (stands.kind === "composition-unconfirmed") {
      merged = { ...stands, since }
    }
  }
  return withRevision(state, {
    ...state,
    requirements: [
      ...state.requirements.filter((r) => r.kind !== requirement.kind),
      merged,
    ],
  })
}

// ---------------------------------------------------------------------------
// Перехід 4: «видимість змінилась»
// ---------------------------------------------------------------------------

export interface VisibilityChange {
  /** Явна видимість; ключ відсутній — не міняти, `undefined` — зняти явну. */
  readonly visible?: boolean | undefined
  /** Число підписників. */
  readonly subscribers?: number
}

/**
 * Видимість змінилась. Ревізію рухає, лише коли ефективна видимість змінилась
 * за стоячої вимоги складу: похідні від неї без вимоги не залежать.
 */
export function changeVisibility(
  state: TargetState,
  change: VisibilityChange
): TargetState {
  return withRevision(state, {
    ...state,
    ...("visible" in change ? { visible: change.visible } : {}),
    ...(change.subscribers === undefined
      ? {}
      : { subscribers: change.subscribers }),
  })
}

// ---------------------------------------------------------------------------
// Перехід 5: «ціль відпущено»
// ---------------------------------------------------------------------------

/**
 * Ціль відпущено: черга, пауза й ті, що чекали перечитування, відпадають,
 * підписників немає. Вимог вона не знімає: їх знімає лише осідання з доказом.
 */
export function releaseTarget(state: TargetState): TargetState {
  return withRevision(state, {
    ...state,
    trailing: undefined,
    recheck: undefined,
    rereadTail: undefined,
    rereadWaiters: [],
    retryAt: undefined,
    subscribers: 0,
  })
}

// ---------------------------------------------------------------------------
// Перехід 6: «вхід похідних змінився»
// ---------------------------------------------------------------------------

/** Що змінилось поза записом (Р-SK3-4). */
export type DerivedInputChange =
  "tab-hidden" | "channel" | "registry-flag" | "affected"

/**
 * Вхід похідних змінився поза записом: рухає лише ревізію. Зміна `tab-hidden`
 * цілі без вимоги складу її не рухає — похідні від неї не залежать.
 */
export function derivedInputChanged(
  state: TargetState,
  change: DerivedInputChange
): TargetState {
  if (
    change === "tab-hidden" &&
    requirementOf(state, "composition-unconfirmed") === undefined
  )
    return state
  return { ...state, revision: state.revision + 1 }
}

// ---------------------------------------------------------------------------
// Похідні (власного стану не мають)
// ---------------------------------------------------------------------------

/**
 * Склад вигляду не підтверджено: стоїть вимога складу, або канал об'єкта не
 * доведено читанням, що осіло (`channelUnproven(readEpoch)` — запит епох
 * сесії). Вимоги рядків 20 і 22 сюди не входять (Р-SK3-5).
 */
export function staleComposition(
  state: TargetState,
  channelUnproven: (okReadEpoch: number) => boolean
): boolean {
  return (
    requirementOf(state, "composition-unconfirmed") !== undefined ||
    channelUnproven(state.okReadEpoch ?? -1)
  )
}

/**
 * Похідна частина `needsRefresh`: вимога складу стоїть, а ціль чи вкладка
 * невидимі. Біт банера реєстру виглядів поєднується з нею в знімку.
 */
export function derivedNeedsRefresh(
  state: TargetState,
  tabHidden: boolean
): boolean {
  return (
    requirementOf(state, "composition-unconfirmed") !== undefined &&
    (!isVisible(state) || tabHidden)
  )
}

/** У польоті щось летить: пауза відкинутого завантаження — не політ. */
export function inFlight(state: TargetState): boolean {
  return (
    (state.flight !== undefined && state.retryAt === undefined) ||
    state.rereadEpochs.length > 0
  )
}

/**
 * Читання зі стартом не раніше `epoch` уже летить чи стоїть у черзі за
 * поточним: вимога з `since = epoch` обіцяна й іншого читання не потребує.
 */
export function promisedFrom(state: TargetState, epoch: number): boolean {
  if (state.rereadEpochs.some((at) => at >= epoch)) return true
  if (state.flight !== undefined && (state.flightEpoch ?? -1) >= epoch)
    return true
  // Хвіст й завантаження-наступник стартують після осідання поточного читання,
  // тобто з `epoch` чи пізніше.
  return state.rereadTail !== undefined || state.trailing !== undefined
}
