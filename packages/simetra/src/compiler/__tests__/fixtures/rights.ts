import {
  applyChanges,
  compile,
  promoteInput,
  promoteObject,
  type CompileResult,
  type PromoteInput,
} from "simetra/compiler"
import { SCOPE_FUNCTIONS_FILE, acceptDebt, metaFiles, uuid } from "../helpers"

/**
 * Синтетичний проєкт прав для тестів контракту прав: вид скоупу `org`,
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
export const ORGANIZATION_FILE = "catalogs/Organization/Organization.meta.json"

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

export function refAttribute(
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
export const ORG_SCOPE_KIND = {
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
    [ORGANIZATION_FILE]: catalog(uuid(6002), "Organization", "organization"),
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

/** Колонка без `NOT NULL`: fail-closed гілки джерел доводяться на `NULL`. */
function nullable(
  id: number,
  name: string,
  physicalName: string,
  type: string
) {
  return { ...column(id, name, physicalName, type), notNull: false }
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
 * типові файли: тести контракту прав їх не бачать. `OrgMember` включає
 * `TaskEditors`, а той — `TaskReaders`, тож замикання включень має два
 * кроки. Контейнерна роль вимагає прапорця контейнера на `Project`.
 * Нескоуплений документ `Announcement` має `post`, якого рівень скоупу на
 * ньому не дає (спека прав Рх7). Грантів типові ролі й набори не мають.
 * Системні довідники прав — по одному на (роль, рівень) для рівнів `org` і
 * глобального (спека прав §4.6); вони мають лише `read` і поза селекторами (спека прав §4.6),
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

/** Системний довідник прав (спека прав §4.6) з роллю й рівнем — власним скоупом. */
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

export const TEAM_ROLES_FILE = "catalogs/TeamRoles/TeamRoles.meta.json"
export const TEAM_ASSIGNMENTS_FILE =
  "catalogs/TeamRoleAssignments/TeamRoleAssignments.meta.json"
export const TEAM_LEAD_ID = uuid(6410)

/**
 * Другий вид скоупу `team` з власним членством: корінь `Team`, учасники
 * `TeamMember`, системні довідники прав `TeamRoles`/`TeamRoleAssignments`,
 * довідник `TeamNote` і роль `TeamLead` з `read@any` на ньому. Так один
 * проєкт має два види скоупу, кожен зі своїми рівнем прав і учасниками.
 */
export function secondScopeKind(): Layer {
  return {
    [PROJECT_FILE]: {
      scopeKinds: [
        ORG_SCOPE_KIND,
        {
          id: TEAM_KIND_ID,
          name: "team",
          physicalName: "team_id",
          root: { object: ref("Catalog", "Team") },
          setFunction: "membership",
        },
      ],
    },
    "catalogs/Team/Team.meta.json": catalog(uuid(6400), "Team", "team", {
      scope: "team",
    }),
    "catalogs/TeamMember/TeamMember.meta.json": catalog(
      uuid(6401),
      "TeamMember",
      "team_member",
      {
        scope: "team",
        membership: { user: "user" },
        attributes: [
          refAttribute(6402, "user", "user_id", ref("Catalog", "Users")),
        ],
      }
    ),
    "catalogs/TeamNote/TeamNote.meta.json": catalog(
      uuid(6403),
      "TeamNote",
      "team_note",
      { scope: "team" }
    ),
    [TEAM_ROLES_FILE]: systemCatalog(
      uuid(6404),
      "TeamRoles",
      "team_roles",
      "rightsRoles",
      "team"
    ),
    [TEAM_ASSIGNMENTS_FILE]: systemCatalog(
      uuid(6405),
      "TeamRoleAssignments",
      "team_role_assignments",
      "roleAssignments",
      "team"
    ),
    [ROLE_FILE("TeamLead")]: role(
      TEAM_LEAD_ID,
      "TeamLead",
      { scopeKind: "team" },
      {
        grants: [grant(objects(["Catalog", "TeamNote"]), ["read"], "any")],
      }
    ),
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
 * Шар: членство виду `org` дає прийнята таблиця, а не `OrgMember` (спека прав Рх7).
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

/** Джерело призначень глобального рівня; типова таблиця — `RoleGrant`. */
export function globalGrantsSource(overrides: Record<string, unknown> = {}) {
  return grantsSource({
    id: GLOBAL_GRANTS_SOURCE_ID,
    name: "globalGrants",
    assignedOn: "global",
    columns: { member: "memberId", role: "roleKey" },
    ...overrides,
  })
}

/**
 * Однотенантний проєкт прав: без видів скоупу, «Користувачі», контейнер
 * `Project`, задача з прив'язкою до нього, контейнерна роль `ProjectLead` з
 * `read@any` на задачі й глобальні системні довідники — контейнерні
 * призначення без виду скоупу лежать у глобальному довіднику (спека прав §4.6).
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

export const USER_REGION_FILE =
  "information-registers/UserRegion/UserRegion.meta.json"

/**
 * Однотенантний `Task` з виміром `region`: значення користувача — рядки
 * зв'язку `UserRegion` на «Користувачів».
 */
export function unscopedDimension(): Map<string, string> {
  return singleTenantRights({
    [PROJECT_FILE]: {
      accessDimensions: [
        {
          ...regionDimension(),
          values: {
            relation: {
              object: ref("InformationRegister", "UserRegion"),
              subject: "user",
              value: "region",
            },
          },
        },
      ],
    },
    [REGION_FILE]: catalog(uuid(6040), "Region", "region", { scope: "none" }),
    [USER_REGION_FILE]: {
      id: uuid(6070),
      kind: "InformationRegister",
      name: "UserRegion",
      physicalName: "user_region",
      kindLabel: "user_region",
      scope: "none",
      dimensions: [
        refAttribute(6071, "user", "user_id", ref("Catalog", "Users")),
        refAttribute(6072, "region", "region_id", ref("Catalog", "Region")),
      ],
    },
    [TASK_FILE]: {
      attributes: [
        refAttribute(6012, "project", "project_id", ref("Catalog", "Project")),
        refAttribute(6013, "region", "region_id", ref("Catalog", "Region")),
      ],
      access: [{ attribute: "region", dimension: "region" }],
    },
  })
}

export const TASK_HOURS_FILE =
  "accumulation-registers/TaskHours/TaskHours.meta.json"
export const TASK_REPORT_FILE = "documents/TaskReport/TaskReport.meta.json"
export const COUNT_COMMENT_FILE =
  "event-subscriptions/CountComment/CountComment.meta.json"
export const COMMENT_COUNTER_FILE =
  "custom-tables/CommentCounter/CommentCounter.meta.json"
export const COUNT_COMMENT_SQL_FILE = "sql/public/count-comment.sql"

/** Таблиці ТЧ і похідні таблиці регістра домену політик (`policyDomain`). */
export const CHECKLIST_TABLE = "task_checklist"
export const COMMENT_TABLE = "task_comment"
export const ATTACHMENTS_TABLE = "task_comment_attachments"
export const HOURS_TABLES = {
  movements: "task_hours",
  totals: "task_hours_totals",
  turnoversMonth: "task_hours_turnovers_month",
} as const

/** Табличну частину з одним рядковим реквізитом. */
function section(id: number, name: string, physicalName: string, attr: string) {
  return {
    id: uuid(id),
    name,
    physicalName,
    attributes: [
      {
        id: uuid(id + 1),
        name: attr,
        physicalName: attr,
        type: "String",
        length: 200,
      },
    ],
  }
}

/**
 * Домен політик читання: кожна форма носія, яку денормалізує
 * платформа, і кожна таблиця, на яку лягає політика прав. `Task` — прямі
 * носії всіх трьох полів прав і ТЧ `checklist`; `TaskComment` і `TaskReport`
 * — власність шляхом через задачу (у коментаря — ТЧ `attachments`, другий
 * крок копії; у звіту — генерована колонка періоду типової нумерації);
 * регістр `TaskHours` — вимір доступу на виміру регістра й похідні таблиці;
 * «Користувачі» — носій-ключ і ТЧ `devices`; підписка `onWrite` на коментарі
 * лише сповіщає (`RAISE NOTICE`): обробник лише перевіряє (спека прав §5.3), а
 * службовий лічильник лишається прийнятою таблицею домену. Ролі читають усе скоуплене (`TaskReaders`
 * через `OrgMember`), а «Користувачів» — і рівень скоупу, і `Everyone` (свій
 * рядок), тож проєкт компілюється без попереджень. Шар поверх `withRoles`:
 * типові файли `rightsFiles` не змінюються.
 */
export function policyDomain(...layers: Layer[]): Map<string, string> {
  const files = withRoles(policyLayer(), ...layers)
  // Обробник — SQL-файл, а не метадані: шар `withRoles` зливає лише
  // JSON-об'єкти. Спрацювання він доводить повідомленням, а не записом.
  files.set(
    COUNT_COMMENT_SQL_FILE,
    "CREATE FUNCTION public.count_comment() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN RAISE NOTICE 'count_comment:%', TG_OP; RETURN NEW; END $$;"
  )
  return files
}

/**
 * Компіляція домену політик з SQL-файлами `sql` і прийнятим боргом: предмет
 * тесту — перевірка SQL, а не ратчет.
 */
export async function compiledPolicyDomain(
  sql: Record<string, string>,
  layers: Layer[] = []
): Promise<CompileResult> {
  const result = policyDomain(...layers)
  for (const [path, text] of Object.entries(sql)) result.set(path, text)
  return compile(await acceptDebt(result))
}

function policyLayer(): Layer {
  const readAny = objects(
    ["Document", "Task"],
    ["Catalog", "TaskComment"],
    ["AccumulationRegister", "TaskHours"],
    ["Catalog", "Users"]
  )
  return {
    [PROJECT_FILE]: { accessDimensions: [regionDimension()] },
    [USERS_FILE]: {
      ownership: ["ref"],
      tabularSections: [section(6501, "devices", "users_devices", "label")],
    },
    [TASK_FILE]: {
      ownership: ["assignee"],
      access: [{ attribute: "region", dimension: "region" }],
      containerBinding: "project",
      tabularSections: [section(6511, "checklist", CHECKLIST_TABLE, "note")],
    },
    [COMMENT_FILE]: {
      ownership: [["task", "assignee"]],
      tabularSections: [
        section(6521, "attachments", ATTACHMENTS_TABLE, "label"),
      ],
    },
    [TASK_HOURS_FILE]: {
      id: uuid(6530),
      kind: "AccumulationRegister",
      name: "TaskHours",
      physicalName: HOURS_TABLES.movements,
      kindLabel: HOURS_TABLES.movements,
      scope: "org",
      registerType: "Balance",
      access: [{ attribute: "region", dimension: "region" }],
      dimensions: [
        refAttribute(6531, "region", "region_id", ref("Catalog", "Region")),
      ],
      resources: [
        {
          id: uuid(6532),
          name: "hours",
          physicalName: "hours",
          type: "Numeric",
          precision: 10,
          scale: 2,
        },
      ],
    },
    [TASK_REPORT_FILE]: {
      id: uuid(6540),
      kind: "Document",
      name: "TaskReport",
      physicalName: "task_report",
      kindLabel: "task_report",
      scope: "org",
      ownership: [["task", "assignee"]],
      attributes: [
        refAttribute(6541, "task", "task_id", ref("Document", "Task")),
      ],
    },
    [COMMENT_COUNTER_FILE]: {
      id: uuid(6550),
      kind: "CustomTable",
      name: "CommentCounter",
      physicalName: "comment_counter",
      scope: "none",
      columns: [column(6551, "commentId", "comment_id", "UUID")],
    },
    [COUNT_COMMENT_FILE]: {
      id: uuid(6560),
      kind: "EventSubscription",
      name: "CountComment",
      physicalName: "count_comment",
      sources: [ref("Catalog", "TaskComment")],
      event: "onWrite",
      handler: { schema: "public", name: "count_comment" },
    },
    [SET_FILE("TaskReaders")]: { grants: [grant(readAny, ["read"], "any")] },
    [ROLE_FILE("Everyone")]: {
      grants: [grant(objects(["Catalog", "Users"]), ["read"], "own")],
    },
  }
}

/**
 * Колонка `comment_id` лічильника з полями `fields` — зокрема виразом, який
 * Postgres обчислює посеред запису в таблицю.
 */
export function counterColumn(fields: Record<string, unknown>): Layer {
  return {
    [COMMENT_COUNTER_FILE]: {
      columns: [
        { ...column(6551, "commentId", "comment_id", "UUID"), ...fields },
      ],
    },
  }
}

/**
 * Корінь скоупу з носієм власності й ТЧ `sites` (`organization_sites`):
 * скоуп рядка ТЧ кореня — сам `parent_id`, тож зв'язок копії — одна колонка.
 */
export function scopeRootCarrier(): Layer {
  return {
    [ORGANIZATION_FILE]: {
      ownership: ["owner"],
      attributes: [
        refAttribute(6601, "owner", "owner_id", ref("Catalog", "Users")),
      ],
      tabularSections: [section(6602, "sites", "organization_sites", "label")],
    },
  }
}

const REGION_NOTES_FILE =
  "information-registers/RegionNotes/RegionNotes.meta.json"
export const REGION_NOTES_TABLE = "region_notes"
export const REGION_WRITER_ID = uuid(6733)
export const RATE_TABLE = "rate"

/**
 * Незалежний регістр відомостей `RegionNotes` з обсягом виміру `region` і
 * власна роль `RegionWriter` (`read`, `write`). Шар самодостатній:
 * `withRoles` зливає файли поверхнево, тож умовного `include` між шарами
 * немає.
 */
export function writableRegister(): Layer {
  return {
    [REGION_NOTES_FILE]: {
      id: uuid(6730),
      kind: "InformationRegister",
      name: "RegionNotes",
      physicalName: REGION_NOTES_TABLE,
      kindLabel: REGION_NOTES_TABLE,
      scope: "org",
      access: [{ attribute: "region", dimension: "region" }],
      dimensions: [
        refAttribute(6731, "region", "region_id", ref("Catalog", "Region")),
      ],
      resources: [
        {
          id: uuid(6732),
          name: "note",
          physicalName: "note",
          type: "String",
          length: 200,
        },
      ],
    },
    [ROLE_FILE("RegionWriter")]: role(
      REGION_WRITER_ID,
      "RegionWriter",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            objects(["InformationRegister", "RegionNotes"]),
            ["read", "write"],
            { dimension: "region" }
          ),
        ],
      }
    ),
  }
}

