import { afterEach } from "vitest"
import type { CatalogIndex, ReadQuery } from "simetra/model"
import type { AttemptEvent } from "../attempts"
import { inspectCore, type CoreSession } from "../core"
import { DISCARDS_MAX, DISCARD_PAUSE_MS } from "../session"
import type { ReadEvent } from "../source"
import {
  READ_REASONS,
  REQUIREMENT_KINDS,
  SITE_CODES,
  TARGET_KINDS,
  type SiteCode,
} from "../sync/vocabulary"
import type { FakePart, FakeReadLog, FakeSource } from "../testing/fake-source"

/*
 * Оракули О1 і О4 ядра синхронізації (спека ядра синхронізації §5.13) і збирач
 * покриття (план SK-0, Р-SK0-10). Оракул читає лише журнал фейкового джерела й
 * події `watchReads`: поля стану ядра він не бачить, тож не залежить від того,
 * що перевіряє.
 */

/** Те, що збирачу треба від діагностики ядра (`inspectCore(core)`). */
export interface ReadSource {
  watchReads(listener: (event: ReadEvent) => void): () => void
  /** Події спроб читання вигляду; без них перевірки осідання немає. */
  watchAttempts?(listener: (event: AttemptEvent) => void): () => void
}

/**
 * Подія з миттю моделі, у яку запит дістав номер, і індексом запиту в журналі
 * фейкового джерела: подія йде безпосередньо перед викликом адаптера в тій
 * самій задачі обмежувача, тож наступний індекс журналу — запит цієї події.
 */
export type StampedEvent = ReadEvent & {
  readonly at: number
  readonly journal: number
}

const codes: ReadonlySet<string> = new Set(SITE_CODES)
const reasons: ReadonlySet<string> = new Set(READ_REASONS)
const requirements: ReadonlySet<string> = new Set(REQUIREMENT_KINDS)
const targetKinds: ReadonlySet<string> = new Set(TARGET_KINDS)

const objectName = (query: ReadQuery) =>
  `${query.object.kind}.${query.object.name}`

const keyed = (query: ReadQuery): boolean => {
  if ("id" in query) return true
  const where = "where" in query ? query.where : undefined
  return (
    where !== undefined &&
    "op" in where &&
    where.op === "in" &&
    where.attribute === "ref"
  )
}

/**
 * Об'єкти, до яких `object` доходить за ребрами `ref` каталогу (транзитивно:
 * ланцюг `include`): одноцільовий `Ref` і цілі пари.
 */
function reachable(index: CatalogIndex, object: string): ReadonlySet<string> {
  const seen = new Set<string>()
  const queue = [object]
  while (queue.length > 0) {
    const entry = index.byRef.get(queue.pop()!)
    if (entry === undefined) continue
    for (const attribute of entry.attributes) {
      const targets = [
        ...(attribute.ref === undefined
          ? []
          : [index.byId.get(attribute.ref.object)]),
        ...(attribute.pair?.targets.map((t) =>
          index.byRef.get(`${t.object.kind}.${t.object.name}`)
        ) ?? []),
      ]
      for (const target of targets) {
        if (target === undefined) continue
        const name = `${target.kind}.${target.name}`
        if (seen.has(name)) continue
        seen.add(name)
        queue.push(name)
      }
    }
  }
  return seen
}

// Польоти, чиє читання може нести `include` (Додаток Б): шляхи виглядів,
// сторінок і ключів; службові частини (S) їх не мають.
const INCLUDE_FLIGHT = /^[MPRK]/

