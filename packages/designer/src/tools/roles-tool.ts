import { existsSync } from "node:fs"
import { readProjectFile, type Diagnostic } from "simetra/compiler"
import { PLATFORM_LOGIN_ROLES } from "simetra/model"
import {
  ensurePlatformRoles,
  platformRoleSet,
  type PlatformRoleOutcome,
  type PlatformRoleSet,
} from "simetra/schema"
import { z } from "zod"
import { withDatabase } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { fromEngine, required } from "./database-tools"
import { defineTool } from "./types"

const PROJECT_FILE = "project.meta.json"

/** Роль, яку `roles` свідомо не створював, і чому. */
export interface SkippedRole {
  name: string
  reason: "no-project-file"
}

export interface RolesData {
  roles: PlatformRoleOutcome[]
  skipped: SkippedRole[]
}

/**
 * Набір ролей теки проєкту (спека П4 §6.2): провайдер — з файлу проєкту, тим самим
 * читачем, що й `compile`. Без файлу роль входу пропускається явно — пропуск
 * видно у виводі, бо роль без членства в ролі запиту `roles` потім не
 * виправив би (наявну лише звіряє).
 */
export async function projectRoleSet(
  dir: string
): Promise<
  | { ok: true; roles: PlatformRoleSet; skipped: SkippedRole[] }
  | { ok: false; diagnostics: Diagnostic[] }
> {
  // Теки немає — файлу проєкту теж: ролі грантів від моделі не залежать
  const text = existsSync(dir)
    ? (await readMetadataDir(dir)).get(PROJECT_FILE)
    : undefined
  if (text === undefined)
    return {
      ok: true,
      roles: platformRoleSet(undefined),
      skipped: [
        { name: PLATFORM_LOGIN_ROLES.runtime, reason: "no-project-file" },
      ],
    }
  const read = readProjectFile(text)
  if (read.project === undefined)
    return { ok: false, diagnostics: read.diagnostics }
  return {
    ok: true,
    roles: platformRoleSet(read.project.database.provider),
    skipped: [],
  }
}

/**
 * Платформні ролі кластерні, тож у бажаному стані бази їх немає, і план їх
 * не створює (спека П4 §6.2, спека designer §3.2): їх створює окремий крок з правом
 * `CREATEROLE`. Ролі грантів задає платформа; файл проєкту потрібен лише
 * ролі входу — її членство в ролі запиту залежить від провайдера.
 */
export const rolesTool = defineTool({
  name: "roles",
  description:
    "Create the platform roles: NOLOGIN roles that generated SQL grants to on the target and the shadow server, and the runtime login role on the target only. Reads the project file for `database.provider`; without a project file the login role is skipped, and the output says so. An existing role is only checked. Needs CREATEROLE, and ADMIN OPTION on every parent role of the login role; refuses before creating anything when a server lacks CREATEROLE or a role has an unsafe shape.",
  input: z.strictObject({}),
  files: "read",
  database: "write",
  destructive: false,
  async run({ dir, database }) {
    const set = await projectRoleSet(dir)
    if (!set.ok) return { ok: false, changes: [], diagnostics: set.diagnostics }
    const { createApplyDatabase } = await import("../schema-engine")
    const ran = await withDatabase(required(database), "roles", (db) =>
      ensurePlatformRoles(
        createApplyDatabase({ readOnly: false }),
        [
          { server: "target", db: db.target },
          ...(db.shadowBase === undefined
            ? []
            : [{ server: "shadow" as const, db: db.shadowBase }]),
        ],
        set.roles
      )
    )
    if (!ran.ok)
      return { ok: false, changes: [], diagnostics: [ran.diagnostic] }
    const data: RolesData = { roles: ran.value.created, skipped: set.skipped }
    // Відмова ролі входу (`roles.admin-option-missing`) приходить разом зі
    // створеними ролями грантів: показуються обидва
    return {
      ok: ran.value.refusal === undefined,
      changes: [],
      diagnostics: (ran.value.refusal ?? []).map(fromEngine),
      data,
    }
  },
})
