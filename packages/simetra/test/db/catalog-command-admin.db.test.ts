import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  COMMAND_CORE_ERRORS,
  COMMAND_SETTING,
  PLATFORM_ROLES,
  SESSION_CLAIMS_SETTING,
  type CommandContext,
} from "simetra/model"
import { uuid } from "../../src/compiler/__tests__/helpers"
import {
  PROJECT_WRITER_ID,
  RIGHTS_ADMIN_ID,
  ROLE_FILE,
  TASK_EDITOR_ID,
  TASK_VIEWER_ID,
  USERS_FILE,
  adminRoles,
  compileRights,
  grant,
  objects,
  policyDomain,
  role,
  writeRoles,
  type Layer,
} from "../../src/compiler/__tests__/fixtures/rights"
import type { Refusal } from "./connection"
import {
  deploy,
  type Seed,
  assignmentRow,
  describeTransaction,
  insert,
  orgDeltaRow,
  seedAdministration,
} from "./rights-seed"

/**
 * Ядро системних довідників прав і «Користувачів».
 * Запобіжники прав (`role-in-use`, ⊆, останній `fullAccess`) — відкладені
 * тригери, що судять транзакцію на `COMMIT`; компілятор бачить лише текст
 * тіла, тож чи не спрацьовують вони хибно на порожньому `UPDATE` шапки, вирішує
 * Postgres. `COMMIT` тут — `SET CONSTRAINTS ALL IMMEDIATE` у точці збереження,
 * як у `rights-guards.db.test.ts`. Роль команд має лише згенеровані гранти:
 * доказ — контракт ролі, а не повний DML.
 */

const E = COMMAND_CORE_ERRORS
const INVALID = (detail: string): Refusal => ({
  code: E.invalid.errcode,
  message: E.invalid.message,
  detail,
})
const ROLES = "org_roles"
const DELTA = "org_roles_delta"
const ASSIGNMENTS = "org_role_assignments"

/** Реквізит застосунку на «Користувачах»: ядро пише лише ключі гранту гілки. */
const nickname = (): Layer => ({
  [USERS_FILE]: {
    attributes: [
      {
        id: uuid(6960),
        name: "nickname",
        physicalName: "nickname",
        type: "String",
        length: 100,
      },
    ],
  },
})

const BLIND_RIGHTS_ADMIN_ID = uuid(6746)

/**
 * Адміністратор прав і його «сліпий» двійник:
 * `administerRights` не дає неявного читання членства, тож призначення
 * адресує учасника лише з явним `read` на довіднику членства свого рівня.
 * `RightsAdmin` тут отримує цей `read` шаром моделі файлу, а не зміною
 * типового `adminRoles()`: інші тести покладаються на його гранти.
 * `BlindRightsAdmin` — ті самі гранти без `read` на членстві: фіксує правило.
 */
const rightsAdmins = (): Layer => {
  const rights = grant(
    objects(["Catalog", "OrgRoles"], ["Catalog", "OrgRoleAssignments"]),
    ["read", "administerRights"],
    "any"
  )
  const task = grant(objects(["Document", "Task"]), ["read"], "any")
  return {
    [ROLE_FILE("RightsAdmin")]: role(
      RIGHTS_ADMIN_ID,
      "RightsAdmin",
      { scopeKind: "org" },
      {
        grants: [
          rights,
          task,
          grant(objects(["Catalog", "OrgMember"]), ["read"], "any"),
        ],
      }
    ),
    [ROLE_FILE("BlindRightsAdmin")]: role(
      BLIND_RIGHTS_ADMIN_ID,
      "BlindRightsAdmin",
      { scopeKind: "org" },
      { grants: [rights, task] }
    ),
  }
}

type Outcome =
  { result: Record<string, unknown>; probe: pg.QueryResultRow[] } | Refusal

