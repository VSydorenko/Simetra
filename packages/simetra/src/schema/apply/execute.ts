import { loadSqlParser } from "simetra/compiler"
import { PROVIDER_API_ROLES, quoteIdent } from "simetra/model"
import type { DbConnection, EngineDiagnostic, LockedTable } from "../engine"
import type { PlanArtifact } from "./artifact"
import { applyDiagnostic } from "./diagnostic"
import {
  compareFingerprints,
  FINGERPRINT_VERSION,
  readFingerprint,
  type CatalogFingerprint,
  type FingerprintSection,
} from "./fingerprint"
import {
  ApplyConnectionLost,
  ApplyDbError,
  type ApplyDatabase,
  type ApplyTransaction,
} from "./port"
import { findApply, readApplyState, writeApplyStateStatements } from "./state"
import { checkPermissions, lintSteps, type PlanStep } from "./steps"

/** Тайм-аути й повтори однієї спроби застосування (рішення 11 плану П3-1). */
export interface ApplyTimeouts {
  lockTimeoutMs: number
  statementTimeoutMs: number
  idleInTransactionMs: number
  /** Скільки спроб усієї транзакції, разом із першою. */
  attempts: number
  /** Пауза перед другою спробою, далі подвоєння до `max`, джитер ±20 %. */
  backoffMs: { first: number; max: number }
}

export const DEFAULT_APPLY_TIMEOUTS: ApplyTimeouts = {
  lockTimeoutMs: 3000,
  statementTimeoutMs: 600_000,
  idleInTransactionMs: 60_000,
  attempts: 5,
  backoffMs: { first: 500, max: 8000 },
}

/** Те з артефакту, що потрібно раннеру; `planHash` приходить окремо. */
export type ExecutablePlan = Pick<
  PlanArtifact,
  | "fromHash"
  | "toHash"
  | "scope"
  | "engine"
  | "steps"
  | "requiredPermissions"
  | "drift"
  | "targetFingerprint"
  | "desiredFingerprint"
  | "resultCatalog"
>

export interface ExecuteOptions {
  /**
   * `apply` — ціль, `COMMIT`; `rehearse` — ціль, усе те саме, але `ROLLBACK`;
   * `proof` — копія стану цілі: без перевірки ланцюжка (стану застосування в
   * копії немає) і з відбитком цілі без `owner` (бази різні).
   */
  mode: "apply" | "rehearse" | "proof"
  /** Хеш артефакту для marker і ledger; у режимі `proof` — `"proof"`. */
  planHash: string
  allow: readonly string[]
  /** `canonicalSnapshot` моделі `toHash`: іде в marker і ledger. */
  snapshot: unknown
  timeouts?: Partial<ApplyTimeouts>
  /** Пауза між спробами; тести підставляють свою. */
  sleep?: (ms: number) => Promise<void>
}

export type ExecuteOutcome =
  | {
      status: "committed" | "rolledBack"
      applyId: string
      attempts: number
      diagnostics: EngineDiagnostic[]
    }
  | {
      status: "refused" | "failed"
      attempts: number
      diagnostics: EngineDiagnostic[]
    }

/**
 * Ключ advisory lock застосування: `0x53494D45` («SIME») і `1`. Транзакційний
 * і без очікування: сесійного стану на цілі не лишається (рішення 14), а
 * зайнятий замок — відмова, не черга.
 */
const ADVISORY_LOCK = "1397312837, 1"

/** Конфлікт блокувань (`lock_timeout`, deadlock) — єдине, що повторюється. */
const RETRYABLE: ReadonlySet<string> = new Set(["55P03", "40P01"])

/**
 * `LOCK TABLE` на таблиці, що зникла (`42P01`) чи змінила вид (`42809`) після
 * плану: ціль уже не та, проти якої план побудовано.
 */
const VANISHED: ReadonlySet<string> = new Set(["42P01", "42809"])

/** Мітка «стану ще немає» — та сама, що в імені файлу першого плану. */
const INITIAL = "initial"

