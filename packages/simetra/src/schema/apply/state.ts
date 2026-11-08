import {
  ROW_VERSION_SEQUENCE,
  executeGrants,
  platformFunctionSignatures,
  platformSchemaGrants,
  type CompiledModel,
  type PromotionRecord,
} from "simetra/compiler"
import {
  APPLIED_SNAPSHOT_HASH_FUNCTION_NAME,
  PLATFORM_SCHEMA,
  quoteIdent,
  type CatalogModel,
  type DatabaseProvider,
} from "simetra/model"
import type {
  EngineDiagnostic,
  EngineIdentity,
  EnginePlan,
  EngineScope,
  Extracted,
} from "../engine"
import { applyDiagnostic } from "./diagnostic"
import type { DriftReport } from "./drift"
import type { CatalogFingerprint, FingerprintSection } from "./fingerprint"
import type { ApplyTransaction } from "./port"
import { rowVersionSeedBlock, rowVersionTables } from "./row-version"
import { PLATFORM_VERSION } from "./version"

/**
 * Форма стану застосування (платформна спека §6.1). Читач приймає лише її:
 * невідома форма — гучна відмова, а не вгадування.
 */
export const APPLY_STATE_FORMAT = 1

const SCHEMA = quoteIdent(PLATFORM_SCHEMA)
const MARKER = `${SCHEMA}.${quoteIdent("marker")}`
const LEDGER = `${SCHEMA}.${quoteIdent("ledger")}`
const SNAPSHOT_HASH_FUNCTION = `${PLATFORM_SCHEMA}.${APPLIED_SNAPSHOT_HASH_FUNCTION_NAME}()`
const SNAPSHOT_HASH_SIGNATURE = `${SCHEMA}.${quoteIdent(APPLIED_SNAPSHOT_HASH_FUNCTION_NAME)}()`
const VERSION_EPOCH = `${SCHEMA}.${quoteIdent("version_epoch")}`
const EPOCH_FUNCTION = `${PLATFORM_SCHEMA}.row_version_epoch()`
const EPOCH_SIGNATURE = `${SCHEMA}.row_version_epoch()`
const RESET_FUNCTION = `${PLATFORM_SCHEMA}.reset_row_version_epoch()`
const RESET_SIGNATURE = `${SCHEMA}.reset_row_version_epoch()`
const SEQUENCE_NAME = `${PLATFORM_SCHEMA}.${ROW_VERSION_SEQUENCE.name}`
const SEQUENCE_ID = `sequence:${PLATFORM_SCHEMA}.${ROW_VERSION_SEQUENCE.name}`

/**
 * Функції платформи плану (`platformFunctions` артефакту): функції шару з
 * фіксованим тілом і три функції стану застосування. Їхні тіла теж
 * фіксовані, а `EXECUTE` мають не всі ролі, тож роль застосування, що не
 * власник стану, інакше отримувала б `apply.function-check-blind` на кожному
 * плані.
 */
