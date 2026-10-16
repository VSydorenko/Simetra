import { z } from "zod"
import {
  canonicalize,
  conversionClass,
  DATA_STEP_KINDS,
  promotionRecordSchema,
  serializeCanonical,
  sha256Hex,
  type ConversionClass,
  type PromotionRecord,
} from "simetra/compiler"
import { DATABASE_PROVIDERS, type CatalogModel } from "simetra/model"
import {
  ENGINE_ACTION_VERBS,
  ENGINE_PREAMBLE_ALLOWED,
  ENGINE_TRANSACTIONALITIES,
  PROVIDER_LOCK_STATEMENTS,
  type EngineDiagnostic,
  type EngineIdentity,
  type EngineScope,
  type EngineSetting,
} from "../engine"
import { applyDiagnostic } from "./diagnostic"
import {
  DEFAULT_PRIVILEGE_OBJTYPES,
  type GlobalDefaultPrivilege,
} from "./environment"
import { DRIFT_REASONS, type DriftReport } from "./drift"
import { FINGERPRINT_SECTIONS, type CatalogFingerprint } from "./fingerprint"
import { PLPGSQL_CHECK_MODES, type PlpgsqlCheckMode } from "./function-checks"
import {
  TABLE_LOCK_MODES,
  type ImplicitLock,
  type LiveForeignKey,
  type ProviderLockSet,
  type TableLock,
} from "./locks"
import { DATA_TRIGGER_MODES, type DataTable } from "./promotion/data"
import type { ServerFacts } from "./server"
import { STEP_CLASSES, type PermissionItem, type PlanStep } from "./steps"

/**
 * Форма файлу плану; читач порівнює її з поточною, а не вгадує. Третій
 * формат: кроки середовища й глобальні типові привілеї ролі плану (рішення 5
 * плану П3-2b-0) поверх кроків із походженням і сторожами, блокувань із
 * режимами й преамбули двигуна (рішення 11 плану П3-2a). Шлях ревалідації
 * та інші поля П3-2b-1 додано в той самий формат: релізу між планами П3-2b
 * немає (рішення 12 плану П3-2b-1). Четвертий формат: факти сервера й
 * голова ledger цілі (рішення 1–2 плану П3-2b-3) — файл третього формату
 * без них отримує чесну відмову «формат застарів», а не «це не план».
 */
export const PLAN_FORMAT = 4

/**
 * Таблиця одиниці, чиї дані план зберігає (рішення 6 плану П3-2a): імена до й
 * після, ключ рядка й пари колонок як SQL-вирази, якими заміри порівнюють
 * дані до кроків і після.
 */
export interface PreservedTable {
  /** Старі імена: заміри «до» йдуть до кроків наміру. */
  before: { schema: string; table: string }
  after: { schema: string; table: string }
  /** SQL-вираз ключа рядка до й після. */
  key: { before: string; after: string }
  /**
   * SQL-вирази колонки до й після; `typeChangeStep` — id кроку зміни типу,
   * що його розбіжність називає `apply.type-narrowing`; `dataStep` — крок
   * даних, чий вираз міряє «до» (рішення 8 плану П3-2b-2).
   */
  columns: {
    before: string
    after: string
    typeChangeStep?: string
    dataStep?: string
  }[]
}

/** Вид канонічного імені, яке намір повертає підоб'єкту таблиці. */
export const CANONICAL_NAME_KINDS = ["constraint", "index", "sequence"] as const

/** Таблиця секції промоції в новому імені. */
export interface SectionTable {
  schema: string
  name: string
}

/**
 * Секція промоції артефакту (рішення 11, R7 плану П3-2a). Під `planHash`:
 * дозвіл прийняв саме цей запис, ці пункти й ці перейменування. Пункти
 * дозволу раннер рахує звідси, а не з `requiredPermissions`.
 */
