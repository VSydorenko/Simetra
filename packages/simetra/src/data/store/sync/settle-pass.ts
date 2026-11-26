import type { Scope, Session } from "../session"
import type { GenerationToken } from "../types"
import type { Evidence } from "./evidence"
import type { Flight } from "./flight"
import {
  FLIGHT_KIND_RULES,
  keysDiscarded,
  keysFailureOf,
  type DiscardedAnswer,
  type FlightKind,
  type FlightKindRules,
  type KeysFailure,
} from "./flight-kinds"
import type { SettleOutcome, SiteCode } from "./vocabulary"

/*
 * Прохід осідання (спека ядра синхронізації §5.5, Р-SK2-3): одна область
 * запису над одним чи кількома польотами, кроки 1–9 в однаковому порядку для
 * всіх видів польоту. Прохід не знає рядків і сховищ: кроки, що їх пишуть,
 * дає шлях гачками, а відмінності `main` між точками — дані виду польоту
 * (`flight-kinds.ts`) чи названий гачок, а не умова в проході.
 */

/** Політ, що осідає, і його відповідь. */
export interface SettleEntry {
  readonly flight: Flight
  /** Читання відмовило (крок 3): помилка, з якою воно відмовило. */
  readonly failure?: { readonly error: unknown }
  /**
   * Осідання польоту, після якого це осідає (Р-SK2-8): ключі приймача — після
   * польоту ТЧ свого власника. Прохід чекає його перед кроком 1.
   */
  readonly after?: PromiseLike<unknown>
}

/** Один наслідок на політ; `detail` — те, що бачить діагностика (код збою). */
export interface SettleResult<D = unknown> {
  readonly outcome: SettleOutcome
  readonly detail?: D
}

/**
 * Гачки шляху за кроками §5.5. Крок 1 — `invalid`, 2 — `barrier`, 3 —
 * `refused` і `failureDetail`, 4 — `gate`, 5 — `apply`, 6 — `marks`, 7 —
 * `settleTarget`, 8 — `sweep`, 9 — `settled` і зняття оренди проходом.
 * Гачок, якого шлях не дає, — крок без дії.
 */
export interface SettleHooks<E extends SettleEntry, D = unknown> {
  /** Токен області запису: дочірній токен польоту чи токен сесії пачки. */
  readonly token: GenerationToken
  /** Підпис області запису для журналу пізньої відповіді. */
  readonly what: string
  /**
   * Тихий вихід до області запису: шлях уже зупинено (приймач після `stop`,
   * токен ключа недійсний), і область з її журналом пізньої відповіді не
   * відкривається, як на `main`. Наслідок `closed`; оренда знімається.
   */
  quiet?(entry: E): boolean
  /** Крок 1: чому політ уже не може писати; `undefined` — може. */
  invalid?(entry: E): SettleOutcome | undefined
  /** Наслідок польоту, коли область запису не відбулась (токен недійсний). */
  lost?(entry: E): SettleOutcome
  /**
   * Крок 2: бар'єр purge рівня відповіді; питається лише про польоти з
   * `purgeBarrier`. `true` — відповідь відкинуто, вимога лишається.
   */
  barrier?(entry: E): boolean
  /**
   * Крок 3, тихий вихід: відмова, після якої писати нікуди (закритий
   * обмежувач читань). Область запису тоді не відкривається для цього польоту.
   */
  refused?(error: unknown): boolean
  /** Код збою для діагностики (крок 3 і збій застосування). */
  failureDetail?(error: unknown): D
  /**
   * Крок 3: дія шляху над збоєм читання в області запису (до кроку 7), коли
   * збій пише не стан цілі, а рядки чи позначки виглядів (ключі приймача).
   */
  readFailed?(entry: E, scope: Scope): void
  /** Дія шляху перед брамою епох: застосування відповіді ще не почалось. */
  beforeGate?(entry: E, scope: Scope): void
  /** Крок 4: брама епох версій відповіді. */
  gate?(entry: E, scope: Scope): "apply" | "discard"
  /** Відкинута брамою відповідь: правило виду (`rulesOf(flight).discardedAnswer`). */
  discarded?(entry: E, scope: Scope): void
  /** Крок 5: застосування відповіді читачем; виняток — збій застосування. */
  apply?(entry: E, scope: Scope): void
  /** Дефект застосування: журнал; стан цілі веде крок 7. */
  applyFailed?(entry: E, error: unknown, scope: Scope): void
  /**
   * Після застосування: відповідь стала відкинутою, бо purge скинув те, що
   * вона писала (сторінка вікна, R17). `true` — наслідок `after-purge`,
   * кроки 6–7 не йдуть.
   */
  dropped?(entry: E): boolean
  /** Крок 6: побічні позначки над станом після запису. */
  marks?(entry: E, scope: Scope): void
  /**
   * Крок 7 — названий шов `settleTarget(flight, outcome, evidence)`: перехід
   * стану цілі за наслідком. `failure` — помилка збою читання чи застосування.
   */
  settleTarget?(
    flight: Flight,
    outcome: SettleOutcome,
    evidence: Evidence | undefined,
    failure?: { readonly error: unknown }
  ): void
  /** Доказ відповіді, коли він багатший за епоху старту (епохи версій частин). */
  evidence?(entry: E): Evidence | undefined
  /** Крок 8: прибирання рядків без власника, нова ревізія похідних. */
  sweep?(scope: Scope): void
  /**
   * Після `sweep`, ще в області запису: дія шляху над польотом, що дійшов до
   * кроку 3 (позначка сторінки), у тому числі після збою читання.
   */
  finish?(entry: E, outcome: SettleOutcome, scope: Scope): void
  /** Крок 9: наслідок названо; оренда ще тримається (подія спроби). */
  settled?(entry: E, outcome: SettleOutcome, detail: D | undefined): void
}