export function planPlatformFunctions(
  model: Pick<CompiledModel, "sqlUnits">
): string[] {
  return [
    ...platformFunctionSignatures(model.sqlUnits),
    SNAPSHOT_HASH_FUNCTION,
    EPOCH_FUNCTION,
    RESET_FUNCTION,
  ].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * DDL стану застосування (платформна спека §6.1, спека користувачів §3):
 * схема `simetra`, marker і ledger. Їх рендерить T2 поза знімком, тож хеш
 * метаданих від них не залежить. Безпеку схеми дає та сама функція, що й
 * платформному шару, і лише коли шару в моделі немає — інакше одиниці
 * задублювалися б. Таблицям стану грантів немає: їх читає й пише лише роль,
 * що застосовує. Винятки — функції стану: `applied_snapshot_hash()` для ролі команд
 * (рішення Р-A3-16): рантайм звіряє хеш знімка з базою, не отримуючи права
 * читати marker, тож функція — `SECURITY DEFINER`, а її `EXECUTE` — лише
 * ролі команд і в обох випадках, бо функцію платформний шар не дає.
 * Читач епохи `row_version_epoch()` має `EXECUTE` ще й ролей користувача й
 * анонімної; `reset_row_version_epoch()` — без грантів.
 *
 * Епоха версій бази (спека П4-B §4.1): таблиця з одним рядком і дві функції.
 * Перелік таблиць `reset_row_version_epoch()` рендериться з моделі в кожному
 * застосуванні: нова таблиця механіки потрапляє в засів без ручної правки.
 */
export function renderApplyState(
  model: Pick<CompiledModel, "project" | "contracts" | "physical">
): string {
  const grants =
    model.contracts.users === undefined
      ? platformSchemaGrants(model.project.database.provider)
      : []
  return [
    `CREATE SCHEMA IF NOT EXISTS ${SCHEMA};`,
    ...grants,
    [
      `CREATE TABLE ${MARKER} (`,
      "  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),",
      "  format integer NOT NULL,",
      "  snapshot_hash text NOT NULL,",
      "  snapshot jsonb NOT NULL,",
      "  scope jsonb NOT NULL,",
      "  catalog jsonb NOT NULL,",
      "  engine_name text NOT NULL,",
      "  engine_version text NOT NULL,",
      "  fingerprint jsonb NOT NULL,",
      "  fingerprint_version integer NOT NULL,",
      "  platform_version text NOT NULL,",
      "  plan_hash text NOT NULL,",
      "  applied_at timestamptz NOT NULL DEFAULT now()",
      ");",
    ].join("\n"),
    [
      `CREATE TABLE ${LEDGER} (`,
      "  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,",
      "  format integer NOT NULL,",
      "  plan_hash text NOT NULL,",
      "  from_hash text,",
      "  to_hash text NOT NULL,",
      "  scope jsonb NOT NULL,",
      "  snapshot jsonb NOT NULL,",
      "  target_fingerprint jsonb NOT NULL,",
      "  result_fingerprint jsonb NOT NULL,",
      "  allowed jsonb NOT NULL,",
      "  drift jsonb,",
      // Запис застосованої промоції з хешем (платформна спека §6.1); з нього
      // `readAppliedPromotions` відрізняє застосований запис від чужого
      "  promotion jsonb,",
      // Хеш звіту репетиції, на який спиралося застосування промоції
      // (спека промоції §8); колонку старому ledger додає той самий
      // план, що пише стан
      "  rehearsal_hash text,",
      "  apply_id uuid NOT NULL UNIQUE,",
      "  engine_name text NOT NULL,",
      "  engine_version text NOT NULL,",
      "  fingerprint_version integer NOT NULL,",
      "  platform_version text NOT NULL,",
      "  applied_by text NOT NULL DEFAULT current_user,",
      "  applied_at timestamptz NOT NULL DEFAULT now()",
      ");",
    ].join("\n"),
    // Після marker: тіло SQL-функції Postgres перевіряє при створенні
    [
      `CREATE OR REPLACE FUNCTION ${SNAPSHOT_HASH_SIGNATURE}`,
      "RETURNS text",
      "LANGUAGE sql STABLE SECURITY DEFINER",
      "SET search_path = ''",
      `AS $$SELECT snapshot_hash FROM ${MARKER}$$;`,
      ...executeGrants(
        SNAPSHOT_HASH_SIGNATURE,
        ["command"],
        model.project.database.provider
      ),
    ].join("\n"),
    // Рядок епохи пише крок плану `versions`; до нього функція дає NULL
    [
      `CREATE TABLE ${VERSION_EPOCH} (`,
      "  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),",
      "  epoch uuid NOT NULL DEFAULT gen_random_uuid()",
      ");",
    ].join("\n"),
    epochFunction(model.project.database.provider),
    resetFunction(model),
  ].join("\n\n")
}

/** Ролі, що читають епоху: команди й ролі запиту провайдера (гостьова сесія теж). */
const EPOCH_READERS = ["command", "user", "anonymous"] as const

/**
 * Епоха версій бази: хеш від ідентичності кластера, лінії часу, бази,
 * послідовності, часу старту й UUID рядка `version_epoch` (рішення Р4). `NULL`
 * на репліці (`pg_current_wal_insert_lsn()` там недоступна, тож гілка за
 * `CASE`) і без рядка. Лінія часу — з імені WAL-файла, а не з контрольного
 * файла: швидкий failover змінює її одразу. OID послідовності береться через
 * `to_regclass`, а не літерал `::regclass`: SQL-тіло перевіряється при
 * створенні, а послідовність двигун може створити пізніше. `SECURITY DEFINER`:
 * роль входу читання грантів згенерованого SQL не має, а функція дає лише
 * хеш, який і так іде браузеру.
 */
function epochFunction(provider: DatabaseProvider): string {
  const identity = [
    "(SELECT system_identifier::text FROM pg_catalog.pg_control_system())",
    "substr(pg_catalog.pg_walfile_name(pg_catalog.pg_current_wal_insert_lsn()), 1, 8)",
    "(SELECT d.oid::text FROM pg_catalog.pg_database d WHERE d.datname = pg_catalog.current_database())",
    `pg_catalog.to_regclass('${SEQUENCE_NAME}')::oid::text`,
    "extract(epoch from pg_catalog.pg_postmaster_start_time())::text",
    "e.epoch::text",
  ].join(" || '/' || ")
  return [
    `CREATE OR REPLACE FUNCTION ${EPOCH_SIGNATURE}`,
    "RETURNS text",
    "LANGUAGE sql STABLE SECURITY DEFINER",
    "SET search_path = ''",
    "AS $$SELECT CASE WHEN pg_catalog.pg_is_in_recovery() THEN NULL ELSE",
    `  (SELECT encode(sha256(convert_to(${identity}, 'UTF8')), 'hex') FROM ${VERSION_EPOCH} e)`,
    "END$$;",
    ...executeGrants(EPOCH_SIGNATURE, EPOCH_READERS, provider),
  ].join("\n")
}

/**
 * Скидання після відновлення лише даних у ту саму базу (`pg_restore
 * --data-only`, `psql` з дампу): дамп повертає `setval` і UUID, а OID бази,
 * послідовності й час старту лишаються, тож епоха сама не змінилася б.
 * Функція сіє послідовність над усіма таблицями механіки й міняє UUID.
 *
 * Замки беруться завжди (режим `fresh` засіву): виклик рідкісний, при
 * зупиненому застосунку, тож швидка гілка без замка нічого не заощадила б, а
 * сліпа гарантія «послідовність не нижча за максимум» — дешевша за підбір
 * умови. Нижче вона не опуститься: `setval` лише вгору. Без `EXECUTE` будь-кому,
 * крім власника: `SECURITY INVOKER`, бо функція пише в таблиці, на які ролі
 * запиту прав не мають.
 *
 * Залишки, яких база не тримає: (1) вікно між відновленням лише даних і
 * викликом функції — версії, видані в ньому, можуть повторитися; процедура —
 * відновлення й виклик при зупиненому застосунку, до першого читання;
 * (2) одиниця боргу, що ставить `synchronous_commit = off` після `touch`,
 * знову робить коміт асинхронним — тоді краш губить видані версії без зміни
 * епохи; (3) одиниця боргу з нелітеральним іменем `set_config` могла б
 * писати `simetra.row_version_*` (лише попередження `sql.debt-session-write`).
 */
function resetFunction(
  model: Pick<CompiledModel, "project" | "physical">
): string {
  const block = rowVersionSeedBlock(rowVersionTables(model), "fresh", [
    `UPDATE ${VERSION_EPOCH} SET epoch = gen_random_uuid();`,
    "IF NOT FOUND THEN",
    `  INSERT INTO ${VERSION_EPOCH} DEFAULT VALUES;`,
    "END IF;",
  ])
  return [
    `CREATE OR REPLACE FUNCTION ${RESET_SIGNATURE}`,
    "RETURNS void",
    "LANGUAGE plpgsql SECURITY INVOKER",
    "SET search_path = ''",
    "AS $$",
    block,
    "$$;",
    ...executeGrants(RESET_SIGNATURE, [], model.project.database.provider),
  ].join("\n")
}

/** Рядок marker: поточний стан інстансу (платформна спека §6.1). */
export interface MarkerRecord {
  format: number
  snapshotHash: string
  /**
   * `canonicalSnapshot` застосованої моделі: ідентичність стану «до», з якої
   * виявляється перехід промоції. Читач тлумачить лише потрібні поля.
   */
  snapshot: unknown
  scope: EngineScope
  catalog: CatalogModel
  engine: EngineIdentity
  fingerprint: CatalogFingerprint
  platformVersion: string
  planHash: string
}

export type ApplyState =
  | { status: "fresh" }
  | {
      status: "applied"
      marker: MarkerRecord
      /** Чи є рядок `version_epoch`: без нього епоху пише крок `versions`. */
      rowVersionEpoch: boolean
    }
  | { status: "corrupt"; diagnostic: EngineDiagnostic }

/** Рядок marker як `to_jsonb`: назви колонок. */
interface MarkerRow {
  format: number
  snapshot_hash: string
  snapshot: unknown
  scope: EngineScope
  catalog: CatalogModel
  engine_name: string
  engine_version: string
  fingerprint: Record<FingerprintSection, string>
  fingerprint_version: number
  platform_version: string
  plan_hash: string
}

function corrupt(
  code: "apply.state-format" | "apply.ledger-without-marker",
  params: Record<string, string | number> = {}
): ApplyState {
  return {
    status: "corrupt",
    diagnostic: applyDiagnostic(code, "error", params),
  }
}

/**
 * Стан застосування цілі. Відсутня таблиця читається як порожня: перше
 * застосування створює схему разом із таблицями. Marker без таблиці ledger
 * дає `applied` свідомо: межа marker завжди містить `simetra`, тож гейт
 * дрейфу (платформна спека §6.2) побачить зниклу таблицю як дрейф, і план не
 * застосується без явного дозволу `drift`. Marker читається одним
 * `to_jsonb`, а форма перевіряється до решти полів — рядок невідомої форми
 * може мати інші колонки, і запит за назвами впав би раніше за відмову.
 * Текстом, а не `jsonb` драйвера: розбір не залежить від налаштувань типів
 * адаптера.
 */
export async function readApplyState(
  tx: ApplyTransaction
): Promise<ApplyState> {
  const [tables] = await tx.query<{
    marker: boolean
    ledger: boolean
    epoch: boolean
  }>(
    "SELECT to_regclass($1) IS NOT NULL AS marker, to_regclass($2) IS NOT NULL AS ledger, to_regclass($3) IS NOT NULL AS epoch",
    [MARKER, LEDGER, VERSION_EPOCH]
  )
  const markerRows = tables?.marker
    ? await tx.query<{ row: string }>(
        `SELECT to_jsonb(m)::text AS row FROM ${MARKER} m`
      )
    : []
  const [markerRow] = markerRows
  if (markerRow === undefined) {
    const [ledger] = tables?.ledger
      ? await tx.query<{ found: boolean }>(
          `SELECT EXISTS (SELECT FROM ${LEDGER}) AS found`
        )
      : []
    // Історія без поточного стану — пошкодження, а не перше застосування:
    // інакше план вважав би базу з історією новою
    return ledger?.found === true
      ? corrupt("apply.ledger-without-marker")
      : { status: "fresh" }
  }
  const row = JSON.parse(markerRow.row) as MarkerRow
  if (row.format !== APPLY_STATE_FORMAT)
    return corrupt("apply.state-format", { found: row.format })
  // Таблиці епохи може ще не бути (база до B1e): це «рядка немає», а не збій
  const [epoch] = tables?.epoch
    ? await tx.query<{ found: boolean }>(
        `SELECT EXISTS (SELECT FROM ${VERSION_EPOCH}) AS found`
      )
    : []
  return {
    status: "applied",
    rowVersionEpoch: epoch?.found === true,
    marker: {
      format: row.format,
      snapshotHash: row.snapshot_hash,
      snapshot: row.snapshot,
      scope: row.scope,
      catalog: row.catalog,
      engine: { name: row.engine_name, version: row.engine_version },
      fingerprint: {
        version: row.fingerprint_version,
        sections: row.fingerprint,
      },
      platformVersion: row.platform_version,
      planHash: row.plan_hash,
    },
  }
}

/** Одне застосування: новий marker і рядок ledger. */
export interface ApplyRecord {
  planHash: string
  fromHash: string | null
  toHash: string
  snapshot: unknown
  scope: EngineScope
  catalog: CatalogModel
  engine: EngineIdentity
  targetFingerprint: CatalogFingerprint
  resultFingerprint: CatalogFingerprint
  allow: readonly string[]
  /**
   * Дрейф, прийнятий дозволом `drift` (`artifact.drift`); `null` — дрейфу не
   * було. Marker після застосування фіксує новий стан, тож дрейф лишається
   * лише тут, в історії.
   */
  drift: DriftReport | null
  /**
   * Застосована промоція: запис і його хеш (`promotionRecordHash`); `null` —
   * план без промоції.
   */
  promotion: { hash: string; record: PromotionRecord } | null
  /**
   * `rehearsalHash` звіту, з яким застосовано промоцію; `null` — без звіту
   * (план без промоції пише SQL NULL).
   */
  rehearsalHash: string | null
  /** UUID виклику раннера; не входить в артефакт і хеш. */
  applyId: string
}

/**
 * Оператори запису стану тієї самої транзакції, що застосовує план: marker
 * замінюється (один рядок), ledger отримує рядок. Версія відбитка — одна
 * колонка на обидва відбитки ledger: їх знімає той самий код в одному
 * виклику, тож різні версії — помилка викликача, а не стан бази.
 */
export function writeApplyStateStatements(
  record: ApplyRecord
): { sql: string; params: unknown[] }[] {
  const { targetFingerprint: target, resultFingerprint: result } = record
  if (target.version !== result.version)
    throw new Error(
      `fingerprint versions differ: target ${target.version}, result ${result.version}`
    )
  const json = (value: unknown) => JSON.stringify(value)
  const markerColumns = [
    "format",
    "snapshot_hash",
    "snapshot",
    "scope",
    "catalog",
    "engine_name",
    "engine_version",
    "fingerprint",
    "fingerprint_version",
    "platform_version",
    "plan_hash",
  ]
  const marker = {
    // `applied_at` бере типове значення й при заміні: час — останнього
    // застосування, а не першого
    sql: [
      `INSERT INTO ${MARKER} (${markerColumns.join(", ")})`,
      "VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb, $9, $10, $11)",
      "ON CONFLICT (singleton) DO UPDATE SET",
      [...markerColumns, "applied_at"]
        .map((c) => `  ${c} = EXCLUDED.${c}`)
        .join(",\n"),
    ].join("\n"),
    params: [
      APPLY_STATE_FORMAT,
      record.toHash,
      json(record.snapshot),
      json(record.scope),
      json(record.catalog),
      record.engine.name,
      record.engine.version,
      json(result.sections),
      result.version,
      PLATFORM_VERSION,
      record.planHash,
    ],
  }
  const ledger = {
    sql: [
      `INSERT INTO ${LEDGER} (format, plan_hash, from_hash, to_hash, scope, snapshot, target_fingerprint, result_fingerprint, allowed, drift, promotion, rehearsal_hash, apply_id, engine_name, engine_version, fingerprint_version, platform_version)`,
      "VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12, $13::uuid, $14, $15, $16, $17)",
    ].join("\n"),
    params: [
      APPLY_STATE_FORMAT,
      record.planHash,
      record.fromHash,
      record.toHash,
      json(record.scope),
      json(record.snapshot),
      json(target.sections),
      json(result.sections),
      json(record.allow),
      // SQL NULL, а не JSON `null`: «дрейфу не було» — відсутність значення
      record.drift === null ? null : json(record.drift),
      // Так само SQL NULL: план без промоції
      record.promotion === null ? null : json(record.promotion),
      record.rehearsalHash,
      record.applyId,
      record.engine.name,
      record.engine.version,
      result.version,
      PLATFORM_VERSION,
    ],
  }
  return [marker, ledger]
}

/**
 * Чи записав ledger застосування з цим `applyId` (спека промоції §7.2):
 * відповідь на невідомий результат `COMMIT`. Шукаємо за `applyId`, а не за
 * `planHash`: артефакт детермінований, тож повторений перехід A→B має той
 * самий хеш, і рядок давнього застосування дав би хибне «застосовано».
 * Немає таблиці — не застосовано: перше застосування створює її в тій самій
 * транзакції. Рядок невідомої форми — `unknown`, а не вгадане «застосовано».
 */
export async function findApply(
  tx: ApplyTransaction,
  applyId: string
): Promise<"applied" | "not-applied" | "unknown"> {
  const [table] = await tx.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [LEDGER]
  )
  if (table?.exists !== true) return "not-applied"
  const [row] = await tx.query<{ format: number }>(
    `SELECT format FROM ${LEDGER} WHERE apply_id = $1::uuid`,
    [applyId]
  )
  if (row === undefined) return "not-applied"
  return row.format === APPLY_STATE_FORMAT ? "applied" : "unknown"
}

