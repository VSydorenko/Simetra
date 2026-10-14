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
  castProbeQuery,
  preservationQuery,
  preservedColumnName,
} from "./promotion/preservation"
import { isRetryable } from "./retry"
import { readInvalidObjects } from "./validity"
import { revalidationSettings, withLocalSettings } from "./settings"
import { findApply, readApplyState, writeApplyStateStatements } from "./state"
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
  | "locks"
  | "implicitLocks"
  | "providerLocks"
  | "foreignKeys"
  | "preamble"
  | "revalidationSearchPath"
  | "plpgsqlCheck"
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
}

/**
 * `apply` — ціль, `COMMIT`; `rehearse` — ціль, усе те саме, але `ROLLBACK`, і
 * з повним доказом двигуна до відкату (тому `rehearsal` обов'язковий: режим
 * без доказу мовчки послабив би репетицію); `proof` — копія стану цілі: без
 * перевірки ланцюжка (стану застосування в копії немає) і з відбитком цілі
 * без `owner` (бази різні).
 */
export type ExecuteOptions = ExecuteBase &
  (
    | { mode: "apply" | "proof" }
    | { mode: "rehearse"; rehearsal: RehearsalProof }
  )

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
 * Ключ advisory lock застосування: `0x53494D45` («SIME») і `1`.
 * Транзакційний, тож сесійного стану на цілі не лишається (рішення 14).
 * Спроба бере його без очікування: зайнятий замок — відмова, не черга. Пошук
 * після обриву з'єднання чекає на нього: так він не обганяє `COMMIT`.
 */
const ADVISORY_LOCK = "1397312837, 1"

/** Порядок блоків кроків за походженням (рішення 1 плану П3-2b-1). */
const ORIGIN_ORDER = ["intent", "engine", "environment"] as const

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
    // Межа 2a (рішення 12): промоцію з `COMMIT` застосовує лише повна
    // перевірка П3-2b. Копія доказу й репетиція з `ROLLBACK` нічого не
    // лишають, тож вони дозволені
    ...(o.mode === "apply" && plan.promotion !== null
      ? [applyDiagnostic("apply.promotion-checks-pending", "error")]
      : []),
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
  // Раннер виконує три блоки кроків кожен під своїми налаштуваннями: крок
  // наміру після кроку двигуна пішов би під преамбулою. Так кроки будують
  // `analyseOnClone` і збір середовища, тож інший порядок — зламаний конвеєр
  // (рішення 1 плану П3-2b-1)
  const ranks = plan.steps.map((s) => ORIGIN_ORDER.indexOf(s.origin))
  if (ranks.some((rank, i) => i > 0 && rank < ranks[i - 1]!))
    throw new Error(
      "plan steps are out of origin order: intent, engine, environment"
    )

  // Поза артефактом і його хешем: той самий план, застосований удруге, —
  // інше застосування з іншим рядком ledger
  const applyId = globalThis.crypto.randomUUID()
  const end = o.mode === "rehearse" ? "rollback" : "commit"
  for (let attempt = 1; ; attempt++) {
    try {
      const warnings = await db.transaction(target, end, (tx) =>
        runAttempt(tx, plan, o, timeouts, applyId, parse)
      )
      return {
        status: end === "commit" ? "committed" : "rolledBack",
        applyId,
        attempts: attempt,
        diagnostics: warnings,
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
      return columns
        .filter((c) => c.schema === t.schema && c.table === t.to)
        .every((c) => measured.has(quoteIdent(c.to)))
    })
  )
}

/**
 * Одна спроба — оператори рішення 11 плану П3-1 по черзі; номери фаз від 7 —
 * таблиця рішення 1 плану П3-2b-1 (пропущені номери — фази інших задач).
 * Нормальне повернення означає `COMMIT` (чи `ROLLBACK` репетиції) і несе
 * попередження спроби; кожна відмова — виняток.
 */
