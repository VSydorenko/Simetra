import { readdir, readFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import {
  canonicalSnapshot,
  compile,
  diagnostic,
  promotionFileName,
  promotionRecordSchema,
  type CompiledModel,
  type ConversionClass,
  type Diagnostic,
  type PromotionRecord,
} from "simetra/compiler"
import {
  buildPlan,
  checkPermissions,
  executePlan,
  FINGERPRINT_VERSION,
  parsePlan,
  planFileName,
  PLATFORM_VERSION,
  serializePlan,
  verifyPlanHash,
  type ApplyTimeouts,
  type DriftReport,
  type EngineIdentity,
  type GlobalDefaultPrivilege,
  type ImplicitLock,
  type PermissionItem,
  type PlanArtifact,
  type PlanStep,
  type PromotionInput,
  type PromotionSection,
  type TableLock,
} from "simetra/schema"
import { z } from "zod"
import { withDatabase } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { UsageError } from "../io/usage-error"
import { fromEngine, hasErrors, loadEngine, required } from "./database-tools"
import { defineTool, PLANS_DIR, type RunOutcome } from "./types"

/**
 * Промоція, яку план несе (рішення 14 плану П3-2a): що стає чим, і що людина
 * дозволяє. Таблиці — структурно, як у секції артефакту: ім'я з крапкою
 * рядок `schema.name` зробив би неоднозначним.
 */
export interface PlanPromotion {
  objectId: string
  kind: PromotionRecord["kind"]
  /** Ім'я об'єкта в метаданих після промоції. */
  name: string
  recordHash: string
  /** Перейменування таблиць одиниці; схема та сама. */
  tables: { schema: string; from: string; to: string }[]
  columns: PromotionSection["columns"]
  canonicalNames: PromotionSection["canonicalNames"]
  /** Пункти `access:`, `delete:`, `remove:` з переліками. */
  permissionItems: PermissionItem[]
}

/** Крок плану для перегляду; клас конверсії — лише біля кроку видалення. */
export type PlanDataStep = Pick<
  PlanStep,
  "id" | "origin" | "class" | "lockClass" | "sql"
> & { conversion?: ConversionClass }

/** Те з артефакту, що людина чи агент переглядає перед `apply`. */
export interface PlanData {
  /** Шлях артефакту відносно кореня проєкту — вхід `plan` для `apply`. */
  file: string
  planHash: string
  fromHash: string | null
  toHash: string
  drift: DriftReport | null
  promotion: PlanPromotion | null
  steps: PlanDataStep[]
  /** Що раннер блокує наперед, до кроків: вихідні імена з режимом. */
  locks: TableLock[]
  /**
   * Таблиці, які роль не може заблокувати наперед: замок бере сам крок
   * (R26 плану П3-2a). Показуються, щоб замок не був мовчазним.
   */
  implicitLocks: ImplicitLock[]
  requiredPermissions: string[]
  /**
   * Роль плану і її глобальні типові привілеї, з якими план доведено
   * (рішення 5 плану П3-2b-0). Кроки середовища — у `steps` з походженням
   * `environment`: вивід показує їх окремою групою з поясненням ролі.
   */
  environment: { role: string; defaultPrivileges: GlobalDefaultPrivilege[] }
}

export interface ApplyData {
  status: "committed" | "rolledBack"
  attempts: number
}

/**
 * Пул лише на виклик: інструменти без застосування не тягнуть `pg`, як і
 * двигун у `loadEngine`.
 */
async function applyDatabase(o: { readOnly: boolean }) {
  const { createApplyDatabase } = await import("../schema-engine")
  return createApplyDatabase(o)
}

const refusedWith = <D>(diagnostics: Diagnostic[]): RunOutcome<D> => ({
  ok: false,
  changes: [],
  diagnostics,
})

function planPromotion(
  section: PromotionSection,
  model: CompiledModel
): PlanPromotion {
  const { record } = section
  // Ім'я — з метаданих, з якими план побудовано: запис несе лише id, а
  // людина впізнає об'єкт за іменем
  const object = model.objects.find((o) => o.id === record.objectId)
  return {
    objectId: record.objectId,
    kind: record.kind,
    name: object?.name ?? record.objectId,
    recordHash: section.recordHash,
    tables: record.tables.map(({ schema, from, to }) => ({ schema, from, to })),
    columns: section.columns,
    canonicalNames: section.canonicalNames,
    permissionItems: section.permissionItems,
  }
}

function planData(
  file: string,
  artifact: PlanArtifact,
  model: CompiledModel
): PlanData {
  const conversions = new Map(
    (artifact.promotion?.conversions ?? []).map((c) => [c.step, c.class])
  )
  return {
    file,
    planHash: artifact.planHash,
    fromHash: artifact.fromHash,
    toHash: artifact.toHash,
    drift: artifact.drift,
    promotion:
      artifact.promotion === null
        ? null
        : planPromotion(artifact.promotion, model),
    steps: artifact.steps.map(({ id, origin, class: cls, lockClass, sql }) => {
      const conversion = conversions.get(id)
      return {
        id,
        origin,
        class: cls,
        lockClass,
        sql,
        ...(conversion === undefined ? {} : { conversion }),
      }
    }),
    locks: artifact.locks,
    implicitLocks: artifact.implicitLocks,
    requiredPermissions: artifact.requiredPermissions,
    environment: {
      role: artifact.role,
      defaultPrivileges: artifact.environment.defaultPrivileges,
    },
  }
}

/** Суфікс файлу запису промоції в `plans/` (`promotionFileName`). */
const RECORD_SUFFIX = promotionFileName("")

/**
 * Записи промоції з `plans/` кореня (рішення 1 плану П3-2a), строго: файл, що
 * не розбирається схемою чи названий не за своїм `objectId`, — відмова плану
 * `plan.promotion-record-invalid`, а не пропуск. Пропущений запис перетворив
 * би промоцію на «запису немає», а вгаданий — на чужий намір. Порядок — за
 * іменем файлу: план детермінований незалежно від файлової системи.
 */
export async function readPromotionRecords(
  root: string
): Promise<
  | { ok: true; records: PromotionInput[] }
  | { ok: false; diagnostic: Diagnostic }
> {
  let names: string[]
  try {
    names = await readdir(join(root, PLANS_DIR))
  } catch (error) {
    // Без `plans/` записів немає: це звичайний проєкт без промоції
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ok: true, records: [] }
    throw error
  }
  const records: PromotionInput[] = []
  for (const name of names.filter((n) => n.endsWith(RECORD_SUFFIX)).sort()) {
    const file = `${PLANS_DIR}/${name}`
    const invalid = (detail: string) => ({
      ok: false as const,
      diagnostic: diagnostic("plan.promotion-record-invalid", "", "", {
        file,
        detail,
      }),
    })
    // Нечитний файл (тека з таким іменем, немає доступу) — той самий
    // зіпсований запис: пропуск чи сирий виняток сховали б намір промоції
    let text: string
    try {
      text = await readFile(join(root, file), "utf8")
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === undefined) throw error
      return invalid(`the file could not be read (${code})`)
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      if (error instanceof SyntaxError) return invalid(error.message)
      throw error
    }
    const parsed = promotionRecordSchema.safeParse(json)
    if (!parsed.success)
      return invalid(
        parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")
      )
    const record = parsed.data
    if (promotionFileName(record.objectId) !== name)
      return invalid(
        `the record is for object ${record.objectId}, so its file is ${PLANS_DIR}/${promotionFileName(record.objectId)}`
      )
    records.push({ record, file })
  }
  return { ok: true, records }
}

