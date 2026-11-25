import type { AttemptEvent } from "../attempts"
import type { SiteCode } from "../sync/vocabulary"

// Повтор спроби того самого завантаження (рядки M7, M8 інвентаря): покоління
// й політ ядро не змінює.
const RETRY_SITES: ReadonlySet<SiteCode> = new Set(["M7", "M8"])

/*
 * Факти про вигляди, які модельний тест веде сам (рішення архітекторки
 * 2026-11-23, 2а): відмітка свіжості, збої й лічильник системних перечитувань
 * не читаються з `Subset` — оракул планувальника не має судити за тим самим
 * станом, який перевіряє. Джерела — події `watchAttempts` («розпочато» з
 * часом моделі й «осіло» з наслідком §5.5; їх звіряє з журналом фейкового
 * джерела оракул осідання) і годинник моделі. Ключ — непрозорий
 * ідентифікатор цілі, однаковий у подіях і в `sync()`.
 */

export interface AttemptSource {
  watchAttempts(listener: (event: AttemptEvent) => void): () => void
}

interface Facts {
  rereads: number
  refreshedAt: number | undefined
  failures: number
  failedAt: number | undefined
  loads: number
  lost: Set<number>
}

export interface ViewTracker {
  /** Системних перечитувань вигляду, що почалися. */
  rereads(id: number): number
  /** Початок останнього застосованого читання вигляду; `undefined` — не читався. */
  refreshedAt(id: number): number | undefined
  /** Невдалі читання вигляду поспіль і початок останнього з них. */
  failures(id: number): number
  failedAt(id: number): number | undefined
  /**
   * Завантажень вигляду, що почалися (повтор тієї самої спроби — M7, M8 — не
   * нове завантаження): номер останнього — номер польоту завантаження.
   */
  loads(id: number): number
  /** Завантаження з цим номером перезапустили: його спроба осіла після purge. */
  lost(id: number, load: number): boolean
  stop(): void
}

/**
 * Веде факти за подіями спроб. `loaded` каже, чи вигляд уже був завантажений
 * на мить збою: збій першого завантаження паузи не веде (§5.5, таблиця видів
 * польоту).
 */
export function trackViews(
  source: AttemptSource,
  now: () => number,
  loaded: (id: number) => boolean
): ViewTracker {
  const views = new Map<number, Facts>()
  const startedAt = new Map<number, number>()
  // Спроба завантаження → номер завантаження, якому вона належить.
  const loadOf = new Map<number, number>()
  const of = (id: number): Facts => {
    let facts = views.get(id)
    if (facts === undefined) {
      facts = {
        rereads: 0,
        refreshedAt: undefined,
        failures: 0,
        failedAt: undefined,
        loads: 0,
        lost: new Set(),
      }
      views.set(id, facts)
    }
    return facts
  }
  const stop = source.watchAttempts((event) => {
    const facts = of(event.target.id)
    if (event.phase === "started") {
      startedAt.set(event.attempt, now())
      if (event.kind === "reread") facts.rereads++
      if (event.kind === "load") {
        if (!RETRY_SITES.has(event.site)) facts.loads++
        loadOf.set(event.attempt, facts.loads)
      }
      return
    }
    // Політ завантаження осідає «після purge» лише тоді, коли його покоління
    // підняли в польоті (`purge` пари чи звуження прав): токен недійсний, а
    // вигляд живий і сесія відкрита.
    if (event.kind === "load" && event.outcome === "after-purge") {
      const load = loadOf.get(event.attempt)
      if (load !== undefined) facts.lost.add(load)
    }
    // Сторінка підтверджує лише себе: ні строку, ні паузи (§5.5).
    if (event.kind === "page") return
    const at = startedAt.get(event.attempt)
    if (event.outcome === "applied") {
      facts.refreshedAt = at
      facts.failures = 0
      facts.failedAt = undefined
    } else if (event.outcome === "failed" && loaded(event.target.id)) {
      facts.failures++
      facts.failedAt = at
    }
  })
  return {
    rereads: (id) => of(id).rereads,
    refreshedAt: (id) => of(id).refreshedAt,
    failures: (id) => of(id).failures,
    failedAt: (id) => of(id).failedAt,
    loads: (id) => of(id).loads,
    lost: (id, load) => of(id).lost.has(load),
    stop,
  }
}
