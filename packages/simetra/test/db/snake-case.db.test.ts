import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PLATFORM_ROLES } from "simetra/model"
import {
  ORG_ADMIN_ID,
  TASK_WRITER_ID,
  adminRoles,
  compileRights,
  policyDomain,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { snakeCaseTwin } from "../../src/compiler/__tests__/fixtures/snake-case"
import { commandAs } from "./connection"
import {
  deploy,
  assignmentRow,
  closureRights,
  describeTransaction,
  insert,
  seedAdministration,
  type Seed,
} from "./rights-seed"

/**
 * Повний цикл snake_case-проєкту з довідниками прав: політики,
 * тригери й функції прав виконує Postgres, тож рівність SQL компіляції не
 * доводить, що запис командою, `rights_mine()` і перевірка ескалації на
 * `COMMIT` працюють. Фізичні імена близнюка ті самі, що в camelCase, тож засів
 * спільний з `rights-guards`. Одне розгортання на опис.
 */
describe("snake_case project with rights catalogs", () => {
  const tx = describeTransaction()
  let ids: Seed = {}
  const claims = (user: string) => ({ sub: ids[user], role: "authenticated" })
  const command = (
    user: string,
    context: { action: string; object: string; root: string },
    sql: string
  ) =>
    commandAs(tx.client(), claims(user), context, sql, {
      after: "SET CONSTRAINTS ALL IMMEDIATE",
    })

  beforeAll(async () => {
    const result = await compileRights(
      snakeCaseTwin(policyDomain(writeRoles(), adminRoles()))
    )
    expect(result.diagnostics).toEqual([])
    expect(result.model!.project.naming.attributeCase).toBe("snake_case")
    const client = await tx.open()
    await deploy(client, result.model!)
    // Як у `rights-guards`: документ роль команд пише через ядро команд, а
    // предмет тут — політики й тригери прав над прямим записом.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    ids = await seedAdministration(client)
    // Учасник з роллю запису задач і задача, яку він змінює.
    await insert(client, "org_role_assignments", {
      org_id: ids.A,
      ...assignmentRow(ids["editor@A"]!, { archetype: TASK_WRITER_ID }),
    })
    ids.T1 = randomUUID()
    await insert(client, "task", {
      id: ids.T1,
      org_id: ids.A,
      project_id: ids.P1,
      date: new Date(),
    })
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
  }, 120_000)
  afterAll(() => tx.close())

  it("a member with a write role inserts and updates a task by command", async () => {
    const id = randomUUID()
    expect(
      await command(
        "editor",
        { action: "create", object: "task", root: id },
        `INSERT INTO public.task (id, org_id, project_id, date) VALUES ('${id}', '${ids.A}', '${ids.P1}', now()) RETURNING id`
      )
    ).toMatchObject({ rows: [{ id }] })
    expect(
      await command(
        "editor",
        { action: "update", object: "task", root: ids.T1! },
        `UPDATE public.task SET date = now() WHERE id = '${ids.T1}' RETURNING id`
      )
    ).toMatchObject({ rows: [{ id: ids.T1 }] })
  })

  it("rights_mine reads custom roles and their deltas as in camelCase", async () => {
    expect(await closureRights(tx.client(), ids)).toEqual([
      "task|read|dimension",
      "task|read|own",
    ])
  })

  it("self-assigning OrgAdmin is an escalation on COMMIT", async () => {
    const id = randomUUID()
    expect(
      await command(
        "admin",
        {
          action: "administerRights",
          object: "org_role_assignments",
          root: id,
        },
        `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ('${id}', '${ids.A}', '${ids["admin@A"]}', '${ORG_ADMIN_ID}')`
      )
    ).toMatchObject({ code: "42501", detail: "escalation" })
  })
})
