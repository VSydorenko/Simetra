import { randomUUID } from "node:crypto"
import type pg from "pg"
import {
  BULLETIN_TABLE,
  CHECKLIST_TABLE,
  COMMENT_TABLE,
  PROJECT_WRITER_ID,
  REGION_WRITER_ID,
  TASK_MARKER_ID,
  TASK_WRITER_ID,
  compileRights,
  policyDomain,
  writableRegister,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import type { CompiledModel } from "simetra/compiler"
import { expect } from "vitest"
import { signUp } from "./auth"
import {
  type Assignment,
  type Seed,
  assignmentRow,
  insert,
  profileLayer,
} from "./rights-seed"

/**
 * Модель і засів опису «command writes», спільні для `rights-write` і
 * `rights-write.supabase` (кейси сервісної ролі провайдера).
 */

/** Домен запису під профіль прогону. */
export async function writesModel(): Promise<CompiledModel> {
  const result = await compileRights(
    policyDomain(writeRoles(), writableRegister(), profileLayer())
  )
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/**
 * Засів: організації A, B; учасники w1 (A, `TaskWriter` і `RegionWriter`,
 * регіон r1 у `MemberRegion`), w2 (A, `TaskMarker`), w3 (B, `TaskWriter`),
 * w4 (A, лише `ProjectWriter` на P1), w5 (`TaskWriter` і в A, і в B —
 * `tenant-move`). Задачі A у P1: T1 (виконавець w2), T2 (w1, рядок ТЧ),
 * T5 (w1, проведена), T3 (w1, два рядки ТЧ і коментар), T4 (два рядки ТЧ, без
 * коментарів: коментар тримає задачу FK `NO ACTION`); T6 — задача A без
 * посилань і залежних рядків: її ключ і скоуп змінює лише тригер, не FK.
 * Задача B — TB у PB. Учасник `u` організації `O` — ключ `u@O`.
 */
export async function seedWrites(client: pg.Client): Promise<Seed> {
  const ids: Seed = { new: randomUUID() }
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

  for (const user of ["w1", "w2", "w3", "w4", "w5"])
    ids[user] = await signUp(client)
  await create("A", "organization")
  await create("B", "organization")
  for (const [member, org] of [
    ["w1", "A"],
    ["w2", "A"],
    ["w3", "B"],
    ["w4", "A"],
    ["w5", "A"],
    ["w5", "B"],
  ] as const) {
    await create(`${member}@${org}`, "org_member", {
      org_id: ids[org],
      user_id: ids[member],
    })
  }
  await create("P1", "project", { org_id: ids.A })
  await create("PB", "project", { org_id: ids.B })
  await create("r1", "region", { org_id: ids.A })
  await create("r2", "region", { org_id: ids.A })
  await create("BA", BULLETIN_TABLE, { org_id: ids.A })
  await create("BB", BULLETIN_TABLE, { org_id: ids.B })

  await assign("w1@A", { archetype: TASK_WRITER_ID })
  await assign("w1@A", { archetype: REGION_WRITER_ID })
  await assign("w2@A", { archetype: TASK_MARKER_ID })
  await assign("w3@B", { archetype: TASK_WRITER_ID })
  await assign("w4@A", { archetype: PROJECT_WRITER_ID, container: ids.P1 })
  await assign("w5@A", { archetype: TASK_WRITER_ID })
  await assign("w5@B", { archetype: TASK_WRITER_ID })
  await insert(client, "member_region", {
    org_id: ids.A,
    member_id: ids["w1@A"],
    region_id: ids.r1,
  })

  const now = new Date()
  const task = (
    key: string,
    org: string,
    values: Record<string, unknown>,
    lines = 0
  ) =>
    create(key, "task", { org_id: ids[org], date: now, ...values }).then(
      async () => {
        for (let line = 1; line <= lines; line++)
          await create(`${key}.l${line}`, CHECKLIST_TABLE, {
            org_id: ids[org],
            parent_id: ids[key],
            line_number: line,
          })
      }
    )
  await task("T1", "A", { project_id: ids.P1, assignee_id: ids["w2@A"] })
  await task("T2", "A", { project_id: ids.P1, assignee_id: ids["w1@A"] }, 1)
  await task("T5", "A", {
    project_id: ids.P1,
    assignee_id: ids["w1@A"],
    posted: true,
  })
  await task("T3", "A", { project_id: ids.P1, assignee_id: ids["w1@A"] }, 2)
  await task("T4", "A", { project_id: ids.P1 }, 2)
  await task("T6", "A", {})
  await task("TB", "B", { project_id: ids.PB, assignee_id: ids["w3@B"] })
  await create("T3.c", COMMENT_TABLE, { org_id: ids.A, task_id: ids.T3 })
  return ids
}
