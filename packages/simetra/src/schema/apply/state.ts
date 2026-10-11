import { platformSchemaGrants, type CompiledModel } from "simetra/compiler"
import { PLATFORM_SCHEMA, quoteIdent, type CatalogModel } from "simetra/model"
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
import { PLATFORM_VERSION } from "./version"

/**
 * Форма стану застосування (рішення 7 плану П3-1). Читач приймає лише її:
 * невідома форма — гучна відмова, а не вгадування.
 */
export const APPLY_STATE_FORMAT = 1

const SCHEMA = quoteIdent(PLATFORM_SCHEMA)
const MARKER = `${SCHEMA}.${quoteIdent("marker")}`
const LEDGER = `${SCHEMA}.${quoteIdent("ledger")}`

/**
 * DDL стану застосування (платформна спека §6.1, спека користувачів §3):
 * схема `simetra`, marker і ledger. Їх рендерить T2 поза знімком, тож хеш
 * метаданих від них не залежить. Безпеку схеми дає та сама функція, що й
 * платформному шару, і лише коли шару в моделі немає — інакше одиниці
 * задублювалися б. Таблицям стану грантів немає: їх читає й пише лише роль,
 * що застосовує.
 */
export function renderApplyState(
  model: Pick<CompiledModel, "project" | "contracts">
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
      "  apply_id uuid NOT NULL UNIQUE,",
      "  engine_name text NOT NULL,",
      "  engine_version text NOT NULL,",
      "  fingerprint_version integer NOT NULL,",
      "  platform_version text NOT NULL,",
      "  applied_by text NOT NULL DEFAULT current_user,",
      "  applied_at timestamptz NOT NULL DEFAULT now()",
      ");",
    ].join("\n"),
  ].join("\n\n")
}

/** Рядок marker: поточний стан інстансу (платформна спека §6.1). */
export interface MarkerRecord {
  format: number
  snapshotHash: string
  scope: EngineScope
  catalog: CatalogModel
  engine: EngineIdentity
  fingerprint: CatalogFingerprint
  platformVersion: string
  planHash: string
}

export type ApplyState =
  | { status: "fresh" }
  | { status: "applied"; marker: MarkerRecord }
  | { status: "corrupt"; diagnostic: EngineDiagnostic }

/** Рядок marker як `to_jsonb`: назви колонок. */
interface MarkerRow {
  format: number
  snapshot_hash: string
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
 * дрейфу (рішення 2 плану П3-1) побачить зниклу таблицю як дрейф, і план не
 * застосується без явного дозволу `drift`. Marker читається одним
 * `to_jsonb`, а форма перевіряється до решти полів — рядок невідомої форми
 * може мати інші колонки, і запит за назвами впав би раніше за відмову.
 * Текстом, а не `jsonb` драйвера: розбір не залежить від налаштувань типів
 * адаптера.
 */
export async function readApplyState(
  tx: ApplyTransaction
): Promise<ApplyState> {
  const [tables] = await tx.query<{ marker: boolean; ledger: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS marker, to_regclass($2) IS NOT NULL AS ledger",
    [MARKER, LEDGER]
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
  return {
    status: "applied",
    marker: {
      format: row.format,
      snapshotHash: row.snapshot_hash,
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
  /** UUID виклику раннера; не входить в артефакт і хеш (рішення 14.3). */
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
      `INSERT INTO ${LEDGER} (format, plan_hash, from_hash, to_hash, scope, snapshot, target_fingerprint, result_fingerprint, allowed, drift, apply_id, engine_name, engine_version, fingerprint_version, platform_version)`,
      "VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::uuid, $12, $13, $14, $15)",
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
      record.applyId,
      record.engine.name,
      record.engine.version,
      result.version,
      PLATFORM_VERSION,
    ],
  }
  return [marker, ledger]
}

const STATE_TABLES = ["marker", "ledger"] as const

/** Стан застосування цілі для звірки та розпізнавач його об'єктів. */
export interface ApplyStateObjects {
  /**
   * `absent` — немає жодного об'єкта стану: обох таблиць, а без платформного
   * шару й схеми `simetra` (разом з її грантами). Будь-що часткове —
   * `present` (рішення 8 плану П3-1).
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
  const schemaAbsent = plan.actions.some((a) => a.produces.includes(schemaId))
  const sub = /^(?:column|constraint|trigger|rule|policy|default):(.*)$/
  // Одиниця гранту компілятора: `grant:<grant|revoke>:<клас>:<об'єкти>:…`;
  // лише схема `simetra` сама, без інших об'єктів у тому самому операторі
  const schemaGrant = new RegExp(
    `^grant:(?:grant|revoke):schema:${PLATFORM_SCHEMA}:`
  )
  const owns = (identity: string): boolean => {
    const wrapped = /^(?:comment|acl|securityLabel):\((.*)\)/.exec(identity)
    if (wrapped !== null) return owns(wrapped[1]!)
    if (tables.some((t) => identity === `table:${t}`)) return true
    const m = sub.exec(identity)
    if (m !== null && tables.some((t) => m[1]!.startsWith(`${t}.`))) return true
    return (
      schemaIsState && (identity === schemaId || schemaGrant.test(identity))
    )
  }
  return {
    state:
      tablesAbsent && (!schemaIsState || schemaAbsent) ? "absent" : "present",
    owns,
    ownsPath: (path) =>
      tables.some(
        (t) => path === `tables.${t}` || path.startsWith(`tables.${t}.`)
      ) ||
      (path.startsWith("units.") && owns(path.slice("units.".length))),
  }
}