/**
 * Зупинка спроби з діагностиками. Порт відкочує лише на винятку, тож кожна
 * відмова чи збій після `BEGIN` летить із `fn` цим винятком, а раннер ловить
 * його поза транзакцією (рішення 1 плану П3-1).
 */
class AttemptStop extends Error {
  constructor(
    readonly status: "refused" | "failed",
    readonly diagnostics: EngineDiagnostic[]
  ) {
    super(diagnostics.map((d) => d.message).join("; "))
    this.name = "AttemptStop"
  }
}

const stop = (
  status: "refused" | "failed",
  code: Parameters<typeof applyDiagnostic>[0],
  params: Record<string, string | number> = {}
): AttemptStop =>
  new AttemptStop(status, [applyDiagnostic(code, "error", params)])

const retryable = (error: unknown): boolean =>
  error instanceof ApplyDbError &&
  error.sqlstate !== undefined &&
  RETRYABLE.has(error.sqlstate)

/**
 * Застосування плану однією транзакцією (платформна спека §6.2 п.4–5, §6.6;
 * рішення 11 плану П3-1). Лінт і дозволи — до будь-якої транзакції: раннер
 * не покладається на те, що інструмент уже перевірив. Повтор обгортає всю
 * спробу — одну транзакцію порту — і лише на конфлікті блокувань. Обрив
 * з'єднання не повторюється ніколи: результат `COMMIT` невідомий, і його
 * встановлює нова транзакція за `applyId` у ledger (рішення 14.3).
 */
export async function executePlan(
  db: ApplyDatabase,
  target: DbConnection,
  plan: ExecutablePlan,
  o: ExecuteOptions
): Promise<ExecuteOutcome> {
  const timeouts: ApplyTimeouts = { ...DEFAULT_APPLY_TIMEOUTS, ...o.timeouts }
  const sleep =
    o.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const refusals = [
    ...fingerprintVersions(plan),
    ...lintSteps(plan.steps, await loadSqlParser()),
    ...checkPermissions({ steps: plan.steps, drift: plan.drift }, o.allow),
  ]
  if (refusals.length > 0)
    return { status: "refused", attempts: 0, diagnostics: refusals }

  // Поза артефактом і його хешем: той самий план, застосований удруге, —
  // інше застосування з іншим рядком ledger
  const applyId = globalThis.crypto.randomUUID()
  const end = o.mode === "rehearse" ? "rollback" : "commit"
  for (let attempt = 1; ; attempt++) {
    try {
      await db.transaction(target, end, (tx) =>
        runAttempt(tx, plan, o, timeouts, applyId)
      )
      return {
        status: end === "commit" ? "committed" : "rolledBack",
        applyId,
        attempts: attempt,
        diagnostics: [],
      }
    } catch (error) {
      if (error instanceof AttemptStop)
        return {
          status: error.status,
          attempts: attempt,
          diagnostics: error.diagnostics,
        }
      if (error instanceof ApplyConnectionLost)
        return afterLostConnection(db, target, o.mode, applyId, attempt)
      // Будь-яка інша помилка (збій читання відбитка чи запису стану,
      // підключення) летить далі як є: транзакцію вже відкочено, а
      // класифікує її межа інструмента
      if (!retryable(error)) throw error
      if (attempt >= timeouts.attempts)
        return {
          status: "failed",
          attempts: attempt,
          diagnostics: [
            applyDiagnostic("apply.lock-timeout", "error", {
              attempts: attempt,
            }),
          ],
        }
      await sleep(backoff(attempt, timeouts.backoffMs))
    }
  }
}

/**
 * Одна спроба — оператори рішення 11 по черзі. Нормальне повернення
 * означає `COMMIT` (чи `ROLLBACK` репетиції); кожна відмова — виняток.
 */
