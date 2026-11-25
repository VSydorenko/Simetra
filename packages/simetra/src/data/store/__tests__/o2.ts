import { readResultFromWire, type ReadQuery } from "simetra/model"
import type { AttemptEvent } from "../attempts"
import type { SyncState, SyncTarget } from "../core"
import type { ViewSpec } from "../types"
import type { RequirementKind } from "../sync/vocabulary"
import type { FakeReadLog, FakeSource } from "../testing/fake-source"
import type { StampedEvent } from "./oracles"

/*
 * Оракул О2 (спека ядра синхронізації §5.13, план SK-0 Р-SK0-6, Р-SK0-7).
 * `sync()` каже, що ядро обіцяє; дотримання обіцянки судять незалежні
 * спостереження: події `watchReads`/`watchAttempts` і журнал фейкового
 * джерела. Поля `Subset` і `ReaderTarget` оракул не бачить.
 *  (а) у спокої кожна вимога має обіцянку (політ, чергу, строк) чи названу
 *      умову, і обіцянку дотримано;
 *  (б) вимога зникає лише разом з ціллю або з доказом свого виду.
 */

type Log = readonly FakeReadLog[]

/** Усе, що О2 бачить на мить кроку моделі. */
export interface O2Input {
  /** Час моделі. */
  readonly now: number
  readonly states: readonly SyncState[]
  readonly events: readonly StampedEvent[]
  readonly attempts: readonly AttemptEvent[]
  readonly fake: Pick<
    FakeSource,
    "log" | "pending" | "inFlight" | "index" | "rightsLog"
  >
  /**
   * Чи живий рядок цілі: рядок, якого немає в сховищі, зникає разом із
   * вимогою, а не з доказом. Без нього рядок вважається живим.
   */
  readonly rowAlive?: (object: string, key: string) => boolean
  /**
   * Шапка власника в сховищі `removed` для кожного тримача: є вигляд, що її
   * показує, і кожен показує її рядок як `removed` (читання не знайшло рядка).
   * Без жодного тримача це не доказ (звільнення тримача — рядок 20 §5.14).
   */
  readonly headerGone?: (object: string, key: string) => boolean
  /**
   * Скільки разів ключ вилучали зі сховища (`purge`): рядок, що вийшов і
   * повернувся між двома оцінками (кроки з читаннями в польоті О2 не судить),
   * — вже не той рядок, і його вимога зникла разом з ним.
   */
  readonly rowLife?: (object: string, key: string) => number
  /**
   * Чи має вигляд видимого тримача на видимій вкладці — за кроками самої
   * моделі, не за `sync()` (його умови судить сам оракул).
   */
  readonly holderVisible?: (target: SyncTarget) => boolean
  /** Затримка звільнення вигляду моделі: межа часу, поки ціль без власника йде з `sync()`. */
  readonly releaseDelayMs?: number
  /**
   * Скільки подій читання було в мить останнього кроку `join` моделі: читання,
   * що знімає вимогу, яка виросла з приєднання, стартує не раніше.
   */
  readonly lastJoin?: () => number | undefined
  /** Модель вилучила ключ власника (`purge`): картка чи ТЧ іде разом із ним. */
  readonly ownerPurged?: (object: string, key: string) => boolean
  /** Вигляд у стані `purged` за публічним знімком моделі: умова «вигляд знищено purge». */
  readonly purgedView?: (target: SyncTarget) => boolean
  /** Чи тримає ціль будь-яке утримання (підписник чи `preload`): без нього вона йде зі звільненням. */
  readonly targetHeld?: (target: SyncTarget) => boolean
  /**
   * Чи тримає вигляд підписник (видимість не питаємо). `preload` без підписника
   * тримачем не є: перевірку шапки після `commit` ядро ставить лише виглядам зі
   * слухачами (`subsets.ts::afterCommit`), тож картка під одним `preload` не
   * перечитується (рядок 17 §5.14).
   */
  readonly holderPresent?: (target: SyncTarget) => boolean
  /** Інтервал збіжності й межа паузи збоїв моделі: строк винятків 3 і 5 — їх сума. */
  readonly revalidateMs?: number
  /** Сховище не тримає жодного рядка (виняток рядка 6: строк знімка прав). */
  readonly storeEmpty?: boolean
}

/** Вхід кроку з тим, що оракул веде сам: вигляди, що вже застосували читання. */
export type O2Context = O2Input & {
  readonly applied: ReadonlySet<number>
  /** Вигляди, чия остання спроба завантаження збоїла: стан помилки першого завантаження. */
  readonly firstLoadFailed: ReadonlySet<number>
}

/**
 * Винятки О2: лише «Відомі прогалини `main`» спеки §5.13, кожна названа станом,
 * що її тримає (Р-SK0-7), а не умовою §5.3. З цим станом зникає й виняток:
 * тоді `main` сам читає, і обіцянку судить звичайне правило.
 */