export interface PromotionSection {
  /** `promotionRecordHash(record)`: те, що ledger запам'ятає як застосоване. */
  recordHash: string
  record: PromotionRecord
  /** Пункти `access:`, `delete:`, `remove:`, `repair:` з тим, що людина переглядає. */
  permissionItems: PermissionItem[]
  preservation: PreservedTable[]
  /**
   * Перейменування колонок наміру в порядку його кроків. Таблиця — у новому
   * імені структурним ключем (R23, R11 плану П3-2a): одиниця може мати
   * таблиці в різних схемах межі.
   */
  columns: { table: SectionTable; from: string; to: string }[]
  /** Канонічні імена підоб'єктів у порядку кроків наміру. */
  canonicalNames: {
    kind: (typeof CANONICAL_NAME_KINDS)[number]
    table: SectionTable
    from: string
    to: string
  }[]
  /** Id кроку → клас конверсії: лише для показу біля кроку. */
  conversions: { step: string; class: ConversionClass }[]
  /**
   * Кроки даних за таблицями (рішення 2 плану П3-2b-2): раннер рендерить
   * їхній SQL з цих полів. Порожньо — у записі кроків даних немає.
   */
  data: DataTable[]
}

/**
 * Незмінний артефакт плану (платформна спека §6.10, рішення 9 плану П3-1):
 * детермінований, без часу й інших мінливих даних. `planHash` покриває все
 * інше, зокрема кроки разом із `lockedTables`, дрейф і `resultCatalog`.
 */
export interface PlanArtifact {
  format: typeof PLAN_FORMAT
  platformVersion: string
  engine: EngineIdentity
  fingerprintVersion: number
  /** Хеш знімка, від якого план починається; `null` — перше застосування. */
  fromHash: string | null
  toHash: string
  scope: EngineScope
  targetFingerprint: CatalogFingerprint
  desiredFingerprint: CatalogFingerprint
  steps: PlanStep[]
  /** Пункти дозволу: `drift`, коли дрейф є, далі id кроків. */
  requiredPermissions: string[]
  /**
   * Дрейф цілі від marker (рішення 2 плану П3-1); `null` — дрейфу немає.
   * Під хешем: дозвіл `drift` прийняв саме цей дрейф, а не будь-який.
   */
  drift: DriftReport | null
  /**
   * Роль сесії (`current_user`), для якої план побудовано: від неї залежать
   * замки, власники й шлях запису, тож застосування іншою роллю — відмова.
   */
  role: string
  /**
   * Факти сервера цілі (`readServerFacts`), прочитані планом тією самою
   * транзакцією READ ONLY, що й стан застосування (рішення 1–2 плану
   * П3-2b-3). Під хешем: репетиція й застосування звіряють з ними живу базу
   * (фаза 4e), тож копія на іншому сервері — не копія цієї цілі.
   */
  server: ServerFacts
  /**
   * Голова ledger цілі (`readLedgerHead`) на момент плану; `null` — ledger
   * немає чи він порожній. Фаза 4e звіряє її: копія з тим самим ланцюжком,
   * але окремими застосуваннями, має іншу голову. Для першого застосування
   * пункт нічого не відрізняє — відоме обмеження.
   */
  ledgerHead: string | null
  /**
   * Що раннер блокує до кроків: вихідні імена з режимом, у детермінованому
   * порядку, за слідом кроків (R26 плану П3-2a). Рахує `planLocks`.
   */
  locks: TableLock[]
  /**
   * Таблиці сліду, які роль не може заблокувати явно (немає права на
   * `LOCK`): замок бере сам крок `step`. У `locks` їх немає, але вивід плану
   * їх показує — не мовчки. Порядок — схема, потім ім'я.
   */
  implicitLocks: ImplicitLock[]
  /**
   * Перелік таблиць провайдерських замків, прочитаний з цілі для `role`
   * (R27 плану П3-2a): з нього слід кроків узяв замки політик і тригерів.
   * Під хешем, щоб підміна переліку в файлі була помітна; раннер перед
   * блокуваннями читає перелік на цілі знову, і інший перелік —
   * `apply.target-changed`.
   */
  providerLocks: ProviderLockSet[]
  /**
   * FK живої цілі, з яких слід кроків узяв замки таблиць поза моделями
   * каталогу (рішення 9 плану П3-2b-1): `subjects` — таблиці сліду у вихідних
   * іменах (`footprintSubjects`), `live` — FK, що торкаються їх в обидва боки
   * (`readLiveForeignKeys`). Під хешем; раннер перед блокуваннями читає FK
   * тих самих таблиць знову, і інший набір — `apply.target-changed`: FK поза
   * межею, доданий після плану, займався б посеред кроків. Поле є завжди;
   * порожні переліки — плану FK цілі не потрібні.
   */
  foreignKeys: {
    subjects: { schema: string; name: string }[]
    live: LiveForeignKey[]
  }
  /**
   * Преамбула двигуна, лише пари з `ENGINE_PREAMBLE_ALLOWED`. Раннер виконує
   * її навколо кроків двигуна разом із їхніми сторожами, такою, як її записав
   * план, а тіла функцій після кроків перевіряє ревалідація (R22 плану
   * П3-2a, рішення 1–3 плану П3-2b-1).
   */
  preamble: EngineSetting[]
  /**
   * `search_path` сесії цілі, прочитаний планом (рішення 2 плану П3-2b-1):
   * під ним раннер перевіряє тіла функцій до кроків і після. Під хешем, тож
   * репетиція й застосування перевіряють однаково.
   */
  revalidationSearchPath: string
  /**
   * Як раннер бере `plpgsql_check` у кожній базі (рішення 4 плану П3-2b-1):
   * режим цілі, прочитаний планом. Під хешем: раннер звіряє його з ціллю, а
   * `unavailable` означає, що план уже попередив чи відмовив і перевірки
   * розширенням немає.
   */
  plpgsqlCheck: PlpgsqlCheckMode
  /**
   * Сигнатури функцій платформи бажаного стану
   * (`platformFunctionSignatures`): їх раннер виключає з `plpgsql_check` і
   * переліку сліпих. Під хешем: ознаку дає модель, а раннер моделі не має.
   */
  platformFunctions: string[]
  /**
   * Недійсні обмеження й індекси бажаної тіні (`readInvalidObjects`): раннер
   * після кроків відмовляє лише на недійсному, чого в бажаному стані немає
   * (рішення 1 плану П3-2b-1, фаза 16).
   */
  desiredInvalid: string[]
  /** Секція промоції; `null` — план без промоції. Поле є завжди, як `drift`. */
  promotion: PromotionSection | null
  /**
   * Середовище, з яким план доведено (рішення 5 плану П3-2b-0): глобальні
   * типові привілеї `role` на цілі, рядками `aclexplode`, відсортовано. Під
   * хешем: кроки середовища правильні саме для цього переліку, тож раннер
   * перед блокуваннями читає його на цілі знову, і інший перелік —
   * `apply.target-changed`. Поле є завжди; порожній перелік — їх немає.
   */
  environment: { defaultPrivileges: GlobalDefaultPrivilege[] }
  resultCatalog: CatalogModel
  planHash: string
}