/** Чому частина не відповідає цілі події; `undefined` — відповідає. */
function mismatch(
  event: ReadEvent,
  part: FakePart,
  index: CatalogIndex
): string | undefined {
  const target = event.target
  if (target.kind === "service")
    return part.type === target.service
      ? undefined
      : `target is the service ${target.service}, the part is ${part.type}`
  if (part.type !== "query" || part.query === undefined)
    return `target is ${target.kind} of ${target.object}, the part is ${part.type}`
  const object = objectName(part.query)
  // Читання за ключами іншого об'єкта — ціль `include` польоту, що його почала
  // ця подія (Додаток Б, «Спільне», п. 3): об'єкт частини мусить бути в
  // ланцюгу `ref` від об'єкта цілі, а код — шляху, що читає вигляди чи ключі.
  if (object !== target.object) {
    return keyed(part.query) &&
      INCLUDE_FLIGHT.test(event.site) &&
      reachable(index, target.object).has(object)
      ? undefined
      : `target object ${target.object}, the part reads ${object}`
  }
  // Вид цілі «ключі» — читання за ключами чи картка; сторінка — не за
  // ключами й не ТЧ (картка вигляду — теж вигляд, але не сторінка).
  if (target.kind === "keys" && !keyed(part.query))
    return `target is keys of ${target.object}, the part is not a read by keys`
  if (
    target.kind === "page" &&
    (keyed(part.query) || "tabularSection" in part.query)
  )
    return `target is a page of ${target.object}, the part is not a page`
  return undefined
}

/**
 * Збої, яких журнал фейка не бачить: відповідь дійшла, а ядро відмовило само
 * (читання понад межу `full`, виняток застосування); відмова за несумісним
 * об'єктом названа умовою допуску `skip`.
 */
const CORE_SIDE_FAILURES: readonly string[] = [
  "data.full-too-large",
  "command.internal",
]

/**
 * Перевірка осідання спроб проти журналу фейкового джерела, у обидва боки
 * (спека §5.13): кожне «застосовано» має відповідь запиту своєї спроби, кожен
 * «збій» — запит з відмовою чи без відповіді (або жодного запиту: умова
 * допуску), кожна подія «осіло» має «розпочато», і кожна відповідь запиту
 * спроби має рівно одну подію «осіло». Запит спроби — подія `watchReads` з її
 * номером. Спроба без відповідей і без «осіло» ще летить — не порушення.
 */
export function settleJournalViolations(
  attempts: readonly AttemptEvent[],
  events: readonly StampedEvent[],
  fake: Pick<FakeSource, "log" | "requestParts">
): string[] {
  const problems: string[] = []
  const started = new Set<number>()
  const settled = new Map<number, string[]>()
  const failures = new Map<number, AttemptEvent & { phase: "settled" }>()
  for (const event of attempts) {
    if (event.phase === "started") {
      if (started.has(event.attempt))
        problems.push(`attempt ${event.attempt}: started twice`)
      started.add(event.attempt)
    } else {
      failures.set(event.attempt, event)
      settled.set(event.attempt, [
        ...(settled.get(event.attempt) ?? []),
        event.outcome,
      ])
    }
  }
  // Частина запиту за подією: запит — за індексом журналу на мить події (два
  // ядра над одним фейком мають власні номери запитів); події одного запиту
  // йдуть у порядку слотів, і журнал фейка тримає ті самі живі частини в тому
  // ж порядку.
  const slots = new Map<number, number>()
  const partsOf = new Map<number, (typeof fake.log)[number][]>()
  for (const event of events) {
    const slot = slots.get(event.journal) ?? 0
    slots.set(event.journal, slot + 1)
    if (event.attempt === undefined) continue
    // Слот події — у запиті з усіма частинами (службовими теж), журнал
    // `log` тримає лише частини-запити даних.
    const request = fake.requestParts[event.journal]
    const queries =
      request?.slice(0, slot).filter((p) => p.type === "query").length ?? 0
    const part =
      request?.[slot]?.type === "query"
        ? fake.log.filter((p) => p.request === event.journal)[queries]
        : undefined
    const list = partsOf.get(event.attempt) ?? []
    if (part !== undefined) list.push(part)
    partsOf.set(event.attempt, list)
  }
  const sent = new Map<number, number>()
  for (const event of events)
    if (event.attempt !== undefined)
      sent.set(event.attempt, (sent.get(event.attempt) ?? 0) + 1)
  const answered = (p: (typeof fake.log)[number]) =>
    p.response !== undefined && p.error === undefined
  for (const [attempt, outcomes] of settled) {
    if (!started.has(attempt))
      problems.push(`attempt ${attempt}: settled without a start`)
    if (outcomes.length > 1)
      problems.push(`attempt ${attempt}: settled ${outcomes.length} times`)
  }
  for (const attempt of started) {
    const parts = partsOf.get(attempt) ?? []
    const outcomes = settled.get(attempt) ?? []
    if (outcomes.length === 0) {
      if (parts.some(answered))
        problems.push(
          `attempt ${attempt}: a part was answered, the attempt has no settle event`
        )
      continue
    }
    if (outcomes[0] === "applied" && !parts.some(answered))
      problems.push(`attempt ${attempt}: applied without an answered part`)
    const why = failures.get(attempt)
    if (
      outcomes[0] === "failed" &&
      (sent.get(attempt) ?? 0) > 0 &&
      parts.every(answered) &&
      why?.skip === undefined &&
      !CORE_SIDE_FAILURES.includes(why?.error ?? "")
    )
      problems.push(
        `attempt ${attempt}: failed, but every part of it was answered`
      )
  }
  return problems
}