export const TASK_WRITER_ID = uuid(6721)
export const TASK_MARKER_ID = uuid(6722)
export const PROJECT_WRITER_ID = uuid(6723)
export const RIGHTS_ADMIN_ID = uuid(6740)
export const TASK_VIEWER_ID = uuid(6741)
export const TASK_EDITOR_ID = uuid(6742)
export const PROJECT_READER_ID = uuid(6743)
export const GLOBAL_ADMIN_ID = uuid(6744)
export const MEMBER_EDITOR_ID = uuid(6745)
export const REASSIGN_ACTION_ID = uuid(6720)
export const BULLETIN_TABLE = "bulletin"
export const BULLETIN_FILE = "catalogs/Bulletin/Bulletin.meta.json"

/**
 * Ролі запису поверх `policyDomain()`: кастомна дія `reassign` на `Task`
 * (лише шапка `assignee`, без ТЧ); `TaskWriter` пише `Task` і коментарі,
 * `post` — лише `own`; `TaskMarker` лише позначає на видалення;
 * `ProjectWriter` — контейнерна роль, на якій мутація межі тенанта (спека прав §5.2) дає
 * інший результат (предикат контейнера не містить умови скоупу); довідник
 * `Bulletin` з `publicRead`.
 */
export function writeRoles(): Layer {
  const task = objects(["Document", "Task"])
  return {
    [TASK_FILE]: {
      customActions: [
        {
          id: REASSIGN_ACTION_ID,
          name: "reassign",
          requires: ["read"],
          // `dml` в метаданих не пишеться: дія з ефектами — це `update`.
          effects: { header: ["assignee"], tabularSections: false },
        },
      ],
    },
    [BULLETIN_FILE]: catalog(uuid(6724), "Bulletin", BULLETIN_TABLE, {
      publicRead: "authenticated",
      attributes: [
        {
          id: uuid(6725),
          name: "text",
          physicalName: "text",
          type: "String",
          length: 200,
        },
      ],
    }),
    [ROLE_FILE("TaskWriter")]: role(
      TASK_WRITER_ID,
      "TaskWriter",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            task,
            ["read", "create", "update", "delete", "reassign"],
            "any"
          ),
          grant(objects(["Catalog", "TaskComment"]), ["read", "update"], "any"),
          grant(task, ["post"], "own"),
          grant(
            objects(["Catalog", "Bulletin"]),
            ["read", "create", "update"],
            "any"
          ),
        ],
      }
    ),
    [ROLE_FILE("TaskMarker")]: role(
      TASK_MARKER_ID,
      "TaskMarker",
      { scopeKind: "org" },
      { grants: [grant(task, ["read", "markDeletion"], "any")] }
    ),
    [ROLE_FILE("ProjectWriter")]: role(
      PROJECT_WRITER_ID,
      "ProjectWriter",
      { container: ref("Catalog", "Project") },
      { grants: [grant(task, ["read", "create", "update"], "any")] }
    ),
  }
}

/**
 * Окремий шар ролей для сценаріїв адміністрування: базові файли й попередні
 * тести зберігають свої гранти, а перевірки запобіжників беруть рівно потрібних
 * акторів поверх `policyDomain(writeRoles(), adminRoles())`.
 */
export function adminRoles(): Layer {
  const task = objects(["Document", "Task"])
  return {
    [ROLE_FILE("RightsAdmin")]: role(
      RIGHTS_ADMIN_ID,
      "RightsAdmin",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            objects(["Catalog", "OrgRoles"], ["Catalog", "OrgRoleAssignments"]),
            ["read", "administerRights"],
            "any"
          ),
          grant(task, ["read"], "any"),
        ],
      }
    ),
    [ROLE_FILE("TaskViewer")]: role(
      TASK_VIEWER_ID,
      "TaskViewer",
      { scopeKind: "org" },
      { grants: [grant(task, ["read"], "any")] }
    ),
    [ROLE_FILE("TaskEditor")]: role(
      TASK_EDITOR_ID,
      "TaskEditor",
      { scopeKind: "org" },
      { grants: [grant(task, ["read", "update"], "any")] }
    ),
    [ROLE_FILE("ProjectReader")]: role(
      PROJECT_READER_ID,
      "ProjectReader",
      { container: ref("Catalog", "Project") },
      { grants: [grant(task, ["read"], "any")] }
    ),
    [ROLE_FILE("GlobalAdmin")]: role(GLOBAL_ADMIN_ID, "GlobalAdmin", "global", {
      fullAccess: true,
    }),
    [ROLE_FILE("MemberEditor")]: role(
      MEMBER_EDITOR_ID,
      "MemberEditor",
      { scopeKind: "org" },
      {
        grants: [
          grant(objects(["Catalog", "OrgMember"]), ["read", "update"], "any"),
        ],
      }
    ),
  }
}

/**
 * `RightsAdmin` поверх `adminRoles()` з явним `read` на довіднику членства:
 * `administerRights` не дає неявного читання, тож без нього призначення не
 * адресує учасника (`command.invalid` `subject`). Перевизначення, а не зміна
 * `adminRoles()`: інші тести покладаються на його гранти.
 */
export function rightsAdminReadingMembers(): Layer {
  return {
    [ROLE_FILE("RightsAdmin")]: role(
      RIGHTS_ADMIN_ID,
      "RightsAdmin",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            objects(["Catalog", "OrgRoles"], ["Catalog", "OrgRoleAssignments"]),
            ["read", "administerRights"],
            "any"
          ),
          grant(objects(["Document", "Task"]), ["read"], "any"),
          grant(objects(["Catalog", "OrgMember"]), ["read"], "any"),
        ],
      }
    ),
  }
}

export const MEMBER_CREATOR_ID = uuid(6747)

/**
 * `MemberCreator` — роль скоупу, що заводить і позначає учасників `OrgMember`
 * без жодного гранту на дані: доводить, що зміна членства командою не дає
 * актору прав у тій самій транзакції — права транзакції ті, що були на її
 * початку (знімок актора, спека прав §7).
 */
export function memberCreator(): Layer {
  return {
    [ROLE_FILE("MemberCreator")]: role(
      MEMBER_CREATOR_ID,
      "MemberCreator",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            objects(["Catalog", "OrgMember"]),
            ["read", "create", "markDeletion"],
            "any"
          ),
        ],
      }
    ),
  }
}

export const GLOBAL_USERS_READER_ID = uuid(6950)
export const GLOBAL_RIGHTS_ADMIN_ID = uuid(6951)
export const GLOBAL_RIGHTS_ONLY_ID = uuid(6952)

/**
 * Глобальні ролі без `fullAccess` поверх `adminRoles()`: приріст рівня
 * `global` покривають лише глобальні права актора, а носія повного доступу
 * тут немає — інакше покриття дав би `fullAccess`, а не право. `UsersReader`
 * — право, яке призначають (`read` `any` на «Користувачах»: `own` дає кожному
 * `Everyone`, і він `any` не покриває); `RightsAdmin` адмініструє глобальні ролі й має це
 * право, `RightsOnly` — адмініструє без нього.
 */
export function globalRightsAdmins(): Layer {
  const administer = grant(
    objects(["Catalog", "GlobalRoles"], ["Catalog", "GlobalRoleAssignments"]),
    ["read", "administerRights"],
    "any"
  )
  // Об'єкт без скоупу: глобальна роль інших не покриває (`rights.grant-level`).
  const usersRead = grant(objects(["Catalog", "Users"]), ["read"], "any")
  return {
    [ROLE_FILE("GlobalUsersReader")]: role(
      GLOBAL_USERS_READER_ID,
      "GlobalUsersReader",
      "global",
      { grants: [usersRead] }
    ),
    [ROLE_FILE("GlobalRightsAdmin")]: role(
      GLOBAL_RIGHTS_ADMIN_ID,
      "GlobalRightsAdmin",
      "global",
      { grants: [administer, usersRead] }
    ),
    [ROLE_FILE("GlobalRightsOnly")]: role(
      GLOBAL_RIGHTS_ONLY_ID,
      "GlobalRightsOnly",
      "global",
      { grants: [administer] }
    ),
  }
}

/** Обов'язковий реквізит застосунку в рядку учасника `OrgMember`. */
export const MEMBER_TITLE = "title"

/**
 * `OrgMember` з обов'язковим реквізитом застосунку без значення за
 * замовчуванням: рядок учасника без нього база відхиляє (`23502`), тож нового
 * учасника заводять лише з його значенням. Перевизначення повторює реквізит
 * `user`: `withRoles` зливає файли лише на верхньому рівні ключів.
 */
export function requiredMemberAttribute(): Layer {
  return {
    [MEMBER_FILE]: {
      attributes: [
        refAttribute(6005, "user", "user_id", ref("Catalog", "Users")),
        {
          id: uuid(7530),
          name: MEMBER_TITLE,
          physicalName: MEMBER_TITLE,
          type: "String",
          length: 50,
          required: true,
        },
      ],
    },
  }
}

/** Масив `Ref` і поліморфна пара `OrgMember` шару `memberScopedReferences()`. */
export const MEMBER_REGIONS = "regions"
export const MEMBER_FOCUS = "focus"

/**
 * `requiredMemberAttribute()` плюс масив `Ref` на скоуплений `Region` і
 * поліморфна пара `Region`/`Users` в `OrgMember`: посилання нового учасника,
 * для яких скоуп цілі звіряє перевірка рядка членства (спека П4 §6.6, §6.12),
 * — одиничний не-масив тримає складений FK. Реквізити повторено цілком:
 * `withRoles` зливає файли лише на верхньому рівні ключів.
 */