export interface O2Exception {
  /** Рядок §5.14, що виняток закриває. */
  readonly rows: readonly number[]
  readonly kinds: readonly RequirementKind[]
  /**
   * Стан, що тримає виняток: `true` — доки стан є; `"bounded"` — виняток діє
   * не довше за `boundMs` від першого разу (з умовою, за якої `main` сам читає:
   * строк того шляху); `false` — виняток не діє.
   */
  readonly holds: (state: SyncState, input: O2Context) => boolean | "bounded"
  /** Межа часу моделі для `"bounded"`. */
  readonly boundMs?: (input: O2Context) => number | undefined
}

export const O2_EXCEPTIONS: readonly O2Exception[] = [
  // Рядок 6: строк знімка прав вимагає рядків у сховищі.
  {
    rows: [6],
    kinds: ["rights-unconfirmed"],
    holds: (_, input) => input.storeEmpty === true,
  },
  // Рядки 3 і 5: вимога складу вигляду після невдалого читання ключів приймача
  // чи відмови запису. Без видимого тримача на видимій вкладці `main` не читає
  // (названий стан); з ним читання йде за строком шляху — інтервал тримача
  // плюс пауза збоїв.
  {
    rows: [3, 5],
    kinds: ["composition-unconfirmed"],
    holds: (state, input) =>
      state.target.kind !== "view" || input.holderVisible === undefined
        ? false
        : input.holderVisible(state.target)
          ? "bounded"
          : true,
    boundMs: (input) =>
      input.revalidateMs === undefined ? undefined : 2 * input.revalidateMs,
  },
  // Рядки 2, 4, 12, 19: вимога рядка (мінімальна версія, недочитано, значення
  // сховано, епоха версій) без строку. Рядок читають вигляди-тримачі його
  // об'єкта: без видимого тримача на видимій вкладці `main` не читає (названий
  // стан), з ним читання йде за строком шляху.
  {
    rows: [2, 4, 12, 19],
    kinds: [
      "min-version",
      "row-unfinished",
      "value-hidden",
      "version-epoch-switched",
    ],
    holds: (state, input) => {
      const target = state.target
      if (target.kind !== "row" || input.holderVisible === undefined)
        return false
      const visible = input.states.some(
        (s) =>
          s.target.kind === "view" &&
          s.target.object === target.object &&
          input.holderVisible!(s.target)
      )
      return visible ? "bounded" : true
    },
    boundMs: (input) =>
      input.revalidateMs === undefined ? undefined : 2 * input.revalidateMs,
  },
  // Рядок 17: «ціль відстала від шапки» картки чи ТЧ читає лише ціль, яку
  // утримує підписник чи `preload`; без тримача читання немає (названий стан),
  // з тримачем — одразу, у межах інтервалу. Вимоги складу тієї ж цілі без
  // тримача теж не читає ніхто.
  {
    rows: [17],
    kinds: [
      "target-behind-header",
      "channel-rejoin",
      "composition-unconfirmed",
    ],
    holds: (state, input) =>
      state.target.kind !== "view" ||
      input.holderPresent === undefined ||
      (state.target.spec.kind !== "card" &&
        state.target.spec.kind !== "section")
        ? false
        : input.holderPresent(state.target)
          ? "bounded"
          : true,
    boundMs: (input) => input.revalidateMs,
  },
  // Рядок 18: вигляд, що жодного разу не застосував читання (перше завантаження
  // збоїло чи не закінчилось), планувальник не читає: його читає лише
  // `refresh()`. Без видимого тримача на видимій вкладці — названий стан; з
  // ним перше застосоване читання стартує не пізніше інтервалу плюс паузи
  // збоїв (межа О3 для видимих виглядів), інакше це дефект `main`.
  {
    rows: [18],
    kinds: [
      "composition-unconfirmed",
      "channel-rejoin",
      "target-behind-header",
    ],
    holds: (state, input) => {
      const target = state.target
      if (target.kind !== "view" || input.applied.has(target.id)) return false
      // Стан помилки першого завантаження: меж у часі немає, стан кінчається
      // першим застосованим читанням чи `refresh()`.
      if (input.firstLoadFailed.has(target.id)) return true
      if (input.holderVisible === undefined) return false
      return input.holderVisible(target) ? "bounded" : true
    },
    boundMs: (input) =>
      input.revalidateMs === undefined ? undefined : 2 * input.revalidateMs,
  },
]

/** Скільки разів спрацював кожен виняток (звіт про вжиті винятки). */
export const exceptionsUsed = new Map<number, number>()

/** Лічильник нуль — О2 порожній, а не зелений. */
export function assertEvaluated(count: number, where: string): void {
  if (count <= 0)
    throw new Error(`O2 evaluated no idle state with a requirement (${where})`)
}

export const targetKey = (target: SyncTarget): string =>
  target.kind === "view"
    ? `view:${target.id}`
    : target.kind === "row"
      ? `row:${target.object}\u0000${target.key}`
      : `service:${target.service}`