/** Оцінка О1 над подіями й журналом фейкового джерела; порожній масив — зелено. */
export function readJournalViolations(
  events: readonly StampedEvent[],
  fake: Pick<FakeSource, "requests" | "requestParts" | "index">
): string[] {
  const problems: string[] = []
  const groups = new Map<number, StampedEvent[]>()
  for (const event of events) {
    const where = `request ${event.journal} (${event.site})`
    if (!reasons.has(event.reason))
      problems.push(`${where}: unknown reason ${event.reason}`)
    if (event.reason === "requirement" && !requirements.has(event.requirement))
      problems.push(`${where}: unknown requirement`)
    if (!targetKinds.has(event.target.kind))
      problems.push(`${where}: unknown target kind`)
    // `test` — службовий код прямих викликів джерела, не читання ядра.
    if (!codes.has(event.site))
      problems.push(`${where}: site ${event.site} is not in the inventory`)
    const group = groups.get(event.journal)
    if (group === undefined) groups.set(event.journal, [event])
    else group.push(event)
  }
  if (events.length === 0 && fake.requests.length > 0)
    return [
      `the fake journal has ${fake.requests.length} requests, the event log is empty`,
    ]
  // Бієкція: кожен запит журналу має групу подій і навпаки.
  for (let i = 0; i < fake.requests.length; i++) {
    const group = groups.get(i)
    if (group === undefined) {
      problems.push(`request ${i}: ${fake.requests[i]} parts, no events`)
      continue
    }
    if (group.length !== fake.requests[i]) {
      problems.push(
        `request ${i}: ${fake.requests[i]} parts, ${group.length} events`
      )
      continue
    }
    const parts = fake.requestParts[i]!
    group.forEach((event, slot) => {
      const why = mismatch(event, parts[slot]!, fake.index)
      if (why !== undefined)
        problems.push(`request ${i} part ${slot} (${event.site}): ${why}`)
    })
  }
  for (const journal of groups.keys())
    if (journal >= fake.requests.length)
      problems.push(
        `request ${journal}: events of a request the fake never got`
      )
  return problems
}

/**
 * Виняток О4 (рядок 1 §5.14, колонка «Було», і рядки 13, 14): запит з цим
 * кодом у вікні спокою дозволено лише після події-причини тієї ж цілі й не
 * пізніше за затримку шляху від неї; ланцюг винятків — не довший за
 * `DISCARDS_MAX`.
 * `after` — коди причин; `"object"` — будь-яка подія того ж об'єкта.
 * Шлях, чий пуск — дія (`endHydration`: R5, R14), у вікно не потрапляє: дія
 * закриває вікно, тож виняток для нього не потрібен.
 */
export interface IdleException {
  readonly site: SiteCode
  /** Рядок §5.14, що виняток закриває. */
  readonly row: 1 | 13
  readonly after: readonly SiteCode[] | "object"
  /** Межа часу моделі від події-причини. */
  readonly delayMs: number
}

// Пауза відкинутих подвоюється до `DISCARDS_MAX` відкинутих проходів.
const DISCARD_PAUSE_MAX_MS = DISCARD_PAUSE_MS * 2 ** (DISCARDS_MAX - 1)

