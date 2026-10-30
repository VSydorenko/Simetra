import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import type { CompiledModel } from "simetra/compiler"
import {
  EVERYONE_ID,
  GRANT_FILE,
  ORG_ADMIN_ID,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_FILE,
  PROJECT_ID,
  PROJECT_LEAD_ID,
  REGION_DIMENSION_ID,
  ROLE_FILE,
  SET_FILE,
  SUPPORT_ID,
  TASK_FILE,
  TASK_ID,
  TEAM_LEAD_ID,
  USERS_FILE,
  compileRights,
  globalGrantsSource,
  grant,
  grantTable,
  objects,
  regionDimension,
  role,
  secondScopeKind,
  singleTenantRights,
  withRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { mainTableOf } from "../../src/compiler/contracts"
import {
  renderCondition,
  rightsPredicates,
} from "../../src/compiler/rights/predicates"
import { signUp } from "./auth"
import {
  expectEquivalent,
  installClosureOracle,
  mineEquivalence,
  roleGrantsEquivalence,
} from "./closure-oracle"
import { queryAs } from "./connection"
import {
  type Assignment,
  type Delta,
  type Seed,
  assignmentRow,
  describeTransaction,
  insert,
  orgDeltaRow,
  outcome,
  set,
  deploy,
} from "./rights-seed"

/**
 * Функції прав на справжньому Postgres (спека прав §5.1, план Права-2a1):
 * множини, які функції повертають під роллю запиту користувача, вирішує
 * Postgres над даними довідників прав — компілятор їх не бачить. Кожен опис
 * розгортає й засіває схему раз у власній транзакції й відкочує її в кінці
 * (Р2a1-18); кожен запит — від ролі API в точці збереження.
 */

const TASK = objects(["Document", "Task"])

/** Проєкт з видами скоупу `org` і `team`, виміром `region` і контейнером. */
async function scopeKindModel(): Promise<CompiledModel> {
  const team = secondScopeKind()
  const result = await compileRights(
    withRoles(team, {
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
        grants: [grant(objects(["Document", "Announcement"]), ["read"], "any")],
      },
      [ROLE_FILE("Everyone")]: {
        grants: [grant(objects(["Catalog", "Users"]), ["read"], "own")],
      },
    })
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
async function seedScopeKind(client: pg.Client): Promise<Seed> {
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
    ["allow", "announcement", "create", "any"],
    ["allow", "global_role_assignments", "read", "any"],
    ["allow", "gone", "read", "any"],
  ])
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
  // Р2a1-11: u22 має кастомну роль без `read@any` і окремо простий
  // `OrgMember` з ним — вимога з іншого призначення дії не рятує.
  await assign("u22", { customRole: ids.custom })
  await assign("u22", { archetype: ORG_MEMBER_ROLE_ID })

  // Р2a1-26: команда з `id` організації A, а учасники команди — з `id`
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

/**
 * Додатковий засів еквівалентності замикання (Р2d2-22) поверх засіву опису:
 * учасники A з кастомними ролями, де замикання знімає рядки обсягу
 * `dimension` (`d1`, `d2`), тримає їх тим самим обсягом (`d3`), і кастомна
 * роль контейнерного архетипу на P1 (`l1`). Повертає всіх користувачів
 * засіву — ключ → id.
 */
async function seedClosureExtras(
  client: pg.Client,
  ids: Seed
): Promise<Record<string, string>> {
  const region: Delta = [
    "deny",
    "task",
    "read",
    "dimension",
    REGION_DIMENSION_ID,
  ]
  const extras: [
    user: string,
    archetype: string,
    deltas: Delta[],
    container?: string,
  ][] = [
    ["d1", ORG_ADMIN_ID, [["deny", "task", "read", "any"], region]],
    [
      "d2",
      ORG_MEMBER_ROLE_ID,
      [
        ["deny", "task", "read", "any"],
        region,
        ["allow", "task", "update", "dimension", REGION_DIMENSION_ID],
      ],
    ],
    [
      "d3",
      ORG_MEMBER_ROLE_ID,
      [
        ["deny", "task", "read", "any"],
        ["allow", "task", "update", "dimension", REGION_DIMENSION_ID],
      ],
    ],
    [
      "l1",
      PROJECT_LEAD_ID,
      [
        ["deny", "task", "read", "any"],
        ["allow", "task", "update", "any"],
      ],
      ids.P1,
    ],
  ]
  const users: Record<string, string> = Object.fromEntries(
    Object.entries(ids).filter(([key]) => /^[ux]\d+$/.test(key))
  )
  for (const [user, archetype, deltas, container] of extras) {
    const sub = await signUp(client)
    const member = randomUUID()
    const role = randomUUID()
    users[user] = sub
    await insert(client, "org_member", {
      id: member,
      org_id: ids.A,
      user_id: sub,
    })
    await insert(client, "org_roles", { id: role, org_id: ids.A, archetype })
    for (const [i, delta] of deltas.entries())
      await insert(
        client,
        "org_roles_delta",
        orgDeltaRow(ids.A!, role, i + 1, delta)
      )
    await insert(client, "org_role_assignments", {
      org_id: ids.A,
      ...assignmentRow(member, {
        customRole: role,
        container: container ?? null,
      }),
    })
  }
  return users
}

const value = (expr: string) => `SELECT ${expr} AS v`
const mineCount = (where: string) =>
  `SELECT count(*)::int AS v FROM simetra.rights_mine() WHERE ${where}`
const any = (action: string, object = "task") =>
  set(`simetra.rights_any('${action}','${object}')`)
const own = (action: string) => set(`simetra.rights_own('${action}','task')`)
const containers = set(
  "simetra.rights_container('read','task','any',NULL::uuid)"
)
const hasRight = (action: string, object: string, extent = "any") =>
  value(`simetra.has_right('${action}','${object}','${extent}',NULL::uuid)`)

/**
 * Перевірка: користувач, запит з одним значенням `v` і очікування — масив
 * ключів засіву (множина) чи стала.
 */
type Check = [user: string, sql: string, expected: string[] | boolean | number]

/** Задачі, які відкривають предикати читання `Task` (OR предикатів, §5.4). */
let readableTasks = ""

const CASES: [name: string, checks: (() => Check[]) | Check[]][] = [
  ["any", [["u1", any("read"), ["A"]]]],
  ["foreign-tenant", [["u4", any("read"), []]]],
  [
    "deny-keeps-own",
    [
      ["u2", any("read"), []],
      ["u2", own("read"), ["A"]],
    ],
  ],
  ["closure", [["u2", any("update"), []]]],
  [
    "closure-same-assignment",
    [
      ["u22", any("update"), []],
      ["u22", any("read"), ["A"]],
    ],
  ],
  [
    "closure-chain",
    [
      ["u9", any("post"), []],
      ["u9", any("unpost"), []],
      ["u9", own("post"), ["A"]],
    ],
  ],
  [
    "closure-extents",
    [
      ["u10", own("post"), []],
      ["u10", any("update"), []],
    ],
  ],
  [
    "domain",
    [
      ["u2", hasRight("read", "announcement"), true],
      ["u2", hasRight("create", "announcement"), false],
    ],
  ],
  [
    "global-catalog",
    [
      ["u2", hasRight("read", "global_role_assignments"), false],
      ["u3", hasRight("read", "global_role_assignments"), false],
    ],
  ],
  [
    "level-mismatch",
    [
      ["u11", hasRight("read", "announcement"), false],
      ["u12", any("delete"), []],
      ["u13", containers, []],
      ["u14", hasRight("read", "announcement"), false],
    ],
  ],
  ["orphan", [["u2", hasRight("read", "gone"), false]]],
  [
    "full-access",
    [
      ["u3", any("delete"), ["A"]],
      ["u3", hasRight("read", "announcement"), true],
    ],
  ],
  ["container", [["u1", containers, ["P1"]]]],
  ["foreign-container", [["u8", containers, []]]],
  ["cross-kind-assignment", [["x1", any("delete"), []]]],
  [
    "cross-kind-own",
    () => [
      ["x2", readableTasks, ["tx2"]],
      [
        "x2",
        set(`simetra.rights_my_members('${ORG_KIND_ID}'::uuid)`),
        ["x2@A"],
      ],
    ],
  ],
  [
    "container-null",
    [
      ["u16", containers, []],
      ["u16", any("read"), []],
    ],
  ],
  [
    "container-ignored",
    [
      ["u17", mineCount("level <> 'container' AND container IS NOT NULL"), 0],
      ["u17", containers, []],
    ],
  ],
  [
    "container-only",
    [
      ["u18", any("read"), []],
      ["u18", own("read"), []],
      [
        "u18",
        set(`simetra.rights_dim('read','task','${REGION_DIMENSION_ID}'::uuid)`),
        [],
      ],
      ["u18", containers, ["P1"]],
    ],
  ],
  // Р2a1-28: позначка видалення контейнера прав не відкликає — мутації
  // немає, бо це відсутність фільтра, а не запобіжник.
  ["container-deletion-mark", [["u21", containers, ["P3"]]]],
  [
    "every-user-archetype",
    [["u19", mineCount("scope IS NOT NULL AND level = 'everyUser'"), 0]],
  ],
  [
    "other-scope-kind",
    [
      ["u20", any("read", "team_note"), []],
      ["u20", mineCount("object = 'team_note'"), 0],
    ],
  ],
  [
    "global",
    [
      ["u5", hasRight("read", "announcement"), true],
      ["u5", any("read"), []],
    ],
  ],
  ["every-user", [["u4", hasRight("read", "users", "own"), true]]],
  ["deletion-mark", [["u6", any("read"), []]]],
  ["custom-deletion-mark", [["u15", own("read"), []]]],
  [
    "invalid-user",
    [
      ["u7", any("read"), []],
      ["u7", hasRight("read", "users", "own"), false],
    ],
  ],
  [
    "dimension-values",
    [
      [
        "u1",
        set(`simetra.rights_dimension_values('${REGION_DIMENSION_ID}'::uuid)`),
        ["R1", "R2"],
      ],
    ],
  ],
  ["predicate", () => [["u2", readableTasks, ["t2"]]]],
]

describe("rights functions with a scope kind", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const model = await scopeKindModel()
    const client = await tx.open()
    await deploy(client, model)
    ids = await seedScopeKind(client)
    const contract = model.contracts.rights.find((c) => c.objectId === TASK_ID)!
    const predicates = rightsPredicates(
      contract,
      "read",
      mainTableOf(model.physical, TASK_ID)!
    ).map((p) => `(${p.conditions.map(renderCondition).join(" AND ")})`)
    readableTasks = `SELECT coalesce(array_agg(t.id::text), '{}') AS v FROM public.task t WHERE ${predicates.join(" OR ")}`
  })

  afterAll(() => tx.close())

  it.each(CASES)("%s", async (_, checks) => {
    for (const [user, sql, expected] of typeof checks === "function"
      ? checks()
      : checks) {
      // Невідомий ключ дав би claims без `sub` — і порожні множини без причини.
      const sub = ids[user]
      if (sub === undefined) throw new Error(`unknown seed key ${user}`)
      const result = await queryAs<{ v: unknown }>(
        tx.client(),
        "authenticated",
        { sub, role: "authenticated" },
        sql
      )
      const want = Array.isArray(expected)
        ? expected.map((key) => ids[key]!).sort()
        : expected
      // Мʼяка перевірка: червоні всі розбіжності кейсу, а не лише перша.
      expect.soft(outcome(result), `${user}: ${sql}`).toEqual(want)
    }
  })

  // Р2d2-22: замикання після переписування дає рівно рядки тіла до нього.
  // Засів опису плюс кастомні ролі з дельтами виміру й кастомна контейнерна
  // роль: замикання знімає рядки й на обсязі `dimension`, і в контейнері.
  it("closure-equivalence: the rows of the closure before the rewrite", async () => {
    const client = tx.client()
    await client.query("SAVEPOINT closure_oracle")
    try {
      await installClosureOracle(client, "scope-kind")
      const users = await seedClosureExtras(client, ids)
      expectEquivalent("rights_mine", await mineEquivalence(client, users))
      const scope = { level: "scope", levelId: ORG_KIND_ID }
      const dim = (effect: string, action: string) => ({
        effect,
        object: "task",
        action,
        extent: "dimension",
        dimension: REGION_DIMENSION_ID,
      })
      const anyDelta = (effect: string, action: string) => ({
        effect,
        object: "task",
        action,
        extent: "any",
        dimension: null,
      })
      expectEquivalent(
        "rights_role_grants",
        await roleGrantsEquivalence(client, {
          admin: { ...scope, archetype: ORG_ADMIN_ID, delta: [] },
          adminDimDeny: {
            ...scope,
            archetype: ORG_ADMIN_ID,
            delta: [anyDelta("deny", "read"), dim("deny", "read")],
          },
          member: { ...scope, archetype: ORG_MEMBER_ROLE_ID, delta: [] },
          memberUpdate: {
            ...scope,
            archetype: ORG_MEMBER_ROLE_ID,
            delta: [anyDelta("deny", "read"), anyDelta("allow", "update")],
          },
          memberDim: {
            ...scope,
            archetype: ORG_MEMBER_ROLE_ID,
            delta: [
              anyDelta("deny", "read"),
              dim("deny", "read"),
              dim("allow", "update"),
            ],
          },
          memberDimKept: {
            ...scope,
            archetype: ORG_MEMBER_ROLE_ID,
            delta: [anyDelta("deny", "read"), dim("allow", "update")],
          },
          lead: {
            level: "container",
            levelId: PROJECT_ID,
            archetype: PROJECT_LEAD_ID,
            delta: [anyDelta("deny", "read"), anyDelta("allow", "update")],
          },
          support: {
            level: "global",
            levelId: null,
            archetype: SUPPORT_ID,
            delta: [],
          },
          everyone: {
            level: "everyUser",
            levelId: null,
            archetype: EVERYONE_ID,
            delta: [],
          },
        })
      )
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT closure_oracle")
    }
  })

  it("service-role: empty sets without an error", async () => {
    expect(
      outcome(
        await queryAs<{ v: unknown }>(
          tx.client(),
          "service_role",
          { role: "service_role" },
          any("read")
        )
      )
    ).toEqual([])
  })

  it("anon may not execute a set function", async () => {
    expect(
      await queryAs(
        tx.client(),
        "anon",
        { role: "anon" },
        "SELECT simetra.rights_any('read','task')"
      )
    ).toEqual({ code: "42501" })
  })
})

