import {
  canonicalize,
  loadSqlParser,
  promotionRecordHash,
  type SqlParser,
} from "simetra/compiler"
import {
  diffCatalogModels,
  PROVIDER_API_ROLES,
  quoteIdent,
} from "simetra/model"
import {
  PROVIDER_EXPECTED_BLIND_FUNCTIONS,
  PROVIDER_LOCKS,
  type DbConnection,
  type EngineCatalog,
  type EngineDiagnostic,
  type EngineSetting,
  type Extracted,
  type SchemaEngine,
} from "../engine"
import {
  isAllowedSetting,
  type PlanArtifact,
  type PreservedTable,
} from "./artifact"
import { applyDiagnostic } from "./diagnostic"
import { differencePaths } from "./drift"
import { environmentMismatch, readGlobalDefaultPrivileges } from "./environment"
import {
  blindWarning,
  CheckNameTaken,
  FUNCTION_ERROR_LIMIT,
  FUNCTION_LIMIT,
  newFunctionErrors,
  plpgsqlCheckInstalled,
  PlpgsqlCheckUnavailable,
  readBlindFunctions,
  readPlpgsqlErrors,
  readValidatorErrors,
  type CheckResult,
  type FunctionError,
} from "./function-checks"
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
import {
  castExpression,
  dataComputeSql,
  dataCountSql,
  dataWriteSql,
  readUserTriggers,
  triggerSql,
  type DataTable,
} from "./promotion/data"
import {
  castProbeQuery,
  dataMeasure,
  preservationQuery,
  preservedColumnName,
} from "./promotion/preservation"
import {
  countOf,
  rehearsalHash,
  rehearsalRefusals,
  statementTimeoutFromReport,
  type RehearsalEvidence,
  type RehearsalPhase,
  type RehearsalReport,
  type RehearsalTimings,
} from "./rehearsal"
import { isRetryable } from "./retry"
import { readInvalidObjects } from "./validity"
import {
  CARRIER_STEP_SETTINGS,
  DATA_SETTINGS,
  revalidationSettings,
  withLocalSettings,
} from "./settings"
import {
  differingServerFacts,
  readServerFacts,
  serverVersionRefusal,
  type ServerFacts,
} from "./server"
import {
  findApply,
  readApplyState,
  readLedgerHead,
  writeApplyStateStatements,
} from "./state"
import {
  coversMode,
  joinModes,
  LOCK_MODE_SQL,
  readLiveForeignKeys,
  readProviderLocks,
  TABLE_LOCK_MODES,
  type TableLock,
  type TableLockMode,
} from "./locks"
import { checkPermissions, lintSteps, type PlanStep } from "./steps"
import { tableKey } from "./table-key"
import { guardTarget } from "./type-guard"

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
  | "role"
  | "server"
  | "ledgerHead"
  | "locks"
  | "implicitLocks"
  | "providerLocks"
  | "foreignKeys"
  | "preamble"
  | "revalidationSearchPath"
  | "plpgsqlCheck"
  | "platformFunctions"
  | "desiredInvalid"
  | "promotion"
  | "environment"
  | "resultCatalog"
>

/**
 * Доказ репетиції (рішення 7 плану П3-2b-1): двигун і бажаний каталог, з
 * яким він порівнює результат кроків тією самою транзакцією. Порт двигуна
 * лише `plan`: раннер у T2 не знає ні `pg`, ні `pg-delta`.
 */
export interface RehearsalProof {
  engine: Pick<SchemaEngine, "plan">
  desired: EngineCatalog
}

interface ExecuteBase {
  /** Хеш артефакту для marker і ledger; у режимі `proof` — `"proof"`. */
  planHash: string
  allow: readonly string[]
  /** `canonicalSnapshot` моделі `toHash`: іде в marker і ledger. */
  snapshot: unknown
  timeouts?: Partial<ApplyTimeouts>
  /** Пауза між спробами; тести підставляють свою. */
  sleep?: (ms: number) => Promise<void>
  /**
   * Годинник доказів репетиції в мс; типово глобальний `performance.now`
   * (без Node API). Тести підставляють свій.
   */
  clock?: () => number
}

/**
 * `apply` — ціль, `COMMIT`; промоцію — лише з чинним звітом репетиції
 * (`report`, рішення 5 плану П3-2b-3), план без промоції звіту не потребує;
 * `rehearse` — ціль чи її копія з даними, усе те саме, але `ROLLBACK`,
 * відбиток цілі без `owner` (копію могли відновити під іншими власниками) і
 * з повним доказом двигуна до відкату (тому `rehearsal` обов'язковий: режим
 * без доказу мовчки послабив би репетицію); `proof` — копія стану цілі: без
 * перевірки ланцюжка (стану застосування в копії немає) і з відбитком цілі
 * без `owner` (бази різні).
 */
export type ExecuteOptions = ExecuteBase &
  (
    | { mode: "apply"; report?: RehearsalReport }
    /**
     * Комітить без звіту репетиції, без перевірки ланцюжка й ролі: такий
     * `COMMIT` безпечний лише на scratch-клоні, який ніхто не читає.
     * Єдиний виклик — доказ плану в `plan.ts`; на справжню ціль цей режим
     * не спрямовують ніколи.
     */
    | { mode: "proof" }
    | { mode: "rehearse"; rehearsal: RehearsalProof }
  )

export type ExecuteOutcome =
  | {
      status: "committed"
      applyId: string
      attempts: number
      diagnostics: EngineDiagnostic[]
    }
  | {
      /** Відкат буває лише в репетиції, і вона несе докази для звіту. */
      status: "rolledBack"
      applyId: string
      attempts: number
      diagnostics: EngineDiagnostic[]
      evidence: RehearsalEvidence
    }
  | {
      status: "refused" | "failed"
      attempts: number
      diagnostics: EngineDiagnostic[]
    }

/**
 * Ключ advisory lock застосування: `0x53494D45` («SIME») і `1`.
 * Транзакційний, тож сесійного стану на цілі не лишається (рішення 14).
 * Спроба бере його без очікування: зайнятий замок — відмова, не черга. Пошук
 * після обриву з'єднання чекає на нього: так він не обганяє `COMMIT`.
 */
const ADVISORY_LOCK = "1397312837, 1"

/**
 * Порядок блоків кроків за походженням (рішення 1 плану П3-2b-1, Р2b2-4):
 * кроки копій носіїв — після двигуна, що створює колонки-копії, і до
 * середовища.
 */
const ORIGIN_ORDER = ["intent", "engine", "carriers", "environment"] as const

/**
 * `LOCK TABLE` на таблиці, що зникла (`42P01`) чи змінила вид (`42809`) після
 * плану: ціль уже не та, проти якої план побудовано.
 */
const VANISHED: ReadonlySet<string> = new Set(["42P01", "42809"])

/** Відмова прав на `LOCK TABLE`: роль не має права на явний замок. */
const LOCK_PRIVILEGE = "42501"

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

/**
 * Конфлікт блокувань (`lock_timeout`, deadlock) — єдине, на чому повторюється
 * спроба. Збій серіалізації (`40001`) перевірки тіл лише прокидають далі, а не
 * записують помилкою функції; під `READ COMMITTED` порту він не виникає, тож
 * раннер прокидає його сирим, як будь-яку іншу помилку бази.
 */
