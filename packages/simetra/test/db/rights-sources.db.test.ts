import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import type { CompiledModel } from "simetra/compiler"
import { renderApplyState, renderDesiredState } from "simetra/schema"
import {
  ADOPTED_LEAD_KEY,
  ADOPTED_MEMBER_KEY,
  ADOPTED_SUPPORT_KEY,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_LEAD_ID,
  adoptedCrossKind,
  adoptedSourcesDomain,
  compileRights,
  polymorphicGrants,
  withoutUsers,
} from "../../src/compiler/__tests__/fixtures/rights"
import {
  type RightsSourceInput,
  readRightsSourceFacts,
  rightsSourceInput,
} from "../../src/schema/apply/rights-sources"
import { signUp } from "./auth"
import {
  type ApiRole,
  queryAs,
  rollbackDatabase,
  testRoleName,
} from "./connection"
import {
  type Seed,
  assignmentRow,
  describeTransaction,
  insert,
  outcome,
  set,
} from "./rights-seed"

/**
 * Прийняті джерела прав на справжньому Postgres (спека прав §4.7, план
 * Права-2d1): що функції прав повертають під роллю `authenticated` для живих
 * рядків прийнятих таблиць (зокрема поліморфної таблиці призначень і таблиці
 * ролей), що пропускають політики читання, що regex і приведення `sub` без
 * «Користувачів» не кидають, і що читання власника й даних цілі планом
 * працює на справжньому каталозі — компілятор бачить лише текст. Одне
 * розгортання на опис (Р2a1-18); засів — у `beforeAll`, кейси лише читають.
 */

/** Модель проєкту з компіляції; попередження — лише межа джерел (Р2d1-9). */
async function sourcesModel(
  files: ReadonlyMap<string, string>
): Promise<CompiledModel> {
  const result = await compileRights(files)
  expect(
    result.diagnostics.filter((d) => d.code !== "rights.adopted-source-writes")
  ).toEqual([])
  return result.model!
}

/** Від чийого імені запит: ключ засіву (`sub`) чи власні роль і claims. */
type Who = string | { role: ApiRole; claims: Record<string, unknown> }

/** Перевірка: хто, запит з одним значенням `v` і очікування (масив — множина). */
type Check = [who: Who, sql: string, expected: unknown]

/** Кейс: перевірки з id засіву (`id` кидає на невідомому ключі). */
type Case = [name: string, checks: (id: (key: string) => string) => Check[]]

const value = (expr: string) => `SELECT ${expr} AS v`
/** Рядки прав, крім «кожного користувача» (роль `Everyone` — не джерело). */
const MINE = `SELECT coalesce(array_agg(m.level || '|' || coalesce(m.scope::text, '-') || '|' || coalesce(m.container::text, '-') || '|' || m.object || '|' || m.action || '|' || m.extent), '{}') AS v FROM simetra.rights_mine() m WHERE m.level <> 'everyUser'`
const MY_SCOPES = `SELECT coalesce(array_agg(s.scope_kind_id::text || '|' || s.scope::text || '|' || s.member::text), '{}') AS v FROM simetra.rights_my_scopes() s`
const TASKS = `SELECT coalesce(array_agg(t.id::text), '{}') AS v FROM public.task t`
const hasRight = (action: string, object: string) =>
  value(`simetra.has_right('${action}','${object}','any',NULL::uuid)`)
/** Скоупи рядків рівня скоупу `rights_mine()` — напряму, без межі тенанта. */
const SCOPE_ROWS = `SELECT coalesce(array_agg(DISTINCT m.scope::text), '{}') AS v FROM simetra.rights_mine() m WHERE m.level = 'scope'`
/** Контейнери рядків контейнерного рівня `rights_mine()`. */
const CONTAINER_ROWS = `SELECT coalesce(array_agg(DISTINCT m.container::text), '{}') AS v FROM simetra.rights_mine() m WHERE m.level = 'container'`

