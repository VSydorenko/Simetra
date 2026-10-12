import { readFile } from "node:fs/promises"
import { resolve, sep } from "node:path"
import {
  canonicalSnapshot,
  compile,
  diagnostic,
  type Diagnostic,
} from "simetra/compiler"
import {
  buildPlan,
  checkPermissions,
  executePlan,
  FINGERPRINT_VERSION,
  parsePlan,
  PLAN_FORMAT,
  planFileName,
  PLATFORM_VERSION,
  serializePlan,
  verifyPlanHash,
  type ApplyTimeouts,
  type DriftReport,
  type EngineIdentity,
  type PlanArtifact,
  type PlanStep,
} from "simetra/schema"
import { z } from "zod"
import { withDatabase } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { UsageError } from "../io/usage-error"
import { fromEngine, hasErrors, loadEngine, required } from "./database-tools"
import { defineTool, PLANS_DIR, type RunOutcome } from "./types"

/** Те з артефакту, що людина чи агент переглядає перед `apply`. */
export interface PlanData {
  /** Шлях артефакту відносно кореня проєкту — вхід `plan` для `apply`. */
  file: string
  planHash: string
  fromHash: string | null
  toHash: string
  drift: DriftReport | null
  steps: Pick<PlanStep, "id" | "class" | "lockClass" | "sql">[]
  requiredPermissions: string[]
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

function planData(file: string, artifact: PlanArtifact): PlanData {
  return {
    file,
    planHash: artifact.planHash,
    fromHash: artifact.fromHash,
    toHash: artifact.toHash,
    drift: artifact.drift,
    steps: artifact.steps.map(({ id, class: cls, lockClass, sql }) => ({
      id,
      class: cls,
      lockClass,
      sql,
    })),
    requiredPermissions: artifact.requiredPermissions,
  }
}

export const planTool = defineTool({
  name: "plan",
  description:
    "Plan applying the metadata to the live database: drift gate, steps with classes and lock levels, proof on a copy of the current state. Writes plans/<from>-<to>.plan.json next to the metadata directory; the database is only read.",
  input: z.strictObject({}),
  files: "write",
  database: "read",
  destructive: false,
  async run({ dir, database }): Promise<RunOutcome<PlanData>> {
    const compiled = await compile(await readMetadataDir(dir))
    const model = compiled.model
    if (model === undefined) return refusedWith(compiled.diagnostics)
    const engine = await loadEngine()
    // Ціль і тіні лише читаються; пише тільки прогін-доказ у жертовну копію
    const dbs = {
      reader: await applyDatabase({ readOnly: true }),
      scratch: await applyDatabase({ readOnly: false }),
    }
    const built = await withDatabase(required(database), "plan", (db) =>
      buildPlan(engine, dbs, model, {
        target: db.target,
        ...(db.shadowBase ? { shadowBase: db.shadowBase } : {}),
      })
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
          data: planData(file, artifact),
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
 * кроки, відбитки чи формат значать інше (рішення 9 плану П3-1).
 */
function versionMismatches(
  artifact: PlanArtifact,
  engine: EngineIdentity
): Diagnostic[] {
  const pairs: [string, string | number, string | number][] = [
    ["format", artifact.format, PLAN_FORMAT],
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
    "Apply a reviewed plan file to the live database in one transaction, or rehearse it (rolled back; still takes ACCESS EXCLUSIVE locks). Needs the plan's hash; destructive and relaxing steps need `allow` by id, and a plan with drift needs `drift` in `allow`.",
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
      .array(z.string().regex(/^(?:s[1-9][0-9]*|drift)$/))
      .optional()
      .meta({ description: "Step ids (s1, s2, …) and drift to permit." }),
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
    const permissions = checkPermissions(artifact, allow)
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
