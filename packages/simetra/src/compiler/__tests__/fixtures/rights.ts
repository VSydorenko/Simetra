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
export const PROJECT_FILE = "project.meta.json"

export const TASK_EDITORS_ID = uuid(6201)
export const TASK_READERS_ID = uuid(6202)
export const ORG_ADMIN_ID = uuid(6210)
export const ORG_MEMBER_ROLE_ID = uuid(6211)
export const PROJECT_LEAD_ID = uuid(6212)
export const SUPPORT_ID = uuid(6213)
export const EVERYONE_ID = uuid(6214)

export const USERS_FILE = "catalogs/Users/Users.meta.json"
export const REGION_FILE = "catalogs/Region/Region.meta.json"
export const ANNOUNCEMENT_ID = uuid(6090)
export const ANNOUNCEMENT_FILE = "documents/Announcement/Announcement.meta.json"
export const REGION_DIMENSION_ID = uuid(6060)
export const STATUS_FILE = "enumerations/Status/Status.meta.json"

export const ROLE_FILE = (name: string) => `roles/${name}/${name}.meta.json`
export const SET_FILE = (name: string) =>
  `rights-sets/${name}/${name}.meta.json`

export const ORG_ROLES_ID = uuid(6230)
export const ORG_ASSIGNMENTS_ID = uuid(6231)
export const GLOBAL_ROLES_ID = uuid(6232)
export const GLOBAL_ASSIGNMENTS_ID = uuid(6233)
export const ORG_ROLES_FILE = "catalogs/OrgRoles/OrgRoles.meta.json"
export const ORG_ASSIGNMENTS_FILE =
  "catalogs/OrgRoleAssignments/OrgRoleAssignments.meta.json"
export const GLOBAL_ROLES_FILE = "catalogs/GlobalRoles/GlobalRoles.meta.json"
export const GLOBAL_ASSIGNMENTS_FILE =
  "catalogs/GlobalRoleAssignments/GlobalRoleAssignments.meta.json"

export const GRANT_FILE = "custom-tables/RoleGrant/RoleGrant.meta.json"
const GRANT_ID = uuid(6110)
export const GRANTS_SOURCE_ID = uuid(6121)
export const GLOBAL_GRANTS_SOURCE_ID = uuid(6123)

export const MEMBERSHIP_FILE = "custom-tables/Membership/Membership.meta.json"
export const MEMBERSHIP_ID = uuid(6100)
export const MEMBERS_SOURCE_ID = uuid(6120)
export const MEMBER_REGION_FILE =
  "information-registers/MemberRegion/MemberRegion.meta.json"
export const TEAM_KIND_ID = uuid(6008)

const ref = (kind: string, name: string) => ({ kind, name })

function refAttribute(
  id: number,
  name: string,
  physicalName: string,
  target: { kind: string; name: string }
) {
  return { id: uuid(id), name, physicalName, type: "Ref", ref: target }
}