const describe = (target: SyncTarget): string =>
  target.kind === "view"
    ? `view ${target.id} of ${target.object}`
    : target.kind === "row"
      ? `row ${target.key} of ${target.object}`
      : `service ${target.service}`

/** Подія читання називає ціль: вигляд і сторінка — за ідентифікатором. */
export function eventNames(event: StampedEvent, target: SyncTarget): boolean {
  const named = event.target
  if (target.kind === "view")
    return (
      (named.kind === "view" || named.kind === "page") && named.id === target.id
    )
  if (target.kind === "service")
    return named.kind === "service" && named.service === target.service
  // Рядок читає читання ключів його об'єкта чи читання вигляду, що на старті
  // тримає саме цей рядок; вигляд того ж об'єкта, що рядка не тримає, — ні.
  return (
    (named.kind === "keys" && named.object === target.object) ||
    (named.kind === "view" &&
      event.held?.includes(`${target.object}\u0000${target.key}`) === true)
  )
}

const objectName = (query: ReadQuery) =>
  `${query.object.kind}.${query.object.name}`

/** Версії рядків, які несуть відповіді записів журналу (рядок, `included`, маркер `known`). */
function deliveredRows(
  entries: Log,
  index: FakeSource["index"]
): Map<string, number> {
  const out = new Map<string, number>()
  const put = (object: string, key: string, version: number) => {
    const at = `${object}\u0000${key}`
    out.set(at, Math.max(out.get(at) ?? -1, version))
  }
  for (const entry of entries) {
    if (entry.response === undefined || entry.query === undefined) continue
    if ("tabularSection" in entry.query) continue
    let result: ReturnType<typeof readResultFromWire>
    try {
      result = readResultFromWire(index, entry.query, entry.response)
    } catch {
      continue
    }
    if (!("rows" in result)) continue
    const object = objectName(entry.query)
    for (const row of result.rows) {
      if ("ref" in row) put(object, row.ref as string, row.version as number)
      else {
        const marked = entry.known?.keys[(row as { known: number }).known]
        // Маркер підтверджує ключ у версії, яку несе `known`.
        if (marked !== undefined) put(object, marked as string, Infinity)
      }
    }
    for (const [name, targets] of Object.entries(result.included ?? {}))
      for (const row of targets)
        put(name, row.ref as string, row.version as number)
  }
  return out
}

/** Вікно між двома станами спокою: те, що сталося, поки вимога стояла. */
interface Window {
  readonly events: readonly StampedEvent[]
  readonly attempts: readonly AttemptEvent[]
  readonly log: Log
  readonly input: O2Input
  readonly rows: Map<string, number>
}

/** Застосоване завантаження чи системне перечитування вигляду у вікні. */
const viewRead = (w: Window, target: SyncTarget): boolean =>
  target.kind === "view" &&
  w.attempts.some(
    (a) =>
      a.phase === "settled" &&
      a.outcome === "applied" &&
      a.kind !== "page" &&
      a.target.id === target.id
  )

/** Відповідь частини службового читання, надісланої у вікні. */
const serviceAnswered = (w: Window, target: SyncTarget): boolean => {
  if (target.kind !== "service") return false
  const sent = w.events.filter((e) => eventNames(e, target))
  if (target.service === "version") return sent.length > 0
  return sent.some((e) =>
    w.input.fake.rightsLog.some(
      (r) => r.request === e.journal && r.response !== undefined
    )
  )
}

/** Відповідь у журналі несе рядок у версії не нижчій за `version`. */
const carriesRow = (
  w: Window,
  target: SyncTarget,
  version: number | undefined
): boolean => {
  if (target.kind !== "row") return false
  const got = w.rows.get(`${target.object}\u0000${target.key}`)
  return got !== undefined && got >= (version ?? -1)
}

/**
 * Таблиця доказів: по рядку на вид вимоги §5.2, що `main` має. Доказ — те, що
 * ядро не може вигадати: застосована спроба вигляду, відповідь у журналі
 * фейкового джерела. Сторінка доказом не є: вона підтверджує лише себе.
 */
export const PROOFS: Readonly<
  Record<
    RequirementKind,
    (
      w: Window,
      target: SyncTarget,
      requirement: { version?: number }
    ) => boolean
  >
> = {
  // Склад вигляду: осіло завантаження чи перечитування цього вигляду.
  "composition-unconfirmed": (w, t) => viewRead(w, t),
  "channel-rejoin": (w, t) => viewRead(w, t),
  "hydration-trust": (w, t) => viewRead(w, t),
  // Запит вигляду після відповіді прав, що звузила доступ.
  "access-narrowed": (w, t) => viewRead(w, t),
  "target-behind-header": (w, t) => viewRead(w, t),
  // Позначка рядка: будь-яка відповідь, що несе рядок.
  "min-version": (w, t, r) => carriesRow(w, t, r.version),
  "value-hidden": (w, t) => carriesRow(w, t, undefined),
  "row-unfinished": (w, t) => carriesRow(w, t, undefined),
  "version-epoch-switched": (w, t) => carriesRow(w, t, undefined),
  "rights-unconfirmed": (w, t) => serviceAnswered(w, t),
  "version-unconfirmed": (w, t) => serviceAnswered(w, t),
}

