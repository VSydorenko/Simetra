import type { FunctionError, PlpgsqlCheckMode } from "./function-checks"
import type { ServerFacts } from "./server"

/**
 * Звіт репетиції (рішення 3 плану П3-2b-3, спека промоції §8): те, що
 * успішна репетиція довела на копії з даними. У `planHash` не входить; він
 * прив'язаний до плану полем `planHash`. Таблиці — структурно `{ schema,
 * table }`, скрізь у старих іменах (до кроків), як їх знає ціль.
 */
export interface RehearsalReport {
  format: 1
  planHash: string
  server: ServerFacts
  ledgerHead: string | null
  /** Рядки таблиць одиниці з заміру «до» (фаза 6a). */
  rows: { schema: string; table: string; rows: number }[]
  durations: {
    /** Сума тривалостей операторів фази, зокрема витягу двигуна. */
    phases: { phase: string; ms: number }[]
    /**
     * Кожен оператор окремим записом; схему id описує `timedTransaction`
     * у `execute.ts`.
     */
    steps: { id: string; ms: number }[]
    /** Найдовший оператор `steps` — не сума фази й не витяг. */
    longestStatementMs: number
  }
  /** Лічильники кроків даних: обчислено (фаза 8) і записано (фаза 10). */
  data: { schema: string; table: string; computed: number; written: number }[]
  /** Рядки, збереження яких доведено замірами «після» (фаза 14). */
  preservation: { schema: string; table: string; rows: number }[]
  plpgsqlCheck:
    | "skipped"
    | {
        mode: PlpgsqlCheckMode
        baseline: FunctionError[]
        after: FunctionError[]
      }
  /** Тригери користувача, вимкнені на час запису кроків даних. */
  triggers: {
    schema: string
    table: string
    name: string
    enabled: "O" | "A"
  }[]
  /** Параметри попереджень `apply.lock-footprint-exceeded` (фаза 19a). */
  lockFootprint: { table: string; mode: string; planned: string }[]
}

/** Докази раннера: усе для звіту, крім того, що додає інструмент. */
export type RehearsalEvidence = Omit<RehearsalReport, "format" | "planHash">

/**
 * Лічильник з бази як число (рішення 3, «Лічильники — числа»): порт
 * повертає `count(*)` (`bigint`) рядком. Десятковий рядок чи число →
 * `Number`; від'ємне, дробове, понад безпечне ціле чи щось інше — дефект
 * порту, а не стан цілі, тож `Error`, а не діагностика.
 */
export function countOf(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : Number.NaN
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error(
      `a count from the database is not a non-negative safe integer: ${String(value)}`
    )
  return n
}
