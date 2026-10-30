import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import type { CompiledModel } from "simetra/compiler"
import {
  ATTACHMENTS_TABLE,
  CHECKLIST_TABLE,
  COMMENT_TABLE,
  HOURS_TABLES,
  ORG_MEMBER_ROLE_ID,
  PROJECT_LEAD_ID,
  ROLE_FILE,
  SUPPORT_ID,
  compileRights,
  grant,
  objects,
  policyDomain,
  secondScopeKind,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { queryAs } from "./connection"
import { planNodes, subPlans } from "./explain-plan"
import {
  type Assignment,
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
 * Політики прав читання й копії носіїв на справжньому Postgres (спека прав
 * §5.2, §5.4): які рядки бачить роль запиту під RLS
 * (`RESTRICTIVE`-межі разом з `PERMISSIVE`-правами), що пишуть тригери копій
 * і як планувальник виконує умови політик — вирішує Postgres, компілятор
 * бачить лише текст. Одне розгортання на опис: схема й засів — у
 * транзакції опису, яку `afterAll` відкочує; кейси, що пишуть, — у точці
 * збереження, яку кейс відкочує сам, тож порядок кейсів нічого не змінює.
 */

const TASK = objects(["Document", "Task"])

/**
 * Домен політик з другим видом скоупу `team` (кейс `users-cross-kind`) і
 * грантами ролей, яких типові файли не мають: контейнерна `ProjectLead`
 * читає задачі свого проєкту, глобальна `Support` — нескоуплені оголошення.
 */
async function policyModel(): Promise<CompiledModel> {
  const result = await compileRights(
    policyDomain(secondScopeKind(), {
      [ROLE_FILE("ProjectLead")]: { grants: [grant(TASK, ["read"], "any")] },
      [ROLE_FILE("Support")]: {
        grants: [grant(objects(["Document", "Announcement"]), ["read"], "any")],
      },
    })
  )
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/** Задачі засіву: ключ, організація, виконавець, проєкт, регіон. */
const TASKS = [
  ["t1", "A", "m1@A", "P1", "r2"],
  ["t2", "A", "m2@A", "P2", "r2"],
  ["t3", "A", "m3@A", "P2", "r2"],
  ["t4", "A", "m1@A", "P2", "r1"],
  // Засів передає tR від m1 до m2 після вставки коментаря й вкладення:
  // m2 бачить їх лише через поширення копій (двоходове — до вкладення).
  ["tR", "A", "m1@A", "P1", "r2"],
  ["tB", "B", "m5@B", null, "rB"],
] as const

/**
 * Сценарій плану: організації A і B; учасники m1 (A, `OrgMember`), m2 і m3
 * (A, кастомна роль на `OrgMember` з `deny read@any` на задачах, коментарях
 * і годинах; у m3 — регіон r1 у `MemberRegion`), m4 (A, лише `ProjectLead`
 * на P1), m5 (B, `OrgMember`), m6 (A без призначень і B з `OrgMember`);
 * u9 без членства (лише `Everyone`), s1 з глобальною `Support`; x3 і x4 —
 * учасники команди, чий `id` навмисно дорівнює `id` організації A. Кожна
 * задача має рядок ТЧ і коментар з вкладенням (ключі `<t>.l`, `<t>.c`,
 * `<t>.a`). Учасник `u` організації `O` — ключ `u@O`.
 */
async function seedPolicies(client: pg.Client): Promise<Seed> {
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

  for (const user of [
    "m1",
    "m2",
    "m3",
    "m4",
    "m5",
    "m6",
    "u9",
    "s1",
    "x3",
    "x4",
  ])
    ids[user] = await signUp(client)
  await create("A", "organization")
  await create("B", "organization")
  await create("P1", "project", { org_id: ids.A })
  await create("P2", "project", { org_id: ids.A })
  await create("r1", "region", { org_id: ids.A })
  await create("r2", "region", { org_id: ids.A })
  await create("rB", "region", { org_id: ids.B })
  for (const [user, org] of [
    ["m1", "A"],
    ["m2", "A"],
    ["m3", "A"],
    ["m4", "A"],
    ["m6", "A"],
    ["m5", "B"],
    ["m6", "B"],
  ] as const) {
    await create(`${user}@${org}`, "org_member", {
      org_id: ids[org],
      user_id: ids[user],
    })
  }

  await create("denyRead", "org_roles", {
    org_id: ids.A,
    archetype: ORG_MEMBER_ROLE_ID,
  })
  for (const [i, object] of ["task", "task_comment", "task_hours"].entries()) {
    await insert(
      client,
      "org_roles_delta",
      orgDeltaRow(ids.A!, ids.denyRead!, i + 1, ["deny", object, "read", "any"])
    )
  }
  await assign("m1@A", { archetype: ORG_MEMBER_ROLE_ID })
  await assign("m2@A", { customRole: ids.denyRead })
  await assign("m3@A", { customRole: ids.denyRead })
  await assign("m4@A", { archetype: PROJECT_LEAD_ID, container: ids.P1 })
  await assign("m5@B", { archetype: ORG_MEMBER_ROLE_ID })
  await assign("m6@B", { archetype: ORG_MEMBER_ROLE_ID })
  await insert(
    client,
    "global_role_assignments",
    assignmentRow(ids.s1!, { archetype: SUPPORT_ID })
  )
  await insert(client, "member_region", {
    org_id: ids.A,
    member_id: ids["m3@A"],
    region_id: ids.r1,
  })

  // Спека прав §5.1: команда з `id` організації A — збіг скоупів різних видів.
  await insert(client, "team", { id: ids.A })
  for (const user of ["x3", "x4"]) {
    await insert(client, "team_member", {
      id: randomUUID(),
      team_id: ids.A,
      user_id: ids[user],
    })
  }

  const now = new Date()
  for (const [key, org, assignee, project, region] of TASKS) {
    await create(key, "task", {
      org_id: ids[org],
      date: now,
      assignee_id: ids[assignee],
      project_id: project === null ? null : ids[project],
      region_id: ids[region],
    })
    await create(`${key}.l`, CHECKLIST_TABLE, {
      org_id: ids[org],
      parent_id: ids[key],
      line_number: 1,
    })
    await create(`${key}.c`, COMMENT_TABLE, {
      org_id: ids[org],
      task_id: ids[key],
    })
    await create(`${key}.a`, ATTACHMENTS_TABLE, {
      org_id: ids[org],
      parent_id: ids[`${key}.c`],
      line_number: 1,
    })
  }
  await client.query("UPDATE public.task SET assignee_id = $1 WHERE id = $2", [
    ids["m2@A"],
    ids.tR,
  ])

  for (const user of ["m1", "m2", "m5", "u9"]) {
    await create(`${user}.d`, "users_devices", {
      parent_id: ids[user],
      line_number: 1,
    })
  }
  for (const [org, region] of [
    ["A", "r1"],
    ["A", "r2"],
    ["B", "rB"],
  ] as const) {
    await insert(client, HOURS_TABLES.totals, {
      org_id: ids[org],
      region_id: ids[region],
      hours: 1,
    })
  }
  await create("a1", "announcement", { date: now })
  return ids
}

/** Значення колонки рядків запиту як множина тексту. */
const values = (sql: string) =>
  `SELECT coalesce(array_agg(x::text), '{}') AS v FROM (${sql}) AS q(x)`
const TASKS_READ = values("SELECT id FROM public.task")
const COMMENTS_READ = values(`SELECT id FROM public.${COMMENT_TABLE}`)
const DEVICES_READ = values("SELECT parent_id FROM public.users_devices")

/** Перевірка: користувач, запит з одним значенням `v`, ключі засіву. */
type Check = [user: string, sql: string, expected: string[]]

const CASES: [name: string, checks: Check[]][] = [
  ["any", [["m1", TASKS_READ, ["t1", "t2", "t3", "t4", "tR"]]]],
  ["foreign-tenant", [["m5", TASKS_READ, ["tB"]]]],
  // Членство в A без ролі нічого в A не відкриває: межа тенанта лише звужує.
  ["member-without-role", [["m6", TASKS_READ, ["tB"]]]],
  ["own", [["m2", TASKS_READ, ["t2", "tR"]]]],
  ["dimension", [["m3", TASKS_READ, ["t3", "t4"]]]],
  ["container", [["m4", TASKS_READ, ["t1", "tR"]]]],
  [
    "unscoped",
    [
      ["s1", values("SELECT id FROM public.announcement"), ["a1"]],
      ["m1", values("SELECT id FROM public.announcement"), []],
    ],
  ],
  [
    "users-cross-tenant",
    [
      [
        "m1",
        values("SELECT id FROM public.users"),
        ["m1", "m2", "m3", "m4", "m6"],
      ],
    ],
  ],
  [
    "users-cross-kind",
    [["x3", set("simetra.rights_visible_users()"), ["x3", "x4"]]],
  ],
  [
    "tabular",
    [
      [
        "m2",
        values(`SELECT parent_id FROM public.${CHECKLIST_TABLE}`),
        ["t2", "tR"],
      ],
    ],
  ],
  ["path", [["m2", COMMENTS_READ, ["t2.c", "tR.c"]]]],
  [
    "path-tabular",
    [
      [
        "m2",
        values(`SELECT parent_id FROM public.${ATTACHMENTS_TABLE}`),
        ["t2.c", "tR.c"],
      ],
    ],
  ],
  // `read@any` на «Користувачах» не відкриває пристроїв невидимих користувачів.
  ["users-devices-cross-tenant", [["m1", DEVICES_READ, ["m1", "m2"]]]],
  ["key-carrier", [["u9", DEVICES_READ, ["u9"]]]],
  // `deny read@any` m3 покриває й `TaskHours`: лишається вимір.
  [
    "register-totals",
    [
      [
        "m3",
        values(`SELECT region_id FROM public.${HOURS_TABLES.totals}`),
        ["r1"],
      ],
    ],
  ],
]

describe("policies", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const model = await policyModel()
    const client = await tx.open()
    await deploy(client, model)
    ids = await seedPolicies(client)
  })

  afterAll(() => tx.close())

  const key = (name: string) => {
    // Невідомий ключ дав би claims без `sub` — і порожні множини без причини.
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }

  const readAs = async (user: string, sql: string) => {
    const sub = key(user)
    return outcome(
      await queryAs<{ v: unknown }>(
        tx.client(),
        "authenticated",
        { sub, role: "authenticated" },
        sql
      )
    )
  }

  const keys = (names: string[]) => names.map(key).sort()

  /** Кейс, що пише від власника: усе, що він змінив, відкочується. */
  const rolledBack = async (fn: (client: pg.Client) => Promise<void>) => {
    const client = tx.client()
    await client.query("SAVEPOINT scenario")
    try {
      await fn(client)
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT scenario")
    }
  }

  it.each(CASES)("%s", async (_, checks) => {
    for (const [user, sql, expected] of checks) {
      // Мʼяка перевірка: червоні всі розбіжності кейсу, а не лише перша.
      expect
        .soft(await readAs(user, sql), `${user}: ${sql}`)
        .toEqual(keys(expected))
    }
  })

  // Умови політик — `= ANY (ARRAY(SELECT …))` і `(SELECT has_right(…))`:
  // функція прав рахується раз на запит (InitPlan), а не на рядок (SubPlan).
  it.each([
    CHECKLIST_TABLE,
    COMMENT_TABLE,
    ATTACHMENTS_TABLE,
    HOURS_TABLES.totals,
  ])("plan of %s evaluates rights once per query", async (table) => {
    const result = await queryAs<{ "QUERY PLAN": unknown }>(
      tx.client(),
      "authenticated",
      { sub: key("m1"), role: "authenticated" },
      `EXPLAIN (FORMAT JSON) SELECT * FROM public.${table}`
    )
    if (!("rows" in result)) throw new Error(`EXPLAIN failed: ${result.code}`)
    const plan = result.rows[0]!["QUERY PLAN"]
    expect.soft(planNodes(plan).some((n) => n.parent === "InitPlan")).toBe(true)
    expect.soft(subPlans(plan)).toEqual([])
  })

  it("forged-copy-update: a forged path copy is re-derived from its source", () =>
    rolledBack(async (client) => {
      const before = await readAs("m2", COMMENTS_READ)
      const { rows } = await client.query<{ copy: string }>(
        `UPDATE public.${COMMENT_TABLE} SET task_id_assignee_id = $1 WHERE id = $2 RETURNING task_id_assignee_id AS copy`,
        [key("m5@B"), key("t2.c")]
      )
      expect.soft(rows).toEqual([{ copy: key("m2@A") }])
      expect.soft(await readAs("m2", COMMENTS_READ)).toEqual(before)
    }))

  it("forged-copy: an inserted tabular row takes the copy from its owner", () =>
    rolledBack(async (client) => {
      const { rows } = await client.query<{ copy: string }>(
        `INSERT INTO public.${CHECKLIST_TABLE} (org_id, parent_id, line_number, assignee_id) VALUES ($1, $2, 2, $3) RETURNING assignee_id AS copy`,
        [key("A"), key("t2"), key("m5@B")]
      )
      expect(rows).toEqual([{ copy: key("m2@A") }])
    }))

  // Залежний рядок — у CTE, джерело — в основному операторі: основний
  // `INSERT` тягне рядок з CTE, тож рядок ТЧ пишеться раніше за задачу і
  // `BEFORE`-тригер ТЧ джерела ще не бачить. У зворотному порядку (задача в
  // CTE) тригер ТЧ, що бере новий знімок, задачу вже бачив би, і кейс не
  // доводив би гілки `INSERT` тригера поширення.
  it("source-after-dependent: a tabular row written before its owner gets the copy", () =>
    rolledBack(async (client) => {
      const task = randomUUID()
      await client.query(
        `WITH a AS (INSERT INTO public.${CHECKLIST_TABLE} (org_id, parent_id, line_number) VALUES ($1::uuid, $2::uuid, 1) RETURNING parent_id)
         INSERT INTO public.task (id, org_id, date, assignee_id) SELECT parent_id, $1::uuid, now(), $3::uuid FROM a`,
        [key("A"), task, key("m2@A")]
      )
      const { rows } = await client.query<{ copy: string | null }>(
        `SELECT assignee_id AS copy FROM public.${CHECKLIST_TABLE} WHERE parent_id = $1`,
        [task]
      )
      expect(rows).toEqual([{ copy: key("m2@A") }])
    }))

  it("propagation-owner: an owner change reaches tabular copies", () =>
    rolledBack(async (client) => {
      const version = async () =>
        (
          await client.query<{ v: number }>(
            "SELECT version::int AS v FROM public.task WHERE id = $1",
            [key("t2")]
          )
        ).rows[0]!.v
      const before = await version()
      await client.query(
        "UPDATE public.task SET assignee_id = $1 WHERE id = $2",
        [key("m1@A"), key("t2")]
      )
      const { rows } = await client.query<{ copy: string | null }>(
        `SELECT assignee_id AS copy FROM public.${CHECKLIST_TABLE} WHERE parent_id = $1`,
        [key("t2")]
      )
      expect.soft(rows).toEqual([{ copy: key("m1@A") }])
      expect.soft(await version()).toBe(before + 1)
    }))

  it("propagation-path: path copies follow in two hops without a content change", () =>
    rolledBack(async (client) => {
      const comment = async () =>
        (
          await client.query<{ copy: string | null; version: number }>(
            `SELECT task_id_assignee_id AS copy, version::int AS version FROM public.${COMMENT_TABLE} WHERE id = $1`,
            [key("t2.c")]
          )
        ).rows[0]!
      const before = { comment: await comment() }
      // Підписка `onWrite` коментаря сповіщає (`RAISE NOTICE`) на кожному
      // своєму спрацюванні; поширення копій її не будить.
      const fired: string[] = []
      client.on("notice", (message) => {
        if (message.message?.startsWith("count_comment:") === true) {
          fired.push(message.message)
        }
      })
      await client.query(
        "UPDATE public.task SET assignee_id = $1 WHERE id = $2",
        [key("m1@A"), key("t2")]
      )
      const { rows } = await client.query<{ copy: string | null }>(
        `SELECT task_id_assignee_id AS copy FROM public.${ATTACHMENTS_TABLE} WHERE parent_id = $1`,
        [key("t2.c")]
      )
      expect.soft(await comment()).toEqual({
        copy: key("m1@A"),
        version: before.comment.version,
      })
      expect.soft(rows).toEqual([{ copy: key("m1@A") }])
      expect.soft(fired).toEqual([])
    }))

  // Рядок ТЧ не посилається на власника чужого скоупу (складений
  // FK); проходить і без політик прав, мутаційного твердження немає.
  it("tabular-foreign-scope: a tabular row of another scope is refused", () =>
    rolledBack(async (client) => {
      const error = await client
        .query(
          `INSERT INTO public.${CHECKLIST_TABLE} (org_id, parent_id, line_number) VALUES ($1, $2, 2)`,
          [key("B"), key("t1")]
        )
        .then(
          () => undefined,
          (e: { code?: string }) => e.code
        )
      expect(error).toBe("23503")
    }))
})