export const hashSchema = z.string().regex(/^[0-9a-f]{64}$/)

/** `ServerFacts` строго: та сама форма в плані й у звіті репетиції. */
export const serverFactsSchema = z.strictObject({
  major: z.number().int(),
  encoding: z.string(),
  collate: z.string(),
  ctype: z.string(),
  localeProvider: z.string(),
  locale: z.string().nullable(),
  collationVersion: z.string().nullable(),
})

const sectionTableSchema = z.strictObject({
  schema: z.string(),
  name: z.string(),
})

const promotionSectionSchema = z.strictObject({
  recordHash: hashSchema,
  record: promotionRecordSchema,
  permissionItems: z.array(
    z.strictObject({ token: z.string(), summary: z.array(z.string()) })
  ),
  preservation: z.array(
    z.strictObject({
      before: z.strictObject({ schema: z.string(), table: z.string() }),
      after: z.strictObject({ schema: z.string(), table: z.string() }),
      key: z.strictObject({ before: z.string(), after: z.string() }),
      columns: z.array(
        z.strictObject({
          before: z.string(),
          after: z.string(),
          typeChangeStep: z.string().optional(),
          dataStep: z.string().optional(),
        })
      ),
    })
  ),
  columns: z.array(
    z.strictObject({
      table: sectionTableSchema,
      from: z.string(),
      to: z.string(),
    })
  ),
  canonicalNames: z.array(
    z.strictObject({
      kind: z.enum(CANONICAL_NAME_KINDS),
      table: sectionTableSchema,
      from: z.string(),
      to: z.string(),
    })
  ),
  conversions: z.array(
    z.strictObject({ step: z.string(), class: conversionClass })
  ),
  data: z.array(
    z.strictObject({
      temp: z.string(),
      before: z.strictObject({
        schema: z.string(),
        table: z.string(),
        key: z.string(),
      }),
      after: z.strictObject({
        schema: z.string(),
        table: z.string(),
        key: z.string(),
      }),
      columns: z.array(
        z.strictObject({
          step: z.string(),
          column: z.string(),
          type: z.string(),
          expression: z.string(),
          kind: z.enum(DATA_STEP_KINDS),
          guard: z.string(),
        })
      ),
      triggers: z.array(
        z.strictObject({
          name: z.string(),
          enabled: z.enum(DATA_TRIGGER_MODES),
        })
      ),
    })
  ),
})