/** Ключі рядків, які вигляд читає за власником: власник ТЧ, ключ картки, ключі `keys`. */
/**
 * Вигляд читає шапку власника `owner`: вигляд ключів, що містить власника, чи
 * картка власника. Секція шапки не читає (вона перечитує рядки ТЧ), тож не є ні
 * доказом зникнення шапки в О2, ні її тримачем в О3.
 */
export const readsHeader = (spec: ViewSpec, owner: string): boolean =>
  (spec.kind === "keys" && spec.keys.includes(owner)) ||
  (spec.kind === "card" && spec.key === owner)

function ownerKeys(target: SyncTarget): readonly string[] {
  if (target.kind !== "view") return []
  const spec = target.spec
  return spec.kind === "section"
    ? [spec.owner]
    : spec.kind === "card"
      ? [spec.key]
      : spec.kind === "keys"
        ? spec.keys
        : []
}

/**
 * `hide` власника замінює вимогу вигляду на «значення сховано» його рядка: нова
 * вимога стоїть на ключі власника й у попередньому знімку її не було.
 */
function hiddenOwner(
  target: SyncTarget,
  states: readonly SyncState[],
  previous: Snapshot | undefined
): boolean {
  if (target.kind !== "view") return false
  const keys = ownerKeys(target)
  return states.some((s) => {
    if (
      s.target.kind !== "row" ||
      s.target.object !== target.object ||
      !keys.includes(s.target.key) ||
      !s.requirements.some((r) => r.kind === "value-hidden")
    )
      return false
    const was = previous?.targets.get(targetKey(s.target))
    return !was?.requirements.some((r) => r.kind === "value-hidden")
  })
}

/**
 * Вимога, що на `main` змінює вид: перемикання епохи версій замінює «мінімальну
 * версію» вимогою свого виду (`object-store.ts`, `onSwitch`); `hide` власника
 * замінює похідну вимогу на «значення сховано» рядків об'єкта.
 */
const REPLACED_BY: Partial<Record<RequirementKind, RequirementKind[]>> = {
  "min-version": ["version-epoch-switched"],
  "target-behind-header": ["value-hidden"],
  "hydration-trust": ["value-hidden"],
}

interface Obligation {
  readonly kind: "queue" | "due"
  readonly since: number
  due: number
}

interface Snapshot {
  readonly targets: ReadonlyMap<
    string,
    {
      readonly target: SyncTarget
      readonly requirements: SyncState["requirements"]
    }
  >
  readonly events: number
  readonly attempts: number
  readonly log: number
  readonly lives: ReadonlyMap<string, number>
}

export interface O2 {
  /** Крок моделі: порушення О2 чи `undefined`. */
  step(input: O2Input): string | undefined
  /** Станів спокою з ≥ 1 вимогою, які О2 справді оцінив. */
  evaluated(): number
}

/**
 * Що ядро ще винне цілі, вимога якої зникла без доказу за винятком таблиці:
 * `leave` — ціль мусить піти з `sync()` до кінця затримки звільнення; `read` —
 * читання цілі, межа якого — інтервал плюс пауза збоїв від появи видимого
 * тримача; `retry` — вимогу зняла спроба, відкинута за епохою: наступне читання
 * цілі стартує не пізніше кінця паузи повтору (строк із причиною `retry` у
 * `sync()`), а для невидимого вигляду — плюс інтервал.
 */
interface FollowUp {
  readonly kind: "leave" | "read" | "retry"
  readonly sinceEvent: number
  sinceTime: number | undefined
  holderSince: number | undefined
  /** `retry`: межа початку читання — кінець паузи повтору, щойно її видно в `sync()`. */
  deadline?: number
}