const retryable = (error: unknown): boolean =>
  isRetryable(error) &&
  !(error instanceof ApplyDbError && error.sqlstate === "40001")

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
  // Явний `undefined` у частковому об'єкті не має перекрити типове
  // значення: інакше вийшов би тайм-аут `undefinedms` чи нескінченні спроби
  const timeouts: ApplyTimeouts = {
    ...DEFAULT_APPLY_TIMEOUTS,
    ...Object.fromEntries(
      Object.entries(o.timeouts ?? {}).filter(([, v]) => v !== undefined)
    ),
  }
  const sleep =
    o.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const parse = await loadSqlParser()
  const refusals = [
    ...fingerprintVersions(plan),
    ...unknownPreamble(plan.preamble),
    ...lintSteps(plan.steps, parse),
    // Пункти промоції — із секції під `planHash`, а не з поля показу
    // `requiredPermissions` (рішення 15 плану П3-2a, R1)
    ...checkPermissions(
      { steps: plan.steps, drift: plan.drift, promotion: plan.promotion },
      o.allow
    ),
  ]
  if (refusals.length > 0)
    return { status: "refused", attempts: 0, diagnostics: refusals }
  // З хешу в ledger `readAppliedPromotions` виводить «запис застосовано»,
  // тож він мусить бути хешем саме записаного запису. Обидва поля під
  // `planHash`, і розбіжність — зламаний конвеєр плану, а не стан цілі:
  // виняток до BEGIN, а не відмова з кодом
  if (
    plan.promotion !== null &&
    (await promotionRecordHash(plan.promotion.record)) !==
      plan.promotion.recordHash
  )
    throw new Error(
      "the promotion section's recordHash is not the hash of its record"
    )
  // Порожній чи неповний перелік збереження тихо пропустив би доказ рядків і
  // значень (рішення 6): кожна таблиця запису — рівно один замір у її
  // старих і нових іменах з кожною змапленою колонкою. Розбіжність — так
  // само зламаний конвеєр плану
  if (plan.promotion !== null && !preservesEveryTable(plan.promotion))
    throw new Error(
      "the promotion section does not preserve exactly the tables of its record"
    )
  // Секція кроків даних — те, що раннер виконує, а дозвіл `repair:` і заміри
  // виведено з запису: розбіжність між ними пише не те, що доведено
  // (рішення 2, 14 плану П3-2b-2) — так само зламаний конвеєр
  if (plan.promotion !== null && !dataMatchesRecord(plan.promotion))
    throw new Error(
      "the promotion section's data steps do not match its record or their measures"
    )
  // Раннер виконує блоки кроків кожен під своїми налаштуваннями: крок
  // наміру після кроку двигуна пішов би під преамбулою. Так кроки будують
  // `analyseOnClone` і збір середовища, тож інший порядок — зламаний конвеєр
  // (рішення 1 плану П3-2b-1)
  const ranks = plan.steps.map((s) => ORIGIN_ORDER.indexOf(s.origin))
  if (ranks.some((rank, i) => i > 0 && rank < ranks[i - 1]!))
    throw new Error(
      `plan steps are out of origin order: ${ORIGIN_ORDER.join(", ")}`
    )
  // Застосування промоції з COMMIT — лише після репетиції на копії з даними
  // (спека промоції §8, рішення 5, 9 плану П3-2b-3). План промоцію без
  // `plpgsql_check` відхиляє, тож такий план — підмінений файл: фаза 7 інакше
  // мовчки дала б `skipped`, а спека вимагає перевірки тіл. Звіт — до
  // будь-якої транзакції: копія й ціль — різні бази, і звіт з іншого плану,
  // сервера чи історії застосувань нічого не каже про цю
  let report: { value: RehearsalReport; hash: string } | undefined
  if (o.mode === "apply" && plan.promotion !== null) {
    if (plan.plpgsqlCheck === "unavailable")
      throw new Error(
        "a promotion plan without plpgsql_check cannot be applied: the plan refuses such a promotion"
      )
    const stale = rehearsalRefusals(plan, o.planHash, o.report)
    if (stale.length > 0)
      return { status: "refused", attempts: 0, diagnostics: stale }
    report = { value: o.report!, hash: await rehearsalHash(o.report!) }
  }

  // Поза артефактом і його хешем: той самий план, застосований удруге, —
  // інше застосування з іншим рядком ledger
  const applyId = globalThis.crypto.randomUUID()
  const end = o.mode === "rehearse" ? "rollback" : "commit"
  for (let attempt = 1; ; attempt++) {
    try {
      const { warnings, evidence } = await db.transaction(target, end, (tx) =>
        runAttempt(tx, plan, o, timeouts, applyId, parse, report)
      )
      if (end === "commit")
        return {
          status: "committed",
          applyId,
          attempts: attempt,
          diagnostics: warnings,
        }
      // Докази — лише цієї, останньої спроби: попередні відкочено повтором
      if (evidence === undefined)
        throw new Error("a rehearsal attempt returned no evidence")
      return {
        status: "rolledBack",
        applyId,
        attempts: attempt,
        diagnostics: warnings,
        evidence,
      }
    } catch (error) {
      if (error instanceof AttemptStop)
        return {
          status: error.status,
          attempts: attempt,
          diagnostics: error.diagnostics,
        }
      if (error instanceof ApplyConnectionLost)
        return afterLostConnection(
          db,
          target,
          o.mode,
          timeouts,
          applyId,
          attempt
        )
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
 * Рівно один замір на кожну таблицю запису — у її старих і нових іменах, і
 * нічого більше; кожна змаплена колонка запису в ньому є. Замір без колонки
 * не довів би, що її значення лишились.
 */
function preservesEveryTable(
  section: NonNullable<ExecutablePlan["promotion"]>
): boolean {
  const { tables, columns } = section.record
  const { preservation } = section
  return (
    preservation.length === tables.length &&
    tables.every((t) => {
      const found = preservation.filter(
        (p) =>
          p.before.schema === t.schema &&
          p.before.table === t.from &&
          p.after.schema === t.schema &&
          p.after.table === t.to
      )
      if (found.length !== 1) return false
      const measured = new Set(found[0]!.columns.map((c) => c.after))
      // Кожен крок даних таблиці міряється за виразом (рішення 8 плану
      // П3-2b-2): без заміру записані значення ніхто не звірив би
      const filled = new Set(found[0]!.columns.map((c) => c.dataStep))
      return (
        columns
          .filter((c) => c.schema === t.schema && c.table === t.to)
          .every((c) => measured.has(quoteIdent(c.to))) &&
        section.record.dataSteps.every(
          (s, i) =>
            s.schema !== t.schema ||
            s.table !== t.from ||
            filled.has(dataStepId(i))
        )
      )
    })
  )
}

/** Id кроку даних — `d<N>` у порядку `record.dataSteps` (рішення 2). */
const dataStepId = (i: number): string => `d${i + 1}`

/**
 * Секція кроків даних проти запису (рішення 2, 14 плану П3-2b-2): рівно одна
 * колонка секції на кожен крок запису — та сама таблиця (старе й нове ім'я з
 * `record.tables`), колонка, вираз і вид; і замір кожної колонки з
 * `dataStep` — точно рендер з секції (`dataMeasure`): вираз, тип запису,
 * бажаний тип і нове ім'я.
 */
function dataMatchesRecord(
  section: NonNullable<ExecutablePlan["promotion"]>
): boolean {
  const { record, data, preservation } = section
  const columns = data.flatMap((t) => t.columns.map((c) => ({ t, c })))
  if (columns.length !== record.dataSteps.length) return false
  const stepsMatch = record.dataSteps.every((s, i) => {
    const found = columns.filter(({ c }) => c.step === dataStepId(i))
    if (found.length !== 1) return false
    const { t, c } = found[0]!
    const table = record.tables.find(
      (r) => r.schema === s.schema && r.from === s.table
    )
    return (
      table !== undefined &&
      t.before.schema === s.schema &&
      t.before.table === s.table &&
      t.before.key === s.key &&
      t.after.schema === table.schema &&
      t.after.table === table.to &&
      c.column === s.column &&
      c.expression === s.expression &&
      c.kind === s.kind
    )
  })
  if (!stepsMatch) return false
  // Кожна колонка заміру з `dataStep` — крок секції, і навпаки
  const measured = preservation.flatMap((p) =>
    p.columns.flatMap((m) => (m.dataStep === undefined ? [] : [{ p, m }]))
  )
  if (measured.length !== columns.length) return false
  return columns.every(({ t, c }) => {
    const found = measured.filter(({ m }) => m.dataStep === c.step)
    if (found.length !== 1) return false
    const { p, m } = found[0]!
    const newType = record.typeChanges.find(
      (x) =>
        x.schema === t.after.schema &&
        x.table === t.after.table &&
        x.column === c.column
    )?.to
    const expected = dataMeasure(c, newType)
    return (
      p.before.schema === t.before.schema &&
      p.before.table === t.before.table &&
      p.after.schema === t.after.schema &&
      p.after.table === t.after.table &&
      m.before === expected.before &&
      m.after === expected.after
    )
  })
}

/**
 * Транзакція репетиції з виміром (рішення 4 плану П3-2b-3): міряє кожен
 * `query`, хоч би звідки він ішов (раннер, відбиток, перевірки тіл, замки,
 * `withLocalSettings`, кроки даних), і приписує його поточній фазі. SQL і
 * порядок операторів не змінює: лише читає годинник до й після.
 *
 * Схема id записів `steps` (одне правило, кожен оператор — рівно один
 * запис; схема звіту `rehearsalReportSchema` тримає її закритою):
 * - оператор кроку плану — id кроку (`s<N>`); сторожі кроку — порядкові;
 * - оператор таблиці даних — `compute-table-<n>` (CTAS фази 8) і
 *   `write-table-<n>` (єдиний `UPDATE` фази 10), `n` — номер таблиці в
 *   секції `data` від 1. Кілька кроків даних таблиці — один `UPDATE`, тож
 *   один запис; `d<N>` id запису не буває. Слово `table` відрізняє їх від
 *   порядкових id тих самих фаз (`compute-<k>`);
 * - `constraints-data` — `SET CONSTRAINTS ALL IMMEDIATE` після запису даних
 *   (фаза `write`), `constraints-deferred` — той самий оператор фази 13
 *   (фаза `deferred`);
 * - решта — `<фаза>-<k>`, `k` — номер оператора без власного id у цій фазі
 *   цієї спроби від 1 (заміри, сторожі, перевірки тіл, відбиток, замки,
 *   налаштування, тригери тощо).
 * Власний id (`setPhase(phase, step)`) називає лише наступний оператор:
 * так один id не дістається двом операторам.
 *
 * Обгортка живе одну спробу: нумерація й докази — лише останньої спроби,
 * не злиття спроб, бо попередні відкочено повтором.
 *
 * Тривалості — сирі, як їх дав годинник; округлює й сумує фази лише
 * `rehearsalReport`. Тому кожен запис несе свою фазу.
 *
 * `extract` міряється лише в `extractMs` фази, а не записом `steps`: витяг є тільки
 * у фазі 18 репетиції (`proveWithEngine`) і на шляху відмови фази 17
 * (`divergedPaths`, де будь-який збій витягу — текст параметра й відкат).
 * Успішне застосування витягу не робить (тест «never extracts on a
 * successful apply»), тож тайм-аут оператора, виведений із найдовшого
 * оператора, його не обірве, а витяг у максимумі роздув би тайм-аут.
 */
export function timedTransaction(
  tx: ApplyTransaction,
  clock: () => number
): ApplyTransaction & {
  setPhase(phase: RehearsalPhase, step?: string): void
  durations(): RehearsalTimings
} {
  // Час витягу за фазою; ключі — ще й порядок входу у фази
  const phases = new Map<RehearsalPhase, number>()
  const ordinals = new Map<RehearsalPhase, number>()
  const steps: RehearsalTimings["steps"] = []
  let current: RehearsalPhase | undefined
  let named: string | undefined
  const inPhase = (): RehearsalPhase => {
    if (current === undefined)
      throw new Error("a rehearsal statement ran before any phase")
    return current
  }
  const timed = async <T>(
    run: () => Promise<T>,
    record: (ms: number) => void
  ): Promise<T> => {
    const start = clock()
    try {
      return await run()
    } finally {
      record(clock() - start)
    }
  }
  return {
    setPhase(phase, step) {
      current = phase
      named = step
      if (!phases.has(phase)) phases.set(phase, 0)
    },
    query(sql, params) {
      const phase = inPhase()
      let id = named
      named = undefined
      if (id === undefined) {
        const k = (ordinals.get(phase) ?? 0) + 1
        ordinals.set(phase, k)
        id = `${phase}-${k}`
      }
      const step = id
      return timed(
        () => tx.query(sql, params),
        (ms) => steps.push({ id: step, phase, ms })
      )
    },
    extract(scope) {
      const phase = inPhase()
      return timed(
        () => tx.extract(scope),
        (ms) => phases.set(phase, phases.get(phase)! + ms)
      )
    },
    durations: () => ({
      phases: [...phases].map(([phase, extractMs]) => ({ phase, extractMs })),
      steps: [...steps],
    }),
  }
}

/**
 * Позначка фази репетиції: `step` — id наступного оператора. Поза
 * репетицією нічого не робить.
 */
type Mark = (phase: RehearsalPhase, step?: string) => void

/**
 * Одна спроба — оператори рішення 11 плану П3-1 по черзі; номери фаз від 7 —
 * таблиця рішення 1 плану П3-2b-1 (пропущені номери — фази інших задач).
 * Нормальне повернення означає `COMMIT` (чи `ROLLBACK` репетиції) і несе
 * попередження спроби; кожна відмова — виняток.
 */
async function runAttempt(
  raw: ApplyTransaction,
  plan: ExecutablePlan,
  o: ExecuteOptions,
  timeouts: ApplyTimeouts,
  applyId: string,
  parse: SqlParser,
  report: { value: RehearsalReport; hash: string } | undefined
): Promise<{ warnings: EngineDiagnostic[]; evidence?: RehearsalEvidence }> {
  // Докази лише в репетиції: застосування й копія доказу йдуть повз обгортку
  const timed =
    o.mode === "rehearse"
      ? timedTransaction(raw, o.clock ?? (() => globalThis.performance.now()))
      : undefined
  const tx: ApplyTransaction = timed ?? raw
  const phase: Mark = (name, step) => timed?.setPhase(name, step)

  // 1. Одне застосування на базу; зайнято — одразу відмова, без повторів
  phase("advisory")
  const [lock] = await tx.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK}) AS locked`
  )
  if (lock?.locked !== true) throw stop("refused", "apply.busy")

  // Сервер, старіший за мінімум платформи, — відмова одразу після замка:
  // жодна наступна фаза не впаде сирою помилкою версійно залежного
  // читання. Копія доказу — інша база, її версію перевіряє двигун
  if (o.mode !== "proof") {
    phase("targetChecks")
    const unsupported = await serverVersionRefusal(tx)
    if (unsupported !== undefined)
      throw new AttemptStop("refused", [unsupported])
  }

  // 1a. План побудовано для своєї ролі: від неї залежать замки (право на
  // явний `LOCK`), власники й шлях запису. `current_user`, бо сесія входу
  // може переключитися на іншу роль налаштуванням `role`. Копія доказу —
  // інша база, можливо з іншою роллю адміністрування
  phase("role")
  const [who] = await tx.query<{ role: string }>("SELECT current_user AS role")
  if (who === undefined) throw new Error("current_user returned no row")
  if (o.mode !== "proof" && who.role !== plan.role)
    throw stop("refused", "apply.role-mismatch", {
      plan: plan.role,
      current: who.role,
    })

  // 2. `SET LOCAL` параметрів не приймає; `set_config(…, true)` — те саме
  // в межах транзакції, тож за пулером тайм-аут не осяде на чужому backend
  phase("timeouts")
  await tx.query(
    "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)",
    [
      `${timeouts.lockTimeoutMs}ms`,
      `${timeouts.statementTimeoutMs}ms`,
      `${timeouts.idleInTransactionMs}ms`,
    ]
  )

  // 3. Роллю API схему не змінюють (спека П2 §8.6)
  const apiRoles: readonly string[] = Object.values(
    PROVIDER_API_ROLES[plan.scope.provider]
  )
  if (apiRoles.includes(who.role))
    throw stop("refused", "apply.api-role", { role: who.role })

  // 4. Ланцюжок: план застосовний лише до стану, від якого його побудовано.
  // Копія доказу стану застосування не має, тож там перевіряти нічого
  phase("chain")
  if (o.mode !== "proof") await checkChain(tx, plan.fromHash)

  // 4a. Перелік таблиць провайдера — той самий, з яким план побудовано (R27
  // плану П3-2a): відбиток каталогу налаштувань не бачить, а таблиця, що
  // з'явилася в переліку, займалася б посеред кроків. Те саме читання, що й у
  // плані, до блокувань; копія доказу — інша база, її перелік план не записував
  phase("targetChecks")
  if (o.mode !== "proof") {
    const live = await readProviderLocks(
      tx,
      plan.role,
      PROVIDER_LOCKS[plan.scope.provider]
    )
    // Канонічна форма, а не JSON.stringify: план із файлу розібрано схемою
    // артефакту, і порядок його ключів не мусить збігатися з порядком читача
    if (canonicalize(live) !== canonicalize(plan.providerLocks))
      throw stop("refused", "apply.target-changed", {
        sections: "providerLocks",
      })
  }

  // 4b. Глобальні типові привілеї ролі — ті самі, з якими план доведено
  // (рішення 5 плану П3-2b-0): відбиток їх не бачить, а від них залежать
  // права кожного об'єкта, який створюють кроки, і кроки середовища правильні
  // лише для цього переліку. Копія доказу засіяна й звірена окремо
  if (o.mode !== "proof") {
    const live = await readGlobalDefaultPrivileges(tx, plan.role)
    if (environmentMismatch(plan.environment.defaultPrivileges, live))
      throw stop("refused", "apply.target-changed", {
        sections: "environment",
      })
  }

  // 4c. FK таблиць сліду — ті самі, з якими план рахував замки (рішення 9
  // плану П3-2b-1): відбиток бачить лише межу, а FK таблиці поза нею, що
  // з'явився після плану, займав би її посеред кроків, а не наперед. Те саме
  // читання, що й у плані, до блокувань і без повтору — як перелік
  // провайдера. Копія доказу несе лише межу: FK поза нею там немає
  if (o.mode !== "proof" && plan.foreignKeys.subjects.length > 0) {
    const live = await readLiveForeignKeys(tx, plan.foreignKeys.subjects)
    // Канонічно, як перелік провайдера (4a)
    if (canonicalize(live) !== canonicalize(plan.foreignKeys.live))
      throw stop("refused", "apply.target-changed", {
        sections: "foreignKeys",
      })
  }

  // 4d. Режим `plpgsql_check` (рішення 4 плану П3-2b-1): план, що застав
  // розширення встановленим, а його в базі вже немає, — ціль уже не та.
  // Розширення на місці, але без прав ролі, — не звірка, а збій перевірки
  // (`apply.plpgsql-check-unavailable` у фазі 7). Перехід «тимчасове →
  // встановлене» допустимий. Копія доказу розширення цілі може не мати — там
  // раннер бере його сам
  if (
    o.mode !== "proof" &&
    plan.plpgsqlCheck === "installed" &&
    !(await plpgsqlCheckInstalled(tx))
  )
    throw stop("refused", "apply.target-changed", {
      sections: "plpgsqlCheck",
    })

  // 4e. Доказ, що база — саме та ціль, від якої план (рішення 1 плану
  // П3-2b-3): факти сервера й голова ledger. Відбиток не бачить ні
  // упорядкування, ні історії застосувань, а копія на іншому сервері чи з
  // окремими застосуваннями тих самих планів пройшла б ланцюжок і відбиток.
  // До блокувань і без повтору, як 4a–4d; копія доказу — інша база. Версію
  // сервера вже звірено одразу після замка застосування. На репетиції
  // розбіжність означає не «ціль змінилася», а «це не копія цієї цілі»:
  // перепланування на цілі дасть ті самі факти й голову, тож відмова називає
  // причину `cause: "copy"` (і різні факти) й радить зробити копію наново
  let identity: { server: ServerFacts; ledgerHead: string | null } | undefined
  if (o.mode !== "proof") {
    const copy = o.mode === "rehearse"
    const server = await readServerFacts(tx)
    const facts = differingServerFacts(plan.server, server)
    if (facts.length > 0)
      throw stop("refused", "apply.target-changed", {
        sections: "server",
        ...(copy ? { cause: "copy", facts: facts.join(", ") } : {}),
      })
    const ledgerHead = await readLedgerHead(tx)
    if (ledgerHead !== plan.ledgerHead)
      throw stop("refused", "apply.target-changed", {
        sections: "ledger",
        ...(copy ? { cause: "copy" } : {}),
      })
    identity = { server, ledgerHead }
  }

  // 5. Блокування наперед за слідом кроків — одна точка очікування замість
  // очікувань посеред кроків. Від сильнішого режиму до слабшого, усередині —
  // порядок артефакту, детермінований (R26 плану П3-2a)
  // Копія доказу несе лише межу двигуна й базу провайдера: таблиці поза
  // межею (скажімо, та, що посилається на колонку зі зміною типу) там може
  // не бути, і `LOCK` на ній дав би хибну відмову доказу
  phase("lock")
  const locks =
    o.mode === "proof" ? await presentLocks(tx, plan.locks) : plan.locks
  for (const mode of [...TABLE_LOCK_MODES].reverse())
    await lockTables(tx, locks, mode)

  // 6. Ціль та сама, що при плануванні. Під блокуваннями п.5 чужа DDL на
  // цих таблицях до кроків уже неможлива. З власником порівнює лише
  // застосування (ціль ↔ ціль): копію репетиції могли відновити з бекапу під
  // іншими власниками (рішення 1 плану П3-2b-3), а копія доказу — інша база
  // з іншою роллю сесії. Чи різнилася секція власника на репетиції,
  // запам'ятовуємо структурно: відмова фази 6 чи 18 тоді називає причину,
  // а не сирий diff. ACL не нормалізуємо відносно власника — це послабило б
  // доказ ідентичності
  phase("fingerprint")
  const targetFingerprint = await readFingerprint(tx, plan.scope)
  const changed = differing(plan.targetFingerprint, targetFingerprint, {
    owner: o.mode === "apply",
  })
  const ownersDiffer =
    o.mode === "rehearse" &&
    differing(plan.targetFingerprint, targetFingerprint, {
      owner: true,
    }).includes("owner")
  // Причина «власники» — лише коли, крім власника, різниться самий ACL (він
  // пишеться відносно власника). Будь-яка інша секція — справжня зміна
  // схеми, і порада «відновіть з --no-owner» її б сховала
  if (changed.length > 0)
    throw stop("refused", "apply.target-changed", {
      sections: changed.join(", "),
      ...(ownersDiffer && changed.every((s) => s === "acl")
        ? { cause: "owners" }
        : {}),
    })

  // 6a. Заміри збереження «до» — у старих іменах, до першого кроку
  // (рішення 6 плану П3-2a), під закріпленими налаштуваннями даних: текст
  // значень залежить від налаштувань, тож репетиція й робота мусять мірити
  // однаково (спека промоції §7.2)
  const preserved = plan.promotion?.preservation ?? []
  const data = plan.promotion?.data ?? []
  const filled = new Map(
    data.flatMap((t) => t.columns.map((c) => [c.step, c] as const))
  )
  phase("measureBefore")
  const before = await underDataSettings(tx, preserved, () =>
    measureBefore(tx, preserved, filled, parse)
  )
  const warnings: EngineDiagnostic[] = []

  // 6c. Рядки цілі проти копії репетиції й тайм-аут оператора зі звіту
  // (рішення 6 плану П3-2b-3) — лише застосування промоції, під замками,
  // з лічильників 6a. До 6c діє типовий тайм-аут раннера
  if (report !== undefined)
    await checkCopyRows(tx, report.value, preserved, before, o, warnings)

  // 6b. Таблиці, що є до кроків: звірка сліду дивиться лише на них, бо
  // створена планом таблиця нікого не блокує. Застосування з COMMIT звірки
  // не робить — це перевірка моделі сліду на доказі й репетиції
  if (o.mode !== "apply") phase("existing")
  const existing = o.mode === "apply" ? undefined : await readExistingTables(tx)

  // 7. Базова лінія тіл функцій — у тій самій транзакції, під блокуваннями,
  // до першого кроку (рішення 3 плану П3-2b-1): помилка, що була до плану,
  // не стає відмовою після нього
  const revalidation = revalidationSettings(plan.revalidationSearchPath)
  const plpgsqlCheck = () => readPlpgsqlChecked(tx, plan, o, warnings)
  phase("baseline")
  const baseline = await withLocalSettings(tx, revalidation, async () => ({
    validators: await readValidatorErrors(tx),
    plpgsql: await plpgsqlCheck(),
  }))

  // 8. Обчислення кроків даних у старих іменах, до кроків наміру (рішення 1
  // плану П3-2b-2), лише в режимі реплікації `origin`
  // (`requireOriginReplication`)
  // Блок — за іменем походження, а не за позицією: новий блок у
  // `ORIGIN_ORDER` інакше мовчки зсунув би решту під чужу фазу
  const block = (origin: (typeof ORIGIN_ORDER)[number]) =>
    plan.steps.filter((s) => s.origin === origin)
  let computed = new Map<string, number>()
  phase("compute")
  if (data.length > 0) {
    await requireOriginReplication(tx)
    computed = await withLocalSettings(tx, DATA_SETTINGS, () =>
      computeData(tx, data, (id) => phase("compute", id))
    )
  }

  // 9. Кроки наміру — під налаштуваннями транзакції
  phase("intent")
  await runSteps(tx, block("intent"), parse, (id) => phase("intent", id))

  // 10. Запис кроків даних — після наміру (колонка-ціль уже є) і до кроків
  // двигуна (сторож звуження бачить записане, `SET NOT NULL` іде після).
  // Відкладене — один раз після запису всіх таблиць (рішення В17): раніше
  // воно перевірило б проміжний стан, де записано лише частину одиниці.
  // І до увімкнення тригерів: увімкнення — `ALTER TABLE`, а з відкладеними
  // подіями на таблиці він падає `55006`, як і наступна DDL тієї самої
  // таблиці. Відновити «як було» не можна: `ALL DEFERRED` відклав би й
  // обмеження `INITIALLY IMMEDIATE`, а фаза 13 однаково робить те саме для
  // решти плану. Відкладені тригери користувача спрацьовують уже під
  // налаштуваннями транзакції, як у фазі 13: закріплений `search_path`
  // зламав би тіло, що називає об'єкти без схеми. Результат запису
  // (обчислено й записано за таблицею) — для звіту репетиції П3-2b-3
  phase("write")
  let written: Awaited<ReturnType<typeof writeData>> = []
  if (data.length > 0) {
    written = await withLocalSettings(tx, DATA_SETTINGS, () =>
      writeData(tx, data, computed, (id) => phase("write", id))
    )
    phase("write", "constraints-data")
    await constraintsNow(tx, "data")
    await enableTriggers(tx, data)
  }
  // 11. Кроки двигуна разом зі сторожами — під преамбулою, такою, як її
  // записав план, і з поверненням налаштувань транзакції після них. Пару
  // виконуємо лише разом із ревалідацією (R22 плану П3-2a):
  // `check_function_bodies = off` пропускає тіло, яке ловить фаза 15
  phase("engine")
  await withLocalSettings(tx, plan.preamble, () =>
    runSteps(tx, block("engine"), parse, (id) => phase("engine", id))
  )
  // 11а. Кроки копій носіїв (Р2b2-4) — після двигуна: колонку-копію
  // створює він, а кроки даних промоції (фаза 10) йдуть ще до нього. Фаза —
  // лише для непорожнього блоку: план без копій лишає журнал фаз як був.
  // Позначка — до перевірки режиму, тож її час рахується фазі копій
  const carriers = block("carriers")
  if (carriers.length > 0) {
    phase("carriers")
    await runCarrierSteps(tx, carriers, parse, (id) => phase("carriers", id))
  }
  // 12. Кроки середовища (рішення 5 плану П3-2b-0) — під налаштуваннями
  // транзакції
  phase("environment")
  await runSteps(tx, block("environment"), parse, (id) =>
    phase("environment", id)
  )

  // 13. Відкладені обмеження спрацьовують тут, а не при `COMMIT`: `ROLLBACK`
  // репетиції їх не запускає, і порушення лишилося б непоміченим. Стоїть до
  // замірів «після», бо відкладений тригер користувача може змінити рядки
  phase("deferred", "constraints-deferred")
  await constraintsNow(tx, "steps")

  // 14. Заміри «після» — у нових іменах, після кроків, під тими самими
  // закріпленими налаштуваннями даних, що й «до»: текст значень порівнюваний
  phase("measureAfter")
  const proven = await underDataSettings(tx, preserved, () =>
    provePreservation(tx, preserved, before, parse)
  )

  // 15. Ревалідація тіл проти базової лінії. `plpgsql_check`, пропущений до
  // кроків, пропускається й після: порівнювати нема з чим. Сліпі функції
  // називає попередження застосування й репетиції, крім очікуваних
  // пресетом провайдера; копія доказу його не дає, бо вивід плану вже назвав
  // перелік цілі
  phase("revalidation")
  const after = await withLocalSettings(tx, revalidation, async () => ({
    validators: await readValidatorErrors(tx),
    plpgsql:
      baseline.plpgsql === "skipped"
        ? ("skipped" as const)
        : await plpgsqlCheck(),
    blind:
      o.mode === "proof"
        ? []
        : (
            await readBlindFunctions(
              tx,
              plan.plpgsqlCheck === "unavailable" ? "unavailable" : "available",
              PROVIDER_EXPECTED_BLIND_FUNCTIONS[plan.scope.provider],
              plan.platformFunctions
            )
          ).blind,
  }))
  checkFunctionErrors([
    [baseline.validators, after.validators],
    ...(baseline.plpgsql === "skipped" || after.plpgsql === "skipped"
      ? []
      : [[baseline.plpgsql, after.plpgsql] as const]),
  ])

  // 16. Недійсне (`NOT VALID`, невдалий `CONCURRENTLY`), чого немає в
  // бажаному стані, не лишається: відбиток таке не завжди відрізняє
  phase("validity")
  const desiredInvalid = new Set(plan.desiredInvalid)
  const invalid = (await readInvalidObjects(tx, plan.scope)).filter(
    (object) => !desiredInvalid.has(object)
  )
  if (invalid.length > 0)
    throw stop("failed", "apply.constraint-invalid", {
      objects: invalid.join("; "),
    })

  // 17. Результат — бажаний стан доказу; без `owner`, бо бажана тінь — інша
  // база. На цілі розбіжність називає ще й шляхи моделі, поки зміни кроків
  // живі; на копії доказу їх уже дає план «копія → тінь» у `prove()`
  phase("verify")
  const resultFingerprint = await readFingerprint(tx, plan.scope)
  const diverged = differing(plan.desiredFingerprint, resultFingerprint, {
    owner: false,
  })
  if (diverged.length > 0)
    throw stop("failed", "apply.verify-failed", {
      sections: diverged.join(", "),
      ...(o.mode === "proof" ? {} : { paths: await divergedPaths(tx, plan) }),
    })

  // 18. Повний доказ двигуна: після кроків ціль, витягнута тим самим
  // з'єднанням, не має плану до бажаного каталогу. Відбиток із фази 17
  // бачить не все, що бачить двигун, а репетиція — єдине місце, де цей
  // доказ дешево перевірити до `COMMIT`
  if (o.mode === "rehearse") {
    phase("proof")
    await proveWithEngine(tx, plan, o.rehearsal, ownersDiffer, parse)
  }

  // 19. Стан у тій самій транзакції. Marker отримує повний відбиток
  // результату з власником: наступний гейт порівнює ціль ↔ ціль. Прийнятий
  // дрейф лишається в ledger, а marker стає новою базою (рішення 16)
  phase("state")
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
    promotion:
      plan.promotion === null
        ? null
        : { hash: plan.promotion.recordHash, record: plan.promotion.record },
    // Хеш звіту — лише застосування промоції; решта пише SQL NULL
    rehearsalHash: report?.hash ?? null,
    applyId,
  }))
    await tx.query(statement.sql, statement.params)

  // 19a. Звірка сліду перед відкатом репетиції чи кінцем доказу: замок,
  // якого слід плану не передбачив, — прогалина моделі сліду
  if (existing !== undefined) phase("footprint")
  const gaps =
    existing === undefined ? [] : await footprintGaps(tx, plan, existing)
  // 20. `COMMIT` чи `ROLLBACK` виконує порт за `end`
  return {
    warnings: [
      ...warnings,
      ...blindWarning(after.blind),
      ...gaps.map((gap) =>
        applyDiagnostic("apply.lock-footprint-exceeded", "warning", gap)
      ),
    ],
    ...(timed === undefined || identity === undefined
      ? {}
      : {
          evidence: {
            ...identity,
            rows: preserved.map((t, i) => ({
              ...oldName(t),
              rows: countOf(before[i]!.rows),
            })),
            durations: timed.durations(),
            data: written,
            preservation: preserved.map((t, i) => ({
              ...oldName(t),
              rows: countOf(proven[i]!.rows),
            })),
            plpgsqlCheck:
              baseline.plpgsql === "skipped" || after.plpgsql === "skipped"
                ? "skipped"
                : {
                    mode: plan.plpgsqlCheck,
                    baseline: baseline.plpgsql.errors,
                    after: after.plpgsql.errors,
                  },
            // Звірені з живими перед вимкненням (фаза 10), у старих іменах
            triggers: data.flatMap((t) =>
              t.triggers.map((trigger) => ({
                schema: t.before.schema,
                table: t.before.table,
                name: trigger.name,
                enabled: trigger.enabled,
              }))
            ),
            lockFootprint: gaps,
          },
        }),
  }
}

/**
 * Фаза 6c. Таблиця з рядками на цілі й порожня на копії — відмова: репетиція
 * не довела нічого про її дані (кроки даних, сторожі, тривалості). Менше
 * рядків на копії — попередження: тривалості звіту недооцінюють ціль, і
 * формула тайм-ауту масштабує їх відношенням. Явний `statementTimeoutMs`
 * людини має перевагу: злиті `timeouts` уже несуть типове значення, тож
 * дивимося на заданий. `statement_timeout` немає ні в `DATA_SETTINGS`, ні в
 * преамбулі, ні в ревалідації, тож `withLocalSettings` його не перекриє.
 */
async function checkCopyRows(
  tx: ApplyTransaction,
  report: RehearsalReport,
  preserved: readonly PreservedTable[],
  before: readonly Measurement[],
  o: ExecuteOptions,
  warnings: EngineDiagnostic[]
): Promise<void> {
  const target = preserved.map((t, i) => ({
    ...oldName(t),
    rows: countOf(before[i]!.rows),
  }))
  for (const t of target) {
    // Склад звіту звірено до транзакції (`rehearsalRefusals`)
    const copy = report.rows.find(
      (r) => r.schema === t.schema && r.table === t.table
    )
    if (copy === undefined)
      throw new Error(`the rehearsal report has no rows of ${t.table}`)
    const table = `${t.schema}.${t.table}`
    if (t.rows > 0 && copy.rows === 0)
      throw stop("refused", "apply.rehearsal-copy-empty", { table })
    if (copy.rows < t.rows)
      warnings.push(
        applyDiagnostic("apply.rehearsal-fewer-rows", "warning", {
          table,
          copy: copy.rows,
          target: t.rows,
        })
      )
  }
  if (o.timeouts?.statementTimeoutMs !== undefined) return
  const timeout = statementTimeoutFromReport(report, target)
  // Притиснутий до межі Postgres тайм-аут фактично знято: людина має знати,
  // що жоден оператор цього застосування не обірветься за часом
  if (timeout.clamped)
    warnings.push(
      applyDiagnostic("apply.rehearsal-timeout-unbounded", "warning", {
        computed: timeout.computed,
        limit: timeout.ms,
      })
    )
  await tx.query(
    "SELECT pg_catalog.set_config('statement_timeout', $1, true)",
    [`${timeout.ms}ms`]
  )
}

/** Таблиця заміру в старих іменах — як її знає ціль і звіт репетиції. */
const oldName = (t: PreservedTable): { schema: string; table: string } => ({
  schema: t.before.schema,
  table: t.before.table,
})

/**
 * `SET CONSTRAINTS ALL IMMEDIATE` фаз 10 (`after: "data"`) і 13 (`"steps"`):
 * не-повторну помилку дає відкладене обмеження чи тригер-обмеження
 * користувача — своїм кодом, з місцем у транзакції.
 */
async function constraintsNow(
  tx: ApplyTransaction,
  after: "data" | "steps"
): Promise<void> {
  try {
    await tx.query("SET CONSTRAINTS ALL IMMEDIATE")
  } catch (error) {
    if (!(error instanceof ApplyDbError) || isRetryable(error)) throw error
    throw stop("failed", "apply.deferred-constraint-failed", {
      after,
      sqlstate: error.sqlstate ?? "unknown",
      error: error.message,
    })
  }
}

type DataColumn = DataTable["columns"][number]

/** Таблиця кроків даних у діагностиках — у нових іменах, як заміри «після». */
const dataTableName = (t: DataTable): string =>
  `${t.after.schema}.${t.after.table}`

/**
 * Фаза 8 (рішення 1, 7, 12 плану П3-2b-2) під `DATA_SETTINGS`, на таблицю:
 * ім'я тимчасової таблиці вільне, сторожі приведення, CTAS у старих іменах і
 * лічильник обчислених. Повертає temp → обчислено.
 */
async function computeData(
  tx: ApplyTransaction,
  tables: readonly DataTable[],
  statement: (id: string) => void
): Promise<Map<string, number>> {
  const computed = new Map<string, number>()
  for (const [n, t] of tables.entries()) {
    // За пулером на backend може лишитися сесійна тимчасова таблиця
    // попереднього клієнта з тим самим іменем: CTAS дав би сирий `42P07`, а
    // читання `pg_temp.<ім'я>` — чужі рядки (Review Focus 4)
    const name = `pg_temp.${quoteIdent(t.temp)}`
    const [slot] = await tx.query<{ taken: boolean }>(
      "SELECT pg_catalog.to_regclass($1) IS NOT NULL AS taken",
      [name]
    )
    if (slot === undefined) throw new Error("to_regclass returned no row")
    if (slot.taken) throw stop("refused", "apply.temp-name-taken", { name })
    for (const c of t.columns) await dataGuard(tx, t, c)
    statement(`compute-table-${n + 1}`)
    await dataQuery(tx, t, "compute", dataComputeSql(t))
    const [row] = await dataQuery<{ computed: string | number }>(
      tx,
      t,
      "compute",
      dataCountSql(t)
    )
    if (row === undefined) throw new Error("the computed count returned no row")
    computed.set(t.temp, countOf(row.computed))
  }
  return computed
}