export function memberScopedReferences(): Layer {
  const { attributes } = requiredMemberAttribute()[MEMBER_FILE] as {
    attributes: unknown[]
  }
  return {
    [MEMBER_FILE]: {
      attributes: [
        ...attributes,
        {
          ...refAttribute(
            8240,
            MEMBER_REGIONS,
            MEMBER_REGIONS,
            ref("Catalog", "Region")
          ),
          array: true,
        },
        {
          id: uuid(8241),
          name: MEMBER_FOCUS,
          physicalName: MEMBER_FOCUS,
          type: "Ref",
          allowedTypes: objects(["Catalog", "Region"], ["Catalog", "Users"]),
        },
      ],
    },
  }
}

export const TICKET_FILE = "catalogs/Ticket/Ticket.meta.json"
export const TICKET_ID = uuid(6901)
export const TICKET_TABLE = "ticket"
export const TICKET_CHECKLIST_TABLE = "ticket_checklist"
export const TICKET_WRITER_ID = uuid(6920)
export const TICKET_OWN_WRITER_ID = uuid(6921)
export const TICKET_REGION_WRITER_ID = uuid(6922)
export const PROJECT_TICKET_WRITER_ID = uuid(6923)
export const TICKET_READER_ID = uuid(6924)
export const TICKET_TARGETS_READER_ID = uuid(6925)
export const TASK_COMMENT_OWN_WRITER_ID = uuid(6926)

/**
 * Реквізити `Ticket`: шар, що додає реквізит, повторює їх усі — `withRoles`
 * зливає файли лише на верхньому рівні ключів.
 */
function ticketAttributes(): Record<string, unknown>[] {
  return [
    refAttribute(6902, "assignee", "assignee_id", ref("Catalog", "OrgMember")),
    refAttribute(6903, "region", "region_id", ref("Catalog", "Region")),
    refAttribute(6904, "project", "project_id", ref("Catalog", "Project")),
    {
      id: uuid(6905),
      name: "subject",
      physicalName: "subject",
      type: "Ref",
      allowedTypes: objects(["Catalog", "Project"], ["Catalog", "Region"]),
    },
    {
      ...refAttribute(
        6906,
        "watchers",
        "watchers",
        ref("Catalog", "OrgMember")
      ),
      array: true,
    },
  ]
}

/**
 * Довідник ядра команд (спека П4 §6.6) поверх `policyDomain()`: `Task` домену —
 * документ, а ядро генерується лише для довідника. `Ticket` — ієрархічний,
 * з автором, з носієм власності `assignee`, виміром `region`, прив'язкою до
 * контейнера `project`, поліморфним `subject` і масивом `watchers`; ТЧ
 * `checklist` посилається на `Region`, на сам `Ticket` (невидима ціль рядка
 * ТЧ під `TicketOwnWriter`) і поліморфно — `subject` (часткова зміна пари). Ролі запису мають `read` на тому самому обсязі,
 * що й запис: `read@any` змінив би видимість під замком рядка. Цілі посилань
 * відкриває окрема роль `TicketTargetsReader`. `TaskCommentOwnWriter` — носій
 * за шляхом `task.assignee`.
 */
export function commandCoreLayer(): Layer {
  const ticket = objects(["Catalog", "Ticket"])
  const writes = ["read", "create", "update", "markDeletion"]
  const writer = (id: string, name: string, extent: unknown) =>
    role(
      id,
      name,
      { scopeKind: "org" },
      {
        grants: [grant(ticket, writes, extent)],
      }
    )
  return {
    [TICKET_FILE]: catalog(TICKET_ID, "Ticket", TICKET_TABLE, {
      trackAuthor: true,
      hierarchyType: "FoldersAndItems",
      ownership: ["assignee"],
      access: [{ attribute: "region", dimension: "region" }],
      containerBinding: "project",
      attributes: ticketAttributes(),
      tabularSections: [
        {
          id: uuid(6907),
          name: "checklist",
          physicalName: TICKET_CHECKLIST_TABLE,
          attributes: [
            // Не `region_id`: це ім'я займає копія носія `region` шапки.
            refAttribute(
              6908,
              "region",
              "line_region_id",
              ref("Catalog", "Region")
            ),
            refAttribute(
              6909,
              "related",
              "related_id",
              ref("Catalog", "Ticket")
            ),
            {
              id: uuid(6910),
              name: "subject",
              physicalName: "subject",
              type: "Ref",
              allowedTypes: objects(
                ["Catalog", "Project"],
                ["Catalog", "Region"]
              ),
            },
          ],
        },
      ],
    }),
    [ROLE_FILE("TicketWriter")]: writer(
      TICKET_WRITER_ID,
      "TicketWriter",
      "any"
    ),
    [ROLE_FILE("TicketOwnWriter")]: writer(
      TICKET_OWN_WRITER_ID,
      "TicketOwnWriter",
      "own"
    ),
    [ROLE_FILE("TicketRegionWriter")]: writer(
      TICKET_REGION_WRITER_ID,
      "TicketRegionWriter",
      { dimension: "region" }
    ),
    [ROLE_FILE("ProjectTicketWriter")]: role(
      PROJECT_TICKET_WRITER_ID,
      "ProjectTicketWriter",
      { container: ref("Catalog", "Project") },
      { grants: [grant(ticket, writes, "any")] }
    ),
    [ROLE_FILE("TicketReader")]: role(
      TICKET_READER_ID,
      "TicketReader",
      { scopeKind: "org" },
      { grants: [grant(ticket, ["read"], "any")] }
    ),
    [ROLE_FILE("TicketTargetsReader")]: role(
      TICKET_TARGETS_READER_ID,
      "TicketTargetsReader",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            objects(
              ["Catalog", "OrgMember"],
              ["Catalog", "Region"],
              ["Catalog", "Project"],
              ["Document", "Task"]
            ),
            ["read"],
            "any"
          ),
        ],
      }
    ),
    [ROLE_FILE("TaskCommentOwnWriter")]: role(
      TASK_COMMENT_OWN_WRITER_ID,
      "TaskCommentOwnWriter",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            objects(["Catalog", "TaskComment"]),
            ["read", "create", "update"],
            "own"
          ),
        ],
      }
    ),
  }
}

/**
 * Обробник підписки разом із SQL-файлом функції: шар `withRoles` зливає лише
 * JSON, тож `sql` додається до файлів після `policyDomain(...)` (`withSql`),
 * як `COUNT_COMMENT_SQL_FILE`.
 */
export interface HandlerFixture {
  layer: Layer
  sql: Record<string, string>
}

/** Файли моделі з SQL-файлами обробників. */
export function withSql(
  files: Map<string, string>,
  ...handlers: HandlerFixture[]
): Map<string, string> {
  for (const handler of handlers)
    for (const [path, sql] of Object.entries(handler.sql)) files.set(path, sql)
  return files
}

const ticketBeforeWrite = (
  id: number,
  name: string,
  physicalName: string
): Layer => ({
  [`event-subscriptions/${name}/${name}.meta.json`]: {
    id: uuid(id),
    kind: "EventSubscription",
    name,
    physicalName,
    sources: objects(["Catalog", "Ticket"]),
    event: "beforeWrite",
    handler: { schema: "public", name: physicalName },
  },
})

/**
 * Підписка `beforeWrite` на `Ticket`, що лише сповіщає `RAISE NOTICE` з
 * `current_user`: так видно, від чиєї ролі виконується обробник. Рядка не
 * змінює — зміна шапки обробником ламала б `mark_deletion` (тригер ефектів —
 * `AFTER` і бачить її).
 */
export function ticketNoticeHandler(): HandlerFixture {
  return {
    layer: ticketBeforeWrite(6950, "TicketNotice", "ticket_notice"),
    sql: {
      "sql/public/ticket-notice.sql":
        "CREATE FUNCTION public.ticket_notice() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN RAISE NOTICE 'ticket-handler:%', current_user; RETURN NEW; END $$;",
    },
  }
}

/**
 * Підписка `beforeWrite` на `Ticket` з тілом обробника `body`: чи присвоює
 * тіло `parent_id`, вирішує `lockAlways` замка ієрархії (спека П4 §6.6). За
 * замовчуванням тіло присвоює батька.
 */
export function ticketParentHandler(
  body = "NEW.parent_id := NULL;"
): HandlerFixture {
  return {
    layer: ticketBeforeWrite(6945, "TicketParent", "ticket_parent"),
    sql: {
      "sql/public/ticket-parent.sql": `CREATE FUNCTION public.ticket_parent() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN ${body} RETURN NEW; END $$;`,
    },
  }
}

/**
 * Реквізит `moveTo` → `Ticket` і обробник `beforeWrite`, що переносить рядок
 * під `move_to` (присвоює `NEW.parent_id`), коли значення задане й інше:
 * зміна батька без ключа `parent_id` у команді (спека П4 §6.6).
 */
export function ticketMoveToHandler(): HandlerFixture {
  return {
    layer: {
      ...ticketBeforeWrite(6952, "TicketMoveTo", "ticket_move_to"),
      [TICKET_FILE]: {
        attributes: [
          ...ticketAttributes(),
          refAttribute(6951, "moveTo", "move_to", ref("Catalog", "Ticket")),
        ],
      },
    },
    sql: {
      "sql/public/ticket-move-to.sql":
        "CREATE FUNCTION public.ticket_move_to() RETURNS trigger LANGUAGE plpgsql VOLATILE SET search_path = '' AS $$ BEGIN IF NEW.move_to IS NOT NULL AND NEW.move_to IS DISTINCT FROM NEW.parent_id THEN NEW.parent_id := NEW.move_to; END IF; RETURN NEW; END $$;",
    },
  }
}

export const GAUGE_FILE = "catalogs/Gauge/Gauge.meta.json"
export const GAUGE_LOG_FILE = "catalogs/GaugeLog/GaugeLog.meta.json"
export const GAUGE_LEVEL_FILE = "enumerations/GaugeLevel/GaugeLevel.meta.json"
export const GAUGE_TABLE = "gauge"
export const GAUGE_LOG_TABLE = "gauge_log"
export const GAUGE_WRITER_ID = uuid(7520)

/**
 * Значення рантайму команд (Р-A3-7) поверх `policyDomain()`: скоуплений
 * довідник `Gauge` з типами, яких немає в довідниках A2, — `Numeric(30,10)`,
 * `BigInt`, `Json`, `Bytes`, посилання на перерахування `GaugeLevel` (логічне
 * ім'я значення ≠ мітка бази), поліморфний `subject`, масив `BigInt`,
 * `reading` з `nonNegative` (CHECK з колонкою) і ТЧ `lines`; `GaugeLog` — другий довідник, у який пише хук. `GaugeWriter` пише
 * обидва й читає цілі пари: без читання цілі ядро відмовило б раніше.
 */
