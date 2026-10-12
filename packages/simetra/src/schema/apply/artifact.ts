import { z } from "zod"
import { canonicalize, serializeCanonical, sha256Hex } from "simetra/compiler"
import { DATABASE_PROVIDERS, type CatalogModel } from "simetra/model"
import {
  ENGINE_ACTION_VERBS,
  ENGINE_PREAMBLE_ALLOWED,
  ENGINE_TRANSACTIONALITIES,
  type EngineDiagnostic,
  type EngineIdentity,
  type EngineScope,
  type EngineSetting,
} from "../engine"
import { applyDiagnostic } from "./diagnostic"
import { DRIFT_REASONS, type DriftReport } from "./drift"
import { FINGERPRINT_SECTIONS, type CatalogFingerprint } from "./fingerprint"
import { TABLE_LOCK_MODES, type TableLock } from "./locks"
import { STEP_CLASSES, type PlanStep } from "./steps"

/**
 * Форма файлу плану; читач порівнює її з поточною, а не вгадує. Другий
 * формат: кроки з походженням і сторожами, блокування з режимами, преамбула
 * двигуна (рішення 11 плану П3-2a).
 */
export const PLAN_FORMAT = 2

/**
 * Незмінний артефакт плану (платформна спека §6.10, рішення 9 плану П3-1):
 * детермінований, без часу й інших мінливих даних. `planHash` покриває все
 * інше, зокрема кроки разом із `lockedTables`, дрейф і `resultCatalog`.
 */
export interface PlanArtifact {
  format: number
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
   * Що раннер блокує до кроків: вихідні імена з режимом, у детермінованому
   * порядку (рішення 9 плану П3-2a). Рахує `planLocks`.
   */
  locks: TableLock[]
  /**
   * Преамбула двигуна, лише пари з `ENGINE_PREAMBLE_ALLOWED`. Раннер виконує
   * з неї лише `search_path` навколо кроків двигуна (рішення 13).
   */
  preamble: EngineSetting[]
  resultCatalog: CatalogModel
  planHash: string
}

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
  origin: z.enum(["intent", "engine"]),
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
  format: z.number().int(),
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
  locks: z.array(
    z.strictObject({
      schema: z.string(),
      name: z.string(),
      mode: z.enum(TABLE_LOCK_MODES),
    })
  ),
  // Пара поза переліком — не план цієї платформи: раннер її не виконав би
  preamble: z.array(
    z
      .strictObject({ name: z.string(), value: z.string() })
      .refine(isAllowedSetting, {
        message: "preamble setting is not on the allowed list",
      })
  ),
  resultCatalog: z
    .record(z.string(), z.unknown())
    .transform((catalog) => catalog as unknown as CatalogModel),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
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
  const from = fromHash === null ? "initial" : fromHash.slice(0, 12)
  return `${from}-${toHash.slice(0, 12)}.plan.json`
}
