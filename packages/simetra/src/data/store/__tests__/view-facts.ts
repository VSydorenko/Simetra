import type { AttemptEvent } from "../attempts"

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
}

export interface ViewTracker {
  /** Системних перечитувань вигляду, що почалися. */
  rereads(id: number): number
  /** Початок останнього застосованого читання вигляду; `undefined` — не читався. */
  refreshedAt(id: number): number | undefined
  /** Невдалі читання вигляду поспіль і початок останнього з них. */
  failures(id: number): number
  failedAt(id: number): number | undefined
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
  const of = (id: number): Facts => {
    let facts = views.get(id)
    if (facts === undefined) {
      facts = {
        rereads: 0,
        refreshedAt: undefined,
        failures: 0,
        failedAt: undefined,
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
      return
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
    stop,
  }
}