export const planTool = defineTool({
  name: "plan",
  description:
    "Plan applying the metadata to the live database: drift gate, steps with classes and lock levels, proof on a copy of the current state. Writes plans/<from>-<to>.plan.json next to the metadata directory; the database is only read.",
  input: z.strictObject({}),
  files: "write",
  database: "read",
  destructive: false,
  async run({ dir, root, database }): Promise<RunOutcome<PlanData>> {
    const compiled = await compile(await readMetadataDir(dir))
    const model = compiled.model
    if (model === undefined) return refusedWith(compiled.diagnostics)
    // Записи — до підключення: невалідний файл не відкриває пулів
    const promotions = await readPromotionRecords(root)
    if (!promotions.ok)
      return refusedWith([...compiled.diagnostics, promotions.diagnostic])
    const engine = await loadEngine()
    // Ціль і тіні лише читаються; пише тільки прогін-доказ у жертовну копію
    const dbs = {
      reader: await applyDatabase({ readOnly: true }),
      scratch: await applyDatabase({ readOnly: false }),
    }
    const built = await withDatabase(required(database), "plan", (db) =>
      buildPlan(
        engine,
        dbs,
        model,
        {
          target: db.target,
          ...(db.shadowBase ? { shadowBase: db.shadowBase } : {}),
        },
        promotions.records
      )
    )
    if (!built.ok)
      return refusedWith([...compiled.diagnostics, built.diagnostic])
    const outcome = built.value
    const diagnostics = [
      ...compiled.diagnostics,
      ...outcome.diagnostics.map(fromEngine),
    ]
    switch (outcome.status) {
      case "refused":
        return refusedWith(diagnostics)
      // Нічого застосовувати — артефакту немає
      case "unchanged":
        return {
          ok: !hasErrors(diagnostics),
          changes: [],
          diagnostics,
          artifacts: [],
        }
      case "planned": {
        const { artifact } = outcome
        const file = `${PLANS_DIR}/${planFileName(artifact.fromHash, artifact.toHash)}`
        return {
          ok: !hasErrors(diagnostics),
          changes: [],
          diagnostics,
          artifacts: [{ path: file, content: serializePlan(artifact) }],
          data: planData(file, artifact, model),
        }
      }
    }
  },
})