/**
 * Сторож приведення кроку (рішення 12): значення виразу, яке приведення до
 * типу запису змінює, зупиняє спробу до обчислення. Помилка бази на сторожі,
 * що не повторювана, — своїм кодом із кроком, а не сирий збій.
 */
async function dataGuard(
  tx: ApplyTransaction,
  t: DataTable,
  c: DataColumn
): Promise<void> {
  let lost: number
  try {
    const [row] = await tx.query<{ lost: string | number }>(c.guard)
    if (row === undefined) throw new Error("the cast guard returned no row")
    lost = Number(row.lost)
  } catch (error) {
    if (!(error instanceof ApplyDbError) || retryable(error)) throw error
    throw stop("failed", "apply.data-step-failed", {
      phase: "cast-guard",
      step: c.step,
      table: dataTableName(t),
      column: c.column,
      sqlstate: error.sqlstate ?? "unknown",
    })
  }
  if (lost > 0)
    throw stop("failed", "apply.data-step-narrowing", {
      step: c.step,
      table: dataTableName(t),
      column: c.column,
      lost,
    })
}

/**
 * Оператор фази запису (рішення В17): збій `ALTER TABLE` на тригері — не
 * проблема даних, тож діагностика називає оператор, і порада йде за ним.
 */
type WriteStatement = "trigger-disable" | "update" | "trigger-enable"

