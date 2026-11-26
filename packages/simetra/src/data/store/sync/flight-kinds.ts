import type { ReadReason, SiteCode } from "./vocabulary"

/*
 * Види польоту й правила осідання за видом — дані (спека ядра синхронізації
 * §5.5, Р-SK2-4). Відмінності `main` між точками — клітинки й перевизначення
 * за кодом рядка Додатка Б, а не гілки проходу.
 */

/** Види польоту, у порядку таблиці §5.5. */
export const FLIGHT_KINDS = [
  "load",
  "page",
  "reread",
  "keys",
  "service",
] as const
export type FlightKind = (typeof FLIGHT_KINDS)[number]

/** Що польот підтверджує. */
export type Confirms =
  /** Вигляд; завантаження може змінити склад. */
  | "view-with-composition"
  /** Лише власну сторінку (`retry` за П15 — лише власне відхилення). */
  | "own-page"
  /** Вигляд без зміни складу й порядку (правило стабільності). */
  | "view-stable"
  /** Рядки за їхніми правилами зняття позначок. */
  | "rows"
  /** Службову ціль. */
  | "service"

/** Чи збій рахує паузу збоїв. */
export type FailureCounts =
  | "if-loaded" // завантаження: лише для вже завантаженого вигляду
  | "never" // сторінка; службове — до SK-4 (рядок 6 §5.14)
  | "always" // системне перечитування
  | "by-reason" // ключі: вирішує причина, див. `KEYS_FAILURE`

/** Що робить збій ключів за причиною (§5.5, ряд «читання ключів»). */
export type KeysFailure =
  | "composition-unconfirmed" // `signal`: «склад не підтверджено» й `needsRefresh`
  | "requirement-budget" // `requirement`: бюджет вимоги; хвіст нічого не ставить
  | "reply-to-requester" // `write-confirm`: наслідок запитувачу й `markUnconfirmed`

/** Що робить відкинута за епохою відповідь. */
export type DiscardedAnswer =
  | "pause-then-retry" // пауза відкинутих, далі `retry` (завантаження, сторінка)
  | "pause-then-deadline" // системне перечитування: пауза в стані цілі, далі строк
  | "reply-discarded" // `write-confirm`: наслідок «відкинуто»
  | "nothing" // ключі, крім `write-confirm`
  | "none" // службове: клітинки в таблиці немає

export interface FlightKindRules {
  /** Причини, з якими польоти виду бувають (§5.5, колонка «Причини»). */
  readonly reasons: readonly ReadReason[]
  readonly confirms: Confirms
  /** Успіх рухає строк і доказ вигляду. */
  readonly successMovesDeadline: boolean
  readonly failureCounts: FailureCounts
  /** Успіх знімає банери; `null` — клітинки немає (службове). */
  readonly liftsBanners: boolean | null
  /** Польоти виду ставлять банер нових рядків і зміни списку. */
  readonly setsBanners: boolean
  readonly discarded: DiscardedAnswer
}

export const FLIGHT_KIND_RULES: Readonly<Record<FlightKind, FlightKindRules>> =
  {
    load: {
      reasons: ["mount", "user", "retry", "requirement"],
      confirms: "view-with-composition",
      successMovesDeadline: true,
      failureCounts: "if-loaded",
      liftsBanners: true,
      setsBanners: false,
      discarded: "pause-then-retry",
    },
    page: {
      reasons: ["user", "retry"],
      confirms: "own-page",
      successMovesDeadline: false,
      failureCounts: "never",
      liftsBanners: false,
      setsBanners: false,
      discarded: "pause-then-retry",
    },
    reread: {
      reasons: ["requirement", "interval", "user", "signal"],
      confirms: "view-stable",
      successMovesDeadline: true,
      failureCounts: "always",
      liftsBanners: false,
      setsBanners: true,
      discarded: "pause-then-deadline",
    },
    keys: {
      reasons: ["signal", "requirement", "write-confirm"],
      confirms: "rows",
      successMovesDeadline: false,
      failureCounts: "by-reason",
      liftsBanners: false,
      setsBanners: false,
      discarded: "nothing", // `write-confirm` — «відкинуто», див. `keysDiscarded`
    },
    service: {
      reasons: ["requirement", "interval"],
      confirms: "service",
      successMovesDeadline: true,
      failureCounts: "never",
      liftsBanners: null,
      setsBanners: false,
      discarded: "none",
    },
  }

/** Збій ключів за причиною (рядок «читання ключів», колонка «Збій»). */
export const KEYS_FAILURE: Readonly<
  Record<"signal" | "requirement" | "write-confirm", KeysFailure>
> = {
  signal: "composition-unconfirmed",
  requirement: "requirement-budget",
  "write-confirm": "reply-to-requester",
}

/** Відкинута відповідь ключів: лише `write-confirm` — наслідок запитувачу. */
export const keysDiscarded = (
  reason: "signal" | "requirement" | "write-confirm"
): DiscardedAnswer =>
  reason === "write-confirm" ? "reply-discarded" : "nothing"

/**
 * Перевизначення правил за кодом рядка Додатка Б (форма SK-1), де `main`
 * різниться всередині виду. K2 (`requirement` «мінімальна версія» приймача)
 * на збої веде себе як K1 (`needsRefresh` і «склад не підтверджено»), а не як
 * хвіст K3. `scheduleRetry` K2 — гачок після області запису, тож це дані
 * збою, а не порядку.
 */
export interface SiteOverride {
  readonly keysFailure: KeysFailure
  readonly schedulesRetryAfterCommit: boolean
}

export const SITE_OVERRIDES: Readonly<Partial<Record<SiteCode, SiteOverride>>> =
  {
    K2: {
      keysFailure: "composition-unconfirmed",
      schedulesRetryAfterCommit: true,
    },
  }

/** Збій ключів польоту: перевизначення коду, інакше правило причини. */
export const keysFailureOf = (
  site: SiteCode,
  reason: "signal" | "requirement" | "write-confirm"
): KeysFailure => SITE_OVERRIDES[site]?.keysFailure ?? KEYS_FAILURE[reason]