const fingerprintSchema = z.strictObject({
  version: z.number().int(),
  sections: z.record(z.enum(FINGERPRINT_SECTIONS), z.string()),
})

const objectRefSchema = z.strictObject({
  kind: z.string(),
  schema: z.string(),
  table: z.string().optional(),
  name: z.string(),
})

const stepSchema = z.strictObject({
  id: z.string(),
  origin: z.enum(["intent", "engine", "environment"]),
  sql: z.string(),
  verb: z.enum(ENGINE_ACTION_VERBS),
  class: z.enum(STEP_CLASSES),
  lockClass: z.string(),
  transactionality: z.enum(ENGINE_TRANSACTIONALITIES),
  newSegmentBefore: z.boolean(),
  lockedTables: z.array(
    z.strictObject({ schema: z.string(), name: z.string() })
  ),
  produces: z.array(z.string()),
  consumes: z.array(z.string()),
  destroys: z.array(z.string()),
  produced: z.array(objectRefSchema),
  destroyed: z.array(objectRefSchema),
  consumed: z.array(objectRefSchema),
  dataLoss: z.boolean(),
  rewriteRisk: z.boolean(),
  guards: z.array(z.string()),
})

/**
 * Строгий верхній рівень, кроки, відбитки, межа й ідентичність двигуна.
 * `resultCatalog` — непрозорий JSON-об'єкт (`z.record(z.string(), z.unknown())`
 * з приведенням до `CatalogModel`): Zod-схеми моделі каталогу в T0 немає, а
 * дзеркальна схема в T2 продублювала б T0. Цілість тримає `planHash`.
 * Так само `readApplyState` читає `marker.catalog`.
 */
export const planArtifactSchema: z.ZodType<PlanArtifact> = z.strictObject({
  // Ранній вихід `parsePlan` дає іншому формату власну відмову; літерал
  // тримає ту саму гарантію і в схемі, і в типі для будь-якого читача
  format: z.literal(PLAN_FORMAT),
  platformVersion: z.string(),
  engine: z.strictObject({ name: z.string(), version: z.string() }),
  fingerprintVersion: z.number().int(),
  fromHash: z.string().nullable(),
  toHash: z.string(),
  scope: z.strictObject({
    schemas: z.array(z.string()),
    provider: z.enum(DATABASE_PROVIDERS),
  }),
  targetFingerprint: fingerprintSchema,
  desiredFingerprint: fingerprintSchema,
  steps: z.array(stepSchema),
  requiredPermissions: z.array(z.string()),
  drift: z
    .strictObject({
      reason: z.enum(DRIFT_REASONS),
      sections: z.array(z.enum(FINGERPRINT_SECTIONS)),
      paths: z.array(z.string()),
    })
    .nullable(),
  role: z.string(),
  server: serverFactsSchema,
  ledgerHead: z.string().nullable(),
  locks: z.array(
    z.strictObject({
      schema: z.string(),
      name: z.string(),
      mode: z.enum(TABLE_LOCK_MODES),
    })
  ),
  implicitLocks: z.array(
    z.strictObject({
      schema: z.string(),
      name: z.string(),
      mode: z.enum(TABLE_LOCK_MODES),
      step: z.string(),
    })
  ),
  providerLocks: z.array(
    z.strictObject({
      setting: z.string(),
      statements: z.array(z.enum(PROVIDER_LOCK_STATEMENTS)),
      tables: z.array(z.strictObject({ schema: z.string(), name: z.string() })),
    })
  ),
  foreignKeys: z.strictObject({
    subjects: z.array(z.strictObject({ schema: z.string(), name: z.string() })),
    live: z.array(
      z.strictObject({
        schema: z.string(),
        table: z.string(),
        columns: z.array(z.string()),
        references: z.strictObject({
          schema: z.string(),
          table: z.string(),
          columns: z.array(z.string()),
        }),
      })
    ),
  }),
  // Пара поза переліком — не план цієї платформи: раннер її не виконав би
  preamble: z.array(
    z
      .strictObject({ name: z.string(), value: z.string() })
      .refine(isAllowedSetting, {
        message: "preamble setting is not on the allowed list",
      })
  ),
  revalidationSearchPath: z.string(),
  plpgsqlCheck: z.enum(PLPGSQL_CHECK_MODES),
  platformFunctions: z.array(z.string()),
  desiredInvalid: z.array(z.string()),
  promotion: promotionSectionSchema.nullable(),
  environment: z.strictObject({
    defaultPrivileges: z.array(
      z.strictObject({
        objtype: z.enum(DEFAULT_PRIVILEGE_OBJTYPES),
        grantee: z.string(),
        privilege: z.string(),
        grantable: z.boolean(),
      })
    ),
  }),
  resultCatalog: z
    .record(z.string(), z.unknown())
    .transform((catalog) => catalog as unknown as CatalogModel),
  planHash: hashSchema,
})