/**
 * Оператор таблиці даних (CTAS, лічильник, тригери, `UPDATE`). Помилка бази,
 * що не повторювана, — `apply.data-step-failed` з таблицею й її кроками;
 * повторювана летить на повтор спроби, як скрізь у раннері. `at` — фаза 8
 * (`compute`) чи оператор фази 10 (`phase: "write"` з `statement`).
 */
async function dataQuery<R extends Record<string, unknown>>(
  tx: ApplyTransaction,
  t: DataTable,
  at: "compute" | WriteStatement,
  sql: string
): Promise<R[]> {
  try {
    return await tx.query<R>(sql)
  } catch (error) {
    if (!(error instanceof ApplyDbError) || retryable(error)) throw error
    throw stop("failed", "apply.data-step-failed", {
      ...(at === "compute"
        ? { phase: "compute" }
        : { phase: "write", statement: at }),
      table: dataTableName(t),
      steps: t.columns.map((c) => c.step).join(", "),
      sqlstate: error.sqlstate ?? "unknown",
      error: error.message,
    })
  }
}

/**
 * Фаза 10 під `DATA_SETTINGS`, на таблицю в нових іменах: звірка тригерів
 * користувача з планом (до вимкнення: після нього живий перелік уже `D`),
 * `DISABLE TRIGGER` поштучно, один `UPDATE`, записано = обчислено. Тригери
 * вмикає `enableTriggers` після `SET CONSTRAINTS` (рішення В17): `55006`
 * перевіряється на таблицю, тож вимкнення наступної таблиці чужі відкладені
 * події не зупиняють. Повертає лічильники таблиць у старих іменах.
 */