/** Довідник фікстури у виді `org`; `rest` перевизначає поля. */
export function catalog(
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

/** Вид скоупу `org` фікстури: членство дає довідник `OrgMember`. */
const ORG_SCOPE_KIND = {
  id: ORG_KIND_ID,
  name: "org",
  physicalName: "org_id",
  root: { object: ref("Catalog", "Organization") },
  setFunction: "membership",
}

function defaults(): Record<string, Record<string, unknown>> {
  return {
    "project.meta.json": {
      name: "RightsApp",
      database: { provider: "supabase" },
      scopeKinds: [ORG_SCOPE_KIND],
    },
    "catalogs/Organization/Organization.meta.json": catalog(
      uuid(6002),
      "Organization",
      "organization"
    ),
    [USERS_FILE]: catalog(uuid(6003), "Users", "users", {
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
    [REGION_FILE]: catalog(uuid(6040), "Region", "region"),
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
    [MEMBER_REGION_FILE]: {
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

function column(id: number, name: string, physicalName: string, type: string) {
  return { id: uuid(id), name, physicalName, type, notNull: true }
}

/** Прийнята таблиця призначень: учасник, ключ ролі й контейнер-проєкт. */
export function grantTable(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANT_ID,
    kind: "CustomTable",
    name: "RoleGrant",
    physicalName: "role_grant",
    kindLabel: "role_grant",
    scope: "none",
    columns: [
      column(6111, "id", "id", "UUID"),
      column(6112, "memberId", "member_id", "UUID"),
      column(6113, "roleKey", "role_key", "Text"),
      column(6114, "projectId", "project_id", "UUID"),
    ],
    primaryKey: { columns: ["id"] },
    ...overrides,
  }
}

/** Джерело призначень контейнерного рівня `Project` над `RoleGrant`. */
export function grantsSource(overrides: Record<string, unknown> = {}) {
  return {
    id: GRANTS_SOURCE_ID,
    name: "grants",
    assignedOn: { container: ref("Catalog", "Project") },
    table: ref("CustomTable", "RoleGrant"),
    columns: { member: "memberId", role: "roleKey", container: "projectId" },
    ...overrides,
  }
}

export function rightsSet(
  id: string,
  name: string,
  rest: Record<string, unknown> = {}
) {
  return { id, kind: "RightsSet", name, ...rest }
}

export function role(
  id: string,
  name: string,
  assignedOn: unknown,
  rest: Record<string, unknown> = {}
) {
  return { id, kind: "Role", name, assignedOn, ...rest }
}

const ANNOUNCEMENT = {
  id: ANNOUNCEMENT_ID,
  kind: "Document",
  name: "Announcement",
  physicalName: "announcement",
  kindLabel: "announcement",
  scope: "none",
}

/**
 * Набори й ролі кожного рівня — перевизначення для `rightsFiles`, а не
 * типові файли: тести планів 1a їх не бачать. `OrgMember` включає
 * `TaskEditors`, а той — `TaskReaders`, тож замикання включень має два
 * кроки. Контейнерна роль вимагає прапорця контейнера на `Project`.
 * Нескоуплений документ `Announcement` має `post`, якого рівень скоупу на
 * ньому не дає (Р1b-1). Грантів типові ролі й набори не мають.
 * Системні довідники прав — по одному на (роль, рівень) для рівнів `org` і
 * глобального (Р2a1-5); вони мають лише `read` і поза селекторами (Р2a1-8),
 * тож рядків проєкції інших тестів не змінюють.
 */
export function rolesAndSets(): Record<string, Record<string, unknown>> {
  return {
    ...systemCatalogs("org"),
    ...systemCatalogs("none"),
    [ANNOUNCEMENT_FILE]: ANNOUNCEMENT,
    [SET_FILE("TaskReaders")]: rightsSet(TASK_READERS_ID, "TaskReaders"),
    [SET_FILE("TaskEditors")]: rightsSet(TASK_EDITORS_ID, "TaskEditors", {
      include: [ref("RightsSet", "TaskReaders")],
    }),
    [ROLE_FILE("OrgAdmin")]: role(
      ORG_ADMIN_ID,
      "OrgAdmin",
      { scopeKind: "org" },
      { fullAccess: true }
    ),
    [ROLE_FILE("OrgMember")]: role(
      ORG_MEMBER_ROLE_ID,
      "OrgMember",
      { scopeKind: "org" },
      { include: [ref("RightsSet", "TaskEditors")] }
    ),
    [ROLE_FILE("ProjectLead")]: role(PROJECT_LEAD_ID, "ProjectLead", {
      container: ref("Catalog", "Project"),
    }),
    [ROLE_FILE("Support")]: role(SUPPORT_ID, "Support", "global"),
    [ROLE_FILE("Everyone")]: role(EVERYONE_ID, "Everyone", "everyUser"),
    [PROJECT_CATALOG_FILE]: { rightsContainer: true },
  }
}

/** Довідники «Ролі» й «Призначення ролей» рівня: `org` чи глобального. */
function systemCatalogs(
  scope: "org" | "none"
): Record<string, Record<string, unknown>> {
  const [prefix, rolesFile, rolesId, assignmentsFile, assignmentsId] =
    scope === "org"
      ? ([
          "org",
          ORG_ROLES_FILE,
          ORG_ROLES_ID,
          ORG_ASSIGNMENTS_FILE,
          ORG_ASSIGNMENTS_ID,
        ] as const)
      : ([
          "global",
          GLOBAL_ROLES_FILE,
          GLOBAL_ROLES_ID,
          GLOBAL_ASSIGNMENTS_FILE,
          GLOBAL_ASSIGNMENTS_ID,
        ] as const)
  const name = prefix === "org" ? "Org" : "Global"
  return {
    [rolesFile]: systemCatalog(
      rolesId,
      `${name}Roles`,
      `${prefix}_roles`,
      "rightsRoles",
      scope
    ),
    [assignmentsFile]: systemCatalog(
      assignmentsId,
      `${name}RoleAssignments`,
      `${prefix}_role_assignments`,
      "roleAssignments",
      scope
    ),
  }
}

/** Системний довідник прав (Р2a1-5) з роллю й рівнем — власним скоупом. */
export function systemCatalog(
  id: string,
  name: string,
  physicalName: string,
  role: "rightsRoles" | "roleAssignments",
  scope: string
) {
  return catalog(id, name, physicalName, { role, scope })
}

/** Шар перевизначень: `null` прибирає файл з проєкту. */
export type Layer = Record<string, Record<string, unknown> | null>

/** Шар, що прибирає файли за шляхами. */
export const without = (...paths: string[]): Layer =>
  Object.fromEntries(paths.map((path) => [path, null]))

/**
 * Ролі й набори фікстури з шарами перевизначень: кожен шар зливається з
 * файлом за шляхом на верхньому рівні ключів, пізніший — поверх раннього;
 * `null` прибирає файл.
 */
export function withRoles(...layers: Layer[]): Map<string, string> {
  const merged = rolesAndSets()
  const removed = new Set<string>()
  for (const layer of layers) {
    for (const [path, fields] of Object.entries(layer)) {
      if (fields === null) {
        delete merged[path]
        removed.add(path)
      } else {
        merged[path] = { ...merged[path], ...fields }
        removed.delete(path)
      }
    }
  }
  const files = rightsFiles(merged)
  // Типові файли `rightsFiles` теж можна прибрати: шар знає лише шлях.
  for (const path of removed) files.delete(path)
  return files
}

/**
 * Другий вид скоупу `team` без членства: зовнішній корінь і дослівна функція
 * множини, тож проєкт компілюється без довідника членства виду.
 */
export function teamScopeKind(): Layer {
  return {
    [PROJECT_FILE]: {
      scopeKinds: [
        ORG_SCOPE_KIND,
        {
          id: TEAM_KIND_ID,
          name: "team",
          physicalName: "team_id",
          root: {
            external: { schema: "public", table: "teams", column: "id" },
          },
          setFunction: { schema: "public", name: "team_ids" },
        },
      ],
    },
  }
}

/** Прийнята таблиця членства виду `org`; `uniques` дає `UNIQUE (scope, id)`. */
export function membershipTable(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBERSHIP_ID,
    kind: "CustomTable",
    name: "Membership",
    physicalName: "membership",
    kindLabel: "membership",
    scope: "org",
    columns: [
      column(6101, "id", "id", "UUID"),
      column(6102, "orgId", "org_id", "UUID"),
      column(6103, "userId", "user_id", "UUID"),
      column(6104, "isActive", "is_active", "Boolean"),
    ],
    primaryKey: { columns: ["id"] },
    uniques: [{ columns: ["orgId", "id"] }],
    scopeColumn: "orgId",
    ...overrides,
  }
}

/** Прийняте джерело членства виду `org` над `Membership`. */
export function membersSource(overrides: Record<string, unknown> = {}) {
  return {
    id: MEMBERS_SOURCE_ID,
    name: "members",
    scopeKind: "org",
    table: ref("CustomTable", "Membership"),
    columns: { scope: "orgId", user: "userId", active: "isActive" },
    ...overrides,
  }
}

/**
 * Шар: членство виду `org` дає прийнята таблиця, а не `OrgMember` (Р1a-17).
 * Функція множини — дослівна; довідник членства й зв'язок над ним прибрано,
 * виконавець задачі посилається на прийняту таблицю. Саме джерело членства
 * тест додає сам — разом з іншими полями проєкту.
 */
export function adoptedMembership(): Layer {
  return {
    [PROJECT_FILE]: {
      scopeKinds: [
        {
          ...ORG_SCOPE_KIND,
          setFunction: { schema: "public", name: "org_ids" },
        },
      ],
    },
    [TASK_FILE]: {
      attributes: [
        refAttribute(
          6011,
          "assignee",
          "assignee_id",
          ref("CustomTable", "Membership")
        ),
      ],
    },
    [MEMBERSHIP_FILE]: membershipTable(),
    ...without(MEMBER_FILE, MEMBER_REGION_FILE),
  }
}

/** Джерело призначень глобального рівня над `RoleGrant`. */
export function globalGrantsSource() {
  return grantsSource({
    id: GLOBAL_GRANTS_SOURCE_ID,
    name: "globalGrants",
    assignedOn: "global",
    columns: { member: "memberId", role: "roleKey" },
  })
}

/**
 * Однотенантний проєкт прав: без видів скоупу, «Користувачі», контейнер
 * `Project`, задача з прив'язкою до нього, контейнерна роль `ProjectLead` з
 * `read@any` на задачі й глобальні системні довідники — контейнерні
 * призначення без виду скоупу лежать у глобальному довіднику (Р2a1-7).
 * Перевизначення зливається з файлом за шляхом, як у `rightsFiles`.
 */
export function singleTenantRights(
  overrides: Record<string, Record<string, unknown>> = {}
): Map<string, string> {
  const files: Record<string, Record<string, unknown>> = {
    "project.meta.json": {
      name: "SingleTenantRights",
      database: { provider: "supabase" },
    },
    [USERS_FILE]: catalog(uuid(6003), "Users", "users", {
      role: "users",
      scope: "none",
    }),
    [PROJECT_CATALOG_FILE]: catalog(PROJECT_ID, "Project", "project", {
      scope: "none",
      rightsContainer: true,
    }),
    [TASK_FILE]: {
      id: TASK_ID,
      kind: "Document",
      name: "Task",
      physicalName: "task",
      kindLabel: "task",
      scope: "none",
      containerBinding: "project",
      attributes: [
        refAttribute(6012, "project", "project_id", ref("Catalog", "Project")),
      ],
    },
    [ROLE_FILE("ProjectLead")]: role(
      PROJECT_LEAD_ID,
      "ProjectLead",
      { container: ref("Catalog", "Project") },
      { grants: [grant(objects(["Document", "Task"]), ["read"], "any")] }
    ),
    ...systemCatalogs("none"),
  }
  for (const [path, fields] of Object.entries(overrides)) {
    files[path] = { ...files[path], ...fields }
  }
  return metaFiles(files)
}

/** Вимір `region`: значення учасника — рядки зв'язку `MemberRegion`. */
export function regionDimension() {
  return {
    id: REGION_DIMENSION_ID,
    name: "region",
    target: ref("Catalog", "Region"),
    values: {
      relation: {
        object: ref("InformationRegister", "MemberRegion"),
        subject: "member",
        value: "region",
      },
    },
  }
}

/** Перерахування — вид без контракту прав. */
export function statusEnumeration() {
  return {
    id: uuid(6100),
    kind: "Enumeration",
    name: "Status",
    physicalName: "status",
    values: [{ id: uuid(6101), name: "Open", physicalName: "open" }],
  }
}

export const objects = (...refs: [kind: string, name: string][]) =>
  refs.map(([kind, name]) => ref(kind, name))

export const grant = (
  objects: unknown,
  actions: string[],
  extent: unknown
) => ({
  grant: { objects, actions, extent },
})

export const grantAll = (extent: unknown) => ({ grantAll: { extent } })

export const deny = (
  objects: unknown,
  actions: string[],
  extent?: unknown
) => ({
  deny: { objects, actions, ...(extent === undefined ? {} : { extent }) },
})

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