/** Правила польоту: рядок таблиці виду й клітинки, що залежать від причини й коду. */
export interface ResolvedRules extends FlightKindRules {
  /** Збій ключів: перевизначення коду рядка, інакше правило причини. */
  readonly keysFailure?: KeysFailure
  /** Відкинута відповідь: для ключів — за причиною. */
  readonly discardedAnswer: DiscardedAnswer
}

const kindOf = (flight: Flight): FlightKind => {
  if (flight.kind === undefined)
    throw new Error("a flight settles with its kind")
  return flight.kind
}

const KEYS_REASONS = ["signal", "requirement", "write-confirm"] as const

/** Правила польоту з таблиці виду; політ без виду осісти не може. */
export function rulesOf(flight: Flight): ResolvedRules {
  const kind = kindOf(flight)
  const rules = FLIGHT_KIND_RULES[kind]
  if (kind !== "keys") return { ...rules, discardedAnswer: rules.discarded }
  const reason = KEYS_REASONS.find((r) => r === flight.reason)
  if (reason === undefined)
    throw new Error(
      "a keys flight reads for signal, requirement or write-confirm"
    )
  return {
    ...rules,
    keysFailure: keysFailureOf(flight.site as SiteCode, reason),
    discardedAnswer: keysDiscarded(reason),
  }
}

/**
 * Збій читання, що лишає вигляд без `sweep` на `main`: завантаження й сторінка
 * на відмові читання пишуть стан вигляду і не торкаються рядків; системне
 * перечитування осідає загальною областю, де `sweep` стоїть у `finally`.
 * Ключі: `sweep` дає лише гачок приймача, а `main` осідає його загальною
 * областю `commit`, де `sweep` стоїть у `finally` і на збої читання; хвіст і
 * підтвердження запису `sweep` не мають (гачка немає). Службове — до SK-4.
 */
export const SWEEPS_AFTER_READ_FAILURE: Readonly<Record<FlightKind, boolean>> =
  {
    load: false,
    page: false,
    reread: true,
    keys: true,
    service: false,
  }

/** Доказ осідання за польотом: епоха старту, а для службового — мить відправки. */
function evidenceOf(flight: Flight): Evidence | undefined {
  if (flight.epoch === undefined) return undefined
  return flight.kind === "service"
    ? { kind: "service-sent", epoch: flight.epoch }
    : { kind: "session-start", epoch: flight.epoch }
}

/**
 * Один прохід: синхронний, коли жоден політ не чекає залежності. Оренда
 * кожного польоту знімається рівно раз — і тоді, коли гачок кидає.
 */