async function writeData(
  tx: ApplyTransaction,
  tables: readonly DataTable[],
  computed: ReadonlyMap<string, number>,
  statement: (id: string) => void
): Promise<
  { schema: string; table: string; computed: number; written: number }[]
> {
  const out: {
    schema: string
    table: string
    computed: number
    written: number
  }[] = []
  for (const [n, t] of tables.entries()) {
    // Канонічно, як перелік провайдера (4a): обидва боки впорядковано за
    // іменем, а план із файлу розібрано схемою артефакту
    const live = await readUserTriggers(tx, t.after)
    if (canonicalize(live) !== canonicalize(t.triggers))
      throw stop("refused", "apply.target-changed", { sections: "triggers" })
    for (const sql of triggerSql(t, false))
      await dataQuery(tx, t, "trigger-disable", sql)
    statement(`write-table-${n + 1}`)
    const [row] = await dataQuery<{ written: string | number }>(
      tx,
      t,
      "update",
      dataWriteSql(t)
    )
    if (row === undefined) throw new Error("the written count returned no row")
    const written = countOf(row.written)
    const was = computed.get(t.temp)
    if (was === undefined) throw new Error(`no computed count for ${t.temp}`)
    // Рядок без пари в обчисленні (чи пара без рядка) лишив би значення
    // незаписаним, а ціль — `NULL`
    if (written !== was)
      throw stop("failed", "apply.data-write-mismatch", {
        table: dataTableName(t),
        computed: was,
        written,
      })
    out.push({
      schema: t.before.schema,
      table: t.before.table,
      computed: was,
      written,
    })
  }
  return out
}