export function runtimeValuesLayer(): Layer {
  const gauges = objects(["Catalog", "Gauge"], ["Catalog", "GaugeLog"])
  return {
    [GAUGE_LEVEL_FILE]: {
      id: uuid(7500),
      kind: "Enumeration",
      name: "GaugeLevel",
      physicalName: "gauge_level",
      values: [
        { id: uuid(7501), name: "Low", physicalName: "lvl_low" },
        { id: uuid(7502), name: "High", physicalName: "lvl_high" },
      ],
    },
    [GAUGE_FILE]: catalog(uuid(7503), "Gauge", GAUGE_TABLE, {
      attributes: [
        {
          id: uuid(7504),
          name: "amount",
          physicalName: "amount",
          type: "Numeric",
          precision: 30,
          scale: 10,
        },
        {
          id: uuid(7505),
          name: "counter",
          physicalName: "counter",
          type: "BigInt",
        },
        {
          id: uuid(7506),
          name: "payload",
          physicalName: "payload",
          type: "Json",
        },
        { id: uuid(7507), name: "blob", physicalName: "blob", type: "Bytes" },
        refAttribute(7508, "level", "level", ref("Enumeration", "GaugeLevel")),
        {
          id: uuid(7509),
          name: "subject",
          physicalName: "subject",
          type: "Ref",
          allowedTypes: objects(["Catalog", "Project"], ["Catalog", "Region"]),
        },
        {
          id: uuid(7510),
          name: "marks",
          physicalName: "marks",
          type: "BigInt",
          array: true,
        },
        {
          id: uuid(7516),
          name: "reading",
          physicalName: "reading",
          type: "Integer",
          nonNegative: true,
        },
      ],
      tabularSections: [
        {
          id: uuid(7511),
          name: "lines",
          physicalName: "gauge_lines",
          attributes: [
            {
              id: uuid(7512),
              name: "qty",
              physicalName: "qty",
              type: "Numeric",
              precision: 30,
              scale: 10,
            },
            {
              id: uuid(7513),
              name: "note",
              physicalName: "note",
              type: "String",
              length: 40,
            },
          ],
        },
      ],
    }),
    [GAUGE_LOG_FILE]: catalog(uuid(7514), "GaugeLog", GAUGE_LOG_TABLE, {
      attributes: [
        {
          id: uuid(7515),
          name: "note",
          physicalName: "note",
          type: "String",
          length: 40,
        },
      ],
    }),
    [ROLE_FILE("GaugeWriter")]: role(
      GAUGE_WRITER_ID,
      "GaugeWriter",
      { scopeKind: "org" },
      {
        grants: [
          grant(gauges, ["read", "create", "update", "markDeletion"], "any"),
          grant(
            objects(["Catalog", "Project"], ["Catalog", "Region"]),
            ["read"],
            "any"
          ),
        ],
      }
    ),
  }
}

/**
 * `runtimeValuesLayer()` з `load` реквізитів шапки `Gauge` за іменем і
 * реквізитом `Bytes` у ТЧ `lines` (Рд25): типова лінивість `Bytes` діє лише в
 * шапці.
 */
export function gaugeLoadLayer(loads: Record<string, "eager" | "lazy">): Layer {
  const layer = runtimeValuesLayer()
  const gauge = layer[GAUGE_FILE] as {
    attributes: { name: string }[]
    tabularSections: { attributes: unknown[] }[]
  }
  return {
    ...layer,
    [GAUGE_FILE]: {
      ...gauge,
      attributes: gauge.attributes.map((a) =>
        a.name in loads ? { ...a, load: loads[a.name] } : a
      ),
      tabularSections: gauge.tabularSections.map((section) => ({
        ...section,
        attributes: [
          ...section.attributes,
          { id: uuid(7560), name: "scan", physicalName: "scan", type: "Bytes" },
        ],
      })),
    },
  }
}

/**
 * `runtimeValuesLayer()` з одноцільовим `Ref` `site` у `Gauge` на довідник
 * `Region` з `crossScope: true` — ціль `include` серверного читання. Простий
 * FK дає засіяти посилання на `Region` чужого скоупу: складений FK того
 * самого виду це заборонив би.
 */
export function readQueryLayer(): Layer {
  const layer = runtimeValuesLayer()
  const gauge = layer[GAUGE_FILE] as { attributes: unknown[] }
  return {
    ...layer,
    [GAUGE_FILE]: {
      ...gauge,
      attributes: [
        ...gauge.attributes,
        {
          ...refAttribute(7517, "site", "site_id", ref("Catalog", "Region")),
          crossScope: true,
        },
      ],
    },
  }
}

/**
 * Правило рядка `Gauge` (до `withSql` поверх `runtimeValuesLayer()`): CHECK
 * над двома колонками, тобто без колонки реквізиту. Явне `name` резервується
 * до похідних імен, тож ім'я похідного CHECK може його обійти.
 */
export function gaugeRowRule(name = "gauge_span"): HandlerFixture {
  return {
    layer: {},
    sql: {
      "catalogs/Gauge/Gauge.sql": `ALTER TABLE public.${GAUGE_TABLE} ADD CONSTRAINT ${name} CHECK (num_nonnulls(amount, reading) <= 1);`,
    },
  }
}

export const NOTE_FILE = "catalogs/Note/Note.meta.json"
export const NOTE_LONG_FILE = "catalogs/NoteLong/NoteLong.meta.json"
export const NOTE_WRITER_ID = uuid(6810)
export const NOTE_LONG_WRITER_ID = uuid(6820)
/** 60-байтна назва: літери в позиціях обрізання імен тригерів. */
export const NOTE_LONG = "note_" + "a".repeat(55)

/**
 * Довідник з носієм прав за автором (спека П4 §6.8) поверх `singleTenantRights`:
 * «Користувачі» отримують реквізит `mentor`, а `Note` (`trackAuthor`, ТЧ
 * `lines`) — копію носія власності за шляхом `createdBy.mentor`, тож копія
 * виводиться з примушеного автора. Шлях через автора можливий лише в проєкті
 * без видів скоупу: «Користувачі» не скоуплені, а крок носія в проєкті зі
 * скоупом мусить лишатися в тенанті (`rights.carrier-cross-tenant`).
 * `long` — окремий файл і ідентичності з 60-байтною назвою таблиці: шари
 * зливаються за шляхом файлу. Глобальна роль `NoteWriter` — `read`,
 * `create`, `update` `@any`.
 */
export function authorCarrier(
  variant: "short" | "long" = "short"
): Record<string, Record<string, unknown>> {
  const long = variant === "long"
  const base = long ? 6820 : 6810
  const name = long ? "NoteLong" : "Note"
  return {
    [USERS_FILE]: {
      attributes: [
        refAttribute(6800, "mentor", "mentor_id", ref("Catalog", "Users")),
      ],
    },
    [long ? NOTE_LONG_FILE : NOTE_FILE]: catalog(
      uuid(base + 1),
      name,
      long ? NOTE_LONG : "note",
      {
        kindLabel: long ? "note_long" : "note",
        scope: "none",
        trackAuthor: true,
        ownership: [["createdBy", "mentor"]],
        attributes: [
          {
            id: uuid(base + 2),
            name: "text",
            physicalName: "text",
            type: "String",
            length: 200,
          },
        ],
        tabularSections: [
          section(
            base + 3,
            "lines",
            long ? "note_long_lines" : "note_lines",
            "text"
          ),
        ],
      }
    ),
    [ROLE_FILE(`${name}Writer`)]: role(
      long ? NOTE_LONG_WRITER_ID : NOTE_WRITER_ID,
      `${name}Writer`,
      "global",
      {
        grants: [
          grant(
            objects(["Catalog", name]),
            ["read", "create", "update"],
            "any"
          ),
        ],
      }
    ),
  }
}

export const NOTE_OWN_CREATOR_ID = uuid(6830)

/**
 * Глобальна роль `NoteOwnCreator` — `read` і `create` `@own` на `Note`
 * (носій `createdBy.mentor`), без права на «Користувачів»: копія носія під
 * командою береться з функції джерел авторства (спека П4 §6.7). Перевизначення
 * для `singleTenantRights` поряд з `authorCarrier()`.
 */
export function noteOwnCreator(): Record<string, Record<string, unknown>> {
  return {
    [ROLE_FILE("NoteOwnCreator")]: role(
      NOTE_OWN_CREATOR_ID,
      "NoteOwnCreator",
      "global",
      {
        grants: [
          grant(objects(["Catalog", "Note"]), ["read", "create"], "own"),
        ],
      }
    ),
  }
}

export const TEAM_RIGHTS_ADMIN_ID = uuid(6750)
export const RIGHTS_ONLY_ADMIN_ID = uuid(6751)

/**
 * Ролі аналізу прав поверх `policyDomain(writeRoles(), adminRoles(),
 * secondScopeKind())`: `TeamRightsAdmin` адмініструє права виду `team` —
 * адміністратор іншого виду з тим самим id скоупу; `RightsOnlyAdmin`
 * адмініструє права `org` без `read` на задачах — пояснення рядка, якого
 * викликач не бачить (спека прав §5.1).
 */
export function analysisRoles(): Layer {
  return {
    [ROLE_FILE("TeamRightsAdmin")]: role(
      TEAM_RIGHTS_ADMIN_ID,
      "TeamRightsAdmin",
      { scopeKind: "team" },
      {
        grants: [
          grant(
            objects(
              ["Catalog", "TeamRoles"],
              ["Catalog", "TeamRoleAssignments"]
            ),
            ["read", "administerRights"],
            "any"
          ),
        ],
      }
    ),
    [ROLE_FILE("RightsOnlyAdmin")]: role(
      RIGHTS_ONLY_ADMIN_ID,
      "RightsOnlyAdmin",
      { scopeKind: "org" },
      {
        grants: [
          grant(
            objects(["Catalog", "OrgRoles"], ["Catalog", "OrgRoleAssignments"]),
            ["read", "administerRights"],
            "any"
          ),
        ],
      }
    ),
  }
}

/**
 * Нескоупована константа `Rate`: у глобальній ролі `Support` її `update`
 * природний для вставки й оновлення (спека прав §3).
 */