/**
 * Голова ledger — `apply_id` рядка з найбільшим `id` (спека
 * промоції §8): копія, що отримала ті самі плани окремими застосуваннями, має
 * той самий ланцюжок, але іншу голову. `null` — ledger немає чи він
 * порожній: перше застосування створює його в тій самій транзакції.
 */
export async function readLedgerHead(
  tx: ApplyTransaction
): Promise<string | null> {
  const [table] = await tx.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [LEDGER]
  )
  if (table?.exists !== true) return null
  const [row] = await tx.query<{ head: string }>(
    `SELECT apply_id::text AS head FROM ${LEDGER} ORDER BY id DESC LIMIT 1`
  )
  return row?.head ?? null
}

/**
 * Хеші застосованих записів промоції (`ledger.promotion->>'hash'`, спека
 * промоції §7.1): рядок 5 таблиці рішень відрізняє з них застосований запис від
 * чужого. Ledger без колонки `promotion` — форма до промоцій, у ній жодну
 * промоцію не застосовано: порожня множина, а не помилка. Колонку шукаємо в
 * каталозі, а не запитом до неї: інакше відсутня колонка зламала б транзакцію.
 */
export async function readAppliedPromotions(
  tx: ApplyTransaction
): Promise<Set<string>> {
  const [column] = await tx.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT FROM pg_catalog.pg_attribute WHERE attrelid = to_regclass($1) AND attname = 'promotion' AND NOT attisdropped) AS exists",
    [LEDGER]
  )
  if (column?.exists !== true) return new Set()
  const rows = await tx.query<{ hash: string }>(
    `SELECT promotion->>'hash' AS hash FROM ${LEDGER} WHERE promotion->>'hash' IS NOT NULL`
  )
  return new Set(rows.map((r) => r.hash))
}