/**
 * Кінець фази 10: тригери користувача всіх таблиць одиниці — у режимі, який
 * звірено з планом (`ENABLE` чи `ENABLE ALWAYS`), після `SET CONSTRAINTS`.
 * Під налаштуваннями транзакції: імена в операторі кваліфіковані.
 */
async function enableTriggers(
  tx: ApplyTransaction,
  tables: readonly DataTable[]
): Promise<void> {
  for (const t of tables)
    for (const sql of triggerSql(t, true))
      await dataQuery(tx, t, "trigger-enable", sql)
}

/**
 * Фаза 18. Збій самого витягу — не обрив і не конфлікт блокувань — така сама
 * відмова, що й розбіжність: довести стан не вдалося, а `COMMIT` без доказу
 * репетиція не схвалює. Обрив і повторюваний конфлікт летять як усюди в
 * раннері, бо їх обробляє повтор спроби чи пошук за `applyId`.
 * `ownersDiffer` (фаза 6): витяг копії несе її власників, і двигун бачить
 * дії ACL, а не `OWNER TO` (вимір задачі 0 плану П3-2b-3), тож причину
 * відмови називає параметр `cause`, а перша дія лишається як є.
 */
async function proveWithEngine(
  tx: ApplyTransaction,
  plan: ExecutablePlan,
  proof: RehearsalProof,
  ownersDiffer: boolean,
  parse: SqlParser
): Promise<void> {
  let after: Extracted
  try {
    after = await tx.extract(plan.scope)
  } catch (error) {
    if (error instanceof ApplyConnectionLost || retryable(error)) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw stop("failed", "apply.rehearsal-proof-failed", {
      count: 1,
      first: `(the extract failed: ${message})`,
    })
  }
  const rest = proof.engine.plan(after.catalog, proof.desired, plan.scope)
  const errors = rest.diagnostics.filter((d) => d.severity === "error")
  const count = rest.actions.length + errors.length
  if (count === 0) return
  // Причина «власники» — лише коли кожна дія двигуна змінює права чи
  // власника, а помилок двигуна немає: дія над схемою чи даними означає
  // справжню розбіжність, і порада про `--no-owner` її б сховала
  const owners =
    ownersDiffer &&
    errors.length === 0 &&
    rest.actions.every((a) => changesOnlyAccess(a.sql, parse))
  throw stop("failed", "apply.rehearsal-proof-failed", {
    ...(owners ? { cause: "owners" } : {}),
    count,
    // `count > 0` і `actions` порожній, тож `errors[0]` існує
    first: rest.actions[0]?.sql ?? errors[0]!.message,
  })
}

/**
 * Чи дія двигуна лише змінює права чи власника: кожен оператор — `GRANT`/
 * `REVOKE` привілеїв, `ALTER … OWNER TO` чи `ALTER TABLE`, усі команди якого
 * — `OWNER TO`. Структурно, вузлами розбору: `EngineAction` виду дії не
 * несе, а текстовий префікс пропустив би `ALTER TABLE … OWNER TO …, ADD …`.
 * Нерозібраний текст — не доступ: причину тоді не називаємо.
 */
function changesOnlyAccess(sql: string, parse: SqlParser): boolean {
  const result = parse(sql)
  if (!result.ok || result.statements.length === 0) return false
  return result.statements.every(({ stmt }) => {
    if ("GrantStmt" in stmt || "AlterOwnerStmt" in stmt) return true
    if (!("AlterTableStmt" in stmt)) return false
    const cmds = stmt.AlterTableStmt.cmds ?? []
    return (
      cmds.length > 0 &&
      cmds.every(
        (c) =>
          "AlterTableCmd" in c && c.AlterTableCmd.subtype === "AT_ChangeOwner"
      )
    )
  })
}

/**
 * Шляхи розбіжності до відкату (рішення 6 плану П3-2b-1): витяг двигуна в
 * тій самій транзакції проти `resultCatalog` доказу, з точним порядком
 * колонок, як marker ↔ ціль, бо копія відтворює ціль. Збій витягу —
 * будь-який, зокрема обрив, — лише текст параметра: розбіжність уже
 * доведено відбитком, і відмова лишається `apply.verify-failed`, а
 * `COMMIT` після неї не настає.
 */
async function divergedPaths(
  tx: ApplyTransaction,
  plan: ExecutablePlan
): Promise<string> {
  let extracted: Extracted
  try {
    extracted = await tx.extract(plan.scope)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `(the diagnostic extract failed: ${message})`
  }
  const paths = differencePaths(
    diffCatalogModels(plan.resultCatalog, extracted.model, {
      columnOrder: true,
    })
  )
  return paths.length === 0
    ? "(the catalog model shows no difference)"
    : paths.join(", ")
}

/**
 * Помилки `plpgsql_check` цієї бази (рішення 4 плану П3-2b-1, крок 3).
 * Розширення не вдалося взяти, а план його чекає:
 * - на цілі — `apply.plpgsql-check-unavailable`: план обіцяв перевірку;
 * - на копії доказу — план без промоції попереджає й пропускає перевірку:
 *   копія може жити на `shadowBase` зі стандартним образом Postgres без
 *   розширення; промоція — відмова того самого коду, що називає копію
 *   (спека промоції вимагає перевірки).
 */
async function readPlpgsqlChecked(
  tx: ApplyTransaction,
  plan: ExecutablePlan,
  o: ExecuteOptions,
  warnings: EngineDiagnostic[]
): Promise<CheckResult | "skipped"> {
  try {
    return await readPlpgsqlErrors(
      tx,
      plan.plpgsqlCheck,
      plan.platformFunctions
    )
  } catch (error) {
    if (error instanceof CheckNameTaken)
      throw stop("refused", "apply.temp-name-taken", { name: error.taken })
    if (!(error instanceof PlpgsqlCheckUnavailable)) throw error
    const params = { sqlstate: error.sqlstate, error: error.message }
    if (o.mode !== "proof")
      throw stop("failed", "apply.plpgsql-check-unavailable", params)
    const copy = applyDiagnostic(
      "plan.plpgsql-check-unavailable",
      plan.promotion === null ? "warning" : "error",
      { on: "copy", ...params }
    )
    if (plan.promotion !== null) throw new AttemptStop("failed", [copy])
    warnings.push(copy)
    return "skipped"
  }
}

/**
 * Режим реплікації транзакції — лише `origin` (рішення 13 плану П3-2b-2,
 * Р2b2-4): у `replica` не спрацювали б ні внутрішні тригери FK (запис даних
 * обійшов би перевірку посилань), ні тригери носіїв (крок копій записав би
 * значення без перевиведення). План це вже бачив, але налаштування бази чи
 * ролі могло змінитися після нього, тож гарантія — тут.
 */
async function requireOriginReplication(tx: ApplyTransaction): Promise<void> {
  const [session] = await tx.query<{ role: string }>(
    "SELECT pg_catalog.current_setting('session_replication_role') AS role"
  )
  if (session === undefined) throw new Error("current_setting returned no row")
  if (session.role !== "origin")
    throw stop("refused", "apply.replication-role", { value: session.role })
}

/**
 * Кроки копій носіїв (Р2b2-4, Р2b2-9) — лише під `row_security = off`: під
 * `FORCE ROW LEVEL SECURITY` власник без `BYPASSRLS` інакше оновив би лише
 * рядки, які пропускають політики, і тихо лишив би решту без копій; з `off`
 * Postgres такий оператор відхиляє гучно. Не `DATA_SETTINGS`: крок нічого не
 * обчислює й не приводить, а тригери не вимикаються (тригер носіїв
 * перевиводить ту саму копію, `contentChangeCondition` придушує механіку й
 * підписки), тож закріплений `search_path` зламав би тіло дослівного чи
 * прийнятого тригера, що називає об'єкти без схеми. Експорт — для DB-тесту.
 */