/** Чи дозволена пара преамбули; власні ключі, не ланцюжок прототипів. */
export function isAllowedSetting(s: EngineSetting): boolean {
  return (
    Object.hasOwn(ENGINE_PREAMBLE_ALLOWED, s.name) &&
    ENGINE_PREAMBLE_ALLOWED[s.name] === s.value
  )
}

/** `planHash` — hex SHA-256 канонічної форми артефакту без самого хешу. */
export async function stampPlan(
  draft: Omit<PlanArtifact, "planHash">
): Promise<PlanArtifact> {
  return { ...draft, planHash: await sha256Hex(canonicalize(draft)) }
}

export async function verifyPlanHash(artifact: PlanArtifact): Promise<boolean> {
  const { planHash, ...draft } = artifact
  return (await sha256Hex(canonicalize(draft))) === planHash
}

/** Файл плану — канонічна форма з відступом 2 і `\n` наприкінці. */
export function serializePlan(artifact: PlanArtifact): string {
  return serializeCanonical(artifact)
}

export type ParsedPlan =
  | { ok: true; artifact: PlanArtifact }
  /** План іншого формату: його будують наново, а не лагодять. */
  | {
      ok: false
      reason: "format"
      message: string
      diagnostic: EngineDiagnostic
    }
  | { ok: false; reason: "invalid"; message: string }

/**
 * Строгий розбір файлу плану. `format` читається до строгої схеми: план
 * іншого формату має інші поля, і строга схема назвала б його зіпсованим
 * файлом, хоча правда — «побудуй наново». Шиму для старих форматів немає.
 */
export function parsePlan(text: string): ParsedPlan {
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
  if (typeof format === "number" && format !== PLAN_FORMAT) {
    const diagnostic = applyDiagnostic("apply.plan-format", "error", {
      found: format,
      supported: PLAN_FORMAT,
    })
    return {
      ok: false,
      reason: "format",
      message: diagnostic.message,
      diagnostic,
    }
  }
  const result = planArtifactSchema.safeParse(json)
  return result.success
    ? { ok: true, artifact: result.data }
    : {
        ok: false,
        reason: "invalid",
        message: z.prettifyError(result.error),
      }
}

/**
 * `<from12>-<to12>.plan.json`: інстанси різних версій приходять до одного
 * знімка з різних, тож ім'я лише за `to` колізувало б (§6.10).
 */
export function planFileName(fromHash: string | null, toHash: string): string {
  return `${planFileStem(fromHash, toHash)}.plan.json`
}

/**
 * Спільний префікс файлів переходу `from → to`: плану й звіту його
 * репетиції (`rehearsalFileName`), щоб вони лежали поруч і не розходились.
 */
export function planFileStem(fromHash: string | null, toHash: string): string {
  const from = fromHash === null ? "initial" : fromHash.slice(0, 12)
  return `${from}-${toHash.slice(0, 12)}`
}
