import { randomUUID } from "node:crypto"
import { expect } from "vitest"
import type pg from "pg"
import type { CompiledModel } from "simetra/compiler"
import {
  EVERYONE_ID,
  ORG_ADMIN_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_FILE,
  PROJECT_LEAD_ID,
  ROLE_FILE,
  SET_FILE,
  SUPPORT_ID,
  TASK_FILE,
  TEAM_LEAD_ID,
  USERS_FILE,
  compileRights,
  grant,
  objects,
  regionDimension,
  secondScopeKind,
  withRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import {
  type Assignment,
  type Delta,
  type Seed,
  assignmentRow,
  globalDeltaRow,
  insert,
  insertOrphan,
  orgDeltaRow,
  profileLayer,
} from "./rights-seed"

/**
 * Модель і засів опису «rights functions with a scope kind», спільні для
 * `rights-functions` і `rights-functions.supabase` (кейс сервісної ролі
 * провайдера).
 */

export const TASK = objects(["Document", "Task"])

/** Проєкт з видами скоупу `org` і `team`, виміром `region` і контейнером. */
export async function scopeKindModel(): Promise<CompiledModel> {
  const team = secondScopeKind()
  const result = await compileRights(
    withRoles(
      team,
      {
        [PROJECT_FILE]: {
          ...team[PROJECT_FILE],
          accessDimensions: [regionDimension()],
        },
        [TASK_FILE]: {
          ownership: ["assignee"],
          access: [{ attribute: "region", dimension: "region" }],
          containerBinding: "project",
        },
        [USERS_FILE]: { ownership: ["ref"] },
        [SET_FILE("TaskReaders")]: { grants: [grant(TASK, ["read"], "any")] },
        [SET_FILE("TaskEditors")]: { grants: [grant(TASK, ["update"], "own")] },
        [ROLE_FILE("ProjectLead")]: { grants: [grant(TASK, ["read"], "any")] },
        [ROLE_FILE("Support")]: {
          grants: [
            grant(objects(["Document", "Announcement"]), ["read"], "any"),
          ],
        },
        [ROLE_FILE("Everyone")]: {
          grants: [grant(objects(["Catalog", "Users"]), ["read"], "own")],
        },
      },
      profileLayer()
    )
  )
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/**
 * Сценарій опису «with a scope kind»: організації A і B, проєкти P1, P3 (з
 * позначкою видалення) в A і P2 у B, регіони A, користувачі `u1`–`u22`,
 * `x1`, `x2` з призначеннями з таблиці кейсів плану. Учасник `u` в
 * організації `O` — ключ `u@O`.
 */
export async function seedScopeKind(client: pg.Client): Promise<Seed> {
  const ids: Seed = {}
  const create = async (
    key: string,
    table: string,
    values: Record<string, unknown> = {}
  ) => {
    ids[key] = randomUUID()
    await insert(client, table, { id: ids[key], ...values })
  }
  const users = async (...keys: string[]) => {
    for (const key of keys) ids[key] = await signUp(client)
  }
  const member = (user: string, org = "A") =>
    create(`${user}@${org}`, "org_member", {
      org_id: ids[org],
      user_id: ids[user],
    })
  const assign = (user: string, a: Assignment, org = "A") =>
    insert(client, "org_role_assignments", {
      org_id: ids[org],
      ...assignmentRow(ids[`${user}@${org}`]!, a),
    })
  const assignGlobal = (user: string, a: Assignment) =>
    insert(client, "global_role_assignments", assignmentRow(ids[user]!, a))
  const customRole = async (
    key: string,
    archetype: string,
    deltas: Delta[],
    deletionMark = false
  ) => {
    await create(key, "org_roles", {
      org_id: ids.A,
      archetype,
      deletion_mark: deletionMark,
    })
    for (const [i, delta] of deltas.entries()) {
      await insert(
        client,
        "org_roles_delta",
        orgDeltaRow(ids.A!, ids[key]!, i + 1, delta)
      )
    }
  }

  await create("A", "organization")
  await create("B", "organization")
  await create("P1", "project", { org_id: ids.A })
  await create("P2", "project", { org_id: ids.B })
  await create("P3", "project", { org_id: ids.A, deletion_mark: true })
  for (const region of ["R1", "R2", "R3"]) {
    await create(region, "region", { org_id: ids.A })
  }
  await users(...Array.from({ length: 22 }, (_, i) => `u${i + 1}`), "x1", "x2")
  for (const user of [
    "u1",
    "u2",
    "u3",
    "u6",
    "u7",
    "u8",
    "u9",
    "u10",
    "u11",
    "u14",
    "u15",
    "u16",
    "u17",
    "u18",
    "u19",
    "u20",
    "u21",
    "u22",
    "x2",
  ]) {
    await member(user)
  }
  for (const user of ["u4", "u8", "u17"]) await member(user, "B")

  // u2 і x2: одна кастомна роль на `OrgMember` з усіма дельтами кейсів u2.
  await customRole("custom", ORG_MEMBER_ROLE_ID, [
    ["deny", "task", "read", "any"],
    ["allow", "task", "update", "any"],
    ["allow", "announcement", "read", "any"],
  ])
  // Дельти поза доменом рівня `org` — сироти: перевірка запису на COMMIT
  // їх уже не пропустила б, а читання мусить ігнорувати (fail-closed).
  const orphans: Delta[] = [
    ["allow", "announcement", "create", "any"],
    ["allow", "global_role_assignments", "read", "any"],
    ["allow", "gone", "read", "any"],
  ]
  for (const [i, delta] of orphans.entries())
    await insertOrphan(
      client,
      "org_roles_delta",
      orgDeltaRow(ids.A!, ids.custom!, i + 4, delta)
    )
  await customRole("denyRead", ORG_ADMIN_ID, [["deny", "task", "read", "any"]])
  await customRole("extents", ORG_ADMIN_ID, [
    ["deny", "task", "read", "any"],
    ["deny", "task", "update", "own"],
    ["deny", "task", "post", "any"],
  ])
  await customRole("onSupport", SUPPORT_ID, [])
  await customRole("deleted", ORG_MEMBER_ROLE_ID, [], true)

  await assign("u1", { archetype: ORG_MEMBER_ROLE_ID })
  await assign("u1", { archetype: PROJECT_LEAD_ID, container: ids.P1 })
  await assign("u2", { customRole: ids.custom })
  await assign("u3", { archetype: ORG_ADMIN_ID })
  await assignGlobal("u5", { archetype: SUPPORT_ID })
  await assign("u6", { archetype: ORG_MEMBER_ROLE_ID, deletionMark: true })
  await assign("u7", { archetype: ORG_MEMBER_ROLE_ID })
  await client.query("UPDATE public.users SET invalid = true WHERE id = $1", [
    ids.u7,
  ])
  await assign("u8", { archetype: PROJECT_LEAD_ID, container: ids.P2 })
  await assign("u9", { customRole: ids.denyRead })
  await assign("u10", { customRole: ids.extents })
  await assign("u11", { archetype: SUPPORT_ID })
  await assignGlobal("u12", { archetype: ORG_ADMIN_ID })
  await assignGlobal("u13", { archetype: PROJECT_LEAD_ID, container: ids.P1 })
  await assign("u14", { customRole: ids.onSupport })
  await assign("u15", { customRole: ids.deleted })
  await assign("u16", { archetype: PROJECT_LEAD_ID, container: null })
  await assign("u17", { archetype: ORG_MEMBER_ROLE_ID, container: ids.P2 })
  await assign("u18", { archetype: PROJECT_LEAD_ID, container: ids.P1 })
  await assign("u19", { archetype: EVERYONE_ID })
  await assign("u20", { archetype: TEAM_LEAD_ID })
  await assign("u21", { archetype: PROJECT_LEAD_ID, container: ids.P3 })
  await assign("x2", { customRole: ids.custom })
  // Спека прав Рх9: u22 має кастомну роль без `read@any` і окремо простий
  // `OrgMember` з ним — вимога з іншого призначення дії не рятує.
  await assign("u22", { customRole: ids.custom })
  await assign("u22", { archetype: ORG_MEMBER_ROLE_ID })
  // u23: кастомна роль глобального довідника з дельтою `allow` — у
  // глобальних призначень скоупу немає, тож дельта знаходиться не за ним.
  await users("u23")
  await create("globalCustom", "global_roles", { archetype: SUPPORT_ID })
  await insert(
    client,
    "global_roles_delta",
    globalDeltaRow(ids.globalCustom!, 1, [
      "allow",
      "announcement",
      "create",
      "any",
    ])
  )
  await assignGlobal("u23", { customRole: ids.globalCustom })

  // Спека прав §5.1: команда з `id` організації A, а учасники команди — з `id`
  // учасників u3 (OrgAdmin в A) і u1 (виконавець задачі в A).
  await insert(client, "team", { id: ids.A })
  await insert(client, "team_member", {
    id: ids["u3@A"],
    team_id: ids.A,
    user_id: ids.x1,
  })
  await insert(client, "team_member", {
    id: ids["u1@A"],
    team_id: ids.A,
    user_id: ids.x2,
  })

  const now = new Date()
  for (const [key, org, assignee] of [
    ["t1", "A", "u1@A"],
    ["t2", "A", "u2@A"],
    ["tx2", "A", "x2@A"],
    ["tB", "B", "u4@B"],
  ] as const) {
    await create(key, "task", {
      org_id: ids[org],
      date: now,
      assignee_id: ids[assignee],
    })
  }
  for (const [user, region] of [
    ["u1@A", "R1"],
    ["u1@A", "R2"],
    ["u3@A", "R3"],
  ] as const) {
    await insert(client, "member_region", {
      org_id: ids.A,
      member_id: ids[user],
      region_id: ids[region],
    })
  }
  return ids
}