const LOAD_SITES: readonly SiteCode[] = [
  "M1",
  "M2",
  "M3",
  "M4",
  "M5",
  "M6",
  "M7",
  "M8",
]
const PAGE_SITES: readonly SiteCode[] = ["P1", "P2", "P3"]

export const IDLE_EXCEPTIONS: readonly IdleException[] = [
  // Повтор відкинутого завантаження чи сторінки після паузи (рядок 1).
  { site: "M8", row: 1, after: LOAD_SITES, delayMs: DISCARD_PAUSE_MAX_MS },
  { site: "P2", row: 1, after: PAGE_SITES, delayMs: DISCARD_PAUSE_MAX_MS },
  // Шляхи без власної затримки: їх пускає осідання відповіді, тож вони
  // йдуть тією ж миттю моделі, що й подія-причина (рядки 1 і 13).
  { site: "M4", row: 1, after: "object", delayMs: 0 },
  { site: "R10", row: 1, after: "object", delayMs: 0 },
  { site: "R12", row: 1, after: "object", delayMs: 0 },
  { site: "K3", row: 1, after: ["K3", "K4"], delayMs: 0 },
  { site: "R16", row: 13, after: "object", delayMs: 0 },
  { site: "R17", row: 13, after: "object", delayMs: 0 },
]

const sameTarget = (a: ReadEvent["target"], b: ReadEvent["target"]) =>
  a.kind === "service"
    ? b.kind === "service" && a.service === b.service
    : b.kind !== "service" && a.object === b.object

/** Крок, що його вікно спокою приймає; усе інше — дія, що вікно закриває. */
export interface IdleStep {
  /** Крок без дій (плин часу): вікно спокою лишається відкритим. */
  readonly quiet: boolean
  /** Після кроку вкладка прихована й немає записів у польоті. */
  readonly idle: boolean
}

export interface ReadCollectorOptions {
  /** Час моделі; за замовчуванням `Date.now`. */
  readonly clock?: () => number
  /** Не ставити збирач на перевірку в кінці тесту (самотести оракулів). */
  readonly standalone?: boolean
}

export interface ReadCollector {
  readonly events: StampedEvent[]
  /** Події спроб читання вигляду (`watchAttempts`). */
  readonly attempts: AttemptEvent[]
  /**
   * Записи журналу фейка, які тест прибрав з `fake.log` після читань другого
   * ядра (перегідратація): оракул осідання судить і за ними.
   */
  retain(entries: readonly FakeReadLog[]): void
  /** Скільки кроків О4 оцінено у відкритому вікні: нуль — оракул порожній. */
  evaluated(): number
  /** Порушення О1 на цю мить. */
  violations(): string[]
  /**
   * Крок вікна спокою О4 (після `flush`, до перевірки планувальника): повертає
   * порушення — подію вікна поза винятками. Вікно відкриває крок, після якого
   * вкладка прихована й запитів без відповіді немає.
   */
  idleStep(step: IdleStep): string | undefined
  /**
   * Кінець прогону: знімає збирач з перевірки в кінці тесту й повертає
   * порушення О1 прогону. Для тестів з багатьма прогонами в одному `it`.
   */
  finish(): string[]
  /** Додає відписку ядра, яке ділить із цим збирачем фейкове джерело. */
  attach(stop: () => void): void
  /** Знімає збирач з перевірки в кінці тесту й відписується. */
  stop(): void
}

// Один збирач на фейкове джерело: кілька ядер над одним фейком (гідратація,
// перемикання епох) ділять один журнал запитів, тож їхні події — одна множина.
const active = new Map<FakeSource, ReadCollector>()

// Перевірка О1 — у власному `afterEach`: тест не мусить її викликати, а
// порожній збирач у тесті без запитів нічого не стверджує. Реєстрація на рівні
// модуля діє на кожен файл, що імпортує помічника.
afterEach(async () => {
  // Відповідь, що дійшла перед кінцем тесту, осідає мікрозадачами: оракул
  // осідання судить спокій, а не мить між відповіддю й записом.
  for (let i = 0; i < 200; i++) await Promise.resolve()
  const collectors = [...active.values()]
  const problems = collectors.flatMap((c) => c.violations())
  for (const collector of collectors) collector.stop()
  active.clear()
  if (problems.length > 0)
    throw new Error(`O1 (read journal vs events):\n${problems.join("\n")}`)
})

