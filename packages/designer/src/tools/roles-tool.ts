import { existsSync } from "node:fs"
import { diagnostic, readProjectFile, type Diagnostic } from "simetra/compiler"
import { PLATFORM_LOGIN_ROLES, type DatabaseProvider } from "simetra/model"
import {
  ensurePlatformRoles,
  ensurePostgresCluster,
  platformRoleSet,
  postgresClusterSet,
  type ApplyDatabase,
  type PlatformRoleOutcome,
  type PlatformRoleSet,
} from "simetra/schema"
import { z } from "zod"
import { withDatabase } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { fromEngine, required } from "./database-tools"
import { defineTool, type DatabaseContext } from "./types"

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

/** Набір ролей теки проєкту й провайдер, з якого його складено. */
export interface ProjectRoles {
  /** `undefined` — файлу проєкту немає. */
  provider: DatabaseProvider | undefined
  roles: PlatformRoleSet
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
  | ({ ok: true; skipped: SkippedRole[] } & ProjectRoles)
  | { ok: false; diagnostics: Diagnostic[] }
> {
  // Теки немає — файлу проєкту теж: ролі грантів від моделі не залежать
  const text = existsSync(dir)
    ? (await readMetadataDir(dir)).get(PROJECT_FILE)
    : undefined
  if (text === undefined)
    return {
      ok: true,
      provider: undefined,
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
    provider: read.project.database.provider,
    roles: platformRoleSet(read.project.database.provider),
    skipped: [],
  }
}

/** Ім'я бази з адреси цілі; порожнє, коли адреса бази не називає. */
function databaseOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""))
  } catch {
    return ""
  }
}

/**
 * Готує ролі (і, у профілі `postgres`, кластер) за провайдером проєкту.
 * `postgres` готує суперкористувач через службову базу того самого сервера,
 * ціль і шаблон (рішення Р5); окремий сервер тіней там не підтримано (Р9).
 * Решта провайдерів і проєкт без файлу — ролі на цілі й на сервері тіні.
 */
export async function runRoles(
  dbs: ApplyDatabase,
  db: DatabaseContext,
  project: ProjectRoles
): Promise<{ roles: PlatformRoleOutcome[]; diagnostics: Diagnostic[] }> {
  if (project.provider === "postgres") {
    if (db.shadowBase !== undefined)
      return {
        roles: [],
        diagnostics: [diagnostic("plan.shadow-base-unsupported", "", "")],
      }
    const database = databaseOf(db.target.url)
    if (database === "")
      return {
        roles: [],
        diagnostics: [
          diagnostic("database.failed", "", "", {
            tool: "roles",
            database: db.describe,
            error: "the database address names no database",
          }),
        ],
      }
    const set = postgresClusterSet(database)
    // pg-delta тягнеться лише тут: запуск без цієї гілки його не вантажить
    const { withDatabaseName } = await import("@supabase/pg-delta")
    const result = await ensurePostgresCluster(
      dbs,
      {
        maintenance: { url: withDatabaseName(db.target.url, "postgres") },
        target: db.target,
        template: { url: withDatabaseName(db.target.url, set.template) },
      },
      set
    )
    if (!result.ok)
      return { roles: [], diagnostics: result.error.map(fromEngine) }
    const outcome = (names: string[], kind: "created" | "present") =>
      names.map((name) => ({ server: "target" as const, name, outcome: kind }))
    return {
      roles: [
        ...outcome(result.value.created, "created"),
        ...outcome(result.value.present, "present"),
      ],
      diagnostics: [],
    }
  }
  const ran = await ensurePlatformRoles(
    dbs,
    [
      { server: "target", db: db.target },
      ...(db.shadowBase === undefined
        ? []
        : [{ server: "shadow" as const, db: db.shadowBase }]),
    ],
    project.roles
  )
  // Відмова ролі входу (`roles.admin-option-missing`) приходить разом зі
  // створеними ролями грантів: показуються обидва
  return {
    roles: ran.created,
    diagnostics: (ran.refusal ?? []).map(fromEngine),
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
    "Create the platform roles: NOLOGIN roles that generated SQL grants to on the target and the shadow server, and the runtime login role on the target only. Reads the project file for `database.provider`; without a project file the login role is skipped, and the output says so. An existing role is only checked. Needs CREATEROLE, and ADMIN OPTION on every parent role of the login role; refuses before creating anything when a server lacks CREATEROLE or a role has an unsafe shape. With the provider `postgres` it prepares the cluster instead, as a superuser (the database URL is a superuser URL of the target database): the owner, auth, grant and request roles, the target database owned by the owner, the schemas `extensions` and `better_auth`, `plpgsql_check`, and the sealed template database for shadows. It refuses before writing when the session is not a superuser, an existing database or role has an unsafe shape, or a Simetra login role can connect to another database; a separate shadow server is not supported there.",
  input: z.strictObject({}),
  files: "read",
  database: "write",
  data: "none",
  destructive: false,
  async run({ dir, database }) {
    const set = await projectRoleSet(dir)
    if (!set.ok) return { ok: false, changes: [], diagnostics: set.diagnostics }
    const { createApplyDatabase } = await import("../schema-engine")
    const ran = await withDatabase(required(database), "roles", (db) =>
      runRoles(createApplyDatabase({ readOnly: false }), db, set)
    )
    if (!ran.ok)
      return { ok: false, changes: [], diagnostics: [ran.diagnostic] }
    const data: RolesData = { roles: ran.value.roles, skipped: set.skipped }
    return {
      ok: ran.value.diagnostics.length === 0,
      changes: [],
      diagnostics: ran.value.diagnostics,
      data,
    }
  },
})
