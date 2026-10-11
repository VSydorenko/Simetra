import { z } from "zod"
import { canonicalize, sha256Hex } from "simetra/compiler"
import { DATABASE_PROVIDERS, type CatalogModel } from "simetra/model"
import {
  ENGINE_ACTION_VERBS,
  ENGINE_TRANSACTIONALITIES,
  type EngineIdentity,
  type EngineScope,
} from "../engine"
import { FINGERPRINT_SECTIONS, type CatalogFingerprint } from "./fingerprint"
import { STEP_CLASSES, type PlanStep } from "./steps"

/** Форма файлу плану; читач порівнює її з поточною, а не вгадує. */
export const PLAN_FORMAT = 1

/**
 * Незмінний артефакт плану (платформна спека §6.10, рішення 9 плану П3-1):
 * детермінований, без часу й інших мінливих даних. `planHash` покриває все
 * інше, зокрема кроки разом із `lockedTables` і `resultCatalog`.
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
  requiredPermissions: string[]
  resultCatalog: CatalogModel
  planHash: string
}

const fingerprintSchema = z.strictObject({
  version: z.number().int(),
  sections: z.record(z.enum(FINGERPRINT_SECTIONS), z.string()),
})

const stepSchema = z.strictObject({
  id: z.string(),
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
  dataLoss: z.boolean(),
  rewriteRisk: z.boolean(),
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
  resultCatalog: z
    .record(z.string(), z.unknown())
    .transform((catalog) => catalog as unknown as CatalogModel),
  planHash: z.string().regex(/^[0-9a-f]{64}$/),
})

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

/**
 * Файл плану — канонічна форма з відступом 2 і `\n` наприкінці. Відступи
 * додаються до самого канонічного тексту, а не до повторного `JSON.stringify`:
 * той ставить цілочисельні ключі об'єкта першими й зламав би порядок RFC 8785.
 */
export function serializePlan(artifact: PlanArtifact): string {
  return `${indentJson(canonicalize(artifact))}\n`
}

/** Відступи для компактного JSON; рядки копіюються як є, з екрануванням. */
function indentJson(text: string): string {
  let out = ""
  let depth = 0
  let inString = false
  const newline = () => `\n${"  ".repeat(depth)}`
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === "\\") out += text[++i]!
      else if (ch === '"') inString = false
      continue
    }
    switch (ch) {
      case '"':
        inString = true
        out += ch
        break
      case "{":
      case "[":
        // Порожні `{}` і `[]` лишаються в рядку, як у `JSON.stringify`
        if (text[i + 1] === (ch === "{" ? "}" : "]")) {
          out += ch + text[++i]!
          break
        }
        depth++
        out += ch + newline()
        break
      case "}":
      case "]":
        depth--
        out += newline() + ch
        break
      case ",":
        out += `,${newline()}`
        break
      case ":":
        out += ": "
        break
      default:
        out += ch
    }
  }
  return out
}

export function parsePlan(
  text: string
): { ok: true; artifact: PlanArtifact } | { ok: false; message: string } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
  const result = planArtifactSchema.safeParse(json)
  return result.success
    ? { ok: true, artifact: result.data }
    : { ok: false, message: z.prettifyError(result.error) }
}

/**
 * `<from12>-<to12>.plan.json`: інстанси різних версій приходять до одного
 * знімка з різних, тож ім'я лише за `to` колізувало б (§6.10).
 */
export function planFileName(fromHash: string | null, toHash: string): string {
  const from = fromHash === null ? "initial" : fromHash.slice(0, 12)
  return `${from}-${toHash.slice(0, 12)}.plan.json`
}