/**
 * Однотенантний проєкт, де глобальний рівень призначень покриває прийняте
 * джерело, а глобальні довідники лишаються за контейнерний рівень `Project`
 * (Р2a1-24): так поруч живуть глобальне призначення й архетип покритого
 * рівня — обидва з `storage_id` `NULL`, і розрізняє їх лише рівень
 * зберігання.
 */
async function singleTenantModel(): Promise<CompiledModel> {
  const result = await compileRights(
    singleTenantRights({
      [PROJECT_FILE]: { assignmentSources: [globalGrantsSource()] },
      [GRANT_FILE]: grantTable(),
      [ROLE_FILE("Support")]: role(SUPPORT_ID, "Support", "global", {
        grants: [grant(TASK, ["read"], "any")],
      }),
    })
  )
  expect(result.diagnostics.map((d) => [d.severity, d.code])).toEqual([
    ["warning", "rights.adopted-source-writes"],
  ])
  return result.model!
}

describe("rights functions without scope kinds", () => {
  const tx = describeTransaction()
  let s1 = ""
  let s2 = ""
  let p1 = ""

  beforeAll(async () => {
    const model = await singleTenantModel()
    const client = await tx.open()
    await deploy(client, model)
    s1 = await signUp(client)
    s2 = await signUp(client)
    p1 = randomUUID()
    await insert(client, "project", { id: p1 })
    await insert(client, "project", { id: randomUUID() })
    await insert(
      client,
      "global_role_assignments",
      assignmentRow(s1, { archetype: PROJECT_LEAD_ID, container: p1 })
    )
    await insert(
      client,
      "global_role_assignments",
      assignmentRow(s2, { archetype: SUPPORT_ID })
    )
  })

  const as = (sub: string, sql: string) =>
    queryAs<{ v: unknown }>(
      tx.client(),
      "authenticated",
      { sub, role: "authenticated" },
      sql
    )

  afterAll(() => tx.close())

  it("single-tenant-container: a container role opens its container only", async () => {
    expect.soft(outcome(await as(s1, hasRight("read", "task")))).toBe(false)
    expect.soft(outcome(await as(s1, containers))).toEqual([p1])
  })

  // Р2a1-12/24: рядок глобального довідника не вмикає архетип рівня,
  // покритого джерелом, хоч `storage_id` обох — `NULL`.
  it("covered-level-archetype: a global catalog row does not enable it", async () => {
    expect.soft(outcome(await as(s2, hasRight("read", "task")))).toBe(false)
    expect.soft(outcome(await as(s2, mineCount("true")))).toBe(0)
  })
})
