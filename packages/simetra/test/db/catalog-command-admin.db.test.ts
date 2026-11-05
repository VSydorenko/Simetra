import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  COMMAND_CORE_ERRORS,
  COMMAND_SETTING,
  PLATFORM_ROLES,
  PROVIDER_API_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
  type CommandContext,
} from "simetra/model"
import { uuid } from "../../src/compiler/__tests__/helpers"
import { SNAPSHOT_TABLES } from "../../src/compiler/rights/actor-snapshot"
import {
  ACTOR_SNAPSHOT,
  ADOPTED_LEAD_KEY,
  ADOPTED_SNAPSHOT,
  BULLETIN_TABLE,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_WRITER_ID,
  REGION_DIMENSION_ID,
  RIGHTS_ADMIN_ID,
  ROLE_FILE,
  TASK_EDITOR_ID,
  TASK_VIEWER_ID,
  TASK_WRITER_ID,
  TEAM_LEAD_ID,
  USERS_FILE,
  actorSnapshotDomain,
  adminRoles,
  adoptedSnapshotDomain,
  compileRights,
  grant,
  objects,
  role,
  writeRoles,
  type Layer,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import {
  commandSteps,
  testDatabaseUrl,
  type CommandStep,
  type Refusal,
} from "./connection"
import {
  deploy,
  type Assignment,
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
const S = ACTOR_SNAPSHOT
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

  /**
   * Рядки кейсів знімка актора поверх `seedAdministration`: задачі й
   * коментарі в A (`XT` з коментарем `XTC` — виконавець `admin@A`, `XA` з
   * коментарем `XC` — без виконавця), нотатка регіону `RN` у регіоні `R1`,
   * запрошений рядок без призначень `bareInvite@B` і `bOnly` — учасник лише B. Права на них дають ролі, які кейс призначає у своїй точці
   * збереження.
   */
  const seedSnapshot = async (client: pg.Client) => {
    const row = async (
      name: string,
      table: string,
      values: Record<string, unknown>
    ) => {
      ids[name] = randomUUID()
      await insert(client, table, { id: ids[name], ...values })
    }
    const now = new Date()
    await row("XT", "task", {
      org_id: key("A"),
      date: now,
      assignee_id: key("admin@A"),
    })
    await row("XA", "task", { org_id: key("A"), date: now })
    await row("XC", "task_comment", { org_id: key("A"), task_id: key("XA") })
    await row("XTC", "task_comment", { org_id: key("A"), task_id: key("XT") })
    await row("bareInvite@B", "org_member", { org_id: key("B"), user_id: null })
    ids.bOnly = await signUp(client)
    await row("bOnly@B", "org_member", {
      org_id: key("B"),
      user_id: key("bOnly"),
    })
    await row("RN", S.regionNote, { org_id: key("A"), region_id: key("R1") })
  }

  beforeAll(async () => {
    // Модель знімка актора (план Права-3): кожна форма джерела фактів —
    // контейнер, регістр зв'язку, дослівні функції виміру й множини виду.
    const result = await compileRights(
      actorSnapshotDomain(
        writeRoles(),
        adminRoles(),
        rightsAdmins(),
        nickname()
      )
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
    await seedSnapshot(client)
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

  // Знімок актора (план Права-3, спека прав §5.1, §7): факти актора — на
  // початок транзакції. DB, бо що бачать RLS і ядро після першої зміни
  // джерела, вирішує Postgres: тригер `BEFORE … FOR EACH STATEMENT`, гілки
  // функцій за заголовком xid і відкат точок збереження. Кожен запис з
  // контекстом — у точці збереження `commandSteps`: знімок живе до кінця
  // транзакції опису, і лишений знімок зламав би наступні кейси.
  const claimsOf = (user: string) => ({
    sub: key(user),
    role: "authenticated",
  })
  const steps = (
    user: string,
    list: readonly CommandStep[],
    options?: { immediate?: boolean }
  ) => commandSteps(tx.client(), claimsOf(user), list, options)

  /**
   * Стан «з початку транзакції»: рядки власника (довідники прав — у режимі
   * обслуговування, без знімка) у точці збереження кейсу; відкладені ключі
   * засіву перевіряються одразу, тож кейс починає з порожньої черги.
   */
  const given = async <T>(
    rows: (client: pg.Client) => Promise<void>,
    body: () => Promise<T>
  ): Promise<T> => {
    const client = tx.client()
    await client.query("SAVEPOINT snapshot_given")
    try {
      await rows(client)
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      await client.query("SET CONSTRAINTS ALL DEFERRED")
      return await body()
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT snapshot_given")
    }
  }
  const assign = (client: pg.Client, member: string, a: Assignment) =>
    insert(client, ASSIGNMENTS, {
      org_id: key("A"),
      ...assignmentRow(key(member), a),
    })

  /** Зміна від власника з контекстом команди: джерела, яких політики не відкривають. */
  const ownerStep = (
    [action, object, root]: [string, string, string],
    sql: string,
    params?: unknown[]
  ): CommandStep => ({
    context: { action, object, root },
    sql,
    ...(params === undefined ? {} : { params }),
    asOwner: true,
  })
  const saveStep = (
    table: string,
    action: string,
    item: Record<string, unknown>,
    version: string | null
  ): CommandStep => ({
    context: { action, object: table, root: item.id as string },
    sql: `SELECT public.${table}_save($1::jsonb, $2::bigint) AS r`,
    params: [JSON.stringify(item), version],
  })
  /** Запис у «Користувачів», що нічого не змінює, — джерело всіх чотирьох фактів (Р-7). */
  const takeAll = (): CommandStep =>
    ownerStep(
      ["update", "users", randomUUID()],
      "UPDATE public.users SET version = version WHERE false"
    )
  const readStep = (table: string, row: string): CommandStep => ({
    sql: `SELECT id FROM public.${table} WHERE id = $1`,
    params: [key(row)],
  })
  const NO_RIGHT: Refusal = {
    code: E.forbidden.errcode,
    message: E.forbidden.message,
    detail: E.forbidden.noRight,
  }
  const refused = (detail: string) => ({
    code: E.forbidden.errcode,
    message: E.forbidden.message,
    detail,
  })
  /**
   * `proveOpened`: після зміни джерела факт, що відкриває `X`, є в живому
   * варіанті й немає в публічній функції — інакше «відмова» могла б мати
   * іншу причину, ніж знімок.
   */
  const opened = (live: string, pub: string): CommandStep => ({
    check: async (client) =>
      (
        await client.query<{ live: boolean; pub: boolean }>(
          `SELECT EXISTS (${live}) AS live, EXISTS (${pub}) AS pub`
        )
      ).rows[0],
  })
  const OPENED = { live: true, pub: false }
  const rightOf = (object: string, action: string, extra = "") => {
    const where = `WHERE m.object = '${object}' AND m.action = '${action}'${extra}`
    return [
      `SELECT 1 FROM simetra.rights_mine_live() m ${where}`,
      `SELECT 1 FROM simetra.rights_mine() m ${where}`,
    ] as const
  }
  const rowCount = (step: unknown) => (step as { rowCount: number }).rowCount
  /** Множини запитів `a` і `b`: розмір `a` і розмір симетричної різниці. */
  const compare = async (client: pg.Client, a: string, b: string) =>
    (
      await client.query<{ n: number; diff: number }>(
        `SELECT (SELECT count(*) FROM (${a}) x)::int AS n, ((SELECT count(*) FROM ((${a}) EXCEPT (${b})) x) + (SELECT count(*) FROM ((${b}) EXCEPT (${a})) x))::int AS diff`
      )
    ).rows[0]!
  const headers = async (client: pg.Client) =>
    (
      await client.query<{ fact: string; actor: string }>(
        `SELECT fact, actor FROM ${SNAPSHOT_TABLES.header.schema}.${SNAPSHOT_TABLES.header.name} WHERE xid = txid_current() ORDER BY fact COLLATE "C"`
      )
    ).rows
  const DIMENSIONS = [
    REGION_DIMENSION_ID,
    S.zoneDimensionId,
    S.homeRegionDimensionId,
  ]
  const liveValues = DIMENSIONS.map(
    (d) =>
      `SELECT '${d}'::uuid AS dimension_id, v AS value FROM simetra.rights_dimension_values_live('${d}'::uuid) v`
  ).join(" UNION ALL ")
  const publicValues = liveValues.replaceAll(
    "rights_dimension_values_live",
    "rights_dimension_values"
  )
  /** Публічні функції кожного факту поряд із живими варіантами. */
  const FACT_PAIRS = [
    [
      "SELECT * FROM simetra.rights_mine()",
      "SELECT * FROM simetra.rights_mine_live()",
    ],
    [
      "SELECT * FROM simetra.rights_my_scopes()",
      "SELECT scope_kind_id, scope, member FROM simetra.rights_my_scopes_live()",
    ],
    [publicValues, liveValues],
    [
      `SELECT v FROM simetra.rights_scope_set('${S.teamKindId}'::uuid) v`,
      `SELECT v FROM simetra.rights_scope_set_live('${S.teamKindId}'::uuid) v`,
    ],
  ] as const
  /** Публічні функції фактів поточного користувача — порожні для чужого актора. */
  const factCounts = async (client: pg.Client) =>
    (
      await client.query<Record<string, number>>(
        `SELECT (SELECT count(*) FROM simetra.rights_mine())::int AS rights,
          (SELECT count(*) FROM simetra.rights_my_scopes())::int AS scopes,
          (SELECT count(*) FROM public.org_member_member_scopes())::int AS member_scopes,
          (SELECT public.org_member_my_member('${key("A")}'::uuid) IS NOT NULL)::int AS my_member,
          (SELECT count(*) FROM (${publicValues}) v)::int AS "values",
          (SELECT count(*) FROM simetra.rights_scope_set('${S.teamKindId}'::uuid))::int AS scope_sets`
      )
    ).rows[0]!
  const NO_FACTS = {
    rights: 0,
    scopes: 0,
    member_scopes: 0,
    my_member: 0,
    values: 0,
    scope_sets: 0,
  }
  /**
   * Актор з усіма формами фактів: повний доступ у A (`OrgAdmin` — носій),
   * права рівня скоупу, `own`, обох вимірів моделі знімка і контейнера, кастомна
   * роль з дельтами; рядки регістрів, `Zone` і `TeamSeat` дають значення
   * вимірів і множину виду `team`.
   */
  const richActor = async (client: pg.Client, user: string) => {
    const member = `${user}@A`
    await assign(client, member, { archetype: S.ownEditorId })
    await assign(client, member, { archetype: S.regionNoteWriterId })
    await assign(client, member, {
      archetype: PROJECT_WRITER_ID,
      container: key("P1"),
    })
    await assign(client, member, { customRole: key("closureCustom") })
    await insert(client, "member_region", {
      org_id: key("A"),
      member_id: key(member),
      region_id: key("R1"),
    })
    await insert(client, S.userRegion, {
      org_id: key("A"),
      user_id: key(user),
      region_id: key("R1"),
    })
    await insert(client, S.zone, {
      id: randomUUID(),
      org_id: key("A"),
      keeper_id: key(user),
    })
    await insert(client, S.teamSeat, {
      id: randomUUID(),
      user_id: key(user),
      team: randomUUID(),
    })
  }

  describe("actor snapshot", () => {
    it("keeps the effects of earlier steps visible to later steps", async () => {
      // Перший тест помічника `commandSteps` (план Права-3, Задача 1): запис
      // кроку бачать наступні кроки тієї самої точки збереження.
      const outcome = await steps("root", [
        ownerStep(
          ["update", "task", key("XA")],
          "UPDATE public.task SET region_id = $1 WHERE id = $2",
          [key("R1"), key("XA")]
        ),
        {
          check: async (client) =>
            (
              await client.query(
                "SELECT region_id FROM public.task WHERE id = $1",
                [key("XA")]
              )
            ).rows,
        },
      ])
      expect(outcome).toEqual({
        completed: [{ rows: [], rowCount: 1 }, [{ region_id: key("R1") }]],
      })
    })

    it("takes the snapshot equal to the live facts of the actor", async () => {
      await given(
        (client) => richActor(client, "root"),
        async () => {
          const pairs = {
            check: async (client: pg.Client) =>
              Promise.all(
                FACT_PAIRS.map(([pub, live]) => compare(client, pub, live))
              ),
          }
          const table = (name: keyof typeof SNAPSHOT_TABLES, columns: string) =>
            `SELECT ${columns} FROM simetra.${SNAPSHOT_TABLES[name].name} WHERE xid = txid_current()`
          const outcome = await steps("root", [
            pairs,
            takeAll(),
            {
              check: async (client) => ({
                headers: await headers(client),
                tables: await Promise.all([
                  compare(
                    client,
                    table("scopes", "scope_kind_id, scope, member, catalog"),
                    "SELECT scope_kind_id, scope, member, catalog FROM simetra.rights_my_scopes_live() WHERE scope IS NOT NULL AND member IS NOT NULL"
                  ),
                  compare(
                    client,
                    table("values", "dimension_id, value"),
                    liveValues
                  ),
                  compare(
                    client,
                    table("scopeSets", "scope_kind_id, scope"),
                    `SELECT '${S.teamKindId}'::uuid, v FROM simetra.rights_scope_set_live('${S.teamKindId}'::uuid) v`
                  ),
                  compare(
                    client,
                    "SELECT * FROM simetra.rights_mine()",
                    "SELECT * FROM simetra.rights_mine_live()"
                  ),
                ]),
                inputs: (
                  await client.query<Record<string, number>>(
                    `SELECT ${(
                      ["typed", "containers", "deltas", "holders"] as const
                    )
                      .map(
                        (t) =>
                          `(SELECT count(*) FROM (${table(t, "*")}) x)::int AS ${t}`
                      )
                      .join(", ")}`
                  )
                ).rows[0],
                holders: (
                  await client.query(table("holders", "level, level_id, scope"))
                ).rows,
                // Значення кожного виміру знято, а функція `zone` дала й `NULL`
                values: (
                  await client.query<{
                    dimension_id: string
                    n: number
                    nulls: number
                  }>(
                    `SELECT dimension_id, count(*)::int AS n, count(*) FILTER (WHERE value IS NULL)::int AS nulls FROM (${table("values", "dimension_id, value")}) v GROUP BY dimension_id ORDER BY dimension_id`
                  )
                ).rows,
              }),
            },
          ])
          expect(outcome.refusal).toBeUndefined()
          const [before, , after] = outcome.completed as [
            { n: number; diff: number }[],
            unknown,
            {
              headers: unknown[]
              tables: { n: number; diff: number }[]
              inputs: Record<string, number>
              holders: unknown[]
              values: { dimension_id: string; n: number; nulls: number }[]
            },
          ]
          // До запису публічні функції — живі; кожна множина непорожня.
          for (const pair of before) expect(pair.n).toBeGreaterThan(0)
          expect(before.map((p) => p.diff)).toEqual([0, 0, 0, 0])
          expect(after.headers).toEqual(
            ["rights", "scopeSets", "scopes", "values"].map((fact) => ({
              fact,
              actor: key("root"),
            }))
          )
          for (const t of after.tables) expect(t.n).toBeGreaterThan(0)
          expect(after.tables.map((t) => t.diff)).toEqual([0, 0, 0, 0])
          for (const n of Object.values(after.inputs))
            expect(n).toBeGreaterThan(0)
          // Носії `fullAccess` актора — `fullAccessHolderRows`: `OrgAdmin` в A
          expect(after.holders).toEqual([
            { level: "scope", level_id: ORG_KIND_ID, scope: key("A") },
          ])
          expect(after.values.map((v) => v.dimension_id).sort()).toEqual(
            [...DIMENSIONS].sort()
          )
          expect(
            after.values.find((v) => v.dimension_id === S.zoneDimensionId)
          ).toMatchObject({ nulls: 1 })
        }
      )
    })

    it("takes the snapshot before the first change of own membership", async () => {
      // `invite@A` несе `OrgAdmin`: після самоприйняття наживо `outsider`
      // бачить кожну задачу A. Глобальна роль на скоуплений об'єкт права не
      // дає (`rights.grant-level`), тож `X` відкриває саме призначення рядка.
      const scope = key("A")
      const outcome = await steps("outsider", [
        ownerStep(
          ["update", "org_member", key("invite@A")],
          "UPDATE public.org_member SET user_id = $1 WHERE id = $2",
          [key("outsider"), key("invite@A")]
        ),
        readStep("task", "XA"),
        {
          check: async (client) =>
            (
              await client.query(
                `SELECT
                  (SELECT count(*) FROM simetra.rights_my_scopes() s WHERE s.scope = '${scope}')::int AS scopes,
                  (SELECT count(*) FROM public.org_member_member_scopes() s WHERE s = '${scope}')::int AS member_scopes,
                  (SELECT public.org_member_my_member('${scope}'::uuid) IS NOT NULL)::int AS my_member`
              )
            ).rows[0],
        },
        opened(
          `SELECT 1 FROM simetra.rights_my_scopes_live() s WHERE s.scope = '${scope}'`,
          `SELECT 1 FROM simetra.rights_my_scopes() s WHERE s.scope = '${scope}'`
        ),
      ])
      expect(outcome.refusal).toBeUndefined()
      const [claim, read, facts, proof] = outcome.completed
      expect(rowCount(claim)).toBe(1)
      expect(rowCount(read)).toBe(0)
      expect(facts).toEqual({ scopes: 0, member_scopes: 0, my_member: 0 })
      expect(proof).toEqual(OPENED)
    })

    it("reads live facts while no source changed", async () => {
      await given(
        (client) => richActor(client, "root"),
        async () => {
          const outcome = await steps("root", [
            // `bulletin` — не джерело: xid уже призначено, знімка немає
            ownerStep(
              ["update", BULLETIN_TABLE, randomUUID()],
              `UPDATE public.${BULLETIN_TABLE} SET text = text WHERE false`
            ),
            {
              check: async (client) => ({
                headers: await headers(client),
                xid: (
                  await client.query<{ assigned: boolean }>(
                    "SELECT txid_current_if_assigned() IS NOT NULL AS assigned"
                  )
                ).rows[0]!.assigned,
                pairs: await Promise.all(
                  FACT_PAIRS.map(([pub, live]) => compare(client, pub, live))
                ),
              }),
            },
          ])
          const [, state] = outcome.completed as [
            unknown,
            {
              headers: unknown[]
              xid: boolean
              pairs: { n: number; diff: number }[]
            },
          ]
          expect(state.headers).toEqual([])
          expect(state.xid).toBe(true)
          for (const pair of state.pairs) expect(pair.n).toBeGreaterThan(0)
          expect(state.pairs.map((p) => p.diff)).toEqual([0, 0, 0, 0])
        }
      )
    })

    // Джерело одного факту закріплює транзакцію за актором (Р3-3): чужий
    // актор не отримує й тих фактів, яких ще не знято.
    it.each([
      [
        "rights",
        "update",
        "project",
        "UPDATE public.project SET description = description WHERE false",
      ],
      // Регістр команда пише дією `write` і рядками, а не `UPDATE`
      [
        "values",
        "write",
        S.userRegion,
        `DELETE FROM public.${S.userRegion} WHERE false`,
      ],
      [
        "scopeSets",
        "update",
        S.teamSeat,
        `UPDATE public.${S.teamSeat} SET team = team WHERE false`,
      ],
    ])(
      "returns empty facts to another actor after a single-fact snapshot (%s)",
      async (fact, action, table, statement) => {
        await given(
          (client) => richActor(client, "root"),
          async () => {
            const outcome = await steps("viewer", [
              ownerStep([action, table, randomUUID()], statement),
              {
                check: async (client) => {
                  const taken = await headers(client)
                  await client.query("SELECT set_config($1, $2, true)", [
                    SESSION_CLAIMS_SETTING,
                    JSON.stringify(claimsOf("root")),
                  ])
                  return {
                    taken,
                    facts: await factCounts(client),
                    // Наживо в `root` кожен факт є: порожнеча — від знімка
                    live: (
                      await Promise.all(
                        FACT_PAIRS.map(([, live]) =>
                          client.query<{ n: number }>(
                            `SELECT count(*)::int AS n FROM (${live}) x`
                          )
                        )
                      )
                    ).map((r) => r.rows[0]!.n),
                  }
                },
              },
            ])
            const [, state] = outcome.completed as [
              unknown,
              { taken: unknown[]; facts: unknown; live: number[] },
            ]
            expect(state.taken).toEqual([{ fact, actor: key("viewer") }])
            expect(state.facts).toEqual(NO_FACTS)
            for (const n of state.live) expect(n).toBeGreaterThan(0)
          }
        )
      }
    )

    it("returns empty facts to another actor of the transaction", async () => {
      const assignment = randomUUID()
      // Знімок `admin` записом у довідник прав, потім claims — `root`
      const start: CommandStep[] = [
        saveStep(
          ASSIGNMENTS,
          admin,
          {
            id: assignment,
            org_id: key("A"),
            subject: key("target@A"),
            archetype: TASK_VIEWER_ID,
          },
          null
        ),
        {
          check: async (client) => {
            await client.query("SELECT set_config($1, $2, true)", [
              SESSION_CLAIMS_SETTING,
              JSON.stringify(claimsOf("root")),
            ])
            return factCounts(client)
          },
        },
      ]
      const read = await steps("admin", [...start, readStep("task", "XA")])
      expect(read.refusal).toBeUndefined()
      expect(read.completed[1]).toEqual(NO_FACTS)
      expect(rowCount(read.completed[2])).toBe(0)
      // Контроль: наживо `root` (`OrgAdmin`) бачить `XA`
      expect(
        rowCount((await steps("root", [readStep("task", "XA")])).completed[0])
      ).toBe(1)
      const write = await steps("admin", [
        ...start,
        ownerStep(
          ["update", "project", key("P1")],
          "UPDATE public.project SET description = description WHERE false"
        ),
      ])
      expect(write.refusal).toEqual(refused(E.forbidden.rightsContext))
      const commit = await steps("admin", [...start], { immediate: true })
      expect(commit.refusal).toEqual(refused(E.forbidden.rightsContext))
    })

    it("retakes the snapshot after a rolled back savepoint", async () => {
      // Після відкату точки, що взяла знімок, наступний запис бере його
      // заново — з фактами на ту мить, а не з відкоченими.
      const role = randomUUID()
      const typedRoles = {
        check: async (client: pg.Client) =>
          (
            await client.query<{ archetype: string }>(
              `SELECT archetype FROM simetra.${SNAPSHOT_TABLES.typed.name} WHERE xid = txid_current() ORDER BY 1`
            )
          ).rows.map((r) => r.archetype),
      }
      const outcome = await steps("other", [
        { sql: "SAVEPOINT retake", asOwner: true },
        takeAll(),
        { check: headers },
        typedRoles,
        { sql: "ROLLBACK TO SAVEPOINT retake", asOwner: true },
        { check: headers },
        // Призначення в режимі обслуговування: знімка не бере
        {
          sql: `SELECT set_config('${RIGHTS_MAINTENANCE_SETTING}', 'on', true)`,
          asOwner: true,
        },
        {
          sql: `INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype) VALUES ('${role}', '${key("A")}', '${key("other@A")}', '${TASK_VIEWER_ID}')`,
          asOwner: true,
        },
        {
          sql: `SELECT set_config('${RIGHTS_MAINTENANCE_SETTING}', 'off', true)`,
          asOwner: true,
        },
        takeAll(),
        { check: headers },
        typedRoles,
      ])
      expect(outcome.refusal).toBeUndefined()
      const c = outcome.completed
      expect((c[2] as unknown[]).length).toBe(4)
      expect(c[3]).toEqual([])
      expect(c[5]).toEqual([])
      expect(rowCount(c[7])).toBe(1)
      expect((c[10] as unknown[]).length).toBe(4)
      expect(c[11]).toEqual([TASK_VIEWER_ID])
    })

    it("keeps the snapshot after a passed immediate check", async () => {
      // Р3-7: пройдена `SET CONSTRAINTS ALL IMMEDIATE` знімка не прибирає —
      // зміна виміру (⊆ її не судить) не діє до COMMIT.
      await given(
        (client) =>
          assign(client, "admin@A", { archetype: S.regionNoteWriterId }),
        async () => {
          const outcome = await steps("admin", [
            ownerStep(
              ["write", S.userRegion, randomUUID()],
              `INSERT INTO public.${S.userRegion} (org_id, user_id, region_id) VALUES ($1, $2, $3)`,
              [key("A"), key("admin"), key("R1")]
            ),
            opened(
              `SELECT 1 FROM simetra.rights_dimension_values_live('${S.homeRegionDimensionId}'::uuid) v WHERE v = '${key("R1")}'`,
              `SELECT 1 FROM simetra.rights_dimension_values('${S.homeRegionDimensionId}'::uuid) v WHERE v = '${key("R1")}'`
            ),
            // Ключ черги: призначення іншому учаснику в межах ⊆ актора
            saveStep(
              ASSIGNMENTS,
              admin,
              {
                id: randomUUID(),
                org_id: key("A"),
                subject: key("target@A"),
                archetype: TASK_VIEWER_ID,
              },
              null
            ),
            { sql: "SET CONSTRAINTS ALL IMMEDIATE", asOwner: true },
            readStep(S.regionNote, "RN"),
            { check: headers },
          ])
          expect(outcome.refusal).toBeUndefined()
          const [change, proof, , , read, kept] = outcome.completed
          expect(rowCount(change)).toBe(1)
          expect(proof).toEqual(OPENED)
          expect(rowCount(read)).toBe(0)
          expect((kept as unknown[]).length).toBeGreaterThan(0)
        }
      )
    })

    it("cleans the snapshots of finished transactions", async () => {
      // xid закоміченої транзакції — з окремого з'єднання: xid спільні для
      // кластера, а `PGAPPNAME` прогону тегує й це з'єднання.
      const other = new pg.Client({ connectionString: testDatabaseUrl() })
      await other.connect()
      let finished: string
      try {
        finished = (
          await other.query<{ x: string }>("SELECT txid_current()::text AS x")
        ).rows[0]!.x
      } finally {
        await other.end()
      }
      const tables = Object.values(SNAPSHOT_TABLES).map((t) => t.name)
      const counts = async (client: pg.Client) =>
        (
          await client.query<{ t: string; own: number; foreign: number }>(
            tables
              .map(
                (t) =>
                  `SELECT '${t}' AS t, count(*) FILTER (WHERE xid = txid_current())::int AS own, count(*) FILTER (WHERE xid = ${finished})::int AS foreign FROM simetra.${t}`
              )
              .join(" UNION ALL ")
          )
        ).rows
      const k = randomUUID()
      const seedForeign = [
        `INSERT INTO simetra.rights_tx_header (xid, fact, actor) VALUES (${finished}, 'rights', '${k}')`,
        `INSERT INTO simetra.rights_tx_typed (xid) VALUES (${finished})`,
        `INSERT INTO simetra.rights_tx_containers (xid) VALUES (${finished})`,
        `INSERT INTO simetra.rights_tx_deltas (xid) VALUES (${finished})`,
        `INSERT INTO simetra.rights_tx_holders (xid) VALUES (${finished})`,
        `INSERT INTO simetra.rights_tx_start (xid, full_access) VALUES (${finished}, false)`,
        `INSERT INTO simetra.rights_tx_scopes (xid, scope_kind_id, scope, member, catalog) VALUES (${finished}, '${k}', '${k}', '${k}', true)`,
        `INSERT INTO simetra.rights_tx_values (xid, dimension_id, value) VALUES (${finished}, '${k}', NULL)`,
        `INSERT INTO simetra.rights_tx_scope_sets (xid, scope_kind_id, scope) VALUES (${finished}, '${k}', '${k}')`,
      ]
      await given(
        async (client) => {
          await richActor(client, "root")
          for (const sql of seedForeign) await client.query(sql)
        },
        async () => {
          expect((await counts(tx.client())).map((r) => r.foreign)).toEqual(
            tables.map(() => 1)
          )
          const outcome = await steps("root", [takeAll(), { check: counts }])
          const [, after] = outcome.completed as [
            unknown,
            { t: string; own: number; foreign: number }[],
          ]
          expect(after.map((r) => r.foreign)).toEqual(tables.map(() => 0))
          // Свій знімок лишається; кеш `start` пише лише перевірка на COMMIT
          expect(after.filter((r) => r.own === 0).map((r) => r.t)).toEqual([
            SNAPSHOT_TABLES.start.name,
          ])
        }
      )
    })

    it("keeps exempt sources out of reach of the command role", async () => {
      // DB-доказ, що згенерований SQL ролі команд винятків Р3-6 не
      // відкриває: таблиці знімка, `identities` і `CustomTable` моделі.
      const exempt = [
        ...Object.values(SNAPSHOT_TABLES).map((t) => `simetra.${t.name}`),
        "simetra.identities",
        "public.comment_counter",
      ]
      const privileges = async (table: string) =>
        (
          await tx
            .client()
            .query<Record<string, boolean>>(
              `SELECT has_any_column_privilege($1, $2, 'INSERT') AS insert, has_any_column_privilege($1, $2, 'UPDATE') AS update, has_table_privilege($1, $2, 'DELETE') AS delete, has_table_privilege($1, $2, 'TRUNCATE') AS truncate`,
              [PLATFORM_ROLES.command, table]
            )
        ).rows[0]
      const none = {
        insert: false,
        update: false,
        delete: false,
        truncate: false,
      }
      for (const table of exempt)
        expect([table, await privileges(table)]).toEqual([table, none])
      // Контроль: таблиця виду-джерела ролі команд відкрита
      expect(await privileges("public.project")).toMatchObject({
        insert: true,
        update: true,
      })
    })

    it("takes no snapshot in maintenance mode", async () => {
      const id = randomUUID()
      const outcome = await steps("root", [
        {
          sql: `SELECT set_config('${RIGHTS_MAINTENANCE_SETTING}', 'on', true)`,
          asOwner: true,
        },
        takeAll(),
        ownerStep(
          [admin, ASSIGNMENTS, id],
          `INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)`,
          [id, key("A"), key("other@A"), TASK_VIEWER_ID]
        ),
        { check: headers },
      ])
      expect(outcome.refusal).toBeUndefined()
      expect(rowCount(outcome.completed[2])).toBe(1)
      expect(outcome.completed[3]).toEqual([])
    })

    it("revokes execute on live variants from every api role", async () => {
      const live = [
        "simetra.rights_mine_live()",
        "simetra.rights_my_scopes_live()",
        "simetra.rights_my_members_live(uuid)",
        "simetra.rights_dimension_values_live(uuid)",
        "simetra.rights_scope_set_live(uuid)",
      ]
      const roles = [
        ...Object.values(PROVIDER_API_ROLES.supabase),
        PLATFORM_ROLES.command,
      ]
      const { rows } = await tx
        .client()
        .query<{ granted: boolean }>(
          "SELECT has_function_privilege(r, f, 'EXECUTE') AS granted FROM unnest($1::text[]) r, unnest($2::text[]) f",
          [roles, live]
        )
      expect(rows).toHaveLength(roles.length * live.length)
      expect(rows.every((r) => !r.granted)).toBe(true)
    })
  })

  describe("the database judges a command by the rights at the start of its transaction", () => {
    // Кожен кейс «refuses» має близнюка без кроку `X`: зміна й повернення
    // проходять ⊆ на COMMIT — відмову дає саме знімок, а не кінцевий стан.
    const passes = async (user: string, list: readonly CommandStep[]) => {
      const outcome = await steps(user, list, { immediate: true })
      expect(outcome.refusal).toBeUndefined()
      for (const step of outcome.completed) expect(rowCount(step)).toBe(1)
    }
    const assignStep = (id: string, member: string, archetype: string) =>
      ownerStep(
        [admin, ASSIGNMENTS, id],
        `INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)`,
        [id, key("A"), key(member), archetype]
      )
    const unassignStep = (id: string) =>
      ownerStep(
        [admin, ASSIGNMENTS, id],
        `DELETE FROM public.${ASSIGNMENTS} WHERE id = $1`,
        [id]
      )

    it("refuses assign → update X → unassign", async () => {
      const id = randomUUID()
      const outcome = await steps("admin", [
        saveStep(
          ASSIGNMENTS,
          admin,
          {
            id,
            org_id: key("A"),
            subject: key("admin@A"),
            archetype: TASK_WRITER_ID,
          },
          null
        ),
        opened(...rightOf("task_comment", "update")),
        saveStep(
          "task_comment",
          "update",
          { id: key("XC"), description: "x" },
          await versionOf("task_comment", "XC")
        ),
      ])
      expect(outcome.completed[1]).toEqual(OPENED)
      expect(outcome.refusal).toEqual(NO_RIGHT)
      await passes("admin", [
        assignStep(id, "admin@A", TASK_WRITER_ID),
        unassignStep(id),
      ])
    })

    it("hides X in assign → read X → unassign", async () => {
      const id = randomUUID()
      const outcome = await steps(
        "admin",
        [
          assignStep(id, "admin@A", TASK_WRITER_ID),
          opened(...rightOf("task_comment", "read")),
          readStep("task_comment", "XC"),
          unassignStep(id),
        ],
        { immediate: true }
      )
      expect(outcome.refusal).toBeUndefined()
      const [assigned, proof, read, unassigned] = outcome.completed
      expect([rowCount(assigned), rowCount(unassigned)]).toEqual([1, 1])
      expect(proof).toEqual(OPENED)
      expect(rowCount(read)).toBe(0)
      // Близнюк читання: та сама роль з початку транзакції бачить `XC`
      await given(
        (client) => assign(client, "admin@A", { archetype: TASK_WRITER_ID }),
        async () => {
          const twin = await steps("admin", [readStep("task_comment", "XC")])
          expect(rowCount(twin.completed[0])).toBe(1)
        }
      )
    })

    it("refuses assign → update a member row → unassign", async () => {
      // `TaskOwnEditor` дає `update own` коментарів: `XTC` — коментар задачі
      // `XT`, виконавець якої — `admin@A`
      const id = randomUUID()
      const outcome = await steps("admin", [
        assignStep(id, "admin@A", S.ownEditorId),
        opened(...rightOf("task_comment", "update", " AND m.extent = 'own'")),
        saveStep(
          "task_comment",
          "update",
          { id: key("XTC"), description: "x" },
          await versionOf("task_comment", "XTC")
        ),
      ])
      expect(rowCount(outcome.completed[0])).toBe(1)
      expect(outcome.completed[1]).toEqual(OPENED)
      expect(outcome.refusal).toEqual(NO_RIGHT)
      await passes("admin", [
        assignStep(id, "admin@A", S.ownEditorId),
        unassignStep(id),
      ])
    })

    describe("membership", () => {
      // Права на скоуплений об'єкт має лише учасник скоупу, а учасник у скоупі
      // один (UNIQUE): учасник, якого додає зміна членства, — рядок іншого
      // скоупу. Факт `scopes` тоді тримає межу «Користувачів»
      // (`rights_visible_users`): `gAdmin` (`update any` на «Користувачах» —
      // з початку) бере запрошення `bareInvite@B`, і рядок `bOnly` (учасник
      // лише B) стає видимим лише наживо.
      const row = "bareInvite@B"
      const claim = (): CommandStep =>
        ownerStep(
          ["update", "org_member", key(row)],
          "UPDATE public.org_member SET user_id = $1 WHERE id = $2",
          [key("gAdmin"), key(row)]
        )
      // Вихід із членства тригер ефектів не пропускає: повернення — видалення
      // й той самий запрошений рядок знову
      const revert = (): CommandStep[] => [
        ownerStep(
          ["delete", "org_member", key(row)],
          "DELETE FROM public.org_member WHERE id = $1",
          [key(row)]
        ),
        ownerStep(
          ["create", "org_member", key(row)],
          "INSERT INTO public.org_member (id, org_id) VALUES ($1, $2)",
          [key(row), key("B")]
        ),
      ]
      const proof = () =>
        opened(
          `SELECT 1 FROM simetra.rights_my_scopes_live() s WHERE s.scope = '${key("B")}'`,
          `SELECT 1 FROM simetra.rights_my_scopes() s WHERE s.scope = '${key("B")}'`
        )

      it("refuses membership → update a member's user → revert", async () => {
        const outcome = await steps("gAdmin", [
          claim(),
          proof(),
          saveStep(
            "users",
            "update",
            { id: key("bOnly"), nickname: "x" },
            await versionOf("users", "bOnly")
          ),
        ])
        expect(rowCount(outcome.completed[0])).toBe(1)
        expect(outcome.completed[1]).toEqual(OPENED)
        expect(outcome.refusal).toEqual(NO_RIGHT)
        await passes("gAdmin", [claim(), ...revert()])
      })

      it("hides X in membership → read X → revert", async () => {
        const outcome = await steps(
          "gAdmin",
          [claim(), proof(), readStep("users", "bOnly"), ...revert()],
          { immediate: true }
        )
        expect(outcome.refusal).toBeUndefined()
        const [claimed, opens, read, ...reverted] = outcome.completed
        expect([claimed, ...reverted].map(rowCount)).toEqual([1, 1, 1])
        expect(opens).toEqual(OPENED)
        expect(rowCount(read)).toBe(0)
        // Близнюк читання: учасник B з початку транзакції бачить `bOnly`
        await given(
          (client) =>
            insert(client, "org_member", {
              id: randomUUID(),
              org_id: key("B"),
              user_id: key("gAdmin"),
            }),
          async () => {
            const twin = await steps("gAdmin", [readStep("users", "bOnly")])
            expect(rowCount(twin.completed[0])).toBe(1)
          }
        )
      })

      it("reads X by the start membership after leaving → read X → revert", async () => {
        // Межа тенанта (`_member_scopes`) — зі знімка. Скоуп, якого межа ще
        // не має, прав не дає (права — лише в учасника), тож межу доводить
        // вихід із членства: `viewer` знімає свої призначення й рядок
        // учасника, і `XA` лишається видимою до COMMIT.
        const assignments = [
          ["viewerRole", TASK_VIEWER_ID],
          ["viewerAdminRole", RIGHTS_ADMIN_ID],
        ] as const
        const leave = [
          ...assignments.map(([name]) =>
            ownerStep(
              [admin, ASSIGNMENTS, key(name)],
              `DELETE FROM public.${ASSIGNMENTS} WHERE id = $1`,
              [key(name)]
            )
          ),
          ownerStep(
            ["delete", "org_member", key("viewer@A")],
            "DELETE FROM public.org_member WHERE id = $1",
            [key("viewer@A")]
          ),
        ]
        const back = [
          ownerStep(
            ["create", "org_member", key("viewer@A")],
            "INSERT INTO public.org_member (id, org_id, user_id) VALUES ($1, $2, $3)",
            [key("viewer@A"), key("A"), key("viewer")]
          ),
          ...assignments.map(([name, archetype]) =>
            ownerStep(
              [admin, ASSIGNMENTS, key(name)],
              `INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)`,
              [key(name), key("A"), key("viewer@A"), archetype]
            )
          ),
        ]
        const outcome = await steps(
          "viewer",
          [
            ...leave,
            // Інверсія `proveOpened`: наживо скоупу вже немає, у знімку — є
            opened(
              `SELECT 1 FROM simetra.rights_my_scopes() s WHERE s.scope = '${key("A")}'`,
              `SELECT 1 FROM simetra.rights_my_scopes_live() s WHERE s.scope = '${key("A")}'`
            ),
            readStep("task", "XA"),
            ...back,
          ],
          { immediate: true }
        )
        expect(outcome.refusal).toBeUndefined()
        const c = outcome.completed
        expect([...c.slice(0, 3), ...c.slice(5)].map(rowCount)).toEqual([
          1, 1, 1, 1, 1, 1,
        ])
        expect(c[3]).toEqual(OPENED)
        expect(rowCount(c[4])).toBe(1)
      })
    })

    it("keeps the catalog rows apart from adopted sources in membership set functions", async () => {
      // М17. Довідник членства й прийняте джерело одного виду — помилка
      // компілятора `rights.membership-source-duplicate`, тож рядок джерела
      // того самого виду (`catalog = false`) у знімку дописує власник: доказ
      // фільтра `catalog` функцій членства, а не стану, який дає платформа.
      const [adopted, catalog] = [key("B"), key("C")]
      const scopes = `simetra.${SNAPSHOT_TABLES.scopes.name}`
      const outcome = await steps("root", [
        takeAll(),
        {
          check: async (client) => {
            await client.query(
              `INSERT INTO ${scopes} (xid, scope_kind_id, scope, member, catalog) VALUES (txid_current(), $1, $2, $3, false), (txid_current(), $1, $4, $5, true)`,
              [ORG_KIND_ID, adopted, randomUUID(), catalog, randomUUID()]
            )
            return (
              await client.query(
                `SELECT
                  ARRAY(SELECT s FROM public.org_member_member_scopes() s WHERE s IN ($1, $2) ORDER BY s = $2) AS member_scopes,
                  (SELECT public.org_member_my_member($1) IS NOT NULL)::int AS my_member,
                  (SELECT count(*) FROM simetra.rights_my_scopes() s WHERE s.scope = $1)::int AS my_scopes`,
                [adopted, catalog]
              )
            ).rows[0]
          },
        },
      ])
      // Рядок джерела «моїм скоупом» лишається, а функції членства його не бачать
      expect(outcome.completed[1]).toEqual({
        member_scopes: [catalog],
        my_member: 0,
        my_scopes: 1,
      })
    })

    describe("users as a source", () => {
      // Право з обсягом виміру `homeRegion` — з початку; значення виміру дає
      // рядок регістру зв'язку з суб'єктом-«Користувачем».
      const link = () =>
        ownerStep(
          ["write", S.userRegion, randomUUID()],
          `INSERT INTO public.${S.userRegion} (org_id, user_id, region_id) VALUES ($1, $2, $3)`,
          [key("A"), key("other"), key("R1")]
        )
      const unlink: CommandStep = ownerStep(
        ["write", S.userRegion, randomUUID()],
        `DELETE FROM public.${S.userRegion} WHERE user_id = (SELECT simetra.current_user_id())`
      )
      const proof = opened(
        `SELECT 1 FROM simetra.rights_dimension_values_live('${S.homeRegionDimensionId}'::uuid) v`,
        `SELECT 1 FROM simetra.rights_dimension_values('${S.homeRegionDimensionId}'::uuid) v`
      )
      const writer = (member: string) => (client: pg.Client) =>
        assign(client, member, { archetype: S.regionNoteWriterId })

      it("refuses users as a source → update X → revert", async () => {
        await given(writer("other@A"), async () => {
          const outcome = await steps("other", [
            link(),
            proof,
            saveStep(
              S.regionNote,
              "update",
              { id: key("RN"), description: "x" },
              await versionOf(S.regionNote, "RN")
            ),
          ])
          expect(rowCount(outcome.completed[0])).toBe(1)
          expect(outcome.completed[1]).toEqual(OPENED)
          expect(outcome.refusal).toEqual(NO_RIGHT)
          await passes("other", [link(), unlink])
        })
      })

      it("hides X in users as a source → read X → revert", async () => {
        await given(writer("other@A"), async () => {
          const outcome = await steps(
            "other",
            [link(), proof, readStep(S.regionNote, "RN"), unlink],
            { immediate: true }
          )
          expect(outcome.refusal).toBeUndefined()
          const [linked, opens, read, unlinked] = outcome.completed
          expect([rowCount(linked), rowCount(unlinked)]).toEqual([1, 1])
          expect(opens).toEqual(OPENED)
          expect(rowCount(read)).toBe(0)
        })
        // Близнюк читання: той самий рядок зв'язку з початку транзакції
        await given(
          async (client) => {
            await writer("other@A")(client)
            await insert(client, S.userRegion, {
              org_id: key("A"),
              user_id: key("other"),
              region_id: key("R1"),
            })
          },
          async () => {
            const twin = await steps("other", [readStep(S.regionNote, "RN")])
            expect(rowCount(twin.completed[0])).toBe(1)
          }
        )
      })
    })

    it("refuses a custom role delta → update X → revert", async () => {
      // М31б: дельта `allow` утримуваної кастомної ролі з'являється в
      // транзакції. Архетип `OrgMember` дає читання коментарів у тому самому
      // призначенні: замикання вимог `update` → `read` — у межах призначення.
      const custom = randomUUID()
      const delta = orgDeltaRow(key("A"), custom, 1, [
        "allow",
        "task_comment",
        "update",
        "any",
      ])
      const columns = Object.keys(delta)
      const add = ownerStep(
        [admin, ROLES, custom],
        `INSERT INTO public.${DELTA} (${columns.join(", ")}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
        Object.values(delta)
      )
      await given(
        async (client) => {
          await insert(client, ROLES, {
            id: custom,
            org_id: key("A"),
            archetype: ORG_MEMBER_ROLE_ID,
          })
          await assign(client, "admin@A", { customRole: custom })
        },
        async () => {
          const outcome = await steps("admin", [
            add,
            opened(
              ...rightOf("task_comment", "update", " AND m.extent = 'any'")
            ),
            saveStep(
              "task_comment",
              "update",
              { id: key("XC"), description: "x" },
              await versionOf("task_comment", "XC")
            ),
          ])
          expect(rowCount(outcome.completed[0])).toBe(1)
          expect(outcome.completed[1]).toEqual(OPENED)
          expect(outcome.refusal).toEqual(NO_RIGHT)
          await passes("admin", [
            add,
            ownerStep(
              [admin, ROLES, custom],
              `DELETE FROM public.${DELTA} WHERE id = $1`,
              [delta.id]
            ),
          ])
        }
      )
    })

    it("refuses a new container → update X → revert", async () => {
      // М31в: призначення `ProjectZoneWriter` актора посилається на
      // контейнер, якого на початку немає (колонка контейнера без FK);
      // контейнер і `Zone` у ньому з'являються в транзакції.
      const container = randomUUID()
      const zone = randomUUID()
      const project = ownerStep(
        ["create", "project", container],
        "INSERT INTO public.project (id, org_id) VALUES ($1, $2)",
        [container, key("A")]
      )
      await given(
        (client) =>
          assign(client, "other@A", { archetype: S.zoneWriterId, container }),
        async () => {
          const outcome = await steps("other", [
            project,
            ownerStep(
              ["create", S.zone, zone],
              `INSERT INTO public.${S.zone} (id, org_id, project_id) VALUES ($1, $2, $3)`,
              [zone, key("A"), container]
            ),
            opened(
              ...rightOf(
                S.zone,
                "update",
                ` AND m.level = 'container' AND m.container = '${container}'`
              )
            ),
            saveStep(S.zone, "update", { id: zone, description: "x" }, "1"),
          ])
          expect(outcome.completed.slice(0, 2).map(rowCount)).toEqual([1, 1])
          expect(outcome.completed[2]).toEqual(OPENED)
          expect(outcome.refusal).toEqual(NO_RIGHT)
          await passes("other", [
            project,
            ownerStep(
              ["delete", "project", container],
              "DELETE FROM public.project WHERE id = $1",
              [container]
            ),
          ])
        }
      )
    })

    // Діра бази до блоку Права-3 закрита: перевірка права ядра й RLS читають
    // права на початок транзакції, тож самопризначена роль запису до COMMIT
    // не діє — та сама відмова, що в контрольного запису без ролі (Р-1).
    it("the database refuses a direct command the rights granted in its transaction", async () => {
      const bulletin = randomUUID()
      const assignment = randomUUID()
      await given(
        (client) =>
          insert(client, BULLETIN_TABLE, {
            id: bulletin,
            org_id: key("A"),
            text: "before",
          }),
        async () => {
          const write = saveStep(
            BULLETIN_TABLE,
            "update",
            { id: bulletin, text: "after" },
            await versionOf(BULLETIN_TABLE, bulletin)
          )
          // Контроль: без призначення `RightsAdmin` рядок `Bulletin` не пише
          expect((await steps("admin", [write])).refusal).toEqual(NO_RIGHT)
          const outcome = await steps("admin", [
            saveStep(
              ASSIGNMENTS,
              admin,
              {
                id: assignment,
                org_id: key("A"),
                subject: key("admin@A"),
                archetype: TASK_WRITER_ID,
              },
              null
            ),
            opened(...rightOf(BULLETIN_TABLE, "update")),
            write,
          ])
          expect(outcome.completed[1]).toEqual(OPENED)
          expect(outcome.refusal).toEqual(NO_RIGHT)
        }
      )
    })
  })

  describe("rights of a pair", () => {
    // Р3-16: фікстура з розрізняльними рядками — `deny`, що знімає
    // утримуваний рядок дії (`closureCustom`: `deny task read any` над
    // `TaskViewer`), `deny` на дію з `req(update)` (там само) і дія з
    // `req(update)`, яку дає лише дельта `allow` (`read any` над архетипом
    // лише власних коментарів); кастомні ролі, контейнер, обидва виміри,
    // роль кожного користувача (`Everyone`).
    it("matches the full rights of the actor for every pair of the domain, live and from the snapshot", async () => {
      const custom = randomUUID()
      await given(
        async (client) => {
          await richActor(client, "editor")
          await insert(client, ROLES, {
            id: custom,
            org_id: key("A"),
            archetype: S.commentUpdaterId,
          })
          await insert(
            client,
            DELTA,
            orgDeltaRow(key("A"), custom, 1, [
              "allow",
              "task_comment",
              "read",
              "any",
            ])
          )
          await assign(client, "editor@A", { customRole: custom })
        },
        async () => {
          const outcome = await steps("editor", [
            { check: pairContract },
            ownerStep(
              [admin, ASSIGNMENTS, randomUUID()],
              `UPDATE public.${ASSIGNMENTS} SET version = version WHERE false`
            ),
            { check: headers },
            { check: pairContract },
          ])
          expect(outcome.refusal).toBeUndefined()
          const [live, , taken, snapshot] = outcome.completed as [
            Record<string, { diff: number; nonempty: number }>,
            unknown,
            { fact: string }[],
            Record<string, { diff: number; nonempty: number }>,
          ]
          expect(taken.map((h) => h.fact)).toEqual(["rights"])
          for (const branch of [live, snapshot]) {
            expect(Object.keys(branch)).toEqual([
              "pair",
              "any",
              "own",
              "dim",
              "container",
              "has",
            ])
            for (const [name, { diff, nonempty }] of Object.entries(branch)) {
              expect([name, diff]).toEqual([name, 0])
              expect([name, nonempty > 0]).toEqual([name, true])
            }
          }
        }
      )
    }, 60_000)
  })

  // Вимога безпеки аудиту: носій `fullAccess`, узятий у транзакції, актора
  // від ⊆ не звільняє — носії судяться на початок (`rights_tx_holders`).
  // Підміна користувача рядка з іншим користувачем відмовляє раніше тригер
  // ефектів (`effect`, `rights-guards`), тож рядок — запрошений, а
  // політики не-учаснику `update` членства не відкривають: зміна — від
  // власника з контекстом.
  it.each([
    ["invite@A", E.forbidden.escalation],
    ["bareInvite@A", undefined],
  ] as const)(
    "refuses capturing a member row with full access (%s)",
    async (row, detail) => {
      const outcome = await steps(
        "outsider",
        [
          ownerStep(
            ["update", "org_member", key(row)],
            "UPDATE public.org_member SET user_id = $1 WHERE id = $2",
            [key("outsider"), key(row)]
          ),
        ],
        { immediate: true }
      )
      expect(rowCount(outcome.completed[0])).toBe(1)
      expect(outcome.refusal).toEqual(
        detail === undefined ? undefined : refused(detail)
      )
    }
  )

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

// Знімок актора над прийнятими джерелами (план Права-3, Задача 6): друге
// мале розгортання, бо спільна модель файлу має роль кожного користувача й
// довідник членства `org`, а тут членство `org` — прийнята таблиця з
// активністю, межа тенанта — дослівна функція, і в актора без призначень
// немає жодного рядка прав.
describe("actor snapshot over adopted sources", () => {
  const tx = describeTransaction()
  const ids: Seed = {}
  const key = (name: string) => {
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const G = ADOPTED_SNAPSHOT.orgGuest
  const steps = (
    user: string,
    list: readonly CommandStep[],
    options?: { immediate?: boolean }
  ) =>
    commandSteps(
      tx.client(),
      { sub: key(user), role: "authenticated" },
      list,
      options
    )
  const ownerStep = (
    [action, object, root]: [string, string, string],
    sql: string,
    params: unknown[]
  ): CommandStep => ({
    context: { action, object, root },
    sql,
    params,
    asOwner: true,
  })
  const rowCount = (step: unknown) => (step as { rowCount: number }).rowCount
  const opened = (live: string, pub: string): CommandStep => ({
    check: async (client) =>
      (
        await client.query<{ live: boolean; pub: boolean }>(
          `SELECT EXISTS (${live}) AS live, EXISTS (${pub}) AS pub`
        )
      ).rows[0],
  })

  beforeAll(async () => {
    const result = await compileRights(adoptedSnapshotDomain())
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    const row = async (
      name: string,
      table: string,
      values: Record<string, unknown> = {}
    ) => {
      ids[name] = randomUUID()
      await insert(client, table, { id: ids[name], ...values })
    }
    for (const org of ["A", "B"]) await row(org, "organization")
    for (const user of ["editor", "idle", "nobody"])
      ids[user] = await signUp(client)
    await row("PA", "project", { org_id: key("A") })
    await row("PB", "project", { org_id: key("B") })
    // `editor`: активний учасник A з `CommentEditor`, без рядка `OrgGuest`
    await row("editor@A", "membership", {
      org_id: key("A"),
      user_id: key("editor"),
      is_active: true,
    })
    await row("editorRole", "org_role_assignments", {
      org_id: key("A"),
      ...assignmentRow(key("editor@A"), {
        archetype: ADOPTED_SNAPSHOT.commentEditorId,
      }),
    })
    await row("TA", "task", { org_id: key("A"), date: new Date() })
    await row("CA", "task_comment", { org_id: key("A"), task_id: key("TA") })
    // `idle`: неактивний учасник A з активним призначенням джерела; активний
    // учасник B — з активним і неактивним призначеннями
    await row("idle@A", "membership", {
      org_id: key("A"),
      user_id: key("idle"),
      is_active: false,
    })
    await row("idle@B", "membership", {
      org_id: key("B"),
      user_id: key("idle"),
      is_active: true,
    })
    const grant = (
      name: string,
      member: string,
      project: string,
      active: boolean
    ) =>
      row(name, "role_grant", {
        member_id: key(member),
        role_key: ADOPTED_LEAD_KEY,
        project_id: key(project),
        is_active: active,
      })
    await grant("idleGrantA", "idle@A", "PA", true)
    await grant("idleGrantB", "idle@B", "PB", true)
    await grant("idleOffGrantB", "idle@B", "PA", false)
    // Запрошення `team` з `TeamLead` і без призначень
    await row("T", "team")
    await row("invite@T", "team_member", { team_id: key("T"), user_id: null })
    await row("bareInvite@T", "team_member", {
      team_id: key("T"),
      user_id: null,
    })
    await row("inviteRole", "team_role_assignments", {
      team_id: key("T"),
      ...assignmentRow(key("invite@T"), { archetype: TEAM_LEAD_ID }),
    })
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
  }, 120_000)
  afterAll(() => tx.close())

  const given = async <T>(
    rows: (client: pg.Client) => Promise<void>,
    body: () => Promise<T>
  ): Promise<T> => {
    const client = tx.client()
    await client.query("SAVEPOINT adopted_given")
    try {
      await rows(client)
      return await body()
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT adopted_given")
    }
  }
  const guest = (id: string): CommandStep =>
    ownerStep(
      ["create", G, id],
      `INSERT INTO public.${G} (id, user_id, org) VALUES ($1, $2, $3)`,
      [id, key("editor"), key("A")]
    )
  const unguest = (id: string): CommandStep =>
    ownerStep(["delete", G, id], `DELETE FROM public.${G} WHERE id = $1`, [id])
  const scopeSet = (fn: string) =>
    `SELECT 1 FROM simetra.${fn}('${ORG_KIND_ID}'::uuid) v WHERE v = '${key("A")}'`
  const readComment: () => CommandStep = () => ({
    sql: "SELECT id FROM public.task_comment WHERE id = $1",
    params: [key("CA")],
  })

  describe("the database judges a command by the rights at the start of its transaction", () => {
    // Межа тенанта `org` — дослівна функція множини (Р3-11): рядок таблиці
    // виду `OrgGuest`, який вона читає, відкриває скоуп лише наживо.
    it("hides X in a verbatim scope set → read X → revert", async () => {
      const id = randomUUID()
      const outcome = await steps(
        "editor",
        [
          guest(id),
          opened(
            scopeSet("rights_scope_set_live"),
            scopeSet("rights_scope_set")
          ),
          readComment(),
          unguest(id),
        ],
        { immediate: true }
      )
      expect(outcome.refusal).toBeUndefined()
      const [added, proof, read, removed] = outcome.completed
      expect([rowCount(added), rowCount(removed)]).toEqual([1, 1])
      expect(proof).toEqual({ live: true, pub: false })
      expect(rowCount(read)).toBe(0)
      // Близнюк читання: той самий рядок `OrgGuest` з початку транзакції
      await given(
        (client) =>
          insert(client, G, { id, user_id: key("editor"), org: key("A") }),
        async () => {
          const twin = await steps("editor", [readComment()])
          expect(rowCount(twin.completed[0])).toBe(1)
        }
      )
    })

    it("refuses a verbatim scope set → update X → revert", async () => {
      const id = randomUUID()
      const version = (
        await tx
          .client()
          .query<{ v: string }>(
            "SELECT version::text AS v FROM public.task_comment WHERE id = $1",
            [key("CA")]
          )
      ).rows[0]!.v
      const outcome = await steps("editor", [
        guest(id),
        opened(scopeSet("rights_scope_set_live"), scopeSet("rights_scope_set")),
        {
          context: {
            action: "update",
            object: "task_comment",
            root: key("CA"),
          },
          sql: "SELECT public.task_comment_save($1::jsonb, $2::bigint) AS r",
          params: [
            JSON.stringify({ id: key("CA"), description: "x" }),
            version,
          ],
        },
      ])
      expect(rowCount(outcome.completed[0])).toBe(1)
      expect(outcome.completed[1]).toEqual({ live: true, pub: false })
      // Ядро судить межу тенанта тією самою функцією, що й RLS
      expect(outcome.refusal).toEqual({
        code: E.forbidden.errcode,
        message: E.forbidden.message,
        detail: E.forbidden.noRight,
      })
      const twin = await steps("editor", [guest(id), unguest(id)], {
        immediate: true,
      })
      expect(twin.refusal).toBeUndefined()
      expect(twin.completed.map(rowCount)).toEqual([1, 1])
    })

    // Межа тенанта ядра стоїть лише в гілці створення (`scope_insert`):
    // оновлення вище її не доводить — його тримають інші перевірки.
    it("refuses a verbatim scope set → create X → revert", async () => {
      const id = randomUUID()
      const comment = randomUUID()
      const create = (): CommandStep => ({
        context: { action: "create", object: "task_comment", root: comment },
        sql: "SELECT public.task_comment_save($1::jsonb, NULL::bigint) AS r",
        params: [
          JSON.stringify({
            id: comment,
            org_id: key("A"),
            description: "x",
          }),
        ],
      })
      const outcome = await steps("editor", [
        guest(id),
        opened(scopeSet("rights_scope_set_live"), scopeSet("rights_scope_set")),
        create(),
      ])
      expect(rowCount(outcome.completed[0])).toBe(1)
      expect(outcome.completed[1]).toEqual({ live: true, pub: false })
      expect(outcome.refusal).toEqual({
        code: E.forbidden.errcode,
        message: E.forbidden.message,
        detail: E.forbidden.noRight,
      })
      // Близнюк: рядок `OrgGuest` з початку транзакції — те саме створення
      // проходить, тож відмову дає знімок межі, а не брак права `create`
      await given(
        (client) =>
          insert(client, G, { id, user_id: key("editor"), org: key("A") }),
        async () => {
          const twin = await steps("editor", [create()], { immediate: true })
          expect(twin.refusal).toBeUndefined()
          expect(rowCount(twin.completed[0])).toBe(1)
        }
      )
    })
  })

  it("keeps an inactive adopted member out of the snapshot", async () => {
    // Знімок успадковує умову активності прийнятих джерел (Р3-5): учасник
    // `idle@A` неактивний, а `idleOffGrantB` — неактивне призначення
    // активного `idle@B`; активні рядки того самого джерела — контроль.
    const outcome = await steps("idle", [
      ownerStep(
        ["update", "users", key("idle")],
        "UPDATE public.users SET version = version WHERE false",
        []
      ),
      {
        check: async (client) =>
          (
            await client.query(
              `SELECT
                ARRAY(SELECT s.member::text FROM simetra.rights_tx_scopes s WHERE s.xid = txid_current() ORDER BY 1) AS snapshot_members,
                ARRAY(SELECT t.container::text FROM simetra.rights_tx_typed t WHERE t.xid = txid_current() ORDER BY 1) AS snapshot_containers,
                ARRAY(SELECT s.member::text FROM simetra.rights_my_scopes() s ORDER BY 1) AS my_scopes,
                ARRAY(SELECT DISTINCT m.container::text FROM simetra.rights_mine() m ORDER BY 1) AS mine`
            )
          ).rows[0],
      },
    ])
    expect(outcome.refusal).toBeUndefined()
    expect(outcome.completed[1]).toEqual({
      snapshot_members: [key("idle@B")],
      snapshot_containers: [key("PB")],
      my_scopes: [key("idle@B")],
      mine: [key("PB")],
    })
  })

  it("gives no membership for an adopted row without a scope, live or snapshot", async () => {
    // Колонка скоупу прийнятої `Membership` — nullable: рядок без скоупу
    // членства не дає (fail-closed), тож «мої скоупи» й версії однакові до
    // і після знімка. `idle@B` — контроль: активний рядок зі скоупом.
    const scopes = async (client: pg.Client) =>
      (
        await client.query(
          `SELECT
            ARRAY(SELECT coalesce(s.scope::text, 'null') FROM simetra.rights_my_scopes() s ORDER BY 1) AS my_scopes,
            ARRAY(SELECT coalesce(v.scope::text, 'null') FROM simetra.rights_versions() v WHERE v.scope_kind_id = $1 ORDER BY 1) AS versions,
            ARRAY(SELECT s.scope::text FROM simetra.rights_tx_scopes s WHERE s.xid = txid_current() ORDER BY 1) AS snapshot`,
          [ORG_KIND_ID]
        )
      ).rows[0]
    const outcome = await given(
      (client) =>
        insert(client, "membership", {
          id: randomUUID(),
          org_id: null,
          user_id: key("idle"),
          is_active: true,
        }),
      () =>
        steps("idle", [
          { check: scopes },
          ownerStep(
            ["update", "users", key("idle")],
            "UPDATE public.users SET version = version WHERE false",
            []
          ),
          { check: scopes },
        ])
    )
    expect(outcome.refusal).toBeUndefined()
    const scoped = { my_scopes: [key("B")], versions: [key("B")] }
    // `snapshot` доводить, що друге читання — зі знімка, а не наживо
    expect([outcome.completed[0], outcome.completed[2]]).toEqual([
      { ...scoped, snapshot: [] },
      { ...scoped, snapshot: [key("B")] },
    ])
  })

  // Review Focus 5: у актора без жодного рядка прав ключ `actor` ставить
  // заголовок факту `rights`, а не рядки входів, яких немає.
  it.each([
    ["invite@T", E.forbidden.escalation],
    ["bareInvite@T", undefined],
  ] as const)(
    "judges the self-acceptance of an actor without rights (%s)",
    async (row, detail) => {
      const outcome = await steps(
        "nobody",
        [
          {
            check: async (client) =>
              (
                await client.query<{ n: number }>(
                  "SELECT count(*)::int AS n FROM simetra.rights_mine_live()"
                )
              ).rows[0]!.n,
          },
          ownerStep(
            ["update", "team_member", key(row)],
            "UPDATE public.team_member SET user_id = $1 WHERE id = $2",
            [key("nobody"), key(row)]
          ),
        ],
        { immediate: true }
      )
      expect(outcome.completed[0]).toBe(0)
      expect(rowCount(outcome.completed[1])).toBe(1)
      expect(outcome.refusal).toEqual(
        detail === undefined
          ? undefined
          : {
              code: E.forbidden.errcode,
              message: E.forbidden.message,
              detail,
            }
      )
    }
  )

  it("matches the full rights for every pair over adopted sources with conditions", async () => {
    // Контракт пари (Р3-16) над рядками прийнятих джерел з умовою
    // активності: фільтр пари діє після `typed`, куди входять ці рядки.
    const outcome = await steps("idle", [
      { check: pairContract },
      ownerStep(
        ["update", "users", key("idle")],
        "UPDATE public.users SET version = version WHERE false",
        []
      ),
      { check: pairContract },
    ])
    expect(outcome.refusal).toBeUndefined()
    const [live, , snapshot] = outcome.completed as Record<
      string,
      { diff: number; nonempty: number }
    >[]
    for (const branch of [live!, snapshot!]) {
      for (const [name, { diff }] of Object.entries(branch))
        expect([name, diff]).toEqual([name, 0])
      expect(branch.pair!.nonempty).toBeGreaterThan(0)
      expect(branch.container!.nonempty).toBeGreaterThan(0)
    }
  }, 60_000)

  it("keeps exempt adopted sources out of reach of the command role", async () => {
    // Прийняті джерела членства й призначень — винятки Р3-6 (тригерів
    // платформа на них не ставить): запису ролі команд згенерований SQL не
    // відкриває. Контроль — таблиця виду-джерела `OrgGuest`.
    const privileges = async (table: string) =>
      (
        await tx
          .client()
          .query<Record<string, boolean>>(
            `SELECT has_any_column_privilege($1, $2, 'INSERT') AS insert, has_any_column_privilege($1, $2, 'UPDATE') AS update, has_table_privilege($1, $2, 'DELETE') AS delete, has_table_privilege($1, $2, 'TRUNCATE') AS truncate`,
            [PLATFORM_ROLES.command, table]
          )
      ).rows[0]
    const none = {
      insert: false,
      update: false,
      delete: false,
      truncate: false,
    }
    for (const table of [
      "public.membership",
      "public.role_grant",
      "public.global_grant",
    ])
      expect([table, await privileges(table)]).toEqual([table, none])
    expect(await privileges(`public.${G}`)).toMatchObject({
      insert: true,
      update: true,
    })
  })
})

/**
 * Контракт прав пари (Р3-16) для кожної пари `(дія, об'єкт)` домену, а не
 * вибірки: `rights_mine(a, o)` — рядки повного `rights_mine()` з
 * `object = o AND action ∈ {a} ∪ req*(a)`, а кожна функція множин — той
 * самий фільтр над повним `rights_mine()`. Кожна функція кличеться раз на
 * пару (чи обсяг) — у матеріалізованому CTE; по кожній — симетрична різниця
 * з очікуваним і кількість пар з непорожнім результатом.
 */
async function pairContract(
  client: pg.Client
): Promise<Record<string, { diff: number; nonempty: number }>> {
  // Рядки повного `rights_mine()` для пари `p` з умовою обсягу
  const whole = (extra: string) =>
    `JOIN whole w ON w.object = p.object AND w.action = p.action${extra}`
  const extent =
    " AND w.extent = p.extent AND w.dimension_id IS NOT DISTINCT FROM p.dimension_id"
  const functions: Record<string, { actual: string; expected: string }> = {
    pair: {
      actual:
        "SELECT p.object AS po, p.action AS pa, r.* FROM pairs p, LATERAL simetra.rights_mine(p.action, p.object) r",
      expected:
        "SELECT p.object, p.action, w.* FROM pairs p JOIN need n ON n.object = p.object AND n.action = p.action JOIN whole w ON w.object = p.object AND w.action = n.need",
    },
    any: {
      actual:
        "SELECT p.object, p.action, v FROM pairs p, LATERAL simetra.rights_any(p.action, p.object) v",
      expected: `SELECT p.object, p.action, w.scope FROM pairs p ${whole(" AND w.level = 'scope' AND w.extent = 'any'")}`,
    },
    own: {
      actual:
        "SELECT p.object, p.action, v FROM pairs p, LATERAL simetra.rights_own(p.action, p.object) v",
      expected: `SELECT p.object, p.action, w.scope FROM pairs p ${whole(" AND w.level = 'scope' AND w.extent = 'own'")}`,
    },
    dim: {
      actual:
        "SELECT p.object, p.action, p.dimension_id, v FROM extents p, LATERAL simetra.rights_dim(p.action, p.object, p.dimension_id) v WHERE p.extent = 'dimension'",
      expected: `SELECT p.object, p.action, p.dimension_id, w.scope FROM extents p ${whole(" AND w.level = 'scope' AND w.extent = 'dimension' AND w.dimension_id = p.dimension_id")} WHERE p.extent = 'dimension'`,
    },
    container: {
      actual:
        "SELECT p.object, p.action, p.extent, p.dimension_id, v FROM extents p, LATERAL simetra.rights_container(p.action, p.object, p.extent, p.dimension_id) v",
      expected: `SELECT p.object, p.action, p.extent, p.dimension_id, w.container FROM extents p ${whole(` AND w.level = 'container'${extent}`)}`,
    },
    has: {
      actual:
        "SELECT p.object, p.action, p.extent, p.dimension_id FROM extents p WHERE simetra.has_right(p.action, p.object, p.extent, p.dimension_id)",
      expected: `SELECT DISTINCT p.object, p.action, p.extent, p.dimension_id FROM extents p ${whole(` AND w.level <> 'container'${extent}`)}`,
    },
  }
  const ctes = Object.entries(functions).flatMap(([name, f]) => [
    `${name}_actual AS MATERIALIZED (${f.actual})`,
    `${name}_expected AS MATERIALIZED (${f.expected})`,
  ])
  const columns = Object.keys(functions).flatMap((name) => [
    `(SELECT count(*) FROM ((TABLE ${name}_actual EXCEPT TABLE ${name}_expected) UNION ALL (TABLE ${name}_expected EXCEPT TABLE ${name}_actual)) d)::int AS ${name}_diff`,
    `(SELECT count(*) FROM (SELECT DISTINCT a.object, a.action FROM (SELECT ${name === "pair" ? "po AS object, pa AS action" : "object, action"} FROM ${name}_actual) a) a)::int AS ${name}_nonempty`,
  ])
  const { rows } = await client.query<Record<string, number>>(
    `WITH pairs AS (SELECT DISTINCT object, action FROM simetra.rights_domain()),
      extents AS (SELECT DISTINCT object, action, extent, dimension_id FROM simetra.rights_domain()),
      whole AS MATERIALIZED (SELECT * FROM simetra.rights_mine()),
      need AS (SELECT object, action, action AS need FROM pairs UNION SELECT q.object, q.action, q.required FROM simetra.rights_requires() q),
      ${ctes.join(",\n      ")}
    SELECT ${columns.join(",\n      ")}`
  )
  return Object.fromEntries(
    Object.keys(functions).map((name) => [
      name,
      {
        diff: rows[0]![`${name}_diff`]!,
        nonempty: rows[0]![`${name}_nonempty`]!,
      },
    ])
  )
}