const engineLabel = (e: EngineIdentity): string => `${e.name} ${e.version}`

/** Перші 12 hex-символів, як у імені файлу плану. */
const short = (hash: string): string => hash.slice(0, 12)

/** Читає файл плану з `plans/` кореня; поза ним — помилка використання. */
async function readPlanFile(root: string, plan: string): Promise<string> {
  const path = resolve(root, plan)
  if (!path.startsWith(resolve(root, PLANS_DIR) + sep))
    throw new UsageError(
      `The plan file must be under ${PLANS_DIR}/, given relative to the project root (the directory that contains the metadata directory), not to the current directory: ${plan}. Nothing changed.`
    )
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "EISDIR")
      throw new UsageError(`Plan file not found: ${plan}. Nothing changed.`)
    throw error
  }
}

/**
 * Версії, з якими план побудовано й доведено, мусять бути поточними: інакше
 * кроки чи відбитки значать інше (рішення 9 плану П3-1). Формат файлу звіряє
 * вже `parsePlan`.
 */
function versionMismatches(
  artifact: PlanArtifact,
  engine: EngineIdentity
): Diagnostic[] {
  const pairs: [string, string | number, string | number][] = [
    ["fingerprintVersion", artifact.fingerprintVersion, FINGERPRINT_VERSION],
    ["platformVersion", artifact.platformVersion, PLATFORM_VERSION],
    ["engine", engineLabel(artifact.engine), engineLabel(engine)],
  ]
  return pairs
    .filter(([, plan, current]) => plan !== current)
    .map(([field, plan, current]) =>
      diagnostic("apply.plan-versions", "", "", { field, plan, current })
    )
}

const timeoutMs = z.number().int().positive()