async function runAttempt(
  tx: ApplyTransaction,
  plan: ExecutablePlan,
  o: ExecuteOptions,
  timeouts: ApplyTimeouts,
  applyId: string,
  parse: SqlParser
): Promise<EngineDiagnostic[]> {
  // 1. Одне застосування на базу; зайнято — одразу відмова, без повторів
  const [lock] = await tx.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK}) AS locked`
  )
  if (lock?.locked !== true) throw stop("refused", "apply.busy")

  // 1a. План побудовано для своєї ролі: від неї залежать замки (право на
  // явний `LOCK`), власники й шлях запису. `current_user`, бо сесія входу
  // може переключитися на іншу роль налаштуванням `role`. Копія доказу —
  // інша база, можливо з іншою роллю адміністрування
  const [who] = await tx.query<{ role: string }>("SELECT current_user AS role")
  if (who === undefined) throw new Error("current_user returned no row")
  if (o.mode !== "proof" && who.role !== plan.role)
    throw stop("refused", "apply.role-mismatch", {
      plan: plan.role,
      current: who.role,
    })

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

  // 3. Роллю API схему не змінюють (спека П2 §8.6)
  const apiRoles: readonly string[] = Object.values(
    PROVIDER_API_ROLES[plan.scope.provider]
  )
  if (apiRoles.includes(who.role))
    throw stop("refused", "apply.api-role", { role: who.role })

  // 4. Ланцюжок: план застосовний лише до стану, від якого його побудовано.
  // Копія доказу стану застосування не має, тож там перевіряти нічого
  if (o.mode !== "proof") await checkChain(tx, plan.fromHash)

  // 4a. Перелік таблиць провайдера — той самий, з яким план побудовано (R27
  // плану П3-2a): відбиток каталогу налаштувань не бачить, а таблиця, що
  // з'явилася в переліку, займалася б посеред кроків. Те саме читання, що й у
  // плані, до блокувань; копія доказу — інша база, її перелік план не записував
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

  // 5. Блокування наперед за слідом кроків — одна точка очікування замість
  // очікувань посеред кроків. Від сильнішого режиму до слабшого, усередині —
  // порядок артефакту, детермінований (R26 плану П3-2a)
  // Копія доказу несе лише межу двигуна й базу провайдера: таблиці поза
  // межею (скажімо, та, що посилається на колонку зі зміною типу) там може
  // не бути, і `LOCK` на ній дав би хибну відмову доказу
  const locks =
    o.mode === "proof" ? await presentLocks(tx, plan.locks) : plan.locks
  for (const mode of [...TABLE_LOCK_MODES].reverse())
    await lockTables(tx, locks, mode)

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

  // 6a. Заміри збереження «до» — у старих іменах, до першого кроку, під
  // налаштуваннями транзакції (рішення 6 плану П3-2a)
  const preserved = plan.promotion?.preservation ?? []
  const before = await measureBefore(tx, preserved, parse)

  // 6b. Таблиці, що є до кроків: звірка сліду дивиться лише на них, бо
  // створена планом таблиця нікого не блокує. Застосування з COMMIT звірки
  // не робить — це перевірка моделі сліду на доказі й репетиції
  const existing = o.mode === "apply" ? undefined : await readExistingTables(tx)

  // 7. Базова лінія тіл функцій — у тій самій транзакції, під блокуваннями,
  // до першого кроку (рішення 3 плану П3-2b-1): помилка, що була до плану,
  // не стає відмовою після нього
  const revalidation = revalidationSettings(plan.revalidationSearchPath)
  const warnings: EngineDiagnostic[] = []
  const plpgsqlCheck = () => readPlpgsqlChecked(tx, plan, o, warnings)
  const baseline = await withLocalSettings(tx, revalidation, async () => ({
    validators: await readValidatorErrors(tx),
    plpgsql: await plpgsqlCheck(),
  }))

  // 9. Кроки наміру — під налаштуваннями транзакції
  const blocks = ORIGIN_ORDER.map((origin) =>
    plan.steps.filter((s) => s.origin === origin)
  )
  await runSteps(tx, blocks[0]!, parse)
  // 11. Кроки двигуна разом зі сторожами — під преамбулою, такою, як її
  // записав план, і з поверненням налаштувань транзакції після них. Пару
  // виконуємо лише разом із ревалідацією (R22 плану П3-2a):
  // `check_function_bodies = off` пропускає тіло, яке ловить фаза 15
  await withLocalSettings(tx, plan.preamble, () =>
    runSteps(tx, blocks[1]!, parse)
  )
  // 12. Кроки середовища (рішення 5 плану П3-2b-0) — під налаштуваннями
  // транзакції
  await runSteps(tx, blocks[2]!, parse)

  // 13. Відкладені обмеження спрацьовують тут, а не при `COMMIT`: `ROLLBACK`
  // репетиції їх не запускає, і порушення лишилося б непоміченим. Стоїть до
  // замірів «після», бо відкладений тригер користувача може змінити рядки
  try {
    await tx.query("SET CONSTRAINTS ALL IMMEDIATE")
  } catch (error) {
    if (!(error instanceof ApplyDbError) || isRetryable(error)) throw error
    throw stop("failed", "apply.deferred-constraint-failed", {
      sqlstate: error.sqlstate ?? "unknown",
      error: error.message,
    })
  }

  // 14. Заміри «після» — у нових іменах, після кроків. Та сама транзакція
  // й ті самі налаштування сесії, що й «до», тож текст значень порівнюваний
  // без закріплення GUC
  await provePreservation(tx, preserved, before, parse)

  // 15. Ревалідація тіл проти базової лінії. `plpgsql_check`, пропущений до
  // кроків, пропускається й після: порівнювати нема з чим. Сліпі функції
  // називає попередження застосування й репетиції, крім очікуваних
  // пресетом провайдера; копія доказу його не дає, бо вивід плану вже назвав
  // перелік цілі
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
              PROVIDER_EXPECTED_BLIND_FUNCTIONS[plan.scope.provider]
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
  if (o.mode === "rehearse") await proveWithEngine(tx, plan, o.rehearsal)

  // 19. Стан у тій самій транзакції. Marker отримує повний відбиток
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
    promotion:
      plan.promotion === null
        ? null
        : { hash: plan.promotion.recordHash, record: plan.promotion.record },
    applyId,
  }))
    await tx.query(statement.sql, statement.params)

  // 19a. Звірка сліду перед відкатом репетиції чи кінцем доказу: замок,
  // якого слід плану не передбачив, — прогалина моделі сліду
  const gaps =
    existing === undefined ? [] : await footprintGaps(tx, plan, existing)
  // 20. `COMMIT` чи `ROLLBACK` виконує порт за `end`
  return [...warnings, ...blindWarning(after.blind), ...gaps]
}

/**
 * Фаза 18. Збій самого витягу — не обрив і не конфлікт блокувань — така сама
 * відмова, що й розбіжність: довести стан не вдалося, а `COMMIT` без доказу
 * репетиція не схвалює. Обрив і повторюваний конфлікт летять як усюди в
 * раннері, бо їх обробляє повтор спроби чи пошук за `applyId`.
 */
async function proveWithEngine(
  tx: ApplyTransaction,
  plan: ExecutablePlan,
  proof: RehearsalProof
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
  throw stop("failed", "apply.rehearsal-proof-failed", {
    count,
    first: rest.actions[0]?.sql ?? errors[0]!.message,
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
    return await readPlpgsqlErrors(tx, plan.plpgsqlCheck)
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

/** Кроки блоку по черзі, кожен після своїх сторожів. */
async function runSteps(
  tx: ApplyTransaction,
  steps: readonly PlanStep[],
  parse: SqlParser
): Promise<void> {
  // Конфлікт блокувань летить далі на повтор спроби. Сторожі від
  // `search_path` не залежать: таблиця й типи в них повністю кваліфіковані
  for (const step of steps) {
    for (const guard of step.guards) await runGuard(tx, step.id, guard, parse)
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
): Promise<EngineDiagnostic[]> {
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
    .map((gap) =>
      applyDiagnostic("apply.lock-footprint-exceeded", "warning", {
        table: gap.table,
        mode: LOCK_MODE_SQL[gap.mode],
        planned:
          gap.planned === undefined ? "none" : LOCK_MODE_SQL[gap.planned],
      })
    )
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
  parse: SqlParser
): Promise<Measurement[]> {
  const out: Measurement[] = []
  for (const t of tables) {
    const casts = t.columns.filter((c) => c.typeChangeStep !== undefined)
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
      // зупиняється; вдала нічого не змінює
      for (const c of casts)
        try {
          await tx.query(castProbeQuery(t, c))
        } catch (probe) {
          if (!(probe instanceof ApplyDbError) || retryable(probe)) throw probe
          if (!castFailure(probe)) throw measureFailed(t, "before", probe)
          throw stop("failed", "apply.type-narrowing", {
            step: c.typeChangeStep!,
            table: tableName(t.after),
            column: preservedColumnName(c.after, parse),
            sqlstate: probe.sqlstate!,
          })
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
 * відкочує транзакцію.
 */
async function provePreservation(
  tx: ApplyTransaction,
  tables: readonly PreservedTable[],
  before: readonly Measurement[],
  parse: SqlParser
): Promise<void> {
  for (const [i, t] of tables.entries()) {
    const was = before[i]!
    const now = await measure(tx, t, "after")
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