/** Перевірки кейсу: кожна — від свого імені, м'яко (червоні всі розбіжності). */
async function runChecks(
  client: pg.Client,
  ids: Seed,
  checks: Case[1]
): Promise<void> {
  const id = (key: string) => {
    const found = ids[key]
    // Невідомий ключ дав би claims без `sub` — і порожні множини без причини
    if (found === undefined) throw new Error(`unknown seed key ${key}`)
    return found
  }
  for (const [who, sql, expected] of checks(id)) {
    const [role, claims] =
      typeof who === "string"
        ? (["authenticated", { sub: id(who), role: "authenticated" }] as const)
        : [who.role, who.claims]
    const result = await queryAs<{ v: unknown }>(client, role, claims, sql)
    const want = Array.isArray(expected) ? [...expected].sort() : expected
    expect.soft(outcome(result), `${JSON.stringify(who)}: ${sql}`).toEqual(want)
  }
}

/** Оператор власника в точці збереження: код помилки Postgres чи `undefined`. */
async function ownerCode(
  client: pg.Client,
  run: () => Promise<unknown>
): Promise<string | undefined> {
  await client.query("SAVEPOINT owner_try")
  try {
    await run()
    return undefined
  } catch (error) {
    const code = (error as { code?: unknown }).code
    if (typeof code !== "string") throw error
    return code
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT owner_try")
  }
}

/**
 * Факти джерел (`readRightsSourceFacts`) у точці збереження: виняток читача
 * не лишає транзакцію опису перерваною, а `row_security` — зміненим.
 */
async function sourceFacts(client: pg.Client, input: RightsSourceInput) {
  await client.query("SAVEPOINT source_facts")
  try {
    return await rollbackDatabase(client).transaction(
      { url: "" },
      "rollback",
      (t) => readRightsSourceFacts(t, input)
    )
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT source_facts")
  }
}

/** Засів з ключами `ids`: рядок з новим id під ключем. */
function seeder(client: pg.Client, ids: Seed) {
  return async (
    key: string,
    table: string,
    values: Record<string, unknown> = {},
    id: string = randomUUID()
  ) => {
    ids[key] = id
    await insert(client, table, { id, ...values })
  }
}

/**
 * Засів опису «adopted sources»: тенанти A і B, учасники `Membership` (ключ
 * `u@O`; `un` — з `is_active IS NULL`, `nouser@A` — без користувача),
 * проєкти P1 і P2 в A, задача P1, рядки `RoleGrant` і `GlobalGrant` з плану,
 * призначення довідника `org` з учасником u7 і учасник `team` u6 з id
 * неактивного u2@A у команді з id A (Р2a1-26).
 */