export function globalConstant(): Layer {
  return {
    "constants/Rate/Rate.meta.json": {
      id: uuid(6734),
      kind: "Constant",
      name: "Rate",
      physicalName: RATE_TABLE,
      kindLabel: RATE_TABLE,
      scope: "none",
      type: "Numeric",
      precision: 10,
      scale: 2,
    },
    [ROLE_FILE("Support")]: {
      grants: [grant(objects(["Constant", "Rate"]), ["read", "update"], "any")],
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

/**
 * Домен політик з шаром прийнятої таблиці `layer` до промоції `mapping` і
 * після неї та запис промоції: вихідна й бажана моделі плану з промоцією.
 * `domain` — будівник домену (типово `policyDomain`).
 */
export async function promotedRights(
  layer: Layer,
  mapping: PromoteInput,
  domain: (...layers: Layer[]) => Map<string, string> = policyDomain
) {
  const files = domain(layer)
  const before = (await compileRights(files)).model!
  let n = 950_000
  const result = await promoteObject(files, mapping, {
    schemaPath: (file, schemaFile) => `schemas-of/${file}/${schemaFile}`,
    newId: () => uuid(++n),
  })
  // Попередження домену (як `rights.adopted-source-writes`) промоції не
  // зупиняють
  if (result.diagnostics.some((d) => d.severity === "error"))
    throw new Error(`promotion failed: ${JSON.stringify(result.diagnostics)}`)
  const desired = (await compileRights(applyChanges(files, result.changes)))
    .model!
  return { before, desired, record: result.record! }
}

export const TAG_FILE = "custom-tables/Tag/Tag.meta.json"
export const TAG_ID = uuid(6590)

/**
 * Шар з прийнятою таблицею `Tag` (`public.tag`), яку `tagMapping` промотує
 * в довідник без кроків даних, змін типу й перетворень одиниць: план із
 * промоцією поверх домену політик (спека прав §5.2).
 */
export function promotableTag(): Layer {
  return {
    [TAG_FILE]: {
      id: TAG_ID,
      kind: "CustomTable",
      name: "Tag",
      physicalName: "tag",
      kindLabel: "tag",
      scope: "none",
      columns: [
        column(6591, "id", "id", "UUID"),
        { ...column(6592, "name", "name", "String"), length: 150 },
      ],
      primaryKey: { name: "tag_pkey", columns: ["id"] },
    },
  }
}

export function tagMapping(): PromoteInput {
  return promoteInput.parse({
    target: { name: "Tag" },
    into: {
      kind: "Catalog",
      name: "Tag",
      data: { codeLength: 0, descriptionLength: 150 },
    },
    columns: {
      id: { to: "standard", name: "ref" },
      name: { to: "standard", name: "description" },
    },
    fill: [],
    conversions: {},
  })
}

export const TASK_NOTE_FILE = "custom-tables/TaskNote/TaskNote.meta.json"
export const TASK_NOTE_ID = uuid(6595)
/** Ім'я прийнятої таблиці `TaskNote`; промоція дає довіднику `task_note`. */
export const TASK_NOTE_ADOPTED_TABLE = "task_notes"

/**
 * Шар з прийнятою таблицею `TaskNote` (`public.task_notes`), яку
 * `taskNoteMapping` промотує в довідник `task_note` скоупу `org` з власністю
 * шляхом через задачу: перейменована промоцією таблиця отримує копію носія
 * (спека прав §5.2).
 */
export function promotableTaskNote(): Layer {
  return {
    [TASK_NOTE_FILE]: {
      id: TASK_NOTE_ID,
      kind: "CustomTable",
      name: "TaskNote",
      physicalName: TASK_NOTE_ADOPTED_TABLE,
      kindLabel: "task_note",
      scope: "org",
      scopeColumn: "orgId",
      columns: [
        column(6596, "id", "id", "UUID"),
        { ...column(6597, "name", "name", "String"), length: 150 },
        column(6598, "taskId", "task_id", "UUID"),
        column(6599, "orgId", "org_id", "UUID"),
      ],
      primaryKey: { name: "task_notes_pkey", columns: ["id"] },
    },
  }
}

export function taskNoteMapping(): PromoteInput {
  return promoteInput.parse({
    target: { name: "TaskNote" },
    into: {
      kind: "Catalog",
      name: "TaskNote",
      data: {
        codeLength: 0,
        descriptionLength: 150,
        ownership: [["task", "assignee"]],
      },
    },
    columns: {
      id: { to: "standard", name: "ref" },
      name: { to: "standard", name: "description" },
      orgId: { to: "scope" },
      taskId: {
        to: "attribute",
        element: { name: "task", type: "Ref", ref: ref("Document", "Task") },
      },
    },
    fill: [],
    conversions: {},
  })
}

export const GLOBAL_GRANT_FILE =
  "custom-tables/GlobalGrant/GlobalGrant.meta.json"
const GLOBAL_GRANT_ID = uuid(6115)
/** Ключ `ProjectLead` у джерелі `grants` і ключ `Support` у `globalGrants`. */
export const ADOPTED_LEAD_KEY = "lead"
export const ADOPTED_SUPPORT_KEY = "support"

/**
 * Функція множини виду `org` над прийнятим членством: межа тенанта поважає
 * активність, як і «мої скоупи».
 */
const ORG_IDS_SQL =
  "CREATE FUNCTION public.org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT m.org_id FROM public.membership m WHERE m.user_id = (SELECT simetra.current_user_id()) AND m.is_active IS TRUE $$;"

/** `Membership` джерела: користувач і активність — без `NOT NULL`. */
export function adoptedMembershipTable(
  overrides: Record<string, unknown> = {}
) {
  return membershipTable({
    columns: [
      column(6101, "id", "id", "UUID"),
      column(6102, "orgId", "org_id", "UUID"),
      nullable(6103, "userId", "user_id", "UUID"),
      nullable(6104, "isActive", "is_active", "Boolean"),
    ],
    ...overrides,
  })
}

/** `RoleGrant` джерела: учасник і ключ ролі — без `NOT NULL`. */
export function adoptedGrantTable(overrides: Record<string, unknown> = {}) {
  return grantTable({
    columns: [
      column(6111, "id", "id", "UUID"),
      nullable(6112, "memberId", "member_id", "UUID"),
      nullable(6113, "roleKey", "role_key", "Text"),
      column(6114, "projectId", "project_id", "UUID"),
    ],
    ...overrides,
  })
}

/**
 * Прийнята таблиця глобальних призначень: учасник — id користувача, ключ
 * ролі; окрема від `RoleGrant`, тож ключі одного джерела не «невідомі» для
 * іншого.
 */
export function globalGrantTable(overrides: Record<string, unknown> = {}) {
  return {
    id: GLOBAL_GRANT_ID,
    kind: "CustomTable",
    name: "GlobalGrant",
    physicalName: "global_grant",
    kindLabel: "global_grant",
    scope: "none",
    columns: [
      column(6116, "id", "id", "UUID"),
      nullable(6117, "memberId", "member_id", "UUID"),
      nullable(6118, "roleKey", "role_key", "Text"),
    ],
    primaryKey: { columns: ["id"] },
    ...overrides,
  }
}

/**
 * Шар прийнятих джерел поверх домену політик (спека прав §4.7): членство виду
 * `org` дає `Membership` (джерело `members`), контейнерні призначення
 * `ProjectLead` — `RoleGrant` (`grants`, учасник — рядок `Membership`),
 * глобальні призначення `Support` — `GlobalGrant` (`globalGrants`, учасник —
 * користувач). Довідники прав `org` лишаються (рівень скоупу джерелом не
 * покрито, спека прав §4.7), а глобальні прибрано: єдину глобальну роль покриває
 * джерело. Вимір `region` прибрано — його зв'язок `MemberRegion` прибрав
 * `adoptedMembership()`. Збирає `adoptedSourcesDomain`.
 */
export function adoptedSources(): Layer {
  const membership = adoptedMembership()
  return {
    ...membership,
    [PROJECT_FILE]: {
      ...membership[PROJECT_FILE],
      accessDimensions: [],
      membershipSources: [membersSource()],
      assignmentSources: [
        grantsSource(),
        globalGrantsSource({ table: ref("CustomTable", "GlobalGrant") }),
      ],
    },
    // `access` не буває порожнім (схема), тож поле прибирається: `undefined`
    // зникає при серіалізації файлу.
    [TASK_FILE]: {
      access: undefined,
      attributes: [
        refAttribute(
          6011,
          "assignee",
          "assignee_id",
          ref("CustomTable", "Membership")
        ),
        refAttribute(6012, "project", "project_id", ref("Catalog", "Project")),
        refAttribute(6013, "region", "region_id", ref("Catalog", "Region")),
      ],
    },
    [TASK_HOURS_FILE]: { access: undefined },
    [MEMBERSHIP_FILE]: adoptedMembershipTable(),
    [GRANT_FILE]: adoptedGrantTable(),
    [GLOBAL_GRANT_FILE]: globalGrantTable(),
    [ROLE_FILE("ProjectLead")]: {
      sourceKeys: [{ source: "grants", key: ADOPTED_LEAD_KEY }],
      grants: [grant(objects(["Document", "Task"]), ["read"], "any")],
    },
    [ROLE_FILE("Support")]: {
      sourceKeys: [{ source: "globalGrants", key: ADOPTED_SUPPORT_KEY }],
      grants: [grant(objects(["Document", "Announcement"]), ["read"], "any")],
    },
    ...without(GLOBAL_ROLES_FILE, GLOBAL_ASSIGNMENTS_FILE),
  }
}

/**
 * Домен політик з прийнятими джерелами (`adoptedSources`) і шарами поверх.
 * SQL функції множини `org_ids` — файл, а не метадані: шари зливають лише
 * JSON, тож його кладе будівник, як `policyDomain` — обробник лічильника.
 */
export function adoptedSourcesDomain(...layers: Layer[]): Map<string, string> {
  const files = policyDomain(adoptedSources(), ...layers)
  files.set(SCOPE_FUNCTIONS_FILE, ORG_IDS_SQL)
  return files
}

/**
 * Шар поверх `adoptedSources()`: рядки `RoleGrant` мають nullable `isActive`,
 * змаповану як активність джерела `grants`. Окремим шаром, бо типова
 * `RoleGrant` активності не має, а на неї спираються інші твердження.
 * `assignmentSources` повторено повністю: шари зливаються поверхнево.
 */
export function activeGrants(): Layer {
  return {
    [PROJECT_FILE]: {
      assignmentSources: [
        grantsSource({
          columns: {
            member: "memberId",
            role: "roleKey",
            container: "projectId",
            active: "isActive",
          },
        }),
        globalGrantsSource({ table: ref("CustomTable", "GlobalGrant") }),
      ],
    },
    [GRANT_FILE]: adoptedGrantTable({
      columns: [
        ...adoptedGrantTable().columns,
        nullable(6105, "isActive", "is_active", "Boolean"),
      ],
    }),
  }
}

/**
 * Проєкт без «Користувачів» (спека прав §4.6): прибирає довідник і все, що на
 * нього посилається, — авторство `Task` і «Користувачів» із грантів
 * `TaskReaders` і `Everyone`; власність і ТЧ «Користувачів» ідуть разом із
 * файлом. Прийняті джерела лишаються — лише з ними права без «Користувачів»
 * можливі.
 */
export function withoutUsers(): Layer {
  return {
    ...without(USERS_FILE),
    [TASK_FILE]: { trackAuthor: false },
    [SET_FILE("TaskReaders")]: {
      grants: [
        grant(
          objects(
            ["Document", "Task"],
            ["Catalog", "TaskComment"],
            ["AccumulationRegister", "TaskHours"]
          ),
          ["read"],
          "any"
        ),
      ],
    },
    [ROLE_FILE("Everyone")]: { grants: [] },
  }
}

/**
 * Другий вид скоупу `team` поряд із прийнятим членством `org` — для кейсу між
 * видами (спека прав §5.1). Обидва види оголошено одним значенням `scopeKinds`:
 * `withRoles` зливає файли поверхнево, і `secondScopeKind()` повернув би
 * `org` форму `membership`. Решта файлів — з `secondScopeKind()`.
 */
export function adoptedCrossKind(): Layer {
  const { [PROJECT_FILE]: project, ...rest } = secondScopeKind()
  const [, team] = (project as { scopeKinds: unknown[] }).scopeKinds
  return {
    ...rest,
    [PROJECT_FILE]: {
      scopeKinds: [
        {
          ...ORG_SCOPE_KIND,
          setFunction: { schema: "public", name: "org_ids" },
        },
        team,
      ],
    },
  }
}

export const SOURCE_ROLE_FILE = "custom-tables/SourceRole/SourceRole.meta.json"
export const POLY_GRANT_FILE = "custom-tables/PolyGrant/PolyGrant.meta.json"
export const POLY_GRANTS_SOURCE_ID = uuid(6160)
export const POLY_CONTAINER_GRANTS_SOURCE_ID = uuid(6161)
/** Ключ `OrgMember` у таблиці ролей джерела `polyGrants`. */
export const ADOPTED_MEMBER_KEY = "member"

/**
 * Прийнята таблиця ролей: системна роль — рядок без тенанта (`orgId` —
 * `NULL`), кастомна роль тенанта може мати той самий ключ.
 */
export function sourceRoleTable(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(6150),
    kind: "CustomTable",
    name: "SourceRole",
    physicalName: "source_roles",
    kindLabel: "source_roles",
    scope: "none",
    columns: [
      column(6151, "id", "id", "UUID"),
      column(6152, "key", "key", "Text"),
      nullable(6153, "orgId", "org_id", "UUID"),
    ],
    primaryKey: { columns: ["id"] },
    ...overrides,
  }
}

/**
 * Поліморфна таблиця призначень: рівень рядка — `scopeType`, а `scopeId` —
 * тенант чи контейнер за рівнем; без FK і без `scopeColumn`.
 */
export function polyGrantTable(overrides: Record<string, unknown> = {}) {
  return {
    id: uuid(6155),
    kind: "CustomTable",
    name: "PolyGrant",
    physicalName: "poly_grants",
    kindLabel: "poly_grants",
    scope: "none",
    columns: [
      column(6156, "id", "id", "UUID"),
      nullable(6157, "memberId", "member_id", "UUID"),
      nullable(6158, "roleId", "role_id", "UUID"),
      column(6159, "scopeType", "scope_type", "Text"),
      column(6154, "scopeId", "scope_id", "UUID"),
    ],
    primaryKey: { columns: ["id"] },
    ...overrides,
  }
}

/** Роль через посилання на `SourceRole`: лише системні рядки без тенанта. */
export function sourceRoleRef(overrides: Record<string, unknown> = {}) {
  return {
    column: "roleId",
    references: ref("CustomTable", "SourceRole"),
    key: "key",
    where: [{ column: "orgId", isNull: true }],
    ...overrides,
  }
}

/** Колонки `columns` джерела `polyGrants` з перевизначеннями. */
export const polyColumns = (overrides: Record<string, unknown> = {}) => ({
  member: "memberId",
  scope: "scopeId",
  role: sourceRoleRef(),
  ...overrides,
})

/** Джерело рівня скоупу `org` над поліморфною `PolyGrant`. */
export function polyGrantsSource(overrides: Record<string, unknown> = {}) {
  return {
    id: POLY_GRANTS_SOURCE_ID,
    name: "polyGrants",
    assignedOn: { scopeKind: "org" },
    table: ref("CustomTable", "PolyGrant"),
    where: [{ column: "scopeType", equals: "org" }],
    columns: polyColumns(),
    ...overrides,
  }
}

/** Контейнерне джерело `Project` над тією самою `PolyGrant`. */
export function polyContainerGrantsSource(
  overrides: Record<string, unknown> = {}
) {
  return {
    id: POLY_CONTAINER_GRANTS_SOURCE_ID,
    name: "polyContainerGrants",
    assignedOn: { container: ref("Catalog", "Project") },
    table: ref("CustomTable", "PolyGrant"),
    where: [{ column: "scopeType", equals: "container" }],
    columns: {
      member: "memberId",
      container: "scopeId",
      role: sourceRoleRef(),
    },
    ...overrides,
  }
}

/**
 * Шар поліморфних призначень поверх `adoptedSources()` (спека прав §4.7): одна
 * таблиця `PolyGrant` під джерелом рівня скоупу `polyGrants` і контейнерним
 * `polyContainerGrants`, розділеними дискримінатором `scopeType`; роль — через
 * таблицю ролей `SourceRole` з умовою «без тенанта». Обидва рівні тоді покриті
 * джерелами, тож довідники прав `org` прибрано. `assignmentSources`
 * повторено повністю: шари зливаються поверхнево.
 */
export function polymorphicGrants(): Layer {
  const base = adoptedSources()
  return {
    [PROJECT_FILE]: {
      ...base[PROJECT_FILE],
      assignmentSources: [
        grantsSource(),
        globalGrantsSource({ table: ref("CustomTable", "GlobalGrant") }),
        polyGrantsSource(),
        polyContainerGrantsSource(),
      ],
    },
    [SOURCE_ROLE_FILE]: sourceRoleTable(),
    [POLY_GRANT_FILE]: polyGrantTable(),
    [ROLE_FILE("OrgMember")]: {
      sourceKeys: [{ source: "polyGrants", key: ADOPTED_MEMBER_KEY }],
    },
    [ROLE_FILE("ProjectLead")]: {
      sourceKeys: [
        { source: "grants", key: ADOPTED_LEAD_KEY },
        { source: "polyContainerGrants", key: ADOPTED_LEAD_KEY },
      ],
    },
    ...without(ORG_ROLES_FILE, ORG_ASSIGNMENTS_FILE),
  }
}

/**
 * Домен `polymorphicGrants()` з перевизначеннями джерел (за іменем) і шарами
 * таблиць поверх: джерела повторено повністю, бо шари зливаються поверхнево.
 */
export function polymorphicGrantsDomain(
  sources: {
    members?: Record<string, unknown>
    grants?: Record<string, unknown>
    polyGrants?: Record<string, unknown>
    polyContainerGrants?: Record<string, unknown>
  } = {},
  ...layers: Layer[]
): Map<string, string> {
  return adoptedSourcesDomain(
    polymorphicGrants(),
    {
      [PROJECT_FILE]: {
        membershipSources: [membersSource(sources.members)],
        assignmentSources: [
          grantsSource(sources.grants),
          globalGrantsSource({ table: ref("CustomTable", "GlobalGrant") }),
          polyGrantsSource(sources.polyGrants),
          polyContainerGrantsSource(sources.polyContainerGrants),
        ],
      },
    },
    ...layers
  )
}

/** Таблиця виду, яку читає дослівна функція множини виду `team` (бенчмарк знімка). */
export const BENCH_TEAM_SEAT_FILE = "catalogs/TeamSeat/TeamSeat.meta.json"
export const BENCH_TEAM_SEAT_TABLE = "team_seat"
/** Функція множини виду `team` з `teamScopeKind()`. */
export const BENCH_TEAM_SET_FUNCTION = "public.team_ids"
/** Вимір `zone`: значення користувача дає дослівна функція над `Zone`. */
export const BENCH_ZONE_DIMENSION_ID = uuid(6860)
export const BENCH_ZONE_FILE = "catalogs/Zone/Zone.meta.json"
export const BENCH_ZONE_TABLE = "zone"
export const BENCH_ZONE_FUNCTION = "public.zone_ids"
export const BENCH_ZONE_NOTE_FILE = "catalogs/ZoneNote/ZoneNote.meta.json"
const BENCH_ZONE_SQL_FILE = "sql/public/zone-ids.sql"

/**
 * Шар моделі бенчмарку знімка актора (план Права-3, Р3-9) поверх
 * `teamScopeKind()`: кожна форма джерела фактів, запис у яке міряє
 * сценарій 7. Контейнер — `Project` домену; вимір `zone` бере значення
 * дослівною функцією, що читає таблицю виду `Zone` і кличе функцію членства
 * `_member_scopes`; дослівна функція множини виду `team` читає таблицю виду
 * `TeamSeat` (місця користувачів у командах). `ZoneNote` мапить вимір на
 * об'єкт, щоб вимір діяв у праві, а не лише в проєкті.
 */
function snapshotBenchLayer(): Layer {
  return {
    [PROJECT_FILE]: {
      accessDimensions: [
        regionDimension(),
        {
          id: BENCH_ZONE_DIMENSION_ID,
          name: "zone",
          target: ref("Catalog", "Zone"),
          values: { function: { schema: "public", name: "zone_ids" } },
        },
      ],
    },
    [BENCH_TEAM_SEAT_FILE]: catalog(
      uuid(6851),
      "TeamSeat",
      BENCH_TEAM_SEAT_TABLE,
      {
        scope: "none",
        attributes: [
          refAttribute(6852, "user", "user_id", ref("Catalog", "Users")),
          { id: uuid(6853), name: "team", physicalName: "team", type: "UUID" },
        ],
      }
    ),
    [BENCH_ZONE_FILE]: catalog(uuid(6861), "Zone", BENCH_ZONE_TABLE, {
      attributes: [
        refAttribute(6862, "keeper", "keeper_id", ref("Catalog", "Users")),
      ],
    }),
    [BENCH_ZONE_NOTE_FILE]: catalog(uuid(6863), "ZoneNote", "zone_note", {
      access: [{ attribute: "zone", dimension: "zone" }],
      attributes: [
        refAttribute(6864, "zone", "zone_id", ref("Catalog", "Zone")),
      ],
    }),
  }
}

/**
 * Модель бенчмарку знімка: `policyDomain(adminRoles(), teamScopeKind())` з
 * шаром `snapshotBenchLayer()` і дослівними функціями виміру й множини. SQL —
 * не метадані: `withRoles` зливає лише JSON, тож файли ставляться поверх, а
 * функція множини замінює заглушку `metaFiles`. `layers` — поверх шару
 * бенчмарку (сценарій створення тенанта додає `tenantSelfService()`).
 */
export function snapshotBenchDomain(...layers: Layer[]): Map<string, string> {
  const files = policyDomain(
    adminRoles(),
    teamScopeKind(),
    snapshotBenchLayer(),
    ...layers
  )
  const shell = "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''"
  files.set(
    SCOPE_FUNCTIONS_FILE,
    `CREATE FUNCTION ${BENCH_TEAM_SET_FUNCTION}() RETURNS SETOF uuid ${shell} AS $$ SELECT s.team FROM public.${BENCH_TEAM_SEAT_TABLE} s WHERE s.user_id = (SELECT simetra.current_user_id()) $$;`
  )
  files.set(
    BENCH_ZONE_SQL_FILE,
    `CREATE FUNCTION ${BENCH_ZONE_FUNCTION}() RETURNS SETOF uuid ${shell} AS $$ SELECT z.id FROM public.${BENCH_ZONE_TABLE} z WHERE z.keeper_id = (SELECT simetra.current_user_id()) AND z.org_id IN (SELECT public.org_member_member_scopes()) $$;`
  )
  return files
}

/** Скоуплений регістр зв'язку виміру `region` з суб'єктом-«Користувачем». */
export const SNAPSHOT_USER_REGION_TABLE = "user_region"
/** Прийнятий зв'язок виміру `badge` з «Користувачем». */
export const SNAPSHOT_USER_BADGE_TABLE = "user_badge"
/** Таблиця виду, яку читає дослівна функція множини виду `org`. */
export const SNAPSHOT_ORG_GUEST_TABLE = "org_guest"
const SNAPSHOT_ORG_GUEST_FILE = "catalogs/OrgGuest/OrgGuest.meta.json"
const SNAPSHOT_USER_BADGE_FILE = "custom-tables/UserBadge/UserBadge.meta.json"
const SNAPSHOT_BADGE_FILE = "catalogs/Badge/Badge.meta.json"
const SNAPSHOT_BADGE_DIMENSION_ID = uuid(6880)
const SNAPSHOT_REGION_NOTE_FILE = "catalogs/RegionNote/RegionNote.meta.json"

/**
 * Модель аналізу джерел знімка (план Права-3, Р3-6): кожна форма джерела
 * фактів актора поверх прийнятих джерел (`adoptedSourcesDomain`) і другого
 * виду `team` з довідником членства (`adoptedCrossKind`). Довідник членства —
 * `TeamMember`; прийняті джерела членства й призначень — `Membership`,
 * `RoleGrant` і `GlobalGrant` з таблицею ролей `SourceRole`; контейнер —
 * `Project`; вимір `region` — скоуплений регістр `UserRegion` з
 * суб'єктом-«Користувачем»; вимір `zone` — дослівна функція над таблицею виду
 * `Zone`, що кличе `team_member_member_scopes`; вимір `badge` — прийнятий
 * зв'язок `UserBadge`; дослівна функція множини виду `org` читає прийняте
 * членство й таблицю виду `OrgGuest`.
 */
export function snapshotSourcesDomain(): Map<string, string> {
  const files = adoptedSourcesDomain(adoptedCrossKind(), {
    [PROJECT_FILE]: {
      accessDimensions: [
        {
          ...regionDimension(),
          values: {
            relation: {
              object: ref("InformationRegister", "UserRegion"),
              subject: "user",
              value: "region",
            },
          },
        },
        {
          id: BENCH_ZONE_DIMENSION_ID,
          name: "zone",
          target: ref("Catalog", "Zone"),
          values: { function: { schema: "public", name: "zone_ids" } },
        },
        {
          id: SNAPSHOT_BADGE_DIMENSION_ID,
          name: "badge",
          target: ref("Catalog", "Badge"),
          values: {
            relation: {
              object: ref("CustomTable", "UserBadge"),
              subject: "user",
              value: "badge",
            },
          },
        },
      ],
      membershipSources: [membersSource()],
      assignmentSources: [
        grantsSource(),
        globalGrantsSource({
          table: ref("CustomTable", "GlobalGrant"),
          columns: { member: "memberId", role: sourceRoleRef() },
        }),
      ],
    },
    [USER_REGION_FILE]: {
      id: uuid(6070),
      kind: "InformationRegister",
      name: "UserRegion",
      physicalName: SNAPSHOT_USER_REGION_TABLE,
      kindLabel: SNAPSHOT_USER_REGION_TABLE,
      scope: "org",
      dimensions: [
        refAttribute(6071, "user", "user_id", ref("Catalog", "Users")),
        refAttribute(6072, "region", "region_id", ref("Catalog", "Region")),
      ],
    },
    [SNAPSHOT_REGION_NOTE_FILE]: catalog(
      uuid(6881),
      "RegionNote",
      "region_note",
      {
        access: [
          { attribute: "region", dimension: "region" },
          { attribute: "zone", dimension: "zone" },
          { attribute: "badge", dimension: "badge" },
        ],
        attributes: [
          refAttribute(6882, "region", "region_id", ref("Catalog", "Region")),
          refAttribute(6883, "zone", "zone_id", ref("Catalog", "Zone")),
          refAttribute(6884, "badge", "badge_id", ref("Catalog", "Badge")),
        ],
      }
    ),
    [BENCH_ZONE_FILE]: catalog(uuid(6861), "Zone", BENCH_ZONE_TABLE, {
      attributes: [
        refAttribute(6862, "keeper", "keeper_id", ref("Catalog", "Users")),
        { id: uuid(6893), name: "team", physicalName: "team_id", type: "UUID" },
      ],
    }),
    [SNAPSHOT_BADGE_FILE]: catalog(uuid(6885), "Badge", "badge"),
    [SNAPSHOT_USER_BADGE_FILE]: {
      id: uuid(6886),
      kind: "CustomTable",
      name: "UserBadge",
      physicalName: SNAPSHOT_USER_BADGE_TABLE,
      scope: "org",
      scopeColumn: "orgId",
      columns: [
        column(6892, "orgId", "org_id", "UUID"),
        column(6887, "user", "user_id", "UUID"),
        column(6888, "badge", "badge_id", "UUID"),
      ],
      foreignKeys: [
        {
          name: "user_badge_user_fk",
          columns: ["user"],
          references: { object: ref("Catalog", "Users"), key: "ref" },
        },
        {
          name: "user_badge_badge_fk",
          columns: ["badge"],
          references: { object: ref("Catalog", "Badge"), key: "ref" },
        },
      ],
    },
    [SNAPSHOT_ORG_GUEST_FILE]: catalog(
      uuid(6889),
      "OrgGuest",
      SNAPSHOT_ORG_GUEST_TABLE,
      {
        scope: "none",
        attributes: [
          refAttribute(6890, "user", "user_id", ref("Catalog", "Users")),
          { id: uuid(6891), name: "org", physicalName: "org", type: "UUID" },
        ],
      }
    ),
    [GLOBAL_GRANT_FILE]: globalGrantTable({
      columns: [
        column(6116, "id", "id", "UUID"),
        nullable(6117, "memberId", "member_id", "UUID"),
        nullable(6119, "roleId", "role_id", "UUID"),
      ],
    }),
    [SOURCE_ROLE_FILE]: sourceRoleTable(),
    [ROLE_FILE("Support")]: {
      sourceKeys: [{ source: "globalGrants", key: ADOPTED_SUPPORT_KEY }],
    },
  })
  const shell = "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''"
  files.set(
    SCOPE_FUNCTIONS_FILE,
    `CREATE FUNCTION public.org_ids() RETURNS SETOF uuid ${shell} AS $$ SELECT m.org_id FROM public.membership m WHERE m.user_id = (SELECT simetra.current_user_id()) AND m.is_active IS TRUE UNION SELECT g.org FROM public.${SNAPSHOT_ORG_GUEST_TABLE} g WHERE g.user_id = (SELECT simetra.current_user_id()) $$;`
  )
  files.set(
    BENCH_ZONE_SQL_FILE,
    `CREATE FUNCTION ${BENCH_ZONE_FUNCTION}() RETURNS SETOF uuid ${shell} AS $$ SELECT z.id FROM public.${BENCH_ZONE_TABLE} z WHERE z.keeper_id = (SELECT simetra.current_user_id()) AND z.team_id IN (SELECT public.team_member_member_scopes()) $$;`
  )
  return files
}

/** Таблиці й ролі моделі DB-доказу знімка актора (`actorSnapshotDomain`). */
export const ACTOR_SNAPSHOT = {
  teamKindId: uuid(8101),
  teamSeat: BENCH_TEAM_SEAT_TABLE,
  teamSetFunction: "public.team_ids",
  zone: BENCH_ZONE_TABLE,
  zoneDimensionId: BENCH_ZONE_DIMENSION_ID,
  userRegion: SNAPSHOT_USER_REGION_TABLE,
  homeRegionDimensionId: uuid(8102),
  regionNote: "region_note",
  ownEditorId: uuid(8104),
  regionNoteWriterId: uuid(8105),
  zoneWriterId: uuid(8106),
  commentUpdaterId: uuid(8108),
} as const

/**
 * Шар DB-доказу знімка актора (план Права-3, Задача 6) поверх домену
 * політик: кожна форма джерела, яку знімок має взяти до першої зміни. Вид
 * скоупу `team` — дослівна функція множини над таблицею виду `TeamSeat`
 * (місця користувачів; корінь зовнішній, як у бенчмарку: об'єктів виду
 * немає, бо права на них дає лише рівень скоупу з членством); вимір `zone` —
 * дослівна функція над таблицею виду `Zone`, що кличе функцію членства й
 * дає ще й `NULL`; вимір `homeRegion` — скоуплений регістр зв'язку
 * `UserRegion` з суб'єктом-«Користувачем»; `RegionNote` мапить обидва виміри.
 * `Zone` прив'язана до контейнера `Project`. Ролі: `TaskOwnEditor` (запис
 * власних коментарів задач), `ProjectZoneWriter` (контейнерна, запис `Zone`;
 * у документів ядра команд немає) і `RegionNoteWriter` (обсяги обох вимірів).
 */
function actorSnapshotLayer(): Layer {
  const S = ACTOR_SNAPSHOT
  const regionNote = objects(["Catalog", "RegionNote"])
  const comment = objects(["Catalog", "TaskComment"])
  return {
    [PROJECT_FILE]: {
      scopeKinds: [
        ORG_SCOPE_KIND,
        {
          id: S.teamKindId,
          name: "team",
          physicalName: "team_id",
          root: {
            external: { schema: "public", table: "teams", column: "id" },
          },
          setFunction: { schema: "public", name: "team_ids" },
        },
      ],
      accessDimensions: [
        regionDimension(),
        {
          id: S.zoneDimensionId,
          name: "zone",
          target: ref("Catalog", "Zone"),
          values: { function: { schema: "public", name: "zone_ids" } },
        },
        {
          id: S.homeRegionDimensionId,
          name: "homeRegion",
          target: ref("Catalog", "Region"),
          values: {
            relation: {
              object: ref("InformationRegister", "UserRegion"),
              subject: "user",
              value: "region",
            },
          },
        },
      ],
    },
    [BENCH_TEAM_SEAT_FILE]: catalog(uuid(6851), "TeamSeat", S.teamSeat, {
      scope: "none",
      attributes: [
        refAttribute(6852, "user", "user_id", ref("Catalog", "Users")),
        { id: uuid(6853), name: "team", physicalName: "team", type: "UUID" },
      ],
    }),
    [BENCH_ZONE_FILE]: catalog(uuid(6861), "Zone", S.zone, {
      containerBinding: "project",
      attributes: [
        refAttribute(6862, "keeper", "keeper_id", ref("Catalog", "Users")),
        refAttribute(8120, "project", "project_id", ref("Catalog", "Project")),
      ],
    }),
    [USER_REGION_FILE]: {
      id: uuid(6070),
      kind: "InformationRegister",
      name: "UserRegion",
      physicalName: S.userRegion,
      kindLabel: S.userRegion,
      scope: "org",
      dimensions: [
        refAttribute(6071, "user", "user_id", ref("Catalog", "Users")),
        refAttribute(6072, "region", "region_id", ref("Catalog", "Region")),
      ],
    },
    [SNAPSHOT_REGION_NOTE_FILE]: catalog(
      uuid(6881),
      "RegionNote",
      S.regionNote,
      {
        access: [
          { attribute: "region", dimension: "homeRegion" },
          { attribute: "zone", dimension: "zone" },
        ],
        attributes: [
          refAttribute(6882, "region", "region_id", ref("Catalog", "Region")),
          refAttribute(6883, "zone", "zone_id", ref("Catalog", "Zone")),
        ],
      }
    ),
    [ROLE_FILE("TaskOwnEditor")]: role(
      S.ownEditorId,
      "TaskOwnEditor",
      { scopeKind: "org" },
      {
        grants: [
          grant(comment, ["read"], "any"),
          grant(comment, ["update"], "own"),
        ],
      }
    ),
    [ROLE_FILE("ProjectZoneWriter")]: role(
      S.zoneWriterId,
      "ProjectZoneWriter",
      { container: ref("Catalog", "Project") },
      {
        grants: [
          grant(objects(["Catalog", "Zone"]), ["read", "update"], "any"),
        ],
      }
    ),
    // Архетип лише власних коментарів: `read any` з `req(update)` кастомній
    // ролі над ним дає лише дельта `allow` (розрізняльний рядок прав пари)
    [ROLE_FILE("CommentUpdater")]: role(
      S.commentUpdaterId,
      "CommentUpdater",
      { scopeKind: "org" },
      { grants: [grant(comment, ["read", "update"], "own")] }
    ),
    [ROLE_FILE("RegionNoteWriter")]: role(
      S.regionNoteWriterId,
      "RegionNoteWriter",
      { scopeKind: "org" },
      {
        grants: [
          grant(regionNote, ["read", "update"], { dimension: "homeRegion" }),
          grant(regionNote, ["read"], { dimension: "zone" }),
        ],
      }
    ),
  }
}

/**
 * Модель DB-доказу знімка актора: домен політик з шарами `layers` і
 * `actorSnapshotLayer()`; SQL дослівних функцій множини `team` і виміру
 * `zone` — файли поверх (`withRoles` зливає лише JSON). Функція виміру дає
 * й `NULL`: знімок значень береться з тією самою множиною, що й наживо.
 */
export function actorSnapshotDomain(...layers: Layer[]): Map<string, string> {
  const files = policyDomain(...layers, actorSnapshotLayer())
  const shell = "LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''"
  const S = ACTOR_SNAPSHOT
  files.set(
    SCOPE_FUNCTIONS_FILE,
    `CREATE FUNCTION ${S.teamSetFunction}() RETURNS SETOF uuid ${shell} AS $$ SELECT s.team FROM public.${S.teamSeat} s WHERE s.user_id = (SELECT simetra.current_user_id()) $$;`
  )
  files.set(
    BENCH_ZONE_SQL_FILE,
    `CREATE FUNCTION ${BENCH_ZONE_FUNCTION}() RETURNS SETOF uuid ${shell} AS $$ SELECT z.id FROM public.${S.zone} z WHERE z.keeper_id = (SELECT simetra.current_user_id()) AND z.org_id IN (SELECT public.org_member_member_scopes()) UNION ALL SELECT NULL::uuid WHERE (SELECT simetra.current_user_id()) IS NOT NULL $$;`
  )
  return files
}

/** Ідентифікатори моделі `adoptedSnapshotDomain`. */
export const ADOPTED_SNAPSHOT = {
  commentEditorId: uuid(8107),
  orgGuest: SNAPSHOT_ORG_GUEST_TABLE,
} as const

/**
 * Модель DB-доказу знімка над прийнятими джерелами (план Права-3, Задача 6):
 * членство виду `org` — прийнята `Membership` з активністю, призначення
 * `ProjectLead` — прийнята `RoleGrant` з активністю (`activeGrants`), вид
 * `team` — довідник членства `TeamMember` з роллю `TeamLead`. Ролей кожного
 * користувача немає: актор без призначень не має жодного рядка прав. Функція
 * множини `org` — активне членство, підтверджене рядком таблиці виду
 * `OrgGuest`: межа тенанта вужча за «мої скоупи», тож рядок `OrgGuest`
 * відкриває скоуп, права в якому актор уже має (`CommentEditor`: у
 * документів ядра команд немає, тож запис доводиться на довіднику). Колонка
 * скоупу `Membership` — без `NOT NULL`, як буває в прийнятій таблиці: рядок
 * без скоупу членства не дає ні наживо, ні в знімку.
 */
export function adoptedSnapshotDomain(): Map<string, string> {
  const files = adoptedSourcesDomain(adoptedCrossKind(), activeGrants(), {
    [MEMBERSHIP_FILE]: adoptedMembershipTable({
      columns: adoptedMembershipTable().columns.map((c) =>
        c.name === "orgId" ? nullable(6102, "orgId", "org_id", "UUID") : c
      ),
    }),
    [SNAPSHOT_ORG_GUEST_FILE]: catalog(
      uuid(6889),
      "OrgGuest",
      SNAPSHOT_ORG_GUEST_TABLE,
      {
        scope: "none",
        attributes: [
          refAttribute(6890, "user", "user_id", ref("Catalog", "Users")),
          { id: uuid(6891), name: "org", physicalName: "org", type: "UUID" },
        ],
      }
    ),
    [ROLE_FILE("CommentEditor")]: role(
      ADOPTED_SNAPSHOT.commentEditorId,
      "CommentEditor",
      { scopeKind: "org" },
      {
        grants: [
          // `create` — межа тенанта ядра стоїть лише на створенні (`scope_insert`)
          grant(
            objects(["Catalog", "TaskComment"]),
            ["create", "read", "update"],
            "any"
          ),
        ],
      }
    ),
    ...without(ROLE_FILE("Everyone")),
  })
  files.set(
    SCOPE_FUNCTIONS_FILE,
    `CREATE FUNCTION public.org_ids() RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT m.org_id FROM public.membership m WHERE m.user_id = (SELECT simetra.current_user_id()) AND m.is_active IS TRUE AND m.org_id IN (SELECT g.org FROM public.${SNAPSHOT_ORG_GUEST_TABLE} g WHERE g.user_id = (SELECT simetra.current_user_id())) $$;`
  )
  return files
}

export const TENANT_FOUNDER_ID = uuid(8201)
export const TENANT_OWNER_ID = uuid(8202)
export const TENANT_AUDITOR_ID = uuid(8203)
export const TENANT_ADMIN_ID = uuid(8204)
export const TENANT_READER_ID = uuid(8205)
export const COUNTRY_FILE = "catalogs/Country/Country.meta.json"
export const COUNTRY_ID = uuid(8210)

/**
 * Самообслуговування тенантів (спека П4 §6.13) поверх `withRoles`/`policyDomain`:
 * `Organization` з авторством і власністю `createdBy`; «кожен користувач»
 * `TenantFounder` створює корінь (`create@own`) і бачить власний профіль у
 * «Користувачах» — видима ціль `Ref` для кейсів перевірки посилань.
 * `TenantOwner` — творець кореня виду `org`; без `fullAccess` має рівно запис
 * кореня й учасників та адміністрування призначень. `TenantAuditor` має
 * `markDeletion` кореня, якого `TenantOwner` без `fullAccess` не має;
 * `TenantAdmin` лише адмініструє призначення, `TenantReader` лише читає корінь
 * (обидва ⊆ `TenantOwner`). `OrgMember` отримує поліморфний `Ref` і масив
 * `Ref` на нескоуплені цілі (`Users`, `Country`); `requiredMember` додає
 * обов'язковий `title` поруч із ними — композиція з `requiredMemberAttribute()`
 * перезаписала б реквізити `OrgMember` (шари зливаються поверхнево).
 * `memberRead: false` (лише разом із `fullAccess: false`) знімає з `TenantOwner`
 * грант на `OrgMember`: рядок членства творця невидимий йому й після гранту.
 * `memberRegions` додає `OrgMember` масив `Ref` і поліморфну пару на
 * скоуплений `Region`: цілі, чий скоуп звіряє перевірка рядка членства у
 * функції гранту (Р-A6-12).
 */
export function tenantSelfService(
  options: {
    fullAccess?: boolean
    requiredMember?: boolean
    founder?: boolean
    memberRead?: boolean
    memberRegions?: boolean
  } = {}
): Layer {
  const {
    fullAccess = true,
    requiredMember = false,
    founder = true,
    memberRead = true,
    memberRegions = false,
  } = options
  const organization = objects(["Catalog", "Organization"])
  const members = objects(["Catalog", "OrgMember"])
  const assignments = objects(["Catalog", "OrgRoleAssignments"])
  return {
    [ORGANIZATION_FILE]: { trackAuthor: true, ownership: ["createdBy"] },
    [USERS_FILE]: { ownership: ["ref"] },
    [COUNTRY_FILE]: catalog(COUNTRY_ID, "Country", "country", {
      scope: "none",
    }),
    [MEMBER_FILE]: {
      attributes: [
        refAttribute(6005, "user", "user_id", ref("Catalog", "Users")),
        {
          id: uuid(8211),
          name: "contact",
          physicalName: "contact",
          type: "Ref",
          allowedTypes: objects(["Catalog", "Users"], ["Catalog", "Country"]),
        },
        {
          ...refAttribute(
            8212,
            "countries",
            "countries",
            ref("Catalog", "Country")
          ),
          array: true,
        },
        ...(memberRegions
          ? [
              {
                ...refAttribute(
                  8240,
                  MEMBER_REGIONS,
                  MEMBER_REGIONS,
                  ref("Catalog", "Region")
                ),
                array: true,
              },
              {
                id: uuid(8241),
                name: MEMBER_FOCUS,
                physicalName: MEMBER_FOCUS,
                type: "Ref",
                allowedTypes: objects(
                  ["Catalog", "Region"],
                  ["Catalog", "Country"]
                ),
              },
            ]
          : []),
        ...(requiredMember
          ? [
              {
                id: uuid(7530),
                name: MEMBER_TITLE,
                physicalName: MEMBER_TITLE,
                type: "String",
                length: 50,
                required: true,
              },
            ]
          : []),
      ],
    },
    [ROLE_FILE("TenantFounder")]: role(
      TENANT_FOUNDER_ID,
      "TenantFounder",
      "everyUser",
      {
        grants: [
          ...(founder ? [grant(organization, ["create"], "own")] : []),
          grant(objects(["Catalog", "Users"]), ["read"], "own"),
        ],
      }
    ),
    [ROLE_FILE("TenantOwner")]: role(
      TENANT_OWNER_ID,
      "TenantOwner",
      { scopeKind: "org" },
      fullAccess
        ? { rootCreator: true, fullAccess: true }
        : {
            rootCreator: true,
            grants: [
              grant(organization, ["read", "update"], "any"),
              ...(memberRead
                ? [grant(members, ["read", "create", "update"], "any")]
                : []),
              grant(assignments, ["read", "administerRights"], "any"),
            ],
          }
    ),
    [ROLE_FILE("TenantAuditor")]: role(
      TENANT_AUDITOR_ID,
      "TenantAuditor",
      { scopeKind: "org" },
      { grants: [grant(organization, ["read", "markDeletion"], "any")] }
    ),
    [ROLE_FILE("TenantAdmin")]: role(
      TENANT_ADMIN_ID,
      "TenantAdmin",
      { scopeKind: "org" },
      { grants: [grant(assignments, ["read", "administerRights"], "any")] }
    ),
    [ROLE_FILE("TenantReader")]: role(
      TENANT_READER_ID,
      "TenantReader",
      { scopeKind: "org" },
      { grants: [grant(organization, ["read"], "any")] }
    ),
  }
}

/**
 * Вид `org` з коренем «Користувачі» і творцем кореня `TenantOwner` (спека П4
 * §6.13): рядок кореня створює провізія, а не команда, тож роль `rootCreator`
 * недосяжна — валідна модель без створення тенанта.
 */
export function usersRootCreator(): Layer {
  return {
    [PROJECT_FILE]: {
      scopeKinds: [
        { ...ORG_SCOPE_KIND, root: { object: ref("Catalog", "Users") } },
      ],
    },
    [ROLE_FILE("TenantOwner")]: role(
      TENANT_OWNER_ID,
      "TenantOwner",
      { scopeKind: "org" },
      { rootCreator: true, fullAccess: true }
    ),
  }
}

export const BRANCH_KIND_ID = uuid(8220)
export const BRANCH_FILE = "catalogs/Branch/Branch.meta.json"
export const BRANCH_MEMBER_FILE = "catalogs/BranchMember/BranchMember.meta.json"
export const BRANCH_ROLES_FILE = "catalogs/BranchRoles/BranchRoles.meta.json"
export const BRANCH_ASSIGNMENTS_FILE =
  "catalogs/BranchRoleAssignments/BranchRoleAssignments.meta.json"
export const BRANCH_ADMIN_ID = uuid(8226)
export const TENANT_OPERATOR_ID = uuid(8230)
export const GLOBAL_FOUNDER_ID = uuid(8231)
export const GLOBAL_FULL_ID = uuid(8232)

/**
 * Модель оператора (спека П4 §6.13): другий вид скоупу `branch` без
 * `rootCreator` — корінь `Branch`, учасники `BranchMember`, власні довідники
 * прав і роль `BranchAdmin` з `fullAccess`. Глобальні ролі: `TenantOperator`
 * створює `Branch`, `GlobalFounder` — `Organization` (вид з творцем: творця
 * отримує й глобальний актор, Р-A6-19), `GlobalFull` має `fullAccess` без явного
 * гранту на корені (Р-A6-1), `GlobalAdmin` адмініструє глобальні призначення.
 * `GlobalAdmin` — той самий файл, що в `adminRoles()`: `fullAccess: false`
 * явно, тож шар поверх `adminRoles()` дає саме цю роль.
 */
export function tenantOperator(): Layer {
  const branchKind = {
    id: BRANCH_KIND_ID,
    name: "branch",
    physicalName: "branch_id",
    root: { object: ref("Catalog", "Branch") },
    setFunction: "membership",
  }
  return {
    [PROJECT_FILE]: { scopeKinds: [ORG_SCOPE_KIND, branchKind] },
    [BRANCH_FILE]: catalog(uuid(8221), "Branch", "branch", {
      scope: "branch",
    }),
    [BRANCH_MEMBER_FILE]: catalog(uuid(8222), "BranchMember", "branch_member", {
      scope: "branch",
      membership: { user: "user" },
      attributes: [
        refAttribute(8223, "user", "user_id", ref("Catalog", "Users")),
      ],
    }),
    [BRANCH_ROLES_FILE]: systemCatalog(
      uuid(8224),
      "BranchRoles",
      "branch_roles",
      "rightsRoles",
      "branch"
    ),
    [BRANCH_ASSIGNMENTS_FILE]: systemCatalog(
      uuid(8225),
      "BranchRoleAssignments",
      "branch_role_assignments",
      "roleAssignments",
      "branch"
    ),
    [ROLE_FILE("BranchAdmin")]: role(
      BRANCH_ADMIN_ID,
      "BranchAdmin",
      { scopeKind: "branch" },
      { fullAccess: true }
    ),
    [ROLE_FILE("TenantOperator")]: role(
      TENANT_OPERATOR_ID,
      "TenantOperator",
      "global",
      { grants: [grant(objects(["Catalog", "Branch"]), ["create"], "any")] }
    ),
    [ROLE_FILE("GlobalFounder")]: role(
      GLOBAL_FOUNDER_ID,
      "GlobalFounder",
      "global",
      {
        grants: [
          grant(objects(["Catalog", "Organization"]), ["create"], "any"),
        ],
      }
    ),
    [ROLE_FILE("GlobalFull")]: role(GLOBAL_FULL_ID, "GlobalFull", "global", {
      fullAccess: true,
    }),
    [ROLE_FILE("GlobalAdmin")]: role(GLOBAL_ADMIN_ID, "GlobalAdmin", "global", {
      fullAccess: false,
      grants: [
        grant(
          objects(["Catalog", "GlobalRoleAssignments"]),
          ["read", "administerRights"],
          "any"
        ),
      ],
    }),
  }
}

/**
 * Створення кореня (спека прав §5.2, Р-A6-11) поверх домену політик:
 * самообслуговування й оператор разом; корінь `Organization` має другого
 * власника `owner` і ТЧ `sites` (`scopeRootCarrier()`) — `create@own` кореня
 * дає лише автор, а `INSERT` ТЧ кореня лишається колонковим.
 */
export function rootCreationDomain(): Map<string, string> {
  return policyDomain(
    scopeRootCarrier(),
    tenantSelfService(),
    tenantOperator(),
    {
      [ORGANIZATION_FILE]: {
        trackAuthor: true,
        ownership: ["createdBy", "owner"],
      },
    }
  )
}