/**
 * Підписує `watchReads` ядра й збирає події для О1 та О4. Без `standalone`
 * збирач сам перевіряється в `afterEach`; друге ядро над тим самим фейком
 * додається в той самий збирач.
 */
export function collectReads(
  inspect: ReadSource,
  fake: FakeSource,
  options: ReadCollectorOptions = {}
): ReadCollector {
  const shared = options.standalone === true ? undefined : active.get(fake)
  const clock = options.clock ?? Date.now
  const events: StampedEvent[] = shared?.events ?? []
  const attempts: AttemptEvent[] = shared?.attempts ?? []
  const unsubscribe = inspect.watchReads((event) =>
    events.push({ ...event, at: clock(), journal: fake.requests.length })
  )
  const unsubscribeAttempts = inspect.watchAttempts?.((event) =>
    attempts.push(event)
  )
  if (shared !== undefined) {
    shared.attach(unsubscribe)
    if (unsubscribeAttempts !== undefined) shared.attach(unsubscribeAttempts)
    return shared
  }
  let open = false
  let mark = 0
  let windowSteps = 0
  // Глибина ланцюга винятків: подія-причина поза винятками — 0, кожен
  // виняток на одну глибшого за свою причину. Ланцюг довший за межу
  // відкинутих проходів не з'являється («не частіше за події»).
  const depth = new Map<number, number>()
  const unsubscribes = [
    unsubscribe,
    ...(unsubscribeAttempts === undefined ? [] : [unsubscribeAttempts]),
  ]
  const excused = (event: StampedEvent): boolean => {
    const rule = IDLE_EXCEPTIONS.find((r) => r.site === event.site)
    if (rule === undefined) return false
    const index = events.indexOf(event)
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < index; i++) {
      const cause = events[i]!
      if (event.at - cause.at > rule.delayMs) continue
      if (!sameTarget(cause.target, event.target)) continue
      if (
        rule.after !== "object" &&
        !rule.after.includes(cause.site as SiteCode)
      )
        continue
      best = Math.min(best, (depth.get(i) ?? 0) + 1)
    }
    if (best > DISCARDS_MAX) return false
    depth.set(index, best)
    return true
  }
  const retained: FakeReadLog[] = []
  const collector: ReadCollector = {
    events,
    attempts,
    retain: (entries) => retained.push(...entries),
    evaluated: () => windowSteps,
    violations: () => [
      ...readJournalViolations(events, fake),
      ...settleJournalViolations(attempts, events, {
        log: [...fake.log, ...retained],
        requestParts: fake.requestParts,
      }),
    ],
    idleStep({ quiet, idle }) {
      let problem: string | undefined
      if (open && quiet) {
        windowSteps++
        for (const event of events.slice(mark)) {
          if (excused(event)) continue
          const target =
            event.target.kind === "service"
              ? event.target.service
              : event.target.object
          problem = `a read in the idle window: ${event.site} (${event.reason}) of ${target} at ${event.at}`
          break
        }
      }
      mark = events.length
      // Приховування посеред кроку й відповіді, що осідають після
      // `suspend()`, належать кроку: вікно відкриває лише його кінець.
      open = idle && fake.inFlight === 0 && fake.pending.length === 0
      return problem
    },
    finish() {
      const problems = collector.violations()
      collector.stop()
      return problems
    },
    attach: (stop) => unsubscribes.push(stop),
    stop() {
      for (const stop of unsubscribes.splice(0)) stop()
      active.delete(fake)
    },
  }
  if (options.standalone !== true) active.set(fake, collector)
  return collector
}

/**
 * `collectReads` для ядра, створеного тестом поверх фейка напряму (без
 * `setup`): друге ядро над тим самим фейком ділить збирач з першим.
 */
export const collectCore = (
  core: CoreSession,
  fake: FakeSource,
  options: ReadCollectorOptions = {}
): ReadCollector => collectReads(inspectCore(core), fake, options)