export const applyTool = defineTool({
  name: "apply",
  description:
    "Apply a reviewed plan file to the live database in one transaction, or rehearse it (rolled back; still takes the plan's locks). Needs the plan's hash; destructive and relaxing steps need `allow` by id, drift needs `drift`, and a promotion needs its access:, delete: and remove: items.",
  input: z.strictObject({
    plan: z.string().min(1).meta({
      description:
        "Plan file from `plan`, relative to the project root: plans/….plan.json.",
    }),
    planHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .meta({ description: "planHash of the reviewed plan." }),
    allow: z
      .array(
        z.string().regex(/^(?:s[1-9][0-9]*|drift|(?:access|delete|remove):.+)$/)
      )
      .optional()
      .meta({
        description:
          "Plan items to permit: step ids (s1, s2, …), drift, access:<table>, delete:<table>.<constraint>, remove:<table>.",
      }),
    rehearse: z.boolean().optional(),
    lockTimeoutMs: timeoutMs.optional(),
    statementTimeoutMs: timeoutMs.optional(),
  }),
  files: "read",
  database: "write",
  destructive: true,
  async run({ dir, root, database }, input): Promise<RunOutcome<ApplyData>> {
    // 1–2. Артефакт лише з `plans/` і лише строгий
    const parsed = parsePlan(await readPlanFile(root, input.plan))
    // План іншого формату — чинний файл старої платформи: відмова з порадою
    // побудувати план наново, а не «це не файл плану»
    if (!parsed.ok && parsed.reason === "format")
      return refusedWith([fromEngine(parsed.diagnostic)])
    if (!parsed.ok)
      throw new UsageError(
        `${input.plan} is not a plan file: ${parsed.message}. Nothing changed.`
      )
    const { artifact } = parsed

    // 3. Застосовується лише показаний план: і файл, і підтверджений хеш
    if (
      !(await verifyPlanHash(artifact)) ||
      artifact.planHash !== input.planHash
    )
      return refusedWith([
        diagnostic("apply.plan-hash", "", "", {
          file: input.plan,
          planHash: input.planHash,
        }),
      ])

    // 4. Версії формату, відбитка, платформи й двигуна
    const engine = await loadEngine()
    const versions = versionMismatches(artifact, engine.identity)
    if (versions.length > 0) return refusedWith(versions)

    // 5. Метадані не змінилися після планування
    const compiled = await compile(await readMetadataDir(dir))
    const model = compiled.model
    if (model === undefined) return refusedWith(compiled.diagnostics)
    if (model.hash !== artifact.toHash)
      return refusedWith([
        diagnostic("apply.plan-stale", "", "", {
          plan: short(artifact.toHash),
          current: short(model.hash),
        }),
      ])

    // 6. Дозволи — до підключення: відмова не відкриває пулу запису
    const allow = input.allow ?? []
    // Пункти промоції — із секції артефакту під хешем (рішення 15 плану
    // П3-2a, R1); раннер перевіряє їх знову
    const permissions = checkPermissions(
      {
        steps: artifact.steps,
        drift: artifact.drift,
        promotion: artifact.promotion,
      },
      allow
    )
    if (permissions.length > 0) return refusedWith(permissions.map(fromEngine))

    // 7. Лише тут відкривається пул, що може писати в ціль. Тайм-аути — лише
    // задані: явний `undefined` не має перекривати типове значення раннера
    const timeouts: Partial<ApplyTimeouts> = {
      ...(input.lockTimeoutMs === undefined
        ? {}
        : { lockTimeoutMs: input.lockTimeoutMs }),
      ...(input.statementTimeoutMs === undefined
        ? {}
        : { statementTimeoutMs: input.statementTimeoutMs }),
    }
    const writer = await applyDatabase({ readOnly: false })
    const executed = await withDatabase(required(database), "apply", (db) =>
      executePlan(writer, db.target, artifact, {
        mode: input.rehearse === true ? "rehearse" : "apply",
        planHash: artifact.planHash,
        allow,
        snapshot: canonicalSnapshot(model),
        timeouts,
      })
    )
    if (!executed.ok) return refusedWith([executed.diagnostic])
    const outcome = executed.value
    const diagnostics = outcome.diagnostics.map(fromEngine)
    switch (outcome.status) {
      case "committed":
      case "rolledBack":
        return {
          ok: !hasErrors(diagnostics),
          changes: [],
          diagnostics,
          data: { status: outcome.status, attempts: outcome.attempts },
        }
      case "refused":
      case "failed":
        return refusedWith(diagnostics)
    }
  },
})