export function settlePass<E extends SettleEntry, D = unknown>(
  session: Pick<Session, "commit">,
  entries: readonly E[],
  hooks: SettleHooks<E, D>
): SettleResult<D>[] {
  const outcomes: (SettleOutcome | undefined)[] = entries.map(() => undefined)
  const details: (D | undefined)[] = entries.map(() => undefined)
  const leases = new Set(
    entries.flatMap(({ flight }) =>
      flight.lease === undefined ? [] : [flight.lease]
    )
  )
  try {
    const live: number[] = []
    entries.forEach((entry, i) => {
      if (
        hooks.quiet?.(entry) === true ||
        (entry.failure !== undefined && hooks.refused?.(entry.failure.error))
      )
        outcomes[i] = "closed"
      else live.push(i)
    })
    if (live.length > 0) {
      const ran = session.commit(
        (scope) => region(scope, live),
        hooks.token,
        hooks.what
      )
      if (!ran)
        for (const i of live)
          outcomes[i] = hooks.lost?.(entries[i]!) ?? "closed"
    }
    entries.forEach((entry, i) =>
      hooks.settled?.(entry, outcomes[i]!, details[i])
    )
  } finally {
    for (const lease of leases) lease.release()
  }
  return entries.map((_, i) => ({
    outcome: outcomes[i]!,
    ...(details[i] === undefined ? {} : { detail: details[i] }),
  }))

  function region(scope: Scope, live: readonly number[]) {
    const reached: number[] = []
    try {
      for (const i of live) {
        const entry = entries[i]!
        const { flight } = entry
        // Крок 1.
        const lost = hooks.invalid?.(entry)
        if (lost !== undefined) {
          outcomes[i] = lost
          continue
        }
        // Крок 2: лише польоти, що мають бар'єр (системне перечитування).
        if (flight.purgeBarrier !== undefined && hooks.barrier?.(entry)) {
          outcomes[i] = "after-purge"
          continue
        }
        reached.push(i)
        const failed = (error: unknown) => {
          outcomes[i] = "failed"
          details[i] = hooks.failureDetail?.(error)
          return { error }
        }
        // Крок 3.
        if (entry.failure !== undefined) {
          const failure = failed(entry.failure.error)
          hooks.readFailed?.(entry, scope)
          hooks.settleTarget?.(flight, "failed", undefined, failure)
          continue
        }
        hooks.beforeGate?.(entry, scope)
        // Крок 4.
        if (hooks.gate?.(entry, scope) === "discard") {
          outcomes[i] = "discarded-by-epoch"
          hooks.discarded?.(entry, scope)
          hooks.settleTarget?.(flight, "discarded-by-epoch", undefined)
          continue
        }
        // Крок 5.
        try {
          hooks.apply?.(entry, scope)
        } catch (error) {
          const failure = failed(error)
          hooks.applyFailed?.(entry, error, scope)
          hooks.settleTarget?.(flight, "failed", undefined, failure)
          continue
        }
        if (hooks.dropped?.(entry) === true) {
          outcomes[i] = "after-purge"
          continue
        }
        outcomes[i] = "applied"
        // Крок 6 і 7.
        hooks.marks?.(entry, scope)
        hooks.settleTarget?.(
          flight,
          "applied",
          hooks.evidence?.(entry) ?? evidenceOf(flight)
        )
      }
    } finally {
      // Крок 8: лише збій читання виду без `sweep` на `main` його не кличе;
      // витіснений чи відкинутий бар'єром політ осідає загальною областю, де
      // `sweep` стоїть у `finally`.
      const quiet = (i: number) =>
        reached.includes(i) &&
        entries[i]!.failure !== undefined &&
        !SWEEPS_AFTER_READ_FAILURE[kindOf(entries[i]!.flight)]
      if (!live.every(quiet)) hooks.sweep?.(scope)
      for (const i of reached)
        hooks.finish?.(entries[i]!, outcomes[i] ?? "failed", scope)
    }
  }
}

/**
 * Прохід із залежністю (Р-SK2-8): чекає осідання польотів, після яких осідають
 * записи пачки, і лише тоді йде синхронний прохід. Без залежності — той самий
 * синхронний прохід без зайвих мікрозадач.
 */
export function settleAfter<E extends SettleEntry, D = unknown>(
  session: Pick<Session, "commit">,
  entries: readonly E[],
  hooks: SettleHooks<E, D>
): SettleResult<D>[] | Promise<SettleResult<D>[]> {
  const waits = entries.flatMap((entry) =>
    entry.after === undefined ? [] : [entry.after]
  )
  if (waits.length === 0) return settlePass(session, entries, hooks)
  return Promise.all(waits).then(() => settlePass(session, entries, hooks))
}
