import type {
  AdmissionCondition,
  ReadCause,
  ReadReason,
  RequirementKind,
  SiteCode,
  TargetKind,
} from "./vocabulary"

/*
 * Таблиця допуску як дані (спека ядра синхронізації §5.3, план SK-1, Р-SK1-4).
 * Дві частини: базові клітинки — цільова таблиця §5.3 (усі причини, вісім
 * умов, підтаблиця «Прихована й невидима» §5.2 за видом вимоги) і
 * перевизначення за кодом рядка Додатка Б, які відтворюють `main`. Кожне
 * перевизначення називає, на чому стоїть: рядок §5.14, що його прибере (SK-4),
 * «Не змінюється» §5.14 чи пізню відмову Р-SK1-6. SK-4 прибирає перевизначення
 * й значення «судить шлях», не змінюючи форми.
 */

/** Умови, які судить шлюз SK-1; решту до SK-3/SK-4 судить шлях. */
export const JUDGED_CONDITIONS = [
  "closed",
  "stale-object",
  "discard-bound",
  "tab-hidden",
] as const satisfies readonly AdmissionCondition[]
export type JudgedCondition = (typeof JUDGED_CONDITIONS)[number]

/** Відповідь клітинки: допуск, «відкладено» чи «відмовлено». */
export type Answer = "admit" | "defer" | "refuse"

/**
 * Базова клітинка: відповідь; `path` — умову до SK-3/SK-4 судить шлях;
 * `hidden-by-kind` — за колонкою «Прихована й невидима» §5.2 виду вимоги.
 */
export type BaseCell = Answer | "path" | "hidden-by-kind"

/** На чому стоїть перевизначення: без підстави його не запишеш. */
export type Basis =
  /** Рядок §5.14, що прибирає різницю (SK-4). */
  | { readonly row: number }
  /** «Не змінюється» §5.14: ціль і `main` збігаються, таблиця називає явно. */
  | { readonly unchanged: string }
  /**
   * Пізня відмова Р-SK1-6: шлях на `main` об'єкта не перевіряє, частину без
   * запиту відмовляє `dispatch` (той самий `command.stale-client`).
   */
  | { readonly late: "stale-object" }

export interface Override {
  readonly answer: Answer
  readonly basis: Basis
}

const PATH = {
  "target-invisible": "path",
  paused: "path",
  promised: "path",
  hydrating: "path",
} as const

/**
 * Цільова таблиця §5.3. `discard-bound` «для службових цілей не діє» й
 * «стосується лише читань рядків» — правило над таблицею ({@link baseAnswer}),
 * а не клітинка.
 */
export const BASE: Readonly<
  Record<ReadReason, Readonly<Record<AdmissionCondition, BaseCell>>>
> = {
  mount: {
    closed: "refuse",
    "stale-object": "refuse",
    "discard-bound": "refuse",
    "tab-hidden": "admit",
    ...PATH,
  },
  user: {
    closed: "refuse",
    "stale-object": "refuse",
    "discard-bound": "refuse",
    "tab-hidden": "admit",
    ...PATH,
  },
  retry: {
    closed: "refuse",
    "stale-object": "refuse",
    "discard-bound": "refuse",
    "tab-hidden": "defer",
    ...PATH,
  },
  requirement: {
    closed: "refuse",
    "stale-object": "refuse",
    "discard-bound": "refuse",
    "tab-hidden": "hidden-by-kind",
    ...PATH,
  },
  interval: {
    closed: "refuse",
    "stale-object": "refuse",
    "discard-bound": "refuse",
    "tab-hidden": "defer",
    ...PATH,
  },
  signal: {
    closed: "refuse",
    "stale-object": "refuse",
    "discard-bound": "refuse",
    // Відкладено: вимога «склад не підтверджено» виглядам об'єкта (§5.3).
    "tab-hidden": "defer",
    ...PATH,
  },
  "write-confirm": {
    closed: "refuse",
    "stale-object": "refuse",
    "discard-bound": "refuse",
    "tab-hidden": "admit",
    ...PATH,
  },
}

/**
 * Колонка «Прихована й невидима» §5.2 для прихованої вкладки. Видимість цілі
 * (`target-invisible`) до SK-4 судить шлях, тож тут лише вкладка.
 */
