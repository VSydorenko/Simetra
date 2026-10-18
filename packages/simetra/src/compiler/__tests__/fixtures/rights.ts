import { compile, type CompileResult } from "simetra/compiler"
import { metaFiles, uuid } from "../helpers"

/**
 * Синтетичний проєкт прав для тестів плану прав: вид скоупу `org`,
 * «Користувачі», членство, довідники `Project`, `Region`, `TaskComment`,
 * документ `Task` і зв'язок `MemberRegion`. Типові файли навмисно не мають
 * жодного поля прав: кожен тест задає їх явним перевизначенням, тож точні
 * перевірки одних тестів не ламаються, коли інші додають поля.
 */

export const ORG_KIND_ID = uuid(6001)
export const TASK_ID = uuid(6010)
export const PROJECT_ID = uuid(6020)
export const MEMBER_REGION_ID = uuid(6030)

export const TASK_FILE = "documents/Task/Task.meta.json"
export const PROJECT_CATALOG_FILE = "catalogs/Project/Project.meta.json"
export const COMMENT_FILE = "catalogs/TaskComment/TaskComment.meta.json"
export const MEMBER_FILE = "catalogs/OrgMember/OrgMember.meta.json"

const ref = (kind: string, name: string) => ({ kind, name })

function refAttribute(
  id: number,
  name: string,
  physicalName: string,
  target: { kind: string; name: string }
) {
  return { id: uuid(id), name, physicalName, type: "Ref", ref: target }
}

function catalog(
  id: string,
  name: string,
  physicalName: string,
  rest: Record<string, unknown> = {}
) {
  return {
    id,
    kind: "Catalog",
    name,
    physicalName,
    kindLabel: physicalName,
    scope: "org",
    ...rest,
  }
}

function defaults(): Record<string, Record<string, unknown>> {
  return {
    "project.meta.json": {
      name: "RightsApp",
      database: { provider: "supabase" },
      scopeKinds: [
        {
          id: ORG_KIND_ID,
          name: "org",
          physicalName: "org_id",
          root: { object: ref("Catalog", "Organization") },
          setFunction: "membership",
        },
      ],
    },
    "catalogs/Organization/Organization.meta.json": catalog(
      uuid(6002),
      "Organization",
      "organization"
    ),
    "catalogs/Users/Users.meta.json": catalog(uuid(6003), "Users", "users", {
      role: "users",
      scope: "none",
    }),
    [MEMBER_FILE]: catalog(uuid(6004), "OrgMember", "org_member", {
      membership: { user: "user" },
      attributes: [
        refAttribute(6005, "user", "user_id", ref("Catalog", "Users")),
      ],
    }),
    [PROJECT_CATALOG_FILE]: catalog(PROJECT_ID, "Project", "project"),
    "catalogs/Region/Region.meta.json": catalog(uuid(6040), "Region", "region"),
    [TASK_FILE]: {
      id: TASK_ID,
      kind: "Document",
      name: "Task",
      physicalName: "task",
      kindLabel: "task",
      scope: "org",
      trackAuthor: true,
      attributes: [
        refAttribute(
          6011,
          "assignee",
          "assignee_id",
          ref("Catalog", "OrgMember")
        ),
        refAttribute(6012, "project", "project_id", ref("Catalog", "Project")),
        refAttribute(6013, "region", "region_id", ref("Catalog", "Region")),
      ],
    },
    "information-registers/MemberRegion/MemberRegion.meta.json": {
      id: MEMBER_REGION_ID,
      kind: "InformationRegister",
      name: "MemberRegion",
      physicalName: "member_region",
      kindLabel: "member_region",
      scope: "org",
      dimensions: [
        refAttribute(6031, "member", "member_id", ref("Catalog", "OrgMember")),
        refAttribute(6032, "region", "region_id", ref("Catalog", "Region")),
      ],
    },
    [COMMENT_FILE]: catalog(uuid(6050), "TaskComment", "task_comment", {
      attributes: [
        refAttribute(6051, "task", "task_id", ref("Document", "Task")),
      ],
    }),
  }
}

/**
 * Файли проєкту прав. Перевизначення зливається з типовим файлом за шляхом
 * на верхньому рівні ключів: тест додає поле прав, не повторюючи решти файлу.
 * Шлях без типового файлу додає новий файл.
 */
export function rightsFiles(
  overrides: Record<string, Record<string, unknown>> = {}
): Map<string, string> {
  const files = defaults()
  for (const [path, fields] of Object.entries(overrides)) {
    files[path] = { ...files[path], ...fields }
  }
  return metaFiles(files)
}

export function compileRights(
  files: ReadonlyMap<string, string>
): Promise<CompileResult> {
  return compile(files)
}
