import { randomUUID } from "node:crypto"
import pg from "pg"
import type { CompiledModel } from "simetra/compiler"
import { RIGHTS_MAINTENANCE_SETTING } from "simetra/model"
import { renderDesiredState } from "simetra/schema"
import {
  COMMENT_TABLE,
  GLOBAL_ADMIN_ID,
  MEMBER_EDITOR_ID,
  ORG_ADMIN_ID,
  PROJECT_TICKET_WRITER_ID,
  PROJECT_WRITER_ID,
  RIGHTS_ADMIN_ID,
  TASK_COMMENT_OWN_WRITER_ID,
  TASK_EDITOR_ID,
  TASK_VIEWER_ID,
  TICKET_CHECKLIST_TABLE,
  TICKET_OWN_WRITER_ID,
  TICKET_READER_ID,
  TICKET_REGION_WRITER_ID,
  TICKET_TABLE,
  TICKET_TARGETS_READER_ID,
  TICKET_WRITER_ID,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { queryAs, testDatabaseUrl } from "./connection"

/**
 * Спільний засів DB-сценаріїв прав (`rights-functions`, `rights-policies`,
 * `rights-guards`, `snake-case`):
 * рядки довідників прав і транзакція опису. Засів іде від власника таблиць —
 * RLS його не обмежує.
 */

/** Ключі засіяних рядків → їхні id. */
export type Seed = Record<string, string>

/**
 * Таблиці прав розгорнутої моделі за клієнтом: `insert` вмикає для них режим
 * обслуговування (Р2d2-14). Перелік — з контрактів прав моделі, а не з імені
 * таблиці: регулярка за іменем мовчки пропустила б довідники прав нового виду
 * скоупу (`team_*`), і засів упав би на `rights-context`.
 */
const rightsTables = new WeakMap<pg.Client, ReadonlySet<string>>()

/** Розгортання моделі в транзакції клієнта і перелік її таблиць прав для `insert`. */
export async function deploy(
  client: pg.Client,
  model: CompiledModel
): Promise<void> {
  await client.query(renderDesiredState(model).sql)
  rightsTables.set(
    client,
    new Set(
      model.contracts.rightsCatalogs.flatMap((c) =>
        [c.roles.table, c.roles.delta, c.assignments.table].map(
          (t) => `${t.schema}.${t.name}`
        )
      )
    )
  )
}

/** Рядок у таблицю `public` від власника: RLS його не обмежує. */
export async function insert(
  client: pg.Client,
  table: string,
  values: Record<string, unknown>
): Promise<void> {
  const tables = rightsTables.get(client)
  // Без `deploy` перелік невідомий: мовчазне «не таблиця прав» дало б
  // відмову `rights-context` замість ясної причини.
  if (tables === undefined)
    throw new Error("insert: deploy the model on this client first")
  const columns = Object.keys(values)
  const rightsTable = tables.has(`public.${table}`)
  if (rightsTable)
    await client.query("SELECT set_config($1, 'on', true)", [
      RIGHTS_MAINTENANCE_SETTING,
    ])
  await client.query(
    `INSERT INTO public.${table} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
    Object.values(values)
  )
  if (rightsTable)
    await client.query("SELECT set_config($1, 'off', true)", [
      RIGHTS_MAINTENANCE_SETTING,
    ])
}

export interface Assignment {
  archetype?: string
  customRole?: string
  container?: string | null
  deletionMark?: boolean
}

/** Рядок довідника «Призначення ролей» без колонки скоупу рівня. */
export const assignmentRow = (subject: string, a: Assignment) => ({
  id: randomUUID(),
  subject,
  archetype: a.archetype ?? null,
  custom_role: a.customRole ?? null,
  container: a.container ?? null,
  deletion_mark: a.deletionMark ?? false,
})

export type Delta = [
  effect: "allow" | "deny",
  object: string,
  action: string,
  extent: "any" | "own" | "dimension",
  dimensionId?: string,
]

/** Рядок ТЧ дельт кастомної ролі рівня `org`. */
export const orgDeltaRow = (
  orgId: string,
  roleId: string,
  lineNumber: number,
  [effect, object, action, extent, dimensionId]: Delta
) => ({
  id: randomUUID(),
  org_id: orgId,
  parent_id: roleId,
  line_number: lineNumber,
  object,
  action,
  extent,
  dimension: dimensionId ?? null,
  effect,
})

/** Множина як масив тексту: порядок вирівнює тест, не колація бази. */
export const set = (call: string) =>
  `SELECT coalesce(array_agg(s::text), '{}') AS v FROM ${call} AS s`

/** Значення `v` єдиного рядка; масив — відсортований. */
export function outcome(result: { rows: { v: unknown }[] } | { code: string }) {
  if (!("rows" in result)) return result
  const v = result.rows[0]?.v
  return Array.isArray(v) ? [...(v as string[])].sort() : v
}

/** Транзакція опису: відкривається в `beforeAll`, відкочується в `afterAll`. */
export function describeTransaction(): {
  client: () => pg.Client
  open: () => Promise<pg.Client>
  close: () => Promise<void>
} {
  let current: pg.Client | undefined
  return {
    client: () => current!,
    open: async () => {
      const client = new pg.Client({ connectionString: testDatabaseUrl() })
      await client.connect()
      // `current` лише після успішного з'єднання: `close` не закриває клієнта, що не підключився
      current = client
      await client.query("BEGIN")
      return client
    },
    close: async () => {
      if (current === undefined) return
      // Відкат після збою засіву може сам впасти — першопричину це не затирає
      await current.query("ROLLBACK").catch(() => undefined)
      await current.end()
    },
  }
}

/**
 * Засів сценаріїв адміністрування прав (`rights-guards`, `snake-case`) над
 * `policyDomain(writeRoles(), adminRoles())`: тенанти A, B, C, учасники з
 * призначеннями, кастомні ролі й дельти. Фізичні імена від стилю атрибутів не
 * залежать, тож засів спільний для camelCase і snake_case-близнюка.
 */
export async function seedAdministration(client: pg.Client): Promise<Seed> {
  const ids: Seed = {}
  const row = async (
    key: string,
    table: string,
    values: Record<string, unknown> = {}
  ) => {
    ids[key] = randomUUID()
    await insert(client, table, { ...values, id: ids[key] })
  }
  const member = (key: string, org: string, user: string | null) =>
    row(key, "org_member", {
      org_id: ids[org],
      user_id: user === null ? null : ids[user],
    })
  const assign = (
    key: string,
    memberKey: string,
    archetype: string,
    container?: string
  ) =>
    row(key, "org_role_assignments", {
      org_id: ids.A,
      ...assignmentRow(ids[memberKey]!, {
        archetype,
        container: container === undefined ? null : ids[container],
      }),
    })
  for (const org of ["A", "B", "C"]) await row(org, "organization")
  for (const user of [
    "root",
    "root2",
    "bAdmin",
    "cAdmin",
    "admin",
    "editor",
    "viewer",
    "target",
    "other",
    "memberEditor",
    "gAdmin",
  ]) {
    ids[user] = await signUp(client)
    await member(`${user}@A`, "A", user)
  }
  // Люди без членства в A: членство тримає UNIQUE (скоуп, користувач), тож
  // підставити в рядок A можна лише того, хто ще не учасник A.
  ids.outsider = await signUp(client)
  await member("bAdmin@B", "B", "bAdmin")
  await member("cAdmin@C", "C", "cAdmin")
  await member("invite@A", "A", null)
  // Запрошений рядок без призначень: його самоприйняття прав не додає.
  await member("bareInvite@A", "A", null)
  await row("P1", "project", { org_id: ids.A })
  await row("P2", "project", { org_id: ids.A })
  await row("R1", "region", { org_id: ids.A })
  await assign("rootRole", "root@A", ORG_ADMIN_ID)
  await assign("root2Role", "root2@A", ORG_ADMIN_ID)
  await row("bRole", "org_role_assignments", {
    org_id: ids.B,
    ...assignmentRow(ids["bAdmin@B"]!, { archetype: ORG_ADMIN_ID }),
  })
  await row("cRole", "org_role_assignments", {
    org_id: ids.C,
    ...assignmentRow(ids["cAdmin@C"]!, { archetype: ORG_ADMIN_ID }),
  })
  // «Користувачі» — глобальний рівень: `update` на них дає глобальний
  // `fullAccess`, а бачить їх учасник спільного скоупу (членство в A).
  await row(
    "gAdminRole",
    "global_role_assignments",
    assignmentRow(ids.gAdmin!, { archetype: GLOBAL_ADMIN_ID })
  )
  await assign("adminRole", "admin@A", RIGHTS_ADMIN_ID)
  await assign("editorRole", "editor@A", TASK_EDITOR_ID)
  await assign("editorAdminRole", "editor@A", RIGHTS_ADMIN_ID)
  await assign("viewerRole", "viewer@A", TASK_VIEWER_ID)
  await assign("viewerAdminRole", "viewer@A", RIGHTS_ADMIN_ID)
  await assign("memberEditorRole", "memberEditor@A", MEMBER_EDITOR_ID)
  await row("heldCustom", "org_roles", {
    org_id: ids.A,
    archetype: TASK_VIEWER_ID,
  })
  await row("heldRole", "org_role_assignments", {
    org_id: ids.A,
    ...assignmentRow(ids["admin@A"]!, { customRole: ids.heldCustom }),
  })
  await row("closureCustom", "org_roles", {
    org_id: ids.A,
    archetype: TASK_VIEWER_ID,
  })
  await insert(
    client,
    "org_roles_delta",
    orgDeltaRow(ids.A!, ids.closureCustom!, 1, ["deny", "task", "read", "any"])
  )
  await insert(
    client,
    "org_roles_delta",
    orgDeltaRow(ids.A!, ids.closureCustom!, 2, [
      "allow",
      "task",
      "update",
      "any",
    ])
  )
  await row("inUseCustom", "org_roles", {
    org_id: ids.A,
    archetype: TASK_VIEWER_ID,
  })
  await row("inUseRole", "org_role_assignments", {
    org_id: ids.A,
    ...assignmentRow(ids["target@A"]!, { customRole: ids.inUseCustom }),
  })
  await row("unusedCustom", "org_roles", {
    org_id: ids.A,
    archetype: TASK_VIEWER_ID,
  })
  await row("baselineCustom", "org_roles", {
    org_id: ids.A,
    archetype: TASK_EDITOR_ID,
  })
  await row("moveRole", "org_role_assignments", {
    org_id: ids.A,
    ...assignmentRow(ids["target@A"]!, {
      archetype: PROJECT_WRITER_ID,
      container: ids.P1,
    }),
  })
  await row("inviteRole", "org_role_assignments", {
    org_id: ids.A,
    ...assignmentRow(ids["invite@A"]!, { archetype: ORG_ADMIN_ID }),
  })
  // Права в іншому тенанті не покривають приріст у цьому: повний доступ у B
  // і лише адміністрування прав у A.
  await assign("bAdminRightsRole", "bAdmin@A", RIGHTS_ADMIN_ID)
  // Позначені рядки — база для зняття позначки, що дає повний приріст (Р2c2-5).
  await row("markedRole", "org_role_assignments", {
    org_id: ids.A,
    ...assignmentRow(ids["target@A"]!, {
      archetype: ORG_ADMIN_ID,
      deletionMark: true,
    }),
  })
  await row("markedCustom", "org_roles", {
    org_id: ids.A,
    archetype: TASK_EDITOR_ID,
    deletion_mark: true,
  })
  await row("targetRole", "org_role_assignments", {
    org_id: ids.A,
    ...assignmentRow(ids["target@A"]!, { archetype: TASK_VIEWER_ID }),
  })
  return ids
}

/** Права рівня скоупу `rights_mine()` як відсортовані `об'єкт|дія|обсяг`. */
const SCOPE_MINE =
  "SELECT coalesce(array_agg(m.object || '|' || m.action || '|' || m.extent ORDER BY m.object, m.action, m.extent), '{}') AS v FROM simetra.rights_mine() m WHERE m.level = 'scope'"

/**
 * Права учасника `other@A`, якому призначено кастомну роль `closureCustom`
 * (архетип `TaskViewer`, дельти `deny task read any` і `allow task update`):
 * лишаються похідні обсяги читання архетипу без `any`.
 * Форма читає колонки кастомної ролі, позначки видалення й дельт — саме ті,
 * що в snake_case мають інше логічне ім'я, тож описи обох стилів звіряють
 * однаковий результат. Призначення відкочується разом з точкою збереження.
 */
export async function closureRights(
  client: pg.Client,
  ids: Seed
): Promise<string[]> {
  await client.query("SAVEPOINT closure_rights")
  try {
    await insert(client, "org_role_assignments", {
      org_id: ids.A,
      ...assignmentRow(ids["other@A"]!, { customRole: ids.closureCustom }),
    })
    const result = await queryAs<{ v: string[] }>(
      client,
      "authenticated",
      { sub: ids.other, role: "authenticated" },
      SCOPE_MINE
    )
    if (!("rows" in result)) throw new Error(`rights_mine: ${result.code}`)
    return result.rows[0]!.v
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT closure_rights")
  }
}

/**
 * Учасники засіву ядра команд: ключ користувача, організація, роль шару.
 * Експорт — щоб сітка «ядро ≡ RLS» будувалась із того самого переліку, а не
 * з копії.
 */
export const COMMAND_CORE_MEMBERS = [
  ["tw", "A", TICKET_WRITER_ID],
  ["to", "A", TICKET_OWN_WRITER_ID],
  ["tr", "A", TICKET_REGION_WRITER_ID],
  ["tp", "A", PROJECT_TICKET_WRITER_ID],
  ["rd", "A", TICKET_READER_ID],
  ["cw", "A", TASK_COMMENT_OWN_WRITER_ID],
  ["tb", "B", TICKET_WRITER_ID],
] as const

/**
 * Засів ядра команд (план A2) над `policyDomain(writeRoles(),
 * commandCoreLayer())`: організації A і B; користувачі з ролями шару —
 * `tw` (`TicketWriter`), `to` (`TicketOwnWriter`), `tr` (`TicketRegionWriter`,
 * регіон r1 у `MemberRegion`), `tp` (`ProjectTicketWriter` на P1), `rd`
 * (`TicketReader`), `cw` (`TaskCommentOwnWriter`), `tb` (`TicketWriter` у B);
 * кожен ще має `TicketTargetsReader`, бо без читання цілей посилання дали б
 * `command.invalid` раніше за перевірку права. Ієрархія `K1 → K2 → K3`: K2 і
 * K3 — свої для `to`, K1 — з чужим `assignee`, тож батько K2 для `to`
 * невидимий; K2 має рядок ТЧ `K2.l1`. `KR` — у регіоні r1 у P1, `KB` — рядок
 * тенанта B з рядком ТЧ `KB.l1`. `P2` — другий проєкт A (чужий контейнер
 * для `tp`). `KW` — `watchers = [NULL]`; `KL` — `subject` (project, P1) і
 * два рядки ТЧ `KL.l1` (з тим самим `subject`, для часткової зміни пари),
 * `KL.l2`; `KP` — предвизначений. Задачі `TO` (виконавець
 * `cw`) і `TA` (чужий) з коментарями `TO.c` і `TA.c`. Учасник `u`
 * організації `O` — ключ `u@O`.
 */
export async function seedCommandCore(client: pg.Client): Promise<Seed> {
  const ids: Seed = {}
  const create = async (
    key: string,
    table: string,
    values: Record<string, unknown> = {}
  ) => {
    ids[key] = randomUUID()
    await insert(client, table, { id: ids[key], ...values })
  }
  const assign = (member: string, a: Assignment) =>
    insert(client, "org_role_assignments", {
      org_id: ids[member.split("@")[1]!],
      ...assignmentRow(ids[member]!, a),
    })

  await create("A", "organization")
  await create("B", "organization")
  await create("P1", "project", { org_id: ids.A })
  await create("P2", "project", { org_id: ids.A })
  await create("PB", "project", { org_id: ids.B })
  await create("r1", "region", { org_id: ids.A })
  await create("r2", "region", { org_id: ids.A })
  for (const [user, org, role] of COMMAND_CORE_MEMBERS) {
    ids[user] = await signUp(client)
    const member = `${user}@${org}`
    await create(member, "org_member", { org_id: ids[org], user_id: ids[user] })
    await assign(
      member,
      role === PROJECT_TICKET_WRITER_ID
        ? { archetype: role, container: ids.P1 }
        : { archetype: role }
    )
    await assign(member, { archetype: TICKET_TARGETS_READER_ID })
  }
  await insert(client, "member_region", {
    org_id: ids.A,
    member_id: ids["tr@A"],
    region_id: ids.r1,
  })

  const ticket = (key: string, org: string, values: Record<string, unknown>) =>
    create(key, TICKET_TABLE, { org_id: ids[org], ...values })
  await ticket("K1", "A", {
    assignee_id: ids["tw@A"],
    region_id: ids.r2,
    project_id: ids.P1,
  })
  await ticket("K2", "A", { parent_id: ids.K1, assignee_id: ids["to@A"] })
  await ticket("K3", "A", { parent_id: ids.K2, assignee_id: ids["to@A"] })
  await ticket("KR", "A", {
    assignee_id: ids["tw@A"],
    region_id: ids.r1,
    project_id: ids.P1,
  })
  await ticket("KB", "B", { assignee_id: ids["tb@B"], project_id: ids.PB })
  await create("K2.l1", TICKET_CHECKLIST_TABLE, {
    org_id: ids.A,
    parent_id: ids.K2,
    line_number: 1,
    related_id: ids.K1,
  })
  await create("KB.l1", TICKET_CHECKLIST_TABLE, {
    org_id: ids.B,
    parent_id: ids.KB,
    line_number: 1,
  })
  await ticket("KW", "A", { assignee_id: ids["tw@A"], watchers: [null] })
  const subject = { subject_type: "project", subject_id: ids.P1 }
  await ticket("KL", "A", { assignee_id: ids["tw@A"], ...subject })
  for (const line of [1, 2])
    await create(`KL.l${line}`, TICKET_CHECKLIST_TABLE, {
      org_id: ids.A,
      parent_id: ids.KL,
      line_number: line,
      ...(line === 1 ? subject : {}),
    })
  await ticket("KP", "A", { predefined_name: "main" })

  const now = new Date()
  await create("TO", "task", {
    org_id: ids.A,
    date: now,
    assignee_id: ids["cw@A"],
  })
  await create("TA", "task", {
    org_id: ids.A,
    date: now,
    assignee_id: ids["tw@A"],
  })
  await create("TO.c", COMMENT_TABLE, { org_id: ids.A, task_id: ids.TO })
  await create("TA.c", COMMENT_TABLE, { org_id: ids.A, task_id: ids.TA })
  return ids
}