export const HIDDEN_TAB: Readonly<Record<RequirementKind, Answer>> = {
  "composition-unconfirmed": "defer",
  "channel-rejoin": "defer",
  "hydration-trust": "defer",
  // Доки звуження не ховає значень (до обчислювача блоку кешу прав).
  "access-narrowed": "admit",
  "target-behind-header": "defer",
  // Вимога приймача; вимога запису в межах бюджету читається як
  // `write-confirm` (K4), а не цим видом.
  "min-version": "defer",
  "value-hidden": "defer",
  "row-unfinished": "defer",
  "version-epoch-switched": "defer",
  // §5.2 ділить ці два види за постановником (приєднання й `resume()` —
  // відкладено, решта — допущено). Постановника вимога SK-1 не несе:
  // клітинка — допуск більшості постановників, як на `main`.
  "rights-unconfirmed": "admit",
  "version-unconfirmed": "admit",
}

// Коди, у яких колонка «Умови» Додатка Б не називає `stale-object`: їх
// відмовляє пізня відмова (Р-SK1-6). R10 перевіряє схований об'єкт, а не
// ціль (тримача): несумісного тримача, як на `main`, відмовляє пізня відмова
// (рішення архітекторки 25.11).
const LATE_STALE: readonly SiteCode[] = [
  "M1",
  "M2",
  "M3",
  "M4",
  "M6",
  "M7",
  "M8",
  "P1",
  "P2",
  "P3",
  "R3",
  "R7",
  "R9",
  "R10",
  "R11",
  "R12",
  "R15",
  "R16",
  "R17",
  "R18",
  "K3",
  "K4",
  "S1",
  "S2",
  "S3",
]

// Межа відкинутих без перевірки шляху (Р-SK1-7): рядки 8 і 16 §5.14.
const DISCARD_ROW_8: readonly SiteCode[] = [
  "M1",
  "M2",
  "M3",
  "M5",
  "P1",
  "R7",
  "K4",
]
const DISCARD_ROW_16: readonly SiteCode[] = [
  "R5",
  "R6",
  "R10",
  "R11",
  "R12",
  "K3",
  "M4",
  "M6",
  "M8",
  "P2",
  "R14",
  "R16",
  "R17",
]

// Прихована вкладка: шляхи, що на `main` читають, хоча ціль відкладає.
const HIDDEN_ROW_1: readonly SiteCode[] = [
  "M4",
  "M8",
  "P2",
  "R5",
  "R10",
  "R12",
  "R14",
  "K3",
]
const HIDDEN_ROW_13: readonly SiteCode[] = ["R16", "R17"]

type Overrides = Partial<
  Record<SiteCode, Partial<Record<JudgedCondition, Override>>>
>

function overridesOf(): Overrides {
  const out: Record<string, Partial<Record<JudgedCondition, Override>>> = {}
  const put = (
    codes: readonly SiteCode[],
    condition: JudgedCondition,
    basis: Basis
  ) => {
    for (const code of codes)
      (out[code] ??= {})[condition] = { answer: "admit", basis }
  }
  put(LATE_STALE, "stale-object", { late: "stale-object" })
  put(DISCARD_ROW_8, "discard-bound", { row: 8 })
  put(DISCARD_ROW_16, "discard-bound", { row: 16 })
  put(HIDDEN_ROW_1, "tab-hidden", { row: 1 })
  put(HIDDEN_ROW_13, "tab-hidden", { row: 13 })
  return out
}

/** Перевизначення за кодом рядка Додатка Б і умовою. */
export const OVERRIDES: Readonly<Overrides> = overridesOf()

/** Базова відповідь цільової таблиці; `path` — умову судить шлях. */
export function baseAnswer(
  cause: ReadCause,
  target: TargetKind,
  condition: AdmissionCondition
): Answer | "path" {
  if (condition === "discard-bound" && target === "service") return "admit"
  const cell = BASE[cause.reason][condition]
  if (cell !== "hidden-by-kind") return cell
  // Колонку §5.2 має лише рядок `requirement`: інша причина з нею — помилка даних.
  if (cause.reason !== "requirement")
    throw new Error(
      `a hidden-by-kind cell outside requirement: ${cause.reason}`
    )
  return HIDDEN_TAB[cause.requirement]
}

/** Відповідь шлюзу на одну умову: перевизначення коду, інакше база. */
export const answerOf = (
  cause: ReadCause,
  target: TargetKind,
  site: SiteCode,
  condition: JudgedCondition
): Answer | "path" =>
  OVERRIDES[site]?.[condition]?.answer ?? baseAnswer(cause, target, condition)
