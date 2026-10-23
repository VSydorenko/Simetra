import { PLATFORM_ROLES } from "simetra/model"
import { ensurePlatformRoles, type RoleServer } from "simetra/schema"
import { z } from "zod"
import { withDatabase } from "../io/database"
import { fromEngine, required } from "./database-tools"
import { defineTool } from "./types"

export interface RolesData {
  roles: { server: RoleServer; name: string; outcome: "created" | "present" }[]
}

/**
 * Платформні ролі кластерні, тож у бажаному стані бази їх немає, і план їх
 * не створює (Р2a1-1, Р2a1-3): їх створює окремий крок з правом
 * `CREATEROLE`. Метаданих інструмент не читає — потрібні ролі задає
 * платформа, а не модель.
 */
export const rolesTool = defineTool({
  name: "roles",
  description:
    "Create the platform's cluster roles that generated SQL grants to (NOLOGIN NOINHERIT) on the target and on the shadow server; an existing role is only checked. Needs CREATEROLE; refuses before creating anything when a server lacks it or a role has an unsafe shape. Does not read metadata.",
  input: z.strictObject({}),
  files: "read",
  database: "write",
  destructive: false,
  async run({ database }) {
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
        Object.values(PLATFORM_ROLES)
      )
    )
    if (!ran.ok)
      return { ok: false, changes: [], diagnostics: [ran.diagnostic] }
    if ("refusal" in ran.value)
      return {
        ok: false,
        changes: [],
        diagnostics: ran.value.refusal.map(fromEngine),
      }
    return {
      ok: true,
      changes: [],
      diagnostics: [],
      data: { roles: ran.value },
    }
  },
})
