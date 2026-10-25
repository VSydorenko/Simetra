import {
  compile,
  promoteInput,
  type CompileResult,
  type PromoteInput,
} from "simetra/compiler"
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
 * Домен політик читання (план 2a2): кожна форма носія, яку денормалізує
 * платформа, і кожна таблиця, на яку лягає політика прав. `Task` — прямі
 * носії всіх трьох полів прав і ТЧ `checklist`; `TaskComment` і `TaskReport`
 * — власність шляхом через задачу (у коментаря — ТЧ `attachments`, другий
 * крок копії; у звіту — генерована колонка періоду типової нумерації);
 * регістр `TaskHours` — вимір доступу на виміру регістра й похідні таблиці;
 * «Користувачі» — носій-ключ і ТЧ `devices`; підписка `onWrite` на коментарі
 * пише рядок у службовий лічильник. Ролі читають усе скоуплене (`TaskReaders`
 * через `OrgMember`), а «Користувачів» — і рівень скоупу, і `Everyone` (свій
 * рядок), тож проєкт компілюється без попереджень. Шар поверх `withRoles`:
 * типові файли `rightsFiles` не змінюються.
 */
export function policyDomain(...layers: Layer[]): Map<string, string> {
  const files = withRoles(policyLayer(), ...layers)
  // Обробник лічильника — SQL-файл, а не метадані: шар `withRoles` зливає
  // лише JSON-об'єкти.
  files.set(
    COUNT_COMMENT_SQL_FILE,
    "CREATE FUNCTION public.count_comment() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$ BEGIN INSERT INTO public.comment_counter (comment_id) VALUES (NEW.id); RETURN NEW; END $$;"
  )
  return files
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
export const REASSIGN_ACTION_ID = uuid(6720)
export const BULLETIN_TABLE = "bulletin"
export const BULLETIN_FILE = "catalogs/Bulletin/Bulletin.meta.json"

/**
 * Ролі запису поверх `policyDomain()`: кастомна дія `reassign` на `Task`
 * (лише шапка `assignee`, без ТЧ); `TaskWriter` пише `Task` і коментарі,
 * `post` — лише `own`; `TaskMarker` лише позначає на видалення;
 * `ProjectWriter` — контейнерна роль, на якій мутація межі тенанта 2a2 дає
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
 * Нескоупована константа `Rate`: у глобальній ролі `Support` її `update`
 * природний для вставки й оновлення (Р2b1-7).
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

export const TAG_FILE = "custom-tables/Tag/Tag.meta.json"
export const TAG_ID = uuid(6590)

/**
 * Шар з прийнятою таблицею `Tag` (`public.tag`), яку `tagMapping` промотує
 * в довідник без кроків даних, змін типу й перетворень одиниць: план із
 * промоцією поверх домену політик (Р2a2-11).
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
 * (Р2a2-11).
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