const STATE_TABLES = ["marker", "ledger", "version_epoch"] as const

/** Стан застосування цілі для звірки та розпізнавач його об'єктів. */
export interface ApplyStateObjects {
  /**
   * `absent` — немає жодного об'єкта стану: таблиць, функцій хешу знімка й
   * епохи версій, послідовності версій, а без платформного шару й схеми
   * `simetra` (разом з її грантами). Будь-що часткове —
   * `present` (спека П2 §8.6).
   */
  state: "absent" | "present"
  /** Ідентичність двигуна чи одиниці, що належить лише стану застосування. */
  owns(identity: string): boolean
  /** Адреса відмінності моделей каталогу, що належить лише стану застосування. */
  ownsPath(path: string): boolean
}

/**
 * Об'єкти стану застосування в звірці «ціль → `desiredForApply`». Таблиці
 * видно в моделі цілі; голу схему `simetra` без грантів модель каталогу не
 * несе, тож її відсутність видно з плану: бажаний стан схему має завжди, і
 * план створює її рівно тоді, коли в цілі її немає. Схема й її гранти
 * належать стану лише без платформного шару; з ним це одиниці шару, яких
 * фільтр не чіпає ніколи.
 */
export function applyStateOf(
  target: Extracted,
  plan: EnginePlan,
  model: Pick<CompiledModel, "contracts">
): ApplyStateObjects {
  const schemaIsState = model.contracts.users === undefined
  const tables = STATE_TABLES.map((name) => `${PLATFORM_SCHEMA}.${name}`)
  const schemaId = `schema:${PLATFORM_SCHEMA}`
  const tablesAbsent = !target.model.tables.some(
    (t) =>
      t.schema === PLATFORM_SCHEMA &&
      (STATE_TABLES as readonly string[]).includes(t.name)
  )
  const functions = [
    SNAPSHOT_HASH_FUNCTION,
    EPOCH_FUNCTION,
    RESET_FUNCTION,
  ].map((f) => `function:${f}`)
  const functionAbsent = !target.model.units.some((u) =>
    functions.includes(u.identity)
  )
  // Послідовність версій — одиниця генератора механіки, але її життя
  // прив'язане до стану: без стану вона так само «ще не застосована»
  const sequenceAbsent = !target.model.units.some(
    (u) => u.identity === SEQUENCE_ID
  )
  const schemaAbsent = plan.actions.some((a) => a.produces.includes(schemaId))
  const sub = /^(?:column|constraint|trigger|rule|policy|default):(.*)$/
  // Одиниця гранту компілятора: `grant:<grant|revoke>:<клас>:<об'єкти>:…`;
  // лише схема `simetra` сама, без інших об'єктів у тому самому операторі
  const schemaGrant = new RegExp(
    `^grant:(?:grant|revoke):schema:${PLATFORM_SCHEMA}:`
  )
  // Гранти функцій стану — стану завжди: шар їх не дає. Гранти й відкликання
  // послідовності версій — так само
  const grantPrefixes = [
    ...[SNAPSHOT_HASH_FUNCTION, EPOCH_FUNCTION, RESET_FUNCTION].flatMap((f) => [
      `grant:grant:function:${f}:`,
      `grant:revoke:function:${f}:`,
    ]),
    `grant:revoke:sequence:${SEQUENCE_NAME}:`,
  ]
  const owns = (identity: string): boolean => {
    const wrapped = /^(?:comment|acl|securityLabel):\((.*)\)/.exec(identity)
    if (wrapped !== null) return owns(wrapped[1]!)
    if (tables.some((t) => identity === `table:${t}`)) return true
    if (
      functions.includes(identity) ||
      identity === SEQUENCE_ID ||
      grantPrefixes.some((p) => identity.startsWith(p))
    )
      return true
    const m = sub.exec(identity)
    if (m !== null && tables.some((t) => m[1]!.startsWith(`${t}.`))) return true
    return (
      schemaIsState && (identity === schemaId || schemaGrant.test(identity))
    )
  }
  return {
    state:
      tablesAbsent &&
      functionAbsent &&
      sequenceAbsent &&
      (!schemaIsState || schemaAbsent)
        ? "absent"
        : "present",
    owns,
    ownsPath: (path) =>
      tables.some(
        (t) => path === `tables.${t}` || path.startsWith(`tables.${t}.`)
      ) ||
      (path.startsWith("units.") && owns(path.slice("units.".length))),
  }
}
