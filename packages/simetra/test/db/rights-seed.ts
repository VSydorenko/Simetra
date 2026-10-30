import { randomUUID } from "node:crypto"
import pg from "pg"
import { RIGHTS_MAINTENANCE_SETTING } from "simetra/model"
import {
  COMMENT_TABLE,
  PROJECT_TICKET_WRITER_ID,
  TASK_COMMENT_OWN_WRITER_ID,
  TICKET_CHECKLIST_TABLE,
  TICKET_OWN_WRITER_ID,
  TICKET_READER_ID,
  TICKET_REGION_WRITER_ID,
  TICKET_TABLE,
  TICKET_TARGETS_READER_ID,
  TICKET_WRITER_ID,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { testDatabaseUrl } from "./connection"

/**
 * Спільний засів DB-сценаріїв прав (`rights-functions`, `rights-policies`):
 * рядки довідників прав і транзакція опису. Засів іде від власника таблиць —
 * RLS його не обмежує.
 */

/** Ключі засіяних рядків → їхні id. */
export type Seed = Record<string, string>

/** Рядок у таблицю `public` від власника: RLS його не обмежує. */
export async function insert(
  client: pg.Client,
  table: string,
  values: Record<string, unknown>
): Promise<void> {
  const columns = Object.keys(values)
  const rightsTable =
    /^(?:org|global)_(?:roles(?:_delta)?|role_assignments)$/.test(table)
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
 * Засів ядра команд (план A2) над `policyDomain(writeRoles(),
 * commandCoreLayer())`: організації A і B; користувачі з ролями шару —
 * `tw` (`TicketWriter`), `to` (`TicketOwnWriter`), `tr` (`TicketRegionWriter`,
 * регіон r1 у `MemberRegion`), `tp` (`ProjectTicketWriter` на P1), `rd`
 * (`TicketReader`), `cw` (`TaskCommentOwnWriter`), `tb` (`TicketWriter` у B);
 * кожен ще має `TicketTargetsReader`, бо без читання цілей посилання дали б
 * `command.invalid` раніше за перевірку права. Ієрархія `K1 → K2 → K3`: K2 і
 * K3 — свої для `to`, K1 — з чужим `assignee`, тож батько K2 для `to`
 * невидимий; K2 має рядок ТЧ `K2.l1`. `KR` — у регіоні r1 у P1, `KB` — рядок
 * тенанта B. Задачі `TO` (виконавець `cw`) і `TA` (чужий) з коментарями
 * `TO.c` і `TA.c`. Учасник `u` організації `O` — ключ `u@O`.
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
  const members = [
    ["tw", "A", TICKET_WRITER_ID],
    ["to", "A", TICKET_OWN_WRITER_ID],
    ["tr", "A", TICKET_REGION_WRITER_ID],
    ["tp", "A", PROJECT_TICKET_WRITER_ID],
    ["rd", "A", TICKET_READER_ID],
    ["cw", "A", TASK_COMMENT_OWN_WRITER_ID],
    ["tb", "B", TICKET_WRITER_ID],
  ] as const
  await create("P1", "project", { org_id: ids.A })
  await create("PB", "project", { org_id: ids.B })
  await create("r1", "region", { org_id: ids.A })
  await create("r2", "region", { org_id: ids.A })
  for (const [user, org, role] of members) {
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
