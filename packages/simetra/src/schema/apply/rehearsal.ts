import { z } from "zod"
import { canonicalize, serializeCanonical, sha256Hex } from "simetra/compiler"
import {
  hashSchema,
  planFileStem,
  serverFactsSchema,
  type PlanArtifact,
} from "./artifact"
import { applyDiagnostic } from "./diagnostic"
import type { EngineDiagnostic } from "../engine"
import {
  FUNCTION_ERROR_LIMIT,
  PLPGSQL_CHECK_MODES,
  type FunctionError,
  type PlpgsqlCheckMode,
} from "./function-checks"
import { DATA_TRIGGER_MODES } from "./promotion/data"
import type { ServerFacts } from "./server"

/**
 * Форма файлу звіту (рішення 3 плану П3-2b-3). Інший формат — «звіт
 * застарів»: репетицію повторюють, шиму немає.
 */
export const REHEARSAL_FORMAT = 1

/**
 * Фази репетиції, яким `timedTransaction` приписує оператори (рішення 4 плану
 * П3-2b-3). Один перелік і для раннера, і для схеми звіту: фаза поза ним — не
 * звіт цієї платформи.
 */
export const REHEARSAL_PHASES = [
  "advisory",
  "role",
  "timeouts",
  "chain",
  "targetChecks",
  "lock",
  "fingerprint",
  "measureBefore",
  "existing",
  "baseline",
  "compute",
  "intent",
  "write",
  "engine",
  "carriers",
  "environment",
  "deferred",
  "measureAfter",
  "revalidation",
  "validity",
  "verify",
  "proof",
  "state",
  "footprint",
] as const
export type RehearsalPhase = (typeof REHEARSAL_PHASES)[number]

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
  /** Цілі мілісекунди; округлює лише `rehearsalReport`. */
  durations: {
    /** Сума округлених операторів фази; у `proof` — ще й витяг двигуна. */
    phases: { phase: RehearsalPhase; ms: number }[]
    /** Кожен оператор окремим записом; схема id — `STEP_ID` нижче. */
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

/**
 * Сирі виміри репетиції, як їх дав годинник (дробові мс): звіт з них рахує
 * `rehearsalReport`. Фаза оператора — тут, бо з id кроку плану (`s<N>`) її
 * не видно.
 */
export interface RehearsalTimings {
  /**
   * Фази в порядку входу. `extractMs` — витяг двигуна у фазі: він не
   * оператор і в `steps` не потрапляє.
   */
  phases: { phase: RehearsalPhase; extractMs: number }[]
  steps: { id: string; phase: RehearsalPhase; ms: number }[]
}

/** Докази раннера: усе для звіту, крім того, що додає інструмент. */
export type RehearsalEvidence = Omit<
  RehearsalReport,
  "format" | "planHash" | "durations"
> & { durations: RehearsalTimings }

/**
 * Звіт із доказів раннера — єдине місце, що округлює тривалості: кожен
 * оператор — `Math.ceil` (ціле, тож тайм-аут зі звіту оператор не
 * недооцінить), фаза — сума вже округлених операторів, найдовший — максимум
 * округлених; файл так узгоджений сам із собою. Виняток — витяг двигуна: він
 * не оператор, тож до фази (на успішній репетиції це лише `proof`) додається
 * окремо як `Math.ceil` свого часу.
 */
export function rehearsalReport(
  planHash: string,
  evidence: RehearsalEvidence
): RehearsalReport {
  const { durations, ...rest } = evidence
  const steps = durations.steps.map((s) => ({ ...s, ms: Math.ceil(s.ms) }))
  return {
    format: REHEARSAL_FORMAT,
    planHash,
    ...rest,
    durations: {
      phases: durations.phases.map(({ phase, extractMs }) => ({
        phase,
        ms:
          steps
            .filter((s) => s.phase === phase)
            .reduce((sum, s) => sum + s.ms, 0) + Math.ceil(extractMs),
      })),
      steps: steps.map(({ id, ms }) => ({ id, ms })),
      longestStatementMs: steps.reduce((max, s) => Math.max(max, s.ms), 0),
    },
  }
}

const positive = "[1-9][0-9]*"

/**
 * Закрита схема id операторів (ставить її `timedTransaction` у `execute.ts`):
 * - `s<N>` — оператор кроку плану (`stepId`);
 * - `compute-table-<n>` / `write-table-<n>` — оператор таблиці даних фаз 8 і
 *   10, `n` — номер таблиці в секції `data`;
 * - `constraints-data` / `constraints-deferred` — `SET CONSTRAINTS ALL
 *   IMMEDIATE` після запису даних і фази 13;
 * - `<фаза>-<k>` — k-й оператор фази без власного id (фаза — з
 *   `REHEARSAL_PHASES`).
 * Будь-що інше, як і повтор id, — не звіт цього раннера.
 */
const STEP_ID = new RegExp(
  `^(?:s${positive}|(?:compute|write)-table-${positive}|constraints-(?:data|deferred)|(?:${REHEARSAL_PHASES.join("|")})-${positive})$`
)

const ms = z.number().int().nonnegative()
const count = z.number().int().nonnegative()
const tableName = { schema: z.string(), table: z.string() }

const functionErrors = z
  .array(
    z.strictObject({
      oid: z.string(),
      signature: z.string(),
      relationOid: z.string().nullable(),
      relation: z.string().nullable(),
      sqlstate: z.string(),
      message: z.string(),
    })
  )
  .max(FUNCTION_ERROR_LIMIT)

/** Строга схема звіту: невідоме поле чи інша форма — зіпсований файл. */
export const rehearsalReportSchema: z.ZodType<RehearsalReport> = z.strictObject(
  {
    format: z.literal(REHEARSAL_FORMAT),
    planHash: hashSchema,
    server: serverFactsSchema,
    ledgerHead: z.string().nullable(),
    rows: z.array(z.strictObject({ ...tableName, rows: count })),
    durations: z.strictObject({
      // Раннер пише фази, у які входив: підмножина переліку, кожна раз
      phases: z
        .array(z.strictObject({ phase: z.enum(REHEARSAL_PHASES), ms }))
        .superRefine((phases, ctx) => {
          const seen = new Set<string>()
          for (const [i, { phase }] of phases.entries()) {
            if (seen.has(phase))
              ctx.addIssue({
                code: "custom",
                path: [i, "phase"],
                message: `duplicate phase ${phase}`,
              })
            seen.add(phase)
          }
        }),
      steps: z
        .array(z.strictObject({ id: z.string().regex(STEP_ID), ms }))
        .superRefine((steps, ctx) => {
          const seen = new Set<string>()
          for (const [i, { id }] of steps.entries()) {
            if (seen.has(id))
              ctx.addIssue({
                code: "custom",
                path: [i, "id"],
                message: `duplicate statement id ${id}`,
              })
            seen.add(id)
          }
        }),
      longestStatementMs: ms,
    }),
    data: z.array(
      z.strictObject({ ...tableName, computed: count, written: count })
    ),
    preservation: z.array(z.strictObject({ ...tableName, rows: count })),
    plpgsqlCheck: z.union([
      z.literal("skipped"),
      z.strictObject({
        mode: z.enum(PLPGSQL_CHECK_MODES),
        baseline: functionErrors,
        after: functionErrors,
      }),
    ]),
    triggers: z.array(
      z.strictObject({
        ...tableName,
        name: z.string(),
        enabled: z.enum(DATA_TRIGGER_MODES),
      })
    ),
    lockFootprint: z.array(
      z.strictObject({
        table: z.string(),
        mode: z.string(),
        planned: z.string(),
      })
    ),
  }
)

/** Файл звіту — канонічна форма з відступом 2 і `\n` наприкінці, як план. */
export function serializeRehearsal(report: RehearsalReport): string {
  return serializeCanonical(report)
}

/**
 * Строгий розбір файлу звіту. `format` читається до строгої схеми, як у
 * `parsePlan`: звіт іншого формату — «застарів, повтори репетицію», а не
 * зіпсований файл.
 */
export function parseRehearsal(
  text: string
):
  | { ok: true; report: RehearsalReport }
  | { ok: false; reason: "format" | "invalid"; message: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      reason: "invalid",
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const format =
    typeof json === "object" && json !== null && !Array.isArray(json)
      ? (json as Record<string, unknown>).format
      : undefined
  if (typeof format === "number" && format !== REHEARSAL_FORMAT)
    return {
      ok: false,
      reason: "format",
      message: `the rehearsal report has format ${format}; this platform reads format ${REHEARSAL_FORMAT}`,
    }
  const result = rehearsalReportSchema.safeParse(json)
  return result.success
    ? { ok: true, report: result.data }
    : { ok: false, reason: "invalid", message: z.prettifyError(result.error) }
}

/**
 * Хеш звіту для ledger (рішення 7 плану П3-2b-3): `sha256Hex` канонічної
 * форми, тож той самий звіт дає той самий хеш незалежно від порядку ключів.
 */
export function rehearsalHash(report: RehearsalReport): Promise<string> {
  return sha256Hex(canonicalize(report))
}

/** `<from12>-<to12>.rehearsal.json` — поруч із файлом плану того переходу. */
export function rehearsalFileName(
  fromHash: string | null,
  toHash: string
): string {
  return `${planFileStem(fromHash, toHash)}.rehearsal.json`
}

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

/**
 * Чи звіт чинний для застосування промоції цього плану (рішення 5 плану
 * П3-2b-3, спека промоції §8) — до будь-якої транзакції, чисто. Звіт не під
 * `planHash`, тож раннер звіряє його з даним планом і `planHash` викликача
 * (сам хеш плану перевіряє інструмент через `verifyPlanHash` до виклику):
 * звіт іншого плану, сервера чи голови ledger — «звіт застарів». Склад `rows` — рівно
 * один запис на кожну таблицю одиниці в старих іменах і нічого більше:
 * інакше звіт без рядків оминув би гейт порожньої копії фази 6c. План без
 * промоції звіту не потребує. Одна діагностика — перша розбіжність.
 */
export function rehearsalRefusals(
  plan: Pick<PlanArtifact, "server" | "ledgerHead" | "promotion">,
  planHash: string,
  report: RehearsalReport | undefined
): EngineDiagnostic[] {
  if (plan.promotion === null) return []
  if (report === undefined)
    return [applyDiagnostic("apply.rehearsal-required", "error")]
  const stale = (reason: "plan" | "server" | "ledger" | "tables") => [
    applyDiagnostic("apply.rehearsal-stale", "error", { reason }),
  ]
  if (report.planHash !== planHash) return stale("plan")
  if (canonicalize(report.server) !== canonicalize(plan.server))
    return stale("server")
  if (report.ledgerHead !== plan.ledgerHead) return stale("ledger")
  const { tables } = plan.promotion.record
  const covered =
    report.rows.length === tables.length &&
    tables.every(
      (t) =>
        report.rows.filter((r) => r.schema === t.schema && r.table === t.from)
          .length === 1
    )
  return covered ? [] : stale("tables")
}

/** Нижня межа тайм-ауту оператора зі звіту: хвилина (спека промоції §8). */
const MIN_STATEMENT_TIMEOUT_MS = 60_000

/**
 * Верхня межа `statement_timeout` Postgres (INT_MAX мс, рішення R10). Більше
 * значення сервер відкине, а відмова через артефакт виміру заблокувала б
 * законне застосування; стільки мілісекунд — це вже фактично «без межі», тож
 * формула притискається до неї, а людина отримує попередження.
 */
const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647

/**
 * `statement_timeout` застосування промоції зі звіту (рішення 6 плану
 * П3-2b-3, спека промоції §8): `max(60 000, ⌈3 × longestStatementMs ×
 * max(1, maxₜ(ціль ₜ / копія ₜ))⌉)` мс, не більше
 * `MAX_STATEMENT_TIMEOUT_MS`. Множник — найгірша таблиця, а не відношення
 * сум: оператор над великою таблицею росте з нею, а не з одиницею. Таблиця
 * без рядків на копії відношення не має і в множник не входить. Добуток —
 * цілими до ділення, щоб дріб не дав зайвої мілісекунди. `computed` —
 * значення формули до межі: його називає попередження про зняту межу.
 */
export function statementTimeoutFromReport(
  report: RehearsalReport,
  targetRows: readonly { schema: string; table: string; rows: number }[]
): { ms: number; computed: number; clamped: boolean } {
  const base = 3 * report.durations.longestStatementMs
  let computed = Math.max(MIN_STATEMENT_TIMEOUT_MS, base)
  for (const t of targetRows) {
    const copy = report.rows.find(
      (r) => r.schema === t.schema && r.table === t.table
    )?.rows
    if (copy === undefined || copy === 0) continue
    computed = Math.max(computed, Math.ceil((base * t.rows) / copy))
  }
  const clamped = computed > MAX_STATEMENT_TIMEOUT_MS
  return {
    ms: clamped ? MAX_STATEMENT_TIMEOUT_MS : computed,
    computed,
    clamped,
  }
}