export async function runCarrierSteps(
  tx: ApplyTransaction,
  steps: readonly PlanStep[],
  parse: SqlParser,
  onStep: (id: string) => void
): Promise<void> {
  await requireOriginReplication(tx)
  await withLocalSettings(tx, CARRIER_STEP_SETTINGS, () =>
    runSteps(tx, steps, parse, onStep)
  )
}

/** Кроки блоку по черзі, кожен після своїх сторожів. */
async function runSteps(
  tx: ApplyTransaction,
  steps: readonly PlanStep[],
  parse: SqlParser,
  statement: (id: string) => void
): Promise<void> {
  // Конфлікт блокувань летить далі на повтор спроби. Сторожі від
  // `search_path` не залежать: таблиця й типи в них повністю кваліфіковані
  for (const step of steps) {
    for (const guard of step.guards) await runGuard(tx, step.id, guard, parse)
    try {
      statement(step.id)
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
  }
}

/**
 * Ревалідація проти базової лінії (рішення 3, 4 плану П3-2b-1): пари «до» і
 * «після» кожної перевірки — валідаторів і `plpgsql_check`. Обрізаний
 * перелік з будь-якого боку порівняти не можна — відмова, що називає
 * обрізаний бік, а не тиша; інакше нові помилки мультимножиною однією
 * діагностикою — `apply.function-check-failed`.
 */
function checkFunctionErrors(
  pairs: readonly (readonly [CheckResult, CheckResult])[]
): void {
  const cut = (r: CheckResult) => r.errors.length < r.total
  for (const [baseline, after] of pairs) {
    const side = cut(baseline) ? baseline : cut(after) ? after : undefined
    if (side !== undefined)
      throw stop("failed", "apply.function-check-failed", {
        cut: side === baseline ? "baseline" : "after",
        count: side.total,
        limit: FUNCTION_ERROR_LIMIT,
      })
  }
  const found = pairs.flatMap(([baseline, after]) =>
    newFunctionErrors(baseline.errors, after.errors)
  )
  if (found.length > 0)
    throw stop("failed", "apply.function-check-failed", {
      count: found.length,
      functions: found.slice(0, FUNCTION_LIMIT).map(describeError).join("; "),
    })
}

const describeError = (e: FunctionError): string =>
  `${e.signature}${e.relation === null ? "" : ` on ${e.relation}`}: ${e.sqlstate} ${e.message}`

/** Замки плану на таблицях, що є в цій базі (`relkind` r/p). */
async function presentLocks(
  tx: ApplyTransaction,
  locks: readonly TableLock[]
): Promise<TableLock[]> {
  if (locks.length === 0) return []
  const rows = await tx.query<{ schema: string; name: string }>(
    `SELECT x.schema, x.name
     FROM pg_catalog.json_to_recordset($1::pg_catalog.json) AS x(schema text, name text)
     JOIN pg_catalog.pg_namespace n ON n.nspname = x.schema
     JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = x.name
       AND c.relkind IN ('r', 'p')`,
    [JSON.stringify(locks.map(({ schema, name }) => ({ schema, name })))]
  )
  const present = new Set(rows.map((r) => tableKey(r.schema, r.name)))
  return locks.filter((l) => present.has(tableKey(l.schema, l.name)))
}

/**
 * Наявна таблиця (`relkind` r/p) на початку кроків: oid і ім'я до них, oid
 * усіх предків за успадкуванням чи партиціюванням.
 */
interface ExistingTable {
  oid: string
  schema: string
  name: string
  ancestors: string[]
}

/**
 * Таблиці користувача, що є до кроків, з іменами до кроків — тими самими
 * вихідними іменами, якими план називає замки. Схеми каталогу Postgres —
 * поза звіркою: їх DDL займає службово, і слід плану про них не каже.
 * Предки — бо замок батька без `ONLY` і рекурсія кроку займають нащадка в
 * режимі батька, а слід називає лише батька.
 */
async function readExistingTables(
  tx: ApplyTransaction
): Promise<ExistingTable[]> {
  return tx.query<{
    oid: string
    schema: string
    name: string
    ancestors: string[]
  }>(
    `WITH RECURSIVE up AS (
       SELECT i.inhrelid AS child, i.inhparent AS ancestor
       FROM pg_catalog.pg_inherits i
       UNION
       SELECT up.child, i.inhparent
       FROM up JOIN pg_catalog.pg_inherits i ON i.inhrelid = up.ancestor
     )
     SELECT c.oid::text AS oid, n.nspname AS schema, c.relname AS name,
       ARRAY(SELECT up.ancestor::text FROM up WHERE up.child = c.oid) AS ancestors
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')`
  )
}

/** Режим `pg_locks` сильніший за `ROW EXCLUSIVE`; слабші звірка не бачить. */
const HELD_MODES: Readonly<Record<string, TableLockMode>> = {
  ShareUpdateExclusiveLock: "shareUpdateExclusive",
  ShareLock: "share",
  ShareRowExclusiveLock: "shareRowExclusive",
  ExclusiveLock: "exclusive",
  AccessExclusiveLock: "accessExclusive",
}

/**
 * Звірка сліду (спека промоції §7.2, «З'єднання й блокування»): замки
 * сесії (`pg_locks` власного backend) на таблицях, що були до кроків, проти сліду плану — явних і
 * неявних замків. Замок сильніший за `ROW EXCLUSIVE` на таблиці поза слідом
 * чи сильніший за запланований — попередження `apply.lock-footprint-exceeded`:
 * такий замок узявся посеред кроків, а не наперед.
 */
async function footprintGaps(
  tx: ApplyTransaction,
  plan: ExecutablePlan,
  existing: readonly ExistingTable[]
): Promise<RehearsalEvidence["lockFootprint"]> {
  const rows = await tx.query<{ oid: string; mode: string }>(
    `SELECT l.relation::text AS oid, l.mode
     FROM pg_catalog.pg_locks l
     WHERE l.pid = pg_catalog.pg_backend_pid() AND l.locktype = 'relation'
       AND l.granted AND l.relation::text = ANY($1::text[])`,
    [existing.map((t) => t.oid)]
  )
  const byOid = new Map(existing.map((t) => [t.oid, t]))
  const planned = new Map(
    [...plan.locks, ...plan.implicitLocks].map((l) => [
      tableKey(l.schema, l.name),
      l.mode,
    ])
  )
  // Таблиця може тримати кілька режимів: звіряється найсильніший разом
  const held = new Map<string, TableLockMode>()
  for (const row of rows) {
    const mode = HELD_MODES[row.mode]
    if (mode === undefined || !byOid.has(row.oid)) continue
    const seen = held.get(row.oid)
    held.set(row.oid, seen === undefined ? mode : joinModes(seen, mode))
  }
  const out: { table: string; mode: TableLockMode; planned?: TableLockMode }[] =
    []
  // Запланований режим таблиці — разом із режимами її предків: замок предка
  // без `ONLY` чи рекурсія кроку на ньому займає й нащадка
  const plannedFor = (table: ExistingTable): TableLockMode | undefined => {
    let out: TableLockMode | undefined
    for (const t of [
      table,
      ...table.ancestors.flatMap((a) => byOid.get(a) ?? []),
    ]) {
      const mode = planned.get(tableKey(t.schema, t.name))
      if (mode !== undefined)
        out = out === undefined ? mode : joinModes(out, mode)
    }
    return out
  }
  for (const [oid, mode] of held) {
    const table = byOid.get(oid)!
    const expected = plannedFor(table)
    if (expected !== undefined && coversMode(expected, mode)) continue
    out.push({
      table: `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`,
      mode,
      ...(expected === undefined ? {} : { planned: expected }),
    })
  }
  return out
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
    .map((gap) => ({
      table: gap.table,
      mode: LOCK_MODE_SQL[gap.mode],
      planned: gap.planned === undefined ? "none" : LOCK_MODE_SQL[gap.planned],
    }))
}

/**
 * Сторож звуження типу перед кроком (рішення 5 плану П3-2a): значення, які
 * приведення туди й назад не зберігає, чи збій самого приведення (SQLSTATE
 * класу `22`) зупиняють спробу до кроку, що обрізав би їх мовчки. Інша
 * помилка сторожа — своїм кодом, а не сирим збоєм кроку: крок ще не
 * виконувався.
 */
async function runGuard(
  tx: ApplyTransaction,
  step: string,
  guard: string,
  parse: SqlParser
): Promise<void> {
  const { table, column } = guardTarget(guard, parse)
  let lost: number
  try {
    const [row] = await tx.query<{ lost: string | number }>(guard)
    lost = Number(row?.lost ?? 0)
  } catch (error) {
    if (!(error instanceof ApplyDbError) || retryable(error)) throw error
    const sqlstate = error.sqlstate ?? "unknown"
    if (sqlstate.startsWith("22"))
      throw stop("failed", "apply.type-narrowing", {
        step,
        table,
        column,
        sqlstate,
      })
    throw stop("failed", "apply.type-guard-failed", {
      step,
      column,
      sqlstate,
      error: error.message,
    })
  }
  if (lost > 0)
    throw stop("failed", "apply.type-narrowing", { step, table, column, lost })
}

/**
 * Заміри під `DATA_SETTINGS`. План без промоції замірів не має, тож і
 * налаштувань не ставить.
 */
const underDataSettings = <T>(
  tx: ApplyTransaction,
  preserved: readonly PreservedTable[],
  run: () => Promise<T>
): Promise<T> =>
  withLocalSettings(tx, preserved.length === 0 ? [] : DATA_SETTINGS, run)

/** Один рядок заміру: `rows` і суми `c<i>` колонок у порядку секції. */
type Measurement = Record<string, unknown>

/**
 * Один замір. Помилка бази, що не конфлікт блокувань, — своїм кодом із
 * таблицею й боком, а не сирий збій: без заміру доказу збереження немає.
 * `probeCasts` — замір «до» таблиці з приведеннями: збій приведення (клас
 * `22`) летить як є до проб приведення `measureBefore`. Після кроків змін типу
 * вже немає, тож клас `22` там назвати звуженням нічим.
 */
async function measure(
  tx: ApplyTransaction,
  t: PreservedTable,
  side: "before" | "after",
  probeCasts = false
): Promise<Measurement> {
  let row: Measurement | undefined
  try {
    ;[row] = await tx.query(preservationQuery(t, side))
  } catch (error) {
    if (!(error instanceof ApplyDbError) || retryable(error)) throw error
    if (probeCasts && castFailure(error)) throw error
    throw measureFailed(t, side, error)
  }
  if (row === undefined)
    throw new Error("preservation measurement returned no row")
  return row
}

const measureFailed = (
  t: PreservedTable,
  side: "before" | "after",
  error: ApplyDbError
): AttemptStop =>
  stop("failed", "apply.preservation-measure-failed", {
    table: tableName(side === "before" ? t.before : t.after),
    side,
    sqlstate: error.sqlstate ?? "unknown",
    error: error.message,
  })

const tableName = (t: PreservedTable["after"]): string =>
  `${t.schema}.${t.table}`

/**
 * Заміри «до». Колонка зі зміною типу читається через приведення до нового
 * типу, і невдале приведення (SQLSTATE класу `22`) — те саме звуження, що
 * зловив би сторож кроку: його називає `apply.type-narrowing` з id кроку
 * зміни типу, а не сирий збій. Один прохід не каже, яка колонка впала, тож
 * таблицю з приведеннями міряємо в точці збереження й після збою пробуємо
 * приведення по одному, кожне окремо від ключа.
 */
async function measureBefore(
  tx: ApplyTransaction,
  tables: readonly PreservedTable[],
  filled: ReadonlyMap<string, DataColumn>,
  parse: SqlParser
): Promise<Measurement[]> {
  const out: Measurement[] = []
  for (const t of tables) {
    const casts = t.columns.filter(
      (c) => c.typeChangeStep !== undefined || c.dataStep !== undefined
    )
    if (casts.length === 0) {
      out.push(await measure(tx, t, "before"))
      continue
    }
    await tx.query("SAVEPOINT simetra_preservation")
    try {
      out.push(await measure(tx, t, "before", true))
    } catch (error) {
      if (!castFailure(error)) throw error
      await tx.query("ROLLBACK TO SAVEPOINT simetra_preservation")
      // Невдала проба перериває транзакцію, але після неї спроба однаково
      // зупиняється; вдала нічого не змінює. Ціль кроку даних пробується
      // двічі (рішення 8 плану П3-2b-2): спершу лише вираз у типі запису —
      // його збій називає крок даних; потім, зі зміною типу, повний замір —
      // звуження кроку двигуна
      const probe = async (
        c: PreservedTable["columns"][number],
        failed: (sqlstate: string) => AttemptStop
      ) => {
        try {
          await tx.query(castProbeQuery(t, c))
        } catch (error) {
          if (!(error instanceof ApplyDbError) || retryable(error)) throw error
          if (!castFailure(error)) throw measureFailed(t, "before", error)
          throw failed(error.sqlstate!)
        }
      }
      for (const c of casts) {
        const column = preservedColumnName(c.after, parse)
        const fill =
          c.dataStep === undefined ? undefined : filled.get(c.dataStep)
        if (fill !== undefined)
          await probe({ ...c, before: castExpression(fill) }, (sqlstate) =>
            stop("failed", "apply.data-step-failed", {
              phase: "measure-before",
              step: fill.step,
              table: tableName(t.after),
              column,
              sqlstate,
            })
          )
        if (c.typeChangeStep !== undefined)
          await probe(c, (sqlstate) =>
            stop("failed", "apply.type-narrowing", {
              step: c.typeChangeStep!,
              table: tableName(t.after),
              column,
              sqlstate,
            })
          )
      }
      // Жодне приведення окремо не впало: збій не звуження, але той самий
      // збій заміру
      throw measureFailed(t, "before", error)
    }
    await tx.query("RELEASE SAVEPOINT simetra_preservation")
  }
  return out
}

const castFailure = (error: unknown): error is ApplyDbError =>
  error instanceof ApplyDbError &&
  error.sqlstate !== undefined &&
  error.sqlstate.startsWith("22")

/**
 * Заміри «після» проти «до». Розбіжність — `apply.preservation-failed`:
 * спершу кількість рядків, далі перша колонка в порядку секції. Виняток
 * відкочує транзакцію. Повертає заміри «після» — доказ для звіту репетиції.
 */
async function provePreservation(
  tx: ApplyTransaction,
  tables: readonly PreservedTable[],
  before: readonly Measurement[],
  parse: SqlParser
): Promise<Measurement[]> {
  const out: Measurement[] = []
  for (const [i, t] of tables.entries()) {
    const was = before[i]!
    const now = await measure(tx, t, "after")
    out.push(now)
    const table = tableName(t.after)
    if (String(was.rows) !== String(now.rows))
      throw stop("failed", "apply.preservation-failed", {
        table,
        rows: `${String(was.rows)} → ${String(now.rows)}`,
      })
    // Сума порожньої таблиці — `NULL` з обох боків
    const changed = t.columns.findIndex(
      (_, c) => String(was[`c${c}`]) !== String(now[`c${c}`])
    )
    if (changed >= 0)
      throw stop("failed", "apply.preservation-failed", {
        table,
        column: preservedColumnName(t.columns[changed]!.after, parse),
      })
  }
  return out
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
 * Один `LOCK TABLE` на режим. Таблиця, що зникла чи змінила вид після плану,
 * — ціль уже не та: відмова, а не збій кроку. Відмова прав (`42501`) — теж
 * відмова, без повтору: право ролі план звірив під час побудови, тож воно
 * змінилося після плану, і повтор його не поверне.
 */
async function lockTables(
  tx: ApplyTransaction,
  locks: readonly TableLock[],
  mode: TableLockMode
): Promise<void> {
  const tables = locks
    .filter((l) => l.mode === mode)
    .map((t) => `${quoteIdent(t.schema)}.${quoteIdent(t.name)}`)
  if (tables.length === 0) return
  try {
    // Без `ONLY` (R27 плану П3-2a): нащадки й партиції займаються наперед у
    // тому самому режимі, як їх займе й рекурсія `ALTER TABLE` кроку
    await tx.query(
      `LOCK TABLE ${tables.join(", ")} IN ${LOCK_MODE_SQL[mode]} MODE`
    )
  } catch (error) {
    if (!(error instanceof ApplyDbError) || error.sqlstate === undefined)
      throw error
    if (VANISHED.has(error.sqlstate))
      throw stop("refused", "apply.target-changed", { sections: "relations" })
    if (error.sqlstate === LOCK_PRIVILEGE)
      throw stop("refused", "apply.lock-privilege", {
        mode: LOCK_MODE_SQL[mode],
        tables: tables.join(", "),
        error: error.message,
      })
    throw error
  }
}

/**
 * Лінт преамбули: план несе лише відоме (рішення 13, R22 плану П3-2a), бо
 * раннер виконує її як є.
 * Схема артефакту таку пару вже не пропускає, але раннер не покладається на
 * те, що план прийшов через неї.
 */
function unknownPreamble(
  preamble: readonly EngineSetting[]
): EngineDiagnostic[] {
  return preamble
    .filter((s) => !isAllowedSetting(s))
    .map((s) =>
      applyDiagnostic("engine.preamble-unknown", "error", {
        name: s.name,
        value: s.value,
      })
    )
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
 * Запас понад `idle_in_transaction_session_timeout` для очікування пошуку:
 * осиротілий backend, якому `COMMIT` так і не дійшов, живе рівно до цього
 * тайм-ауту, а сервер ще мусить його завершити й зняти блокування.
 */
const LOOKUP_MARGIN_MS = 30_000

/**
 * Обрив з'єднання: наслідок не вгадується (рішення 14.3). Нова транзакція
 * шукає в ledger рядок цього `applyId`; репетиція закінчується `ROLLBACK`,
 * тож її шукати нічого.
 *
 * Пошук не може обігнати `COMMIT`, що ще в дорозі: після обриву старий
 * backend може ще комітити, і знімок, узятий раніше, сказав би «не
 * застосовано», а коміт ліг би після. Тому спершу блокуюче
 * `pg_advisory_xact_lock` з тим самим ключем: транзакційні блокування
 * Postgres знімає лише тоді, коли коміт уже видно. Потім — окремим
 * оператором — пошук: за `READ COMMITTED` порту знімок береться вже після
 * блокування. Блокування може тримати й чуже паралельне застосування —
 * тоді пошук просто чекає, а результат той самий, бо шукаємо свій `applyId`.
 *
 * Межа очікування більша за `idleInTransactionMs`: осиротілий backend
 * без `COMMIT` тримає блокування, доки його не вб'є
 * `idle_in_transaction_session_timeout`, і коротша межа дала б `unknown`
 * там, де за хвилину правдою було б «не застосовано». Невдале й це
 * читання — `unknown`: краще чесне «невідомо», ніж вигадана відповідь, а
 * повтор на невідомому результаті міг би застосувати план удруге.
 */
async function afterLostConnection(
  db: ApplyDatabase,
  target: DbConnection,
  mode: ExecuteOptions["mode"],
  timeouts: ApplyTimeouts,
  applyId: string,
  attempts: number
): Promise<ExecuteOutcome> {
  const bound = `${timeouts.idleInTransactionMs + LOOKUP_MARGIN_MS}ms`
  const outcome =
    mode === "rehearse"
      ? "not-applied"
      : await db
          .transaction(target, "rollback", async (tx) => {
            // `statement_timeout` теж: очікування блокування — частина
            // оператора, і типовий тайм-аут ролі обірвав би його раніше
            await tx.query(
              "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true)",
              [bound]
            )
            await tx.query(`SELECT pg_advisory_xact_lock(${ADVISORY_LOCK})`)
            return findApply(tx, applyId)
          })
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