export function createO2(): O2 {
  const followUps = new Map<string, FollowUp>()
  // Вигляд → мітка `join` моделі, з якої виросла вимога складу після приєднання.
  const rejoined = new Map<string, number>()
  let count = 0
  let previous: Snapshot | undefined
  const obligations = new Map<string, Obligation>()

  /** Політ без запиту без відповіді, чия подія називає ціль. */
  const flightProblems = (input: O2Input): string[] => {
    const { fake, events, states } = input
    // Польотів немає — нічого судити (вибірка журналу дорога на кожному кроці).
    if (!states.some((s) => s.flights.length > 0)) return []
    const open = new Set(
      fake.log
        .filter((p) => p.response === undefined && p.error === undefined)
        .map((p) => p.request)
    )
    const problems: string[] = []
    // Спроби вигляду, що розпочато й не осіли: політ вигляду — така спроба.
    const settled = new Set(
      input.attempts.flatMap((a) => (a.phase === "settled" ? [a.attempt] : []))
    )
    const unsettled = input.attempts.filter(
      (a) => a.phase === "started" && !settled.has(a.attempt)
    )
    for (const state of states)
      for (const flight of state.flights) {
        const target = state.target
        // Запит чекає в обмежувачі, поки інші запити без відповіді: події ще
        // немає, але політ чесний.
        const behindLimit = fake.inFlight > 0 || fake.pending.length > 0
        let carried: boolean
        if (target.kind === "view") {
          carried = unsettled.some((a) => {
            if (a.target.id !== target.id || a.kind !== flight.kind)
              return false
            const sent = events.filter((e) => e.attempt === a.attempt)
            return sent.length === 0
              ? behindLimit
              : sent.some((e) => open.has(e.journal))
          })
        } else if (target.kind === "service") carried = fake.inFlight > 0
        else
          carried =
            behindLimit ||
            events.some((e) => open.has(e.journal) && eventNames(e, target))
        if (!carried)
          problems.push(
            `${describe(target)}: a ${flight.kind} flight with no unanswered request naming it`
          )
      }
    return problems
  }

  // Вимога під обмеженим винятком: від якої миті, цілі без обіцянки.
  const excusedSince = new Map<string, number>()
  const stillExcused = new Set<string>()

  /** Чи покриває вимогу виняток таблиці; обмежений — не довше за свою межу. */
  const excused = (state: SyncState, input: O2Context): boolean => {
    for (const e of O2_EXCEPTIONS) {
      if (!state.requirements.every((r) => e.kinds.includes(r.kind))) continue
      const held = e.holds(state, input)
      if (held === false) continue
      const key = targetKey(state.target)
      if (held === "bounded") {
        const bound = e.boundMs?.(input)
        if (bound === undefined) continue
        stillExcused.add(key)
        const since = excusedSince.get(key) ?? input.now
        excusedSince.set(key, since)
        if (input.now - since > bound) continue
      }
      exceptionsUsed.set(e.rows[0]!, (exceptionsUsed.get(e.rows[0]!) ?? 0) + 1)
      return true
    }
    return false
  }

  // Наслідок кожної осілої спроби: читання, що закриває борг цілі, мусить осісти
  // не збоєм (сторінка підтверджує лише себе).
  const outcomes = new Map<number, string>()
  const applied = new Set<number>()
  const firstLoadFailed = new Set<number>()
  // Знищені `purge` вигляди, що їх О2 бачив: після відновлення пари вигляд
  // мусить бути прочитаний.
  const purgedSeen = new Set<string>()
  let attemptsSeen = 0

  /** Читання цілі стартувало: сторінка вигляду не рахується (вона підтверджує лише себе). */
  const startedRead = (e: StampedEvent, target: SyncTarget) =>
    eventNames(e, target) && e.target.kind !== "page"
  /** Читання цілі й осіло, не збоєм: для вигляду — спроба завантаження чи перечитування. */
  const settledRead = (e: StampedEvent, target: SyncTarget) =>
    startedRead(e, target) &&
    (target.kind !== "view" ||
      (e.attempt !== undefined &&
        outcomes.has(e.attempt) &&
        outcomes.get(e.attempt) !== "failed" &&
        outcomes.get(e.attempt) !== "discarded-by-epoch"))

  const step = (raw: O2Input): string | undefined => {
    // Вигляди, що застосували читання: набір ведеться по новій частині подій.
    for (; attemptsSeen < raw.attempts.length; attemptsSeen++) {
      const a = raw.attempts[attemptsSeen]!
      if (a.phase === "settled") outcomes.set(a.attempt, a.outcome)
      if (a.phase === "settled" && a.outcome === "applied")
        applied.add(a.target.id)
      if (a.kind === "load") {
        if (a.phase === "settled" && a.outcome === "failed")
          firstLoadFailed.add(a.target.id)
        else firstLoadFailed.delete(a.target.id)
      }
    }
    const input: O2Context = { ...raw, applied, firstLoadFailed }
    const { states, now, events, fake } = input
    const idle = fake.pending.length === 0 && fake.inFlight === 0
    // Політ судить лише спокій: у польоті запит складається з частин, які
    // осідають разом, і мить між відповіддю частини й осіданням запиту не
    // спокій.
    if (!idle) return undefined
    const problems = flightProblems(input)
    const byKey = new Map(states.map((s) => [targetKey(s.target), s]))
    const closed =
      states.length === 0 || states.some((s) => s.refusal === "closed")

    // Знищений purge вигляд — названа умова; відновлення пари вимагає читання.
    for (const key of [...purgedSeen]) {
      const state = byKey.get(key)
      if (state === undefined) purgedSeen.delete(key)
      else if (input.purgedView?.(state.target) !== true) {
        purgedSeen.delete(key)
        followUps.set(key, {
          kind: "read",
          sinceEvent: events.length,
          sinceTime: now,
          holderSince:
            input.holderVisible?.(state.target) === true ? now : undefined,
        })
      }
    }
    for (const state of states)
      if (input.purgedView?.(state.target) === true) {
        const key = targetKey(state.target)
        purgedSeen.add(key)
        obligations.delete(key)
        followUps.delete(key)
      }

    // Дотримання обіцянок попередніх станів спокою.
    for (const [key, promise] of [...obligations]) {
      const state = byKey.get(key)
      if (
        state === undefined ||
        state.requirements.length === 0 ||
        state.refusal !== undefined ||
        (state.deferral !== undefined && state.deferral !== "promised")
      ) {
        obligations.delete(key)
        continue
      }
      if (
        events.slice(promise.since).some((e) => startedRead(e, state.target))
      ) {
        obligations.delete(key)
        continue
      }
      // Строк зник зі `sync()` до свого часу (вкладку приховано, планувальник його
      // не веде): обіцянки більше немає, а вимогу в новому стані судить правило спокою.
      // Строк зник зі `sync()` у мить строку чи після неї, бо тримач вигляду
      // пішов чи вигляд став під винятком таблиці: вимогу тепер тримає названий
      // чи обмежений виняток (його межа не вічна), а не обіцянка. Без винятку
      // вимогу без строку й так судить правило спокою нижче.
      const heldByException = state.due === undefined && excused(state, input)
      if (
        promise.kind === "due" &&
        state.due === undefined &&
        (now < promise.due || heldByException)
      ) {
        obligations.delete(key)
        continue
      }
      if (promise.kind === "queue") {
        problems.push(
          `${describe(state.target)}: the queued read never started`
        )
        obligations.delete(key)
      } else if (
        now < promise.due &&
        state.due !== undefined &&
        state.due > promise.due
      ) {
        // Строк відсунуто вчасно; після строку відсунути його вже не можна.
        promise.due = state.due
      } else if (now >= promise.due) {
        problems.push(
          `${describe(state.target)}: no read by its deadline ${promise.due} (now ${now})`
        )
        obligations.delete(key)
      }
    }

    // Борги цілей, вимоги яких зникли за винятком (рядок 20 і вихід з відмови).
    for (const [key, f] of [...followUps]) {
      const state = byKey.get(key)
      if (state === undefined) {
        followUps.delete(key)
        continue
      }
      const target = state.target
      if (f.kind === "leave") {
        // Відлік — від першого спостереження без утримання: мить, коли
        // утримання скінчилось, між кроками моделі не видно.
        if ((input.targetHeld ?? input.holderPresent)?.(target) !== false)
          f.sinceTime = undefined
        else if (f.sinceTime === undefined) f.sinceTime = now
        else if (
          input.releaseDelayMs !== undefined &&
          now - f.sinceTime > input.releaseDelayMs
        ) {
          problems.push(
            `${describe(target)}: the target of a purged owner stays in sync() past the release delay`
          )
          followUps.delete(key)
        }
        continue
      }
      if (state.requirements.length > 0) {
        followUps.delete(key)
        continue
      }
      if (state.refusal !== undefined) {
        f.holderSince = undefined
        continue
      }
      if (f.kind === "retry") {
        const started = events
          .slice(f.sinceEvent)
          .filter((e) => startedRead(e, target))
        // Читання, що осіло не збоєм, закриває борг; збійний чи відкинутий
        // повтор лишає борг із давньою межею «читання» (інтервал плюс пауза).
        if (started.some((e) => settledRead(e, target))) {
          followUps.delete(key)
          continue
        }
        if (
          started.some(
            (e) =>
              e.attempt !== undefined &&
              (outcomes.get(e.attempt) === "failed" ||
                outcomes.get(e.attempt) === "discarded-by-epoch")
          )
        ) {
          followUps.set(key, {
            kind: "read",
            sinceEvent: events.length,
            sinceTime: now,
            holderSince:
              input.holderVisible?.(target) === true ? now : undefined,
          })
          continue
        }
        if (started.length > 0) continue
        // Межа рухається лише вперед і лише до свого спливу: ядро, що вічно
        // переставляє паузу й не читає, межу не відсуває.
        if (
          state.dueCause === "retry" &&
          state.due !== undefined &&
          (f.deadline === undefined || now <= f.deadline)
        )
          f.deadline = state.due
        const slack =
          input.holderVisible?.(target) === false
            ? (input.revalidateMs ?? 0)
            : 0
        if (now > (f.deadline ?? f.sinceTime ?? now) + slack) {
          problems.push(
            `${describe(target)}: no read of the target by the end of its retry pause after a discarded load`
          )
          followUps.delete(key)
        }
        continue
      }
      if (events.slice(f.sinceEvent).some((e) => settledRead(e, target))) {
        followUps.delete(key)
        continue
      }
      if (input.holderVisible?.(target) === true) {
        f.holderSince ??= now
        if (
          input.revalidateMs !== undefined &&
          now - f.holderSince > 2 * input.revalidateMs
        ) {
          problems.push(
            `${describe(target)}: no read of the target within the interval and the failure pause after its requirement went`
          )
          followUps.delete(key)
        }
      } else f.holderSince = undefined
    }

    // (а) обіцянка або умова на кожну вимогу.
    stillExcused.clear()
    let evaluated = false
    for (const state of states) {
      if (state.requirements.length === 0) continue
      evaluated = true
      if (state.refusal !== undefined) continue
      if (input.purgedView?.(state.target) === true) continue
      if (state.deferral !== undefined && state.deferral !== "promised")
        continue
      const key = targetKey(state.target)
      if (state.flights.length > 0) continue
      if (state.queued.length > 0) {
        if (!obligations.has(key))
          obligations.set(key, { kind: "queue", since: events.length, due: 0 })
      } else if (state.due !== undefined) {
        if (!obligations.has(key))
          obligations.set(key, {
            kind: "due",
            since: events.length,
            due: state.due,
          })
      } else if (excused(state, input)) {
        // Виняток таблиці прогалин `main`.
      } else {
        problems.push(
          `${describe(state.target)}: ${state.requirements.map((r) => r.kind).join(", ")} with no promise and no condition${state.deferral === undefined ? "" : " (promised, but no flight, queue or deadline)"}`
        )
      }
    }
    for (const key of [...excusedSince.keys()])
      if (!stillExcused.has(key)) excusedSince.delete(key)
    if (evaluated) count++

    // (б) зникнення вимоги: разом з ціллю чи з доказом свого виду.
    const now0: Snapshot = {
      targets: new Map(
        states.map((s) => [
          targetKey(s.target),
          { target: s.target, requirements: s.requirements },
        ])
      ),
      events: events.length,
      attempts: input.attempts.length,
      log: fake.log.length,
      lives: new Map(
        states.flatMap((s) =>
          s.target.kind === "row"
            ? [
                [
                  targetKey(s.target),
                  input.rowLife?.(s.target.object, s.target.key) ?? 0,
                ] as const,
              ]
            : []
        )
      ),
    }
    if (previous !== undefined && !closed) {
      const from = previous
      // Відповіді журналу розбираються лише тоді, коли вимога справді зникла.
      let window: Window | undefined
      const windowOf = (): Window => {
        if (window === undefined) {
          const log = fake.log.slice(Math.min(from.log, fake.log.length))
          window = {
            events: events.slice(from.events),
            attempts: input.attempts.slice(from.attempts),
            log,
            input,
            rows: deliveredRows(log, fake.index),
          }
        }
        return window
      }
      for (const [key, was] of previous.targets) {
        const state = byKey.get(key)
        // Ціль зникла: вигляд закрито чи звільнено, рядок вилучено зі сховища.
        const spec = was.target.kind === "view" ? was.target.spec : undefined
        const ownerKey =
          spec?.kind === "section"
            ? spec.owner
            : spec?.kind === "card"
              ? spec.key
              : undefined
        const purged =
          ownerKey !== undefined &&
          input.ownerPurged?.(spec!.object, ownerKey) === true
        if (state === undefined) {
          const t = was.target
          // Сесія за межею відкинутих (`discard-bound`) нічого не читає: рядки
          // без власної цілі втрачають вимоги разом із нею — названа умова.
          if (
            t.kind !== "row" ||
            input.rowAlive === undefined ||
            !input.rowAlive(t.object, t.key) ||
            (input.rowLife?.(t.object, t.key) ?? 0) !==
              (previous.lives.get(key) ?? 0) ||
            states.some((s) => s.refusal === "discard-bound")
          )
            continue
        }
        // Відмова цілі (`discard-bound`, `stale-object`) — названа умова: ядро
        // нічого не читає, вимоги йому не потрібні.
        // Знищений purge вигляд не читають, вимоги йому не потрібні.
        if (state !== undefined && input.purgedView?.(state.target) === true)
          continue
        // Вийшовши з відмови, ціль мусить бути прочитана.
        if (state?.refusal !== undefined) {
          if (was.target.kind === "view" && !followUps.has(key))
            followUps.set(key, {
              kind: "read",
              sinceEvent: events.length,
              sinceTime: now,
              holderSince: undefined,
            })
          continue
        }
        const have = new Map(state?.requirements.map((r) => [r.kind, r]))
        // Вимога, що замінює, не старша за те, що стояло до неї на цілі.
        const floor = Math.max(
          -Infinity,
          ...was.requirements.flatMap((r) =>
            r.epoch === undefined ? [] : [r.epoch]
          )
        )
        for (const requirement of was.requirements) {
          if (have.has(requirement.kind)) continue
          if (
            requirement.kind === "channel-rejoin" &&
            have.has("composition-unconfirmed")
          ) {
            const epoch = have.get("composition-unconfirmed")!.epoch
            if (epoch === undefined || epoch < floor)
              problems.push(
                `${describe(was.target)}: channel-rejoin replaced by a composition requirement of an earlier epoch`
              )
            const joined = input.lastJoin?.()
            if (joined !== undefined) rejoined.set(key, joined)
            continue
          }
          // «Ціль відстала від шапки» без доказу: рядок 20 таблиці прогалин, з
          // межею за тригером; інший тригер — не виняток.
          if (
            requirement.kind === "target-behind-header" &&
            was.target.kind === "view"
          ) {
            // Шапку власника зробило `removed` читання, яке просило її й не
            // дістало рядка: похідна вимога «ціль відстала від шапки» втратила
            // опору й іде з нею. Доказ — лише застосоване не-сторінкове читання
            // у вікні, ціль якого містить ключ шапки, а відповіді — рядка шапки
            // немає, і всі тримачі показують її `removed`. Будь-яке інше читання
            // доказом не є; звільнення тримача — прогалина рядка 20.
            const header = ownerKeys(was.target)[0]
            const ownerObject = was.target.object
            if (
              header !== undefined &&
              input.headerGone?.(ownerObject, header) === true &&
              windowOf().events.some((e) => {
                if (e.target.kind !== "view" || e.attempt === undefined)
                  return false
                if (outcomes.get(e.attempt) !== "applied") return false
                const id = e.target.id
                const read = states.find(
                  (st) => st.target.kind === "view" && st.target.id === id
                )
                return (
                  read !== undefined &&
                  read.target.kind === "view" &&
                  readsHeader(read.target.spec, header) &&
                  !windowOf().rows.has(`${ownerObject}\u0000${header}`)
                )
              })
            )
              continue
            const settledAs = (outcome: string) =>
              windowOf().attempts.some(
                (a) =>
                  a.phase === "settled" &&
                  a.outcome === outcome &&
                  a.kind !== "page" &&
                  a.target.id === (was.target as { id: number }).id
              )
            const failed = settledAs("failed")
            // Відкинута за епохою спроба знімає вимогу так само, як збійна, але
            // читання за нею йде повтором (M8): його строк ядро показує у `sync()`.
            const discarded = settledAs("discarded-by-epoch")
            // Повтор (M8) мог стартувати й осісти в тому самому вікні кроків без
            // спокою: його наслідок судить сам, а не пауза, якої вже немає.
            const attempts = windowOf().attempts
            const mine = (a: AttemptEvent) =>
              a.kind !== "page" &&
              a.target.id === (was.target as { id: number }).id
            let lastDiscard = -1
            attempts.forEach((a, n) => {
              if (
                a.phase === "settled" &&
                a.outcome === "discarded-by-epoch" &&
                mine(a)
              )
                lastDiscard = n
            })
            const after = attempts
              .slice(lastDiscard + 1)
              .filter((a) => lastDiscard >= 0 && mine(a))
            const retried = after.some((a) => a.phase === "started")
            const retriedOk = after.some(
              (a) => a.phase === "settled" && a.outcome === "applied"
            )
            if (discarded && !failed && retriedOk) continue
            const held = input.holderPresent?.(was.target)
            const trigger = purged
              ? "leave"
              : failed || held === false || (discarded && retried)
                ? "read"
                : discarded
                  ? "retry"
                  : undefined
            if (trigger !== undefined) {
              followUps.set(key, {
                kind: trigger,
                sinceEvent: events.length,
                sinceTime: now,
                holderSince:
                  trigger === "read" &&
                  input.holderVisible?.(was.target) === true
                    ? now
                    : undefined,
                // Пауза повтору, яку цей самий стан уже показує: межа від неї.
                ...(trigger === "retry" &&
                state?.dueCause === "retry" &&
                state.due !== undefined
                  ? { deadline: state.due }
                  : {}),
              })
              continue
            }
          }

          const replaced = REPLACED_BY[requirement.kind]?.some((kind) =>
            kind === "value-hidden"
              ? hiddenOwner(was.target, states, previous)
              : have.has(kind)
          )
          if (replaced === true) continue
          if (PROOFS[requirement.kind](windowOf(), was.target, requirement)) {
            // Вимога, що виросла з приєднання, знімається читанням, яке
            // стартувало після кроку `join` моделі (за порядком подій).
            const mark = rejoined.get(key)
            if (
              requirement.kind === "composition-unconfirmed" &&
              mark !== undefined &&
              was.target.kind === "view"
            ) {
              rejoined.delete(key)
              const id = was.target.id
              const late = windowOf().attempts.some(
                (a) =>
                  a.phase === "settled" &&
                  a.outcome === "applied" &&
                  a.kind !== "page" &&
                  a.target.id === id &&
                  events.findIndex((e) => e.attempt === a.attempt) >= mark
              )
              if (!late)
                problems.push(
                  `${describe(was.target)}: the composition requirement of a rejoin was removed by a read that started before the join`
                )
            }
            continue
          }
          problems.push(
            `${describe(was.target)}: ${requirement.kind} disappeared with no proof of its kind`
          )
        }
      }
    }
    previous = now0
    return problems[0]
  }
  return { step, evaluated: () => count }
}
