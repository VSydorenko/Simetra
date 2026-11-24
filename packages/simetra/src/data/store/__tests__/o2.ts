import { readResultFromWire, type ReadQuery } from "simetra/model"
import type { AttemptEvent } from "../attempts"
import { DISCARDS_MAX, DISCARD_PAUSE_MS } from "../session"
import type { SyncState, SyncTarget } from "../core"
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
  /** Сховище не тримає жодного рядка (виняток рядка 6: строк знімка прав). */
  readonly storeEmpty?: boolean
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
  /** Стан, що тримає виняток; `false` — виняток не діє. */
  readonly holds: (state: SyncState, input: O2Input) => boolean
}

export const O2_EXCEPTIONS: readonly O2Exception[] = [
  // Рядок 6: строк знімка прав вимагає рядків у сховищі.
  {
    rows: [6],
    kinds: ["rights-unconfirmed"],
    holds: (_, input) => input.storeEmpty === true,
  },
  // Рядки 4 і 12: позначка рядка без строку — доки жоден вигляд цього об'єкта
  // не читає (немає видимого тримача на видимій вкладці).
  {
    rows: [4, 12],
    kinds: ["min-version", "row-unfinished"],
    holds: (state, input) =>
      state.target.kind === "row" &&
      !input.states.some(
        (s) =>
          s.target.kind === "view" &&
          s.target.object === (state.target as { object: string }).object &&
          s.refusal === undefined &&
          s.deferral !== "tab-hidden" &&
          s.deferral !== "target-invisible"
      ),
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
  // Рядок читає читання ключів його об'єкта чи системне перечитування
  // вигляду-тримача того ж об'єкта.
  return named.kind !== "service" && named.object === target.object
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

/**
 * Вимога, що на `main` змінює вид: перемикання епохи версій замінює «мінімальну
 * версію» вимогою свого виду (`object-store.ts`, `onSwitch`); `hide` власника
 * замінює похідну вимогу на «значення сховано» рядків об'єкта.
 */
const REPLACED_BY: Partial<Record<RequirementKind, RequirementKind[]>> = {
  "min-version": ["version-epoch-switched"],
  // Хвиля приєднання для вигляду, якого вона не читає (невидимий), лише ставить
  // «склад не підтверджено»: вимога приєднання переходить у вимогу складу, і
  // її судить правило (а).
  "channel-rejoin": ["composition-unconfirmed"],
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
}

export interface O2 {
  /** Крок моделі: порушення О2 чи `undefined`. */
  step(input: O2Input): string | undefined
  /** Станів спокою з ≥ 1 вимогою, які О2 справді оцінив. */
  evaluated(): number
}

// Пауза між відкинутою відповіддю завантаження й повтором (M8) подвоюється до
// межі відкинутих проходів: політ у цю паузу триматиме не довше.
const RETRY_PAUSE_MAX_MS = DISCARD_PAUSE_MS * 2 ** (DISCARDS_MAX - 1)

export function createO2(): O2 {
  let count = 0
  let previous: Snapshot | undefined
  const obligations = new Map<string, Obligation>()

  // Вигляд → остання спроба завантаження, що осіла «відкинуто за епохою», і час
  // першого спокою над нею: політ завантаження у паузі повтору.
  const pausedLoads = new Map<number, { attempt: number; since: number }>()

  /** Політ без запиту без відповіді, чия подія називає ціль. */
  const flightProblems = (input: O2Input): string[] => {
    const { fake, events, states } = input
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
          // Завантаження у паузі після відкинутої відповіді: запиту немає, поки
          // не спливе пауза; політ тримається не довше її межі.
          const last = [...input.attempts]
            .reverse()
            .find((a) => a.target.id === target.id && a.kind === "load")
          if (
            flight.kind === "load" &&
            last?.phase === "settled" &&
            last.outcome === "discarded-by-epoch"
          ) {
            const was = pausedLoads.get(target.id)
            if (was === undefined || was.attempt !== last.attempt)
              pausedLoads.set(target.id, {
                attempt: last.attempt,
                since: input.now,
              })
            else if (input.now - was.since > RETRY_PAUSE_MAX_MS)
              problems.push(
                `${describe(target)}: a load flight stays after a discarded answer past the retry pause`
              )
            continue
          }
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

  const step = (input: O2Input): string | undefined => {
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
        events.slice(promise.since).some((e) => eventNames(e, state.target))
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
        state.due !== undefined &&
        state.due > promise.due &&
        state.due > now
      ) {
        promise.due = state.due
      } else if (now >= promise.due) {
        problems.push(
          `${describe(state.target)}: no read by its deadline ${promise.due} (now ${now})`
        )
        obligations.delete(key)
      }
    }

    // (а) обіцянка або умова на кожну вимогу.
    let evaluated = false
    for (const state of states) {
      if (state.requirements.length === 0) continue
      evaluated = true
      if (state.refusal !== undefined) continue
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
      } else if (
        O2_EXCEPTIONS.some(
          (e) =>
            state.requirements.every((r) => e.kinds.includes(r.kind)) &&
            e.holds(state, input) &&
            (exceptionsUsed.set(
              e.rows[0]!,
              (exceptionsUsed.get(e.rows[0]!) ?? 0) + 1
            ),
            true)
        )
      ) {
        // Виняток таблиці прогалин `main`.
      } else {
        problems.push(
          `${describe(state.target)}: ${state.requirements.map((r) => r.kind).join(", ")} with no promise and no condition${state.deferral === undefined ? "" : " (promised, but no flight, queue or deadline)"}`
        )
      }
    }
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
    }
    if (previous !== undefined && !closed) {
      const log = fake.log.slice(Math.min(previous.log, fake.log.length))
      const window: Window = {
        events: events.slice(previous.events),
        attempts: input.attempts.slice(previous.attempts),
        log,
        input,
        rows: deliveredRows(log, fake.index),
      }
      for (const [key, was] of previous.targets) {
        const state = byKey.get(key)
        // Ціль зникла: вигляд закрито чи звільнено, рядок вилучено зі сховища.
        if (state === undefined) {
          const t = was.target
          if (
            t.kind !== "row" ||
            input.rowAlive === undefined ||
            !input.rowAlive(t.object, t.key)
          )
            continue
        }
        const have = new Set(state?.requirements.map((r) => r.kind))
        for (const requirement of was.requirements) {
          if (have.has(requirement.kind)) continue
          const replaced = REPLACED_BY[requirement.kind]?.some((kind) =>
            kind === "value-hidden"
              ? states.some(
                  (s) =>
                    s.target.kind === "row" &&
                    s.target.object ===
                      (was.target.kind === "service"
                        ? ""
                        : was.target.object) &&
                    s.requirements.some((r) => r.kind === kind)
                )
              : have.has(kind)
          )
          if (replaced === true) continue
          if (PROOFS[requirement.kind](window, was.target, requirement))
            continue
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
