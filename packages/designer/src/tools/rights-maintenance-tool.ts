import { compile } from "simetra/compiler"
import { UUID_TEXT } from "simetra/model"
import {
  runRightsMaintenance,
  type RightsMaintenanceDone,
} from "simetra/schema"
import { z } from "zod"
import { withDatabase } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { fromEngine, required } from "./database-tools"
import { defineTool } from "./types"

export type RightsMaintenanceData = RightsMaintenanceDone

const id = z.string().regex(UUID_TEXT, "expected a UUID")
const role = z.string().min(1)

/**
 * Вхід — JSON, одна дія на запуск (Р-A4-8): `strictObject` не пропускає поля
 * іншої дії, тож помилка написання не перетвориться на тиху іншу дію.
 */
const input = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("firstGlobalAssignment"),
    user: id,
    role,
  }),
  z.strictObject({
    action: z.literal("restoreGlobalFullAccess"),
    user: id,
    role: role.optional(),
  }),
  z.strictObject({
    action: z.literal("tenantFullAccess"),
    scopeKind: z.string().min(1),
    scope: id,
    user: id,
    role,
    member: z.record(z.string(), z.unknown()).optional(),
  }),
])

/**
 * Аварійний вхід у права поза командами (спека П4 §6.12): режим
 * обслуговування бази діє лише для входу мігратора, тож інструмент — лише
 * командний рядок і лише з `--yes`; агент через MCP його не бачить (Р-A4-7).
 */
export const rightsMaintenanceTool = defineTool({
  name: "rights-maintenance",
  description:
    "Command line only, needs --yes. Writes one rights assignment in the database maintenance mode, connected as the migrator that applied the plan (SIMETRA_DATABASE_URL). Input is JSON with one action: firstGlobalAssignment {user, role} makes the first global assignment; restoreGlobalFullAccess {user, role?} restores a global fullAccess holder when none is effective; tenantFullAccess {scopeKind, scope, user, role, member?} restores the fullAccess owner of one scope, adding the user's member row from member when the user is not a member yet. Refuses without writing when another apply or maintenance run holds the lock, the applied model is not the compiled one, the user or the scope is unknown, the role does not fit the action, or the level already has what the action makes; a write the user would not hold effectively is rolled back.",
  input,
  files: "read",
  database: "write",
  data: "none",
  destructive: true,
  cliOnly: true,
  async run({ dir, database }, request) {
    const compiled = await compile(await readMetadataDir(dir))
    const model = compiled.model
    // Помилки компіляції — до підключення: невалідна модель не відкриває пулу
    if (model === undefined)
      return { ok: false, changes: [], diagnostics: compiled.diagnostics }
    const { createApplyDatabase } = await import("../schema-engine")
    const ran = await withDatabase(
      required(database),
      "rights-maintenance",
      (db) =>
        runRightsMaintenance(
          createApplyDatabase({ readOnly: false }),
          db.target,
          model,
          request
        )
    )
    if (!ran.ok)
      return { ok: false, changes: [], diagnostics: [ran.diagnostic] }
    if (!ran.value.ok)
      return {
        ok: false,
        changes: [],
        diagnostics: [fromEngine(ran.value.diagnostic)],
      }
    return {
      ok: true,
      changes: [],
      diagnostics: [],
      data: ran.value.done,
    }
  },
})