async function seedAdopted(client: pg.Client): Promise<Seed> {
  const ids: Seed = {}
  const create = seeder(client, ids)
  for (const user of ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u9", "un"])
    ids[user] = await signUp(client)
  await create("A", "organization")
  await create("B", "organization")
  const member = (user: string | null, org: string, active: boolean | null) =>
    create(`${user ?? "nouser"}@${org}`, "membership", {
      org_id: ids[org],
      user_id: user === null ? null : ids[user],
      is_active: active,
    })
  for (const user of ["u1", "u5", "u7", "u9"]) await member(user, "A", true)
  await member("u2", "A", false)
  await member("un", "A", null)
  await member(null, "A", true)
  await member("u3", "B", true)
  await create("P1", "project", { org_id: ids.A })
  await create("P2", "project", { org_id: ids.A })
  await create("t1", "task", {
    org_id: ids.A,
    date: new Date(),
    project_id: ids.P1,
  })
  const roleGrant = (
    member: string | null,
    key: string | null,
    project: string
  ) =>
    insert(client, "role_grant", {
      id: randomUUID(),
      member_id: member === null ? null : ids[member],
      role_key: key,
      project_id: ids[project],
    })
  await roleGrant("u1@A", ADOPTED_LEAD_KEY, "P1")
  // Учасник B на проєкті A — аналог R1 для контейнера (Review Focus 6)
  await roleGrant("u3@B", ADOPTED_LEAD_KEY, "P1")
  await roleGrant("u1@A", "nope", "P1")
  await roleGrant("u2@A", ADOPTED_LEAD_KEY, "P1")
  await roleGrant("u2@A", ADOPTED_LEAD_KEY, "P2")
  // Ключ глобальної ролі в контейнерному джерелі
  await roleGrant("u9@A", ADOPTED_SUPPORT_KEY, "P1")
  await roleGrant("u1@A", null, "P1")
  await roleGrant(null, ADOPTED_LEAD_KEY, "P1")
  await insert(client, "global_grant", {
    id: randomUUID(),
    member_id: ids.u4,
    role_key: ADOPTED_SUPPORT_KEY,
  })
  await insert(client, "org_role_assignments", {
    org_id: ids.A,
    ...assignmentRow(ids["u7@A"]!, { archetype: ORG_MEMBER_ROLE_ID }),
  })
  await insert(client, "team", { id: ids.A })
  await insert(client, "team_member", {
    id: ids["u2@A"],
    team_id: ids.A,
    user_id: ids.u6,
  })
  return ids
}

const ADOPTED_CASES: Case[] = [
  [
    "source-scopes",
    (id) => [
      ["u1", MY_SCOPES, [`${ORG_KIND_ID}|${id("A")}|${id("u1@A")}`]],
      ["u2", MY_SCOPES, []],
    ],
  ],
  ["source-container", (id) => [["u1", TASKS, [id("t1")]]]],
  [
    "source-not-mine",
    (id) => [
      ["u5", MINE, []],
      ["u3", TASKS, []],
      [
        "u3",
        value(
          `(SELECT count(*)::int FROM simetra.rights_mine() m WHERE m.level = 'container' AND m.container = '${id("P1")}')`
        ),
        0,
      ],
    ],
  ],
  ["source-cross-kind", () => [["u6", MINE, []]]],
  [
    "source-inactive",
    () => [
      ["u2", MY_SCOPES, []],
      ["u2", MINE, []],
      ["un", MY_SCOPES, []],
      ["un", MINE, []],
    ],
  ],
  ["source-wrong-level", () => [["u9", MINE, []]]],
  [
    "source-global",
    () => [
      ["u4", hasRight("read", "announcement"), true],
      // Негативний контроль: глобальний рядок u4 — не мій
      ["u1", hasRight("read", "announcement"), false],
      [
        "u1",
        value(
          "(SELECT count(*)::int FROM simetra.rights_mine() m WHERE m.level = 'global')"
        ),
        0,
      ],
    ],
  ],
  [
    "source-visible-users",
    (id) => [
      [
        "u1",
        set("simetra.rights_visible_users()"),
        [id("u1"), id("u5"), id("u7"), id("u9")],
      ],
    ],
  ],
]

describe("adopted sources", () => {
  const tx = describeTransaction()
  let ids: Seed = {}
  let model: CompiledModel
  /** Рядки `MINE` ролі `ProjectLead` на P1 у скоупі A. */
  let leadRows: string[] = []

  beforeAll(async () => {
    model = await sourcesModel(adoptedSourcesDomain(adoptedCrossKind()))
    const client = await tx.open()
    await client.query(renderDesiredState(model).sql)
    ids = await seedAdopted(client)
    const projection = await client.query<{
      object: string
      action: string
      extent: string
    }>(
      "SELECT object, action, extent FROM simetra.rights_projection() WHERE role_id = $1",
      [PROJECT_LEAD_ID]
    )
    leadRows = projection.rows.map(
      (p) => `container|${ids.A}|${ids.P1}|${p.object}|${p.action}|${p.extent}`
    )
  })

  afterAll(() => tx.close())

  it.each(ADOPTED_CASES)("%s", (_, checks) =>
    runChecks(tx.client(), ids, checks)
  )

  // `nope`, `role_key IS NULL` і `member_id IS NULL` нічого не дають без
  // помилки: u1 має рівно права `lead` на P1
  it("source-unknown-key", async () => {
    expect(leadRows.length).toBeGreaterThan(0)
    await runChecks(tx.client(), ids, () => [["u1", MINE, leadRows]])
  })

  // Р2d1-5: `subject` довідника `org` посилається на прийняте членство, тож
  // FK тримає і тенант учасника, і видалення учасника з призначенням
  it("source-subject", async () => {
    const client = tx.client()
    await runChecks(client, ids, () => [["u7", hasRight("read", "task"), true]])
    expect(
      await ownerCode(client, () =>
        insert(client, "org_role_assignments", {
          org_id: ids.A,
          ...assignmentRow(ids["u3@B"]!, { archetype: ORG_MEMBER_ROLE_ID }),
        })
      )
    ).toBe("23503")
    expect(
      await ownerCode(client, () =>
        client.query("DELETE FROM public.membership WHERE id = $1", [
          ids["u7@A"],
        ])
      )
    ).toBe("23503")
  })

  it("source-plan-facts", async () => {
    const client = tx.client()
    const input = rightsSourceInput(model.contracts)
    const facts = (only: RightsSourceInput = input) => sourceFacts(client, only)
    const ownersOf = (...tables: [schema: string, name: string][]) =>
      facts({
        tables: tables.map(([schema, name]) => ({ schema, name })),
        assignments: [],
      })
    // Під роллю опису — власник таблиць
    expect(await facts()).toEqual({
      owners: [
        { table: "public.membership", owned: true },
        { table: "public.role_grant", owned: true },
        { table: "public.global_grant", owned: true },
      ],
      unknownKeys: [
        { source: "grants", keys: ["nope", ADOPTED_SUPPORT_KEY], more: 0 },
        { source: "globalGrants", keys: [], more: 0 },
      ],
    })
    // Роль з `SELECT`, але не власник і без `BYPASSRLS`: таблиця з RLS —
    // відмова, і її дані не читаються; таблиці без RLS — без вимоги
    const role = testRoleName("source_reader")
    const owner = testRoleName("source_owner")
    const heir = testRoleName("source_heir")
    const blind = testRoleName("source_blind")
    // Таблиці й схема — з тегованими іменами ролей: окремого помічника імен
    // схем немає, а все створене відкочує точка збереження
    const ownedTable = `${owner}_t`
    const schema = testRoleName("source_schema")
    await client.query("SAVEPOINT plan_facts")
    try {
      // Творець ролі може перемкнутися на неї лише з `set` (Postgres 16+)
      await client.query("SET LOCAL createrole_self_grant = 'set, inherit'")
      await client.query(`CREATE ROLE ${role} NOLOGIN NOBYPASSRLS`)
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`)
      await client.query(
        `GRANT SELECT ON public.membership, public.role_grant, public.global_grant TO ${role}`
      )
      await client.query(
        "ALTER TABLE public.role_grant ENABLE ROW LEVEL SECURITY"
      )
      await client.query(`SET LOCAL ROLE ${role}`)
      expect(await facts()).toEqual({
        owners: [
          { table: "public.membership", owned: true },
          { table: "public.role_grant", owned: false },
          { table: "public.global_grant", owned: true },
        ],
        unknownKeys: [{ source: "globalGrants", keys: [], more: 0 }],
      })
      await client.query("RESET ROLE")

      // Власник, успадкований через членство (`pg_has_role`), обходить RLS
      await client.query(`CREATE ROLE ${owner} NOLOGIN NOBYPASSRLS`)
      await client.query(`GRANT USAGE, CREATE ON SCHEMA public TO ${owner}`)
      await client.query(`CREATE TABLE public.${ownedTable} (id integer)`)
      await client.query(`ALTER TABLE public.${ownedTable} OWNER TO ${owner}`)
      await client.query(
        `ALTER TABLE public.${ownedTable} ENABLE ROW LEVEL SECURITY`
      )
      await client.query(`CREATE ROLE ${heir} NOLOGIN NOBYPASSRLS`)
      await client.query(`GRANT ${owner} TO ${heir}`)
      await client.query(`SET LOCAL ROLE ${heir}`)
      expect
        .soft(await ownersOf(["public", ownedTable]), "inherited owner")
        .toEqual({
          owners: [{ table: `public.${ownedTable}`, owned: true }],
          unknownKeys: [],
        })
      await client.query("RESET ROLE")

      // Без `SELECT` на таблиці без RLS — відмова; без `USAGE` на схемі —
      // теж відмова (рядок є), а не відсутність і не `42501`
      await client.query(`CREATE ROLE ${blind} NOLOGIN NOBYPASSRLS`)
      await client.query(`GRANT USAGE ON SCHEMA public TO ${blind}`)
      await client.query(`CREATE SCHEMA ${schema}`)
      await client.query(`CREATE TABLE ${schema}.t (id integer)`)
      await client.query(`GRANT SELECT ON ${schema}.t TO ${blind}`)
      await client.query(`SET LOCAL ROLE ${blind}`)
      expect
        .soft(await ownersOf(["public", "membership"]), "no SELECT")
        .toEqual({
          owners: [{ table: "public.membership", owned: false }],
          unknownKeys: [],
        })
      expect.soft(await ownersOf([schema, "t"]), "no schema USAGE").toEqual({
        owners: [{ table: `${schema}.t`, owned: false }],
        unknownKeys: [],
      })
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT plan_facts")
    }
  })
})

/**
 * Засів опису «without users»: id користувача — uuid `sub` (без
 * «Користувачів»), учасники u1, u5 в A і u3, u8 у B, проєкт P1 в A із
 * задачею й рядком `RoleGrant`, таблиця ролей із системними (без тенанта) і
 * кастомними рядками, проєкти P_B і P_X у B (id P_X = id A — колізія id, які
 * генерує клієнт) і рядки `poly_grants` з плану.
 */
async function seedWithoutUsers(client: pg.Client): Promise<Seed> {
  const ids: Seed = {}
  const create = seeder(client, ids)
  for (const user of ["u1", "u3", "u5", "u8"]) ids[user] = randomUUID()
  await create("A", "organization")
  await create("B", "organization")
  for (const [user, org] of [
    ["u1", "A"],
    ["u5", "A"],
    ["u3", "B"],
    ["u8", "B"],
  ] as const) {
    await create(`${user}@${org}`, "membership", {
      org_id: ids[org],
      user_id: ids[user],
      is_active: true,
    })
  }
  await create("P1", "project", { org_id: ids.A })
  await create("t1", "task", {
    org_id: ids.A,
    date: new Date(),
    project_id: ids.P1,
  })
  await insert(client, "role_grant", {
    id: randomUUID(),
    member_id: ids["u1@A"],
    role_key: ADOPTED_LEAD_KEY,
    project_id: ids.P1,
  })
  for (const [key, org, roleKey] of [
    ["R_sys", null, ADOPTED_MEMBER_KEY],
    ["R_cust", "A", ADOPTED_MEMBER_KEY],
    ["R_ghost", null, "ghost"],
    ["R_z", "A", "zzz"],
    ["R_lead", null, ADOPTED_LEAD_KEY],
  ] as const) {
    await create(key, "source_roles", {
      key: roleKey,
      org_id: org === null ? null : ids[org],
    })
  }
  await create("P_B", "project", { org_id: ids.B })
  await create("P_X", "project", { org_id: ids.B }, ids.A)
  for (const [member, role, scopeType, scope] of [
    ["u1@A", "R_sys", "org", "A"], // контроль
    ["u3@B", "R_sys", "org", "A"], // R1
    ["u8@B", "R_sys", "container", "B"], // R1'
    ["u5@A", "R_cust", "org", "A"], // R2
    ["u1@A", "R_ghost", "org", "A"],
    ["u1@A", "R_z", "org", "A"],
    ["u8@B", "R_lead", "container", "P_B"], // контейнерний контроль
    ["u3@B", "R_lead", "org", "A"], // рівень скоупу з `scope_id` = id P_X
  ] as const) {
    await insert(client, "poly_grants", {
      id: randomUUID(),
      member_id: ids[member],
      role_id: ids[role],
      scope_type: scopeType,
      scope_id: ids[scope],
    })
  }
  return ids
}

const CURRENT_USER = value("simetra.current_user_id()")
/** `sub` не uuid: без regex приведення кинуло б `22P02` на кожному запиті. */
const NOT_A_UUID: Who = {
  role: "authenticated",
  claims: { sub: "not-a-uuid", role: "authenticated" },
}

const WITHOUT_USERS_CASES: Case[] = [
  [
    "no-users-subject",
    (id) => [
      ["u1", CURRENT_USER, id("u1")],
      ["u1", TASKS, [id("t1")]],
      [NOT_A_UUID, CURRENT_USER, null],
      [NOT_A_UUID, TASKS, []],
      [NOT_A_UUID, MINE, []],
      [{ role: "anon", claims: { role: "anon" } }, CURRENT_USER, null],
    ],
  ],
  [
    "poly-control",
    (id) => [
      ["u1", SCOPE_ROWS, [id("A")]],
      [
        "u1",
        value(
          `EXISTS (SELECT 1 FROM simetra.rights_mine() m WHERE m.level = 'scope' AND m.scope = '${id("A")}' AND m.object = 'task' AND m.action = 'read')`
        ),
        true,
      ],
    ],
  ],
  ["poly-scope-mismatch", () => [["u3", SCOPE_ROWS, []]]],
  ["poly-other-level", () => [["u8", SCOPE_ROWS, []]]],
  ["poly-custom-role", () => [["u5", SCOPE_ROWS, []]]],
  [
    "poly-container-collision",
    (id) => [
      ["u8", CONTAINER_ROWS, [id("P_B")]],
      ["u3", CONTAINER_ROWS, []],
    ],
  ],
]

describe("without users", () => {
  const tx = describeTransaction()
  let ids: Seed = {}
  let model: CompiledModel

  beforeAll(async () => {
    model = await sourcesModel(
      adoptedSourcesDomain(withoutUsers(), polymorphicGrants())
    )
    const client = await tx.open()
    await client.query(renderDesiredState(model).sql)
    // Без «Користувачів» гранти схеми `simetra` дає стан застосування, а не
    // платформний шар (Р2d1-6): без них роль API не дійде до жодної функції.
    // Те саме поєднання, що застосування бере з `desiredForApply`
    // (`schema/apply/desired.ts`)
    await client.query(renderApplyState(model))
    ids = await seedWithoutUsers(client)
  })

  afterAll(() => tx.close())

  it.each(WITHOUT_USERS_CASES)("%s", (_, checks) =>
    runChecks(tx.client(), ids, checks)
  )

  // Ключі — з тим самим з'єднанням і умовами, що функції прав (Р2d1-18):
  // `zzz` відсікає `where` ролі, а `lead` рядка колізії і `member` рядка R1'
  // — ключі іншого рівня в джерелі над спільною таблицею
  it("poly-plan-keys", async () => {
    const facts = await sourceFacts(
      tx.client(),
      rightsSourceInput(model.contracts)
    )
    const keysOf = (source: string) =>
      facts.unknownKeys.find((u) => u.source === source)?.keys
    expect.soft(keysOf("polyGrants")).toEqual(["ghost", ADOPTED_LEAD_KEY])
    expect.soft(keysOf("polyContainerGrants")).toEqual([ADOPTED_MEMBER_KEY])
  })
})