async function runAttempt(
  tx: ApplyTransaction,
  plan: ExecutablePlan,
  o: ExecuteOptions,
  timeouts: ApplyTimeouts,
  applyId: string
): Promise<void> {
  // 1. Одне застосування на базу; зайнято — одразу відмова, без повторів
  const [lock] = await tx.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK}) AS locked`
  )
  if (lock?.locked !== true) throw stop("refused", "apply.busy")

  // 2. `SET LOCAL` параметрів не приймає; `set_config(…, true)` — те саме
  // в межах транзакції, тож за пулером тайм-аут не осяде на чужому backend
  await tx.query(
    "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)",
    [
      `${timeouts.lockTimeoutMs}ms`,
      `${timeouts.statementTimeoutMs}ms`,
      `${timeouts.idleInTransactionMs}ms`,
    ]
  )

  // 3. Роллю API схему не змінюють (спека П2 §8.6): `current_user`, бо
  // сесія входу може переключитися на роль API налаштуванням `role`
  const [who] = await tx.query<{ role: string }>("SELECT current_user AS role")
  if (who === undefined) throw new Error("current_user returned no row")
  const apiRoles: readonly string[] = Object.values(
    PROVIDER_API_ROLES[plan.scope.provider]
  )
  if (apiRoles.includes(who.role))
    throw stop("refused", "apply.api-role", { role: who.role })

  // 4. Ланцюжок: план застосовний лише до стану, від якого його побудовано.
  // Копія доказу стану застосування не має, тож там перевіряти нічого
  if (o.mode !== "proof") await checkChain(tx, plan.fromHash)

  // 5. Блокування наперед — одна точка очікування замість очікувань
  // посеред кроків
  const tables = tablesToLock(plan.steps)
  if (tables.length > 0)
    try {
      await tx.query(
        `LOCK TABLE ${tables
          .map((t) => `ONLY ${quoteIdent(t.schema)}.${quoteIdent(t.name)}`)
          .join(", ")} IN ACCESS EXCLUSIVE MODE`
      )
    } catch (error) {
      if (
        error instanceof ApplyDbError &&
        error.sqlstate !== undefined &&
        VANISHED.has(error.sqlstate)
      )
        throw stop("refused", "apply.target-changed", {
          sections: "relations",
        })
      throw error
    }

  // 6. Ціль та сама, що при плануванні. Під блокуваннями п.5 чужа DDL на
  // цих таблицях до кроків уже неможлива. Ціль ↔ ціль — з власником; копія
  // доказу — інша база з іншою роллю сесії
  const targetFingerprint = await readFingerprint(tx, plan.scope)
  const changed = differing(plan.targetFingerprint, targetFingerprint, {
    owner: o.mode !== "proof",
  })
  if (changed.length > 0)
    throw stop("refused", "apply.target-changed", {
      sections: changed.join(", "),
    })

  // 7. Кроки по черзі; конфлікт блокувань летить далі на повтор спроби
  for (const step of plan.steps)
    try {
      await tx.query(step.sql)
    } catch (error) {
      if (error instanceof ApplyDbError && !retryable(error))
        throw stop("failed", "apply.step-failed", {
          step: step.id,
          sqlstate: error.sqlstate ?? "unknown",
          error: error.message,
        })
      throw error
    }

  // 8. Результат — бажаний стан доказу; без `owner`, бо бажана тінь — інша база
  const resultFingerprint = await readFingerprint(tx, plan.scope)
  const diverged = differing(plan.desiredFingerprint, resultFingerprint, {
    owner: false,
  })
  if (diverged.length > 0)
    throw stop("failed", "apply.verify-failed", {
      sections: diverged.join(", "),
    })

  // 9. Стан у тій самій транзакції. Marker отримує повний відбиток
  // результату з власником: наступний гейт порівнює ціль ↔ ціль. Прийнятий
  // дрейф лишається в ledger, а marker стає новою базою (рішення 16)
  for (const statement of writeApplyStateStatements({
    planHash: o.planHash,
    fromHash: plan.fromHash,
    toHash: plan.toHash,
    snapshot: o.snapshot,
    scope: plan.scope,
    catalog: plan.resultCatalog,
    engine: plan.engine,
    targetFingerprint,
    resultFingerprint,
    allow: o.allow,
    drift: plan.drift,
    applyId,
  }))
    await tx.query(statement.sql, statement.params)
  // 10. `COMMIT` чи `ROLLBACK` виконує порт за `end`
}

async function checkChain(
  tx: ApplyTransaction,
  fromHash: string | null
): Promise<void> {
  const state = await readApplyState(tx)
  if (state.status === "corrupt")
    throw new AttemptStop("refused", [state.diagnostic])
  const found = state.status === "applied" ? state.marker.snapshotHash : null
  if (found !== fromHash)
    throw stop("refused", "apply.chain", {
      expected: fromHash ?? INITIAL,
      found: found ?? INITIAL,
    })
}

/**
 * Таблиці кроків класу `accessExclusive` у порядку плану, без дублів. Інші
 * класи блокування беруть своє блокування самі: брати за них `ACCESS
 * EXCLUSIVE` наперед — блокувати читання без потреби.
 */
function tablesToLock(steps: readonly PlanStep[]): LockedTable[] {
  const seen = new Set<string>()
  return steps
    .filter((s) => s.lockClass === "accessExclusive")
    .flatMap((s) => s.lockedTables)
    .filter((t) => {
      const key = JSON.stringify([t.schema, t.name])
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function differing(
  expected: CatalogFingerprint,
  actual: CatalogFingerprint,
  o: { owner: boolean }
): FingerprintSection[] {
  const comparison = compareFingerprints(expected, actual, o)
  // Версії звірено до транзакції; тут розбіжність версій — та сама відмова
  if (!comparison.comparable)
    throw stop("refused", "apply.plan-versions", {
      field: "fingerprintVersion",
      plan: expected.version,
      current: actual.version,
    })
  return comparison.differing
}

/**
 * Відбитки плану іншої версії не порівняти з поточними. Звіряємо до
 * транзакції: інакше розбіжність бажаного відбитка з'ясувалася б лише після
 * всіх кроків під `ACCESS EXCLUSIVE`.
 */
function fingerprintVersions(plan: ExecutablePlan): EngineDiagnostic[] {
  const versions = new Set(
    [plan.targetFingerprint, plan.desiredFingerprint]
      .map((f) => f.version)
      .filter((v) => v !== FINGERPRINT_VERSION)
  )
  return [...versions].map((version) =>
    applyDiagnostic("apply.plan-versions", "error", {
      field: "fingerprintVersion",
      plan: version,
      current: FINGERPRINT_VERSION,
    })
  )
}

/** Подвоєння від `first` до `max`, джитер ±20 %, без перевищення `max`. */
function backoff(attempt: number, o: { first: number; max: number }): number {
  const base = Math.min(o.first * 2 ** (attempt - 1), o.max)
  return Math.min(o.max, Math.round(base * (0.8 + Math.random() * 0.4)))
}

/**
 * Обрив з'єднання: наслідок не вгадується. Нова транзакція шукає в ledger
 * рядок цього `applyId`; репетиція закінчується `ROLLBACK`, тож її шукати
 * нічого. Невдале й це читання — `unknown`: краще чесне «невідомо», ніж
 * вигадана відповідь, а повтор на невідомому результаті міг би застосувати
 * план удруге.
 */
async function afterLostConnection(
  db: ApplyDatabase,
  target: DbConnection,
  mode: ExecuteOptions["mode"],
  applyId: string,
  attempts: number
): Promise<ExecuteOutcome> {
  const outcome =
    mode === "rehearse"
      ? "not-applied"
      : await db
          .transaction(target, "rollback", (tx) => findApply(tx, applyId))
          .catch(() => "unknown" as const)
  const diagnostics = [
    applyDiagnostic(
      "apply.connection-lost",
      outcome === "applied" ? "warning" : "error",
      { outcome, applyId }
    ),
  ]
  return outcome === "applied"
    ? { status: "committed", applyId, attempts, diagnostics }
    : { status: "failed", attempts, diagnostics }
}
