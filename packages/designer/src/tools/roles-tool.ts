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
  type PostgresClusterOutcome,
} from "simetra/schema"
import { z } from "zod"
import { failureDiagnostics, withDatabase } from "../io/database"
import { readMetadataDir } from "../io/metadata-dir"
import { fromEngine, required } from "./database-tools"
import { defineTool, type DatabaseContext, type RunOutcome } from "./types"

const PROJECT_FILE = "project.meta.json"

/**
 * Що `roles` свідомо не зробив, і чому: роль входу без файлу проєкту чи
 * грант на таблицю ідентичності, якої ще немає (ім'я — `<схема>.<таблиця>:TRIGGER`).
 */
export interface SkippedRole {
  name: string
  reason: "no-project-file" | "identity-table-missing"
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
 * читачем, що й `compile`. Без файлу ролі входу пропускаються явно — пропуск
 * видно у виводі, бо без провайдера невідомо, членом яких ролей запиту
 * роль рантайму мусить бути.
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
      // Пропущено кожну роль входу: без провайдера `roles` не створює жодної
      skipped: Object.values(PLATFORM_LOGIN_ROLES).map((name) => ({
        name,
        reason: "no-project-file" as const,
      })),
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
 * Підсумок підготовки кластера як рядки інструмента: створене й наявне — за іменем, а
 * доповнене членство — на рядку самої ролі входу (`present` з `added`), а не
 * окремою «роллю».
 */
export function clusterRoles(
  value: PostgresClusterOutcome
): PlatformRoleOutcome[] {
  const outcome = (
    names: string[],
    kind: "created" | "present"
  ): PlatformRoleOutcome[] =>
    names.map((name) => {
      const parents = value.added?.find((a) => a.role === name)?.parents
      return {
        server: "target" as const,
        name,
        outcome: kind,
        ...(parents === undefined ? {} : { added: parents }),
      }
    })
  return [
    ...outcome(value.created, "created"),
    ...outcome(value.present, "present"),
  ]
}

/**
 * Готує ролі (і, у профілі `postgres`, кластер) за провайдером проєкту.
 * `postgres` готує суперкористувач через службову базу того самого сервера,
 * ціль і шаблон; окремий сервер тіней там не підтримано.
 * Решта провайдерів і проєкт без файлу — ролі на цілі й на сервері тіні.
 */
export async function runRoles(
  dbs: ApplyDatabase,
  db: DatabaseContext,
  project: ProjectRoles
): Promise<{
  roles: PlatformRoleOutcome[]
  skipped: SkippedRole[]
  diagnostics: Diagnostic[]
}> {
  if (project.provider === "postgres") {
    if (db.shadowBase !== undefined)
      return {
        roles: [],
        skipped: [],
        diagnostics: [diagnostic("plan.shadow-base-unsupported", "", "")],
      }
    const database = databaseOf(db.target.url)
    if (database === "")
      return {
        roles: [],
        skipped: [],
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
      return {
        roles: [],
        skipped: [],
        diagnostics: result.error.map(fromEngine),
      }
    return {
      roles: clusterRoles(result.value),
      skipped: result.value.skipped.map((name) => ({
        name,
        reason: "identity-table-missing" as const,
      })),
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
  // Відмова ролі входу (`roles.admin-option-missing`,
  // `roles.membership-grant-denied`) приходить разом зі створеними ролями
  // грантів та іншими ролями входу (Р21): показуються обидва
  return {
    roles: ran.created,
    skipped: [],
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
    "Create the platform roles: NOLOGIN roles that generated SQL grants to on the target and the shadow server, and the login roles (the runtime and the signals consumer) on the target only, each a member of its parents WITH INHERIT FALSE, SET TRUE; the signals login role also gets a role setting (ALTER ROLE … SET) that makes its consumer group the role of every new session. Reads the project file for `database.provider`; without a project file the login roles are skipped, and the output says so. An existing role is only checked, its role setting included; the one change it makes is to add a missing membership of an existing login role in a parent of its profile, WITH INHERIT FALSE, SET TRUE, and the output names it. Needs CREATEROLE, and ADMIN OPTION on every parent role of a login role (without it that login role alone is refused, a missing membership with the GRANT statement to run); refuses before creating anything when a server lacks CREATEROLE or a role has an unsafe shape. With the provider `postgres` it prepares the cluster instead, as a superuser (the database URL is a superuser URL of the target database): the owner, auth, grant and request roles, the target database owned by the owner, the schemas `extensions` and `better_auth`, `plpgsql_check`, and the sealed template database for shadows. It refuses before writing when the session is not a superuser, an existing database or role has an unsafe shape, or a Simetra login role can connect to another database; a separate shadow server is not supported there.",
  input: z.strictObject({}),
  files: "read",
  database: "write",
  data: "none",
  destructive: false,
  async run({ dir, database }): Promise<RunOutcome<RolesData, "read">> {
    const set = await projectRoleSet(dir)
    if (!set.ok) return { ok: false, changes: [], diagnostics: set.diagnostics }
    const { createApplyDatabase } = await import("../schema-engine")
    const ran = await withDatabase(required(database), "roles", (db) =>
      runRoles(createApplyDatabase({ readOnly: false }), db, set)
    )
    if (!ran.ok)
      return { ok: false, changes: [], diagnostics: failureDiagnostics(ran) }
    const data: RolesData = {
      roles: ran.value.roles,
      skipped: [...set.skipped, ...ran.value.skipped],
    }
    return {
      ok: ran.value.diagnostics.length === 0,
      changes: [],
      diagnostics: ran.value.diagnostics,
      data,
    }
  },
  present: {
    // Лише термінал: MCP показує загальні рядки, структура — у `structuredContent`
    text: (data, v) =>
      data === undefined || v.channel === "mcp"
        ? undefined
        : [
            ...data.roles.map(
              (x) =>
                `${x.server}: ${x.name} ${x.outcome}${x.added === undefined ? "" : `; added membership in ${x.added.join(", ")}`}`
            ),
            // Пропуск ролі входу не мовчазний: без провайдера невідомо,
            // членом якої ролі запиту вона мусить бути
            ...data.skipped.map((x) => {
              if (x.reason === "no-project-file")
                return `target: ${x.name} skipped: the directory has no project.meta.json, so database.provider is unknown; run roles in a metadata directory with a project file to create it`
              // Ім'я пропуску — `<таблиця>:<привілей>`; ім'я таблиці двокрапки не має
              const at = x.name.lastIndexOf(":")
              return `target: ${x.name.slice(0, at)}: ${x.name.slice(at + 1)} not granted yet — run the Better Auth migration, then simetra roles again`
            }),
            ...(v.diagnostics.length > 0 ? [v.report] : []),
          ].join("\n"),
  },
})