describe("catalog command core on rights system catalogs and Users", () => {
  const tx = describeTransaction()
  let ids: Seed = {}
  const key = (name: string) => {
    // Невідомий ключ дав би `NULL` замість id — і зелений кейс без причини
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  /** Ключ засіву або вже готовий uuid (id нового рядка). */
  const idOf = (name: string) =>
    /^[0-9a-f-]{36}$/.test(name) ? name : key(name)

  beforeAll(async () => {
    const result = await compileRights(
      policyDomain(writeRoles(), adminRoles(), rightsAdmins(), nickname())
    )
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    // Лише згенеровані гранти: членство з `SET` потрібне `SET LOCAL ROLE`,
    // повного DML-гранту таблиць немає.
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    ids = await seedAdministration(client)
    // Відкладені ключі засіву перевіряються зараз: кейси починають з порожньої черги
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
  }, 120_000)
  afterAll(() => tx.close())

  /** Поточна версія рядка — читає власник, RLS її не ховає. */
  const versionOf = async (table: string, row: string) =>
    (
      await tx
        .client()
        .query<{ v: string }>(
          `SELECT version::text AS v FROM public.${table} WHERE id = $1`,
          [idOf(row)]
        )
    ).rows[0]!.v

  /**
   * Один виклик ядра як команда: claims, контекст, `SET LOCAL ROLE` ролі
   * команд, виклик, потім власник завершує відкладені запобіжники
   * (`SET CONSTRAINTS ALL IMMEDIATE` — це `COMMIT` команди) і читає `probe`.
   * Усе — у точці збереження: кейси не залежать від порядку. `commandAs` не
   * годиться — його `after` один оператор, а запобіжникам потрібен ще й
   * `SET CONSTRAINTS` до перевірки.
   */
  const core = async (
    user: string,
    context: CommandContext,
    sql: string,
    params: unknown[],
    probe?: string
  ): Promise<Outcome> => {
    const client = tx.client()
    await client.query("SAVEPOINT admin_core")
    try {
      await client.query("SELECT set_config($1, $2, true)", [
        SESSION_CLAIMS_SETTING,
        JSON.stringify({ sub: key(user), role: "authenticated" }),
      ])
      await client.query("SELECT set_config($1, $2, true)", [
        COMMAND_SETTING,
        JSON.stringify(context),
      ])
      await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      const { rows } = await client.query<{ r: string }>(sql, params)
      await client.query("RESET ROLE")
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      return {
        result: JSON.parse(rows[0]!.r) as Record<string, unknown>,
        probe: probe === undefined ? [] : (await client.query(probe)).rows,
      }
    } catch (error) {
      if (!(error instanceof pg.DatabaseError)) throw error
      const { code, message, detail, hint } = error
      return {
        code: code ?? "",
        message,
        ...(detail === undefined ? {} : { detail }),
        ...(hint === undefined ? {} : { hint }),
      }
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT admin_core")
    }
  }

  const save = (
    user: string,
    table: string,
    action: string,
    item: Record<string, unknown>,
    version: string | null,
    probe?: string
  ) =>
    core(
      user,
      { action, object: table, root: item.id as string },
      `SELECT public.${table}_save($1::jsonb, $2::bigint) AS r`,
      [JSON.stringify(item), version],
      probe
    )

  const admin = "administerRights"

  it("custom role with delta rows: save writes a command journal row", async () => {
    const id = randomUUID()
    const outcome = await save(
      "root",
      ROLES,
      admin,
      {
        id,
        org_id: key("A"),
        archetype: TASK_VIEWER_ID,
        tabular: {
          [DELTA]: [
            {
              id: randomUUID(),
              object: "task",
              action: "read",
              extent: "any",
              effect: "allow",
            },
          ],
        },
      },
      null,
      `SELECT DISTINCT reason, action, object FROM simetra.rights_journal WHERE row_id = '${id}' AND xid = txid_current()`
    )
    expect(outcome).toMatchObject({
      result: { id, tabular: { [DELTA]: [expect.anything()] } },
      probe: [{ reason: "command", action: admin, object: ROLES }],
    })
  })

  // Правка лише ТЧ ролі, яку тримає призначення: шапка оновлюється порожнім
  // `UPDATE` (версія +1, замок), і запобіжники не мають приймати його за
  // зміну ролі. Актор — `RightsAdmin` без `fullAccess`: дельта `allow task
  // read any` покрита його власним `read`, тож відмова означала б хибне ⊆.
  it("delta-only edit of a held role: no role-in-use, no escalation, version +1", async () => {
    const before = await versionOf(ROLES, "inUseCustom")
    const outcome = await save(
      "admin",
      ROLES,
      admin,
      {
        id: key("inUseCustom"),
        tabular: {
          [DELTA]: [
            {
              id: randomUUID(),
              object: "task",
              action: "read",
              extent: "any",
              effect: "allow",
            },
          ],
        },
      },
      before
    )
    expect(outcome).toMatchObject({
      result: {
        id: key("inUseCustom"),
        version: String(BigInt(before) + 1n),
      },
    })
  })

  it("mark_deletion of a role with a live assignment → role-in-use", async () => {
    const outcome = await core(
      "root",
      { action: admin, object: ROLES, root: key("inUseCustom") },
      `SELECT public.${ROLES}_mark_deletion($1::uuid, $2::bigint, true) AS r`,
      [key("inUseCustom"), await versionOf(ROLES, "inUseCustom")]
    )
    expect(outcome).toMatchObject({ code: "42501", detail: "role-in-use" })
  })

  // Спека прав §7: `_save` пише шапку раніше за ТЧ, тож перевірка домену на
  // операторі шапки відхилила б новий архетип з новими дельтами одним
  // викликом; на COMMIT судиться результат. Роль засіває власник у точці
  // збереження кейсу: `task_comment read any` — у домені `org`, але не
  // контейнерного рівня, `task read any` — у домені обох.
  it("save with a new archetype and deltas from the new level's domain passes", async () => {
    const client = tx.client()
    const id = randomUUID()
    await client.query("SAVEPOINT level_change")
    try {
      await insert(client, ROLES, {
        id,
        org_id: key("A"),
        archetype: TASK_EDITOR_ID,
      })
      await insert(
        client,
        DELTA,
        orgDeltaRow(key("A"), id, 1, ["allow", "task_comment", "read", "any"])
      )
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      await client.query("SET CONSTRAINTS ALL DEFERRED")
      const outcome = await save(
        "root",
        ROLES,
        admin,
        {
          id,
          archetype: PROJECT_WRITER_ID,
          tabular: {
            [DELTA]: [
              {
                id: randomUUID(),
                object: "task",
                action: "read",
                extent: "any",
                effect: "allow",
              },
            ],
          },
        },
        await versionOf(ROLES, id),
        `SELECT r.archetype, array_agg(d.object) AS objects FROM public.${ROLES} r JOIN public.${DELTA} d ON d.parent_id = r.id WHERE r.id = '${id}' GROUP BY r.archetype`
      )
      expect(outcome).toMatchObject({
        probe: [{ archetype: PROJECT_WRITER_ID, objects: ["task"] }],
      })
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT level_change")
    }
  })

  const assignCustom = (user: string) => {
    const id = randomUUID()
    return save(
      user,
      ASSIGNMENTS,
      admin,
      {
        id,
        org_id: key("A"),
        subject: key("target@A"),
        custom_role: key("unusedCustom"),
      },
      null,
      `SELECT subject, custom_role FROM public.${ASSIGNMENTS} WHERE id = '${id}'`
    )
  }

  // Перевірка видимості `subject` і `custom_role` не дає хибного
  // `command.invalid` ні типовому адміністратору прав (`RightsAdmin` з явним
  // `read` на членстві), ні адміністратору скоупу (`OrgAdmin`, `fullAccess`).
  it.each(["admin", "root"])(
    "assign a custom role to a member of the own tenant passes (%s)",
    async (user) => {
      const outcome = await assignCustom(user)
      expect(outcome).toMatchObject({
        probe: [{ subject: key("target@A"), custom_role: key("unusedCustom") }],
      })
    }
  )

  // Без `read` на членстві учасник власного тенанта невидимий так само, як
  // чужий: `administerRights` не дає неявного читання. Призначення
  // `BlindRightsAdmin` засіває власник у точці збереження цього кейсу.
  it("rights admin without read on membership → command.invalid subject", async () => {
    const client = tx.client()
    await client.query("SAVEPOINT blind_admin")
    try {
      await insert(client, ASSIGNMENTS, {
        org_id: key("A"),
        ...assignmentRow(key("other@A"), { archetype: BLIND_RIGHTS_ADMIN_ID }),
      })
      expect(await assignCustom("other")).toEqual(INVALID("subject"))
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT blind_admin")
    }
  })

  // Учасник чужого тенанта невидимий у скоупі рядка: та сама відмова, що й
  // для відсутнього рядка.
  it("assign to a member of another tenant → command.invalid subject", async () => {
    const id = randomUUID()
    expect(
      await save(
        "root",
        ASSIGNMENTS,
        admin,
        {
          id,
          org_id: key("A"),
          subject: key("bAdmin@B"),
          archetype: TASK_VIEWER_ID,
        },
        null
      )
    ).toEqual(INVALID("subject"))
  })

  const remove = async (version: string) =>
    core(
      "root",
      { action: admin, object: ASSIGNMENTS, root: key("targetRole") },
      `SELECT public.${ASSIGNMENTS}_delete($1::uuid, $2::bigint) AS r`,
      [key("targetRole"), version],
      `SELECT count(*)::int AS n FROM public.${ASSIGNMENTS} WHERE id = '${key("targetRole")}'`
    )

  // Скоуп у результаті читається з рядка «до», видимого лише через RLS ролі
  // команд, — це вирішує Postgres, не текст тіла.
  it("delete of an assignment passes and returns the assignment's scope", async () => {
    const version = await versionOf(ASSIGNMENTS, "targetRole")
    expect(await remove(version)).toEqual({
      result: { id: key("targetRole"), version, org_id: key("A") },
      probe: [{ n: 0 }],
    })
  })

  it("delete with a stale version → conflict", async () => {
    const version = await versionOf(ASSIGNMENTS, "targetRole")
    expect(await remove(String(BigInt(version) + 1n))).toEqual({
      code: E.conflict.errcode,
      message: E.conflict.message,
      detail: E.conflict.version,
      hint: version,
    })
  })

  describe("Users", () => {
    // `GlobalAdmin` (`fullAccess`) — єдиний у моделі з `update` на «Користувачах»
    const usersSave = async (
      item: Record<string, unknown>,
      version: string | null
    ) =>
      save(
        "gAdmin",
        "users",
        "update",
        { id: key("target"), ...item },
        version,
        `SELECT nickname FROM public.users WHERE id = '${key("target")}'`
      )

    it("save of an application attribute passes", async () => {
      const version = await versionOf("users", "target")
      expect(await usersSave({ nickname: "nick" }, version)).toMatchObject({
        result: {
          id: key("target"),
          nickname: "nick",
          version: String(BigInt(version) + 1n),
        },
        probe: [{ nickname: "nick" }],
      })
    })

    it("unknown key → command.invalid", async () => {
      expect(
        await usersSave({ invalid: 1 }, await versionOf("users", "target"))
      ).toEqual(INVALID("invalid"))
    })

    // «Користувачів» команда не створює (спека П4 §6.6): гілки створення немає
    it("save without a version → command.invalid create", async () => {
      expect(await usersSave({ nickname: "nick" }, null)).toEqual(
        INVALID("create")
      )
    })
  })
})
