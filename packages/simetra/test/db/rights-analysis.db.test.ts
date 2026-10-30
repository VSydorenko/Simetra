import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import {
  COMMAND_SETTING,
  PLATFORM_ROLES,
  SESSION_CLAIMS_SETTING,
} from "simetra/model"
import { accessPolicyNames } from "../../src/compiler/access-units"
import {
  BULLETIN_TABLE,
  EVERYONE_ID,
  GLOBAL_ADMIN_ID,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  PROJECT_LEAD_ID,
  PROJECT_READER_ID,
  RIGHTS_ADMIN_ID,
  RIGHTS_ONLY_ADMIN_ID,
  ROLE_FILE,
  TASK_VIEWER_ID,
  TEAM_KIND_ID,
  TEAM_RIGHTS_ADMIN_ID,
  adminRoles,
  analysisRoles,
  compileRights,
  policyDomain,
  role,
  secondScopeKind,
  singleTenantRights,
  writeRoles,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { queryAs } from "./connection"
import {
  type Assignment,
  type Delta,
  type Seed,
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  orgDeltaRow,
} from "./rights-seed"

/**
 * Функції аналізу прав (спека прав §5.1, план Права-2d2) на живих
 * призначеннях, дельтах і рядках: що вони повернуть під роллю
 * `authenticated` і чи пояснення видимості збігається з тим, що пропускає
 * RLS, — вирішує Postgres; компілятор бачить лише текст. Одне розгортання на
 * опис; кейси, що пишуть, відкочують свою точку збереження.
 */

const ZERO = "00000000-0000-0000-0000-000000000000"

/**
 * Звірка пояснення з RLS — десятки запитів на користувача й рядок. Типові 5 с
 * на кейс під навантаженням спільного стеку не вистачає, а кейс, що впав за
 * часом, лишає свої запити на спільному клієнті опису й ламає наступний кейс.
 */
const EQUIVALENCE_TIMEOUT = 30_000

/** Рядок `rights_explain`. */
interface Explained {
  row: string
  policy: string
  kind: "permissive" | "restrictive"
  extent: string | null
  has_right: boolean | null
  carrier_match: boolean | null
  roles: string[]
}

/**
 * Правило видимості Р2d2-6: кожен `restrictive` рядок має `carrier_match`
 * (AND) і хоч один `permissive` — `has_right AND carrier_match` (OR).
 * Порожнє пояснення — «не видно».
 */
const visible = (rows: readonly Explained[]) =>
  rows
    .filter((r) => r.kind === "restrictive")
    .every((r) => r.carrier_match === true) &&
  rows.some(
    (r) =>
      r.kind === "permissive" &&
      r.has_right === true &&
      r.carrier_match === true
  )

/** Ключі засіву: користувачі (без `@`), учасники `користувач@скоуп`, рядки. */
const USERS = [
  "admin",
  "bAdmin",
  "blind",
  "m1",
  "m2",
  "m3",
  "m4",
  "m5",
  "m6",
  "u8",
  "g",
  "tAdmin",
  "u9",
] as const

/** Задачі засіву: ключ, організація, виконавець, проєкт, регіон. */
const TASKS = [
  ["t1", "A", "m1@A", "P1", "r2"],
  ["t2", "A", "m2@A", "P2", "r2"],
  ["t3", "A", "m3@A", "P2", "r2"],
  ["t4", "A", "m1@A", "P2", "r1"],
  ["tB", "B", "m5@B", null, "rB"],
] as const
const TASKS_A = TASKS.filter(([, org]) => org === "A").map(([key]) => key)

/**
 * Організації A і B, команда `T` з id організації A (Р2a1-26). Учасники A:
 * admin (`RightsAdmin`), blind (`RightsOnlyAdmin` — адміністрування без
 * `read` на задачах), m1 і u8 (`OrgMember`), m2 (кастомна роль на
 * `OrgMember`: `deny read@any` і `allow update@own` на задачах — лише
 * власні), m3 (лише `deny read@any` і регіон r1 — власні й вимір), m4 (лише
 * `ProjectReader` на P1 — контейнер), m6 (без ролей в A, `OrgMember` у B),
 * g (без ролей в A, глобальна `GlobalAdmin`). Учасники B: bAdmin
 * (`RightsAdmin`), m5 (`OrgMember`). Команда: tAdmin (`TeamRightsAdmin`) і u8,
 * чий id учасника команди дорівнює id учасника A. u9 без членства. ab —
 * адміністратор прав A і водночас `OrgMember` у B: бачить рядки B, але
 * адмініструє лише A (гейт пояснення за скоупом рядка). Функцій
 * множини дослівно засів не має: `carrier_match` ніде не `NULL`.
 */
async function seed(client: pg.Client): Promise<Seed> {
  const ids: Seed = {}
  const create = async (
    key: string,
    table: string,
    values: Record<string, unknown> = {}
  ) => {
    ids[key] ??= randomUUID()
    await insert(client, table, { id: ids[key], ...values })
  }
  const assign = (member: string, a: Assignment) =>
    insert(client, "org_role_assignments", {
      org_id: ids[member.split("@")[1]!],
      ...assignmentRow(ids[member]!, a),
    })
  const customRole = async (key: string, deltas: Delta[]) => {
    await create(key, "org_roles", {
      org_id: ids.A,
      archetype: ORG_MEMBER_ROLE_ID,
    })
    for (const [i, delta] of deltas.entries())
      await insert(
        client,
        "org_roles_delta",
        orgDeltaRow(ids.A!, ids[key]!, i + 1, delta)
      )
  }

  for (const user of [...USERS, "ab"]) ids[user] = await signUp(client)
  await create("A", "organization")
  await create("B", "organization")
  await create("P1", "project", { org_id: ids.A })
  await create("P2", "project", { org_id: ids.A })
  await create("r1", "region", { org_id: ids.A })
  await create("r2", "region", { org_id: ids.A })
  await create("rB", "region", { org_id: ids.B })
  for (const [user, org] of [
    ["admin", "A"],
    ["blind", "A"],
    ["m1", "A"],
    ["m2", "A"],
    ["m3", "A"],
    ["m4", "A"],
    ["m6", "A"],
    ["u8", "A"],
    ["g", "A"],
    ["ab", "A"],
    ["ab", "B"],
    ["bAdmin", "B"],
    ["m5", "B"],
    ["m6", "B"],
  ] as const)
    await create(`${user}@${org}`, "org_member", {
      org_id: ids[org],
      user_id: ids[user],
    })

  await customRole("custom", [
    ["deny", "task", "read", "any"],
    ["allow", "task", "update", "own"],
  ])
  await customRole("denyRead", [["deny", "task", "read", "any"]])
  await assign("admin@A", { archetype: RIGHTS_ADMIN_ID })
  await assign("blind@A", { archetype: RIGHTS_ONLY_ADMIN_ID })
  await assign("m1@A", { archetype: ORG_MEMBER_ROLE_ID })
  await assign("u8@A", { archetype: ORG_MEMBER_ROLE_ID })
  await assign("m2@A", { customRole: ids.custom })
  await assign("m3@A", { customRole: ids.denyRead })
  await assign("m4@A", { archetype: PROJECT_READER_ID, container: ids.P1 })
  await assign("ab@A", { archetype: RIGHTS_ADMIN_ID })
  await assign("ab@B", { archetype: ORG_MEMBER_ROLE_ID })
  await assign("bAdmin@B", { archetype: RIGHTS_ADMIN_ID })
  await assign("m5@B", { archetype: ORG_MEMBER_ROLE_ID })
  await assign("m6@B", { archetype: ORG_MEMBER_ROLE_ID })
  await insert(
    client,
    "global_role_assignments",
    assignmentRow(ids.g!, { archetype: GLOBAL_ADMIN_ID })
  )
  await insert(client, "member_region", {
    org_id: ids.A,
    member_id: ids["m3@A"],
    region_id: ids.r1,
  })

  // Р2a1-26: корінь команди з id організації A, учасник команди u8 — з id
  // учасника A: лише вид скоупу розрізняє запити.
  await insert(client, "team", { id: ids.A })
  ids["u8@T"] = ids["u8@A"]!
  for (const user of ["tAdmin", "u8"])
    await create(`${user}@T`, "team_member", {
      team_id: ids.A,
      user_id: ids[user],
    })
  await insert(client, "team_role_assignments", {
    team_id: ids.A,
    ...assignmentRow(ids["tAdmin@T"]!, { archetype: TEAM_RIGHTS_ADMIN_ID }),
  })

  const now = new Date()
  for (const [key, org, assignee, project, region] of TASKS)
    await create(key, "task", {
      org_id: ids[org],
      date: now,
      assignee_id: ids[assignee],
      project_id: project === null ? null : ids[project],
      region_id: ids[region],
    })
  await create("b1", BULLETIN_TABLE, { org_id: ids.A, text: "note" })
  return ids
}

describe("rights analysis", () => {
  const tx = describeTransaction()
  let ids: Seed = {}

  beforeAll(async () => {
    const result = await compileRights(
      policyDomain(
        writeRoles(),
        adminRoles(),
        secondScopeKind(),
        analysisRoles()
      )
    )
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    // Зміни призначень «адміністратором» — у контексті команди з JWT-актором
    // (Р2d2-14), як у `rights-guards`: інакше тригер прав відмовить.
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    ids = await seed(client)
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
  }, 120_000)

  afterAll(() => tx.close())

  const key = (name: string) => {
    // Невідомий ключ дав би `NULL` замість id — і порожню відповідь без причини.
    const id = ids[name]
    if (id === undefined) throw new Error(`unknown seed key ${name}`)
    return id
  }
  const claims = (user: string) => ({ sub: key(user), role: "authenticated" })

  /** Рядки запиту під `authenticated` від імені `user`. */
  const as = async <T extends pg.QueryResultRow>(
    user: string,
    sql: string,
    params: unknown[] = []
  ): Promise<T[]> => {
    const result = await queryAs<T>(
      tx.client(),
      "authenticated",
      claims(user),
      sql,
      params
    )
    if (!("rows" in result)) throw new Error(`${user}: ${result.code}`)
    return result.rows
  }

  const member = (user: string, kind: string, scope: string, m: string) =>
    as(user, "SELECT * FROM simetra.rights_member($1, $2, $3)", [
      kind,
      scope,
      m,
    ])
  const who = (
    user: string,
    action: string,
    object: string,
    kind: string,
    scope: string
  ) =>
    as<{
      user_id: string | null
      member: string | null
      role_id: string
      container: string | null
    }>(user, "SELECT * FROM simetra.rights_who($1, $2, $3, $4)", [
      action,
      object,
      kind,
      scope,
    ])
  const journal = (user: string, kind: string, scope: string) =>
    as<{ row_id: string; scope_kind_id: string; actor: string | null }>(
      user,
      "SELECT * FROM simetra.rights_journal_of($1, $2, 100)",
      [kind, scope]
    )
  /** Пояснення рядків `rows` об'єкта `object` для `subject` від імені `caller`. */
  const explain = (
    caller: string,
    object: string,
    rows: readonly string[],
    subject: string
  ) =>
    as<Explained>(
      caller,
      "SELECT r.id::text AS row, e.* FROM unnest($1::uuid[]) AS r(id) CROSS JOIN LATERAL simetra.rights_explain($2, r.id, $3) e",
      [rows, object, subject]
    )
  const usersOf = (rows: readonly { user_id: string | null }[]) =>
    [...new Set(rows.map((r) => r.user_id))].sort()
  const keys = (names: string[]) => names.map(key).sort()

  /**
   * Зміна призначення `user` у контексті команди (`administerRights` на
   * кореневому рядку `root`); `then` бачить її після відкладених перевірок і
   * журналу, усе відкочується разом.
   */
  const inCommand = async <T>(
    user: string,
    [object, root]: [string, string],
    statement: string,
    then: () => Promise<T>
  ): Promise<T> => {
    const client = tx.client()
    await client.query("SAVEPOINT analysis_command")
    try {
      await client.query("SELECT set_config($1, $2, true)", [
        SESSION_CLAIMS_SETTING,
        JSON.stringify(claims(user)),
      ])
      await client.query("SELECT set_config($1, $2, true)", [
        COMMAND_SETTING,
        JSON.stringify({ action: "administerRights", object, root }),
      ])
      await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      await client.query(statement)
      await client.query("RESET ROLE")
      await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      return await then()
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT analysis_command")
    }
  }
  /** Нове призначення `TaskViewer` учаснику m6 в A від імені `user`. */
  const orgChange = <T>(user: string, then: (id: string) => Promise<T>) => {
    const id = randomUUID()
    return inCommand(
      user,
      ["org_role_assignments", id],
      `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ('${id}', '${key("A")}', '${key("m6@A")}', '${TASK_VIEWER_ID}')`,
      () => then(id)
    )
  }

  /** Які з рядків `rows` таблиці `table` бачить `user` під `authenticated`. */
  const seenBy = async (user: string, table: string, rows: readonly string[]) =>
    new Set(
      (
        await as<{ id: string }>(
          user,
          `SELECT id::text AS id FROM public.${table} WHERE id = ANY ($1::uuid[])`,
          [rows]
        )
      ).map((r) => r.id)
    )

  /**
   * Еквівалентність пояснення й RLS (Review Focus 4): для кожного `u` і рядка
   * `rows`, який бачить `caller`, правило видимості над
   * `rights_explain(…, u)` ⇔ рядок видно `u` під `authenticated`; рядок, якого
   * `caller` не бачить, пояснення не має (Р2d2-19). Повертає кількість
   * непорожніх пояснень.
   */
  const equivalence = async (
    caller: string,
    object: string,
    table: string,
    rows: readonly string[]
  ) => {
    const callerSees = await seenBy(caller, table, rows)
    let explained = 0
    for (const user of USERS) {
      const all = await explain(caller, object, rows, key(user))
      // Дослівних функцій множини засів не має: невідомого збігу бути не може,
      // а `NULL` правило видимості мовчки рахувало б «не видно».
      expect
        .soft(
          all.filter((r) => r.carrier_match === null || r.has_right === null)
        )
        .toEqual([])
      const seen = await seenBy(user, table, rows)
      for (const row of rows) {
        const rowsOf = all.filter((r) => r.row === row)
        if (rowsOf.length > 0) explained++
        if (callerSees.has(row))
          expect.soft(visible(rowsOf), `${user} → ${row}`).toBe(seen.has(row))
        else expect.soft(rowsOf, `${user} → ${row} (hidden)`).toEqual([])
      }
    }
    return explained
  }

  it("analysis-gate: no administerRights in the request scope — empty", async () => {
    const calls = (scope: string, m: string, task: string, user: string) =>
      [
        [
          "SELECT * FROM simetra.rights_member($1, $2, $3)",
          [ORG_KIND_ID, key(scope), key(m)],
        ],
        [
          "SELECT * FROM simetra.rights_who('read', 'task', $1, $2)",
          [ORG_KIND_ID, key(scope)],
        ],
        [
          "SELECT * FROM simetra.rights_explain('task', $1, $2)",
          [key(task), key(user)],
        ],
        [
          "SELECT * FROM simetra.rights_journal_of($1, $2, 100)",
          [ORG_KIND_ID, key(scope)],
        ],
      ] as const
    for (const [sql, params] of calls("A", "m1@A", "t1", "m1")) {
      expect.soft(await as("m1", sql, [...params]), `m1: ${sql}`).toEqual([])
      // Контроль: той самий виклик адміністратора A непорожній.
      expect
        .soft((await as("admin", sql, [...params])).length, `admin: ${sql}`)
        .toBeGreaterThan(0)
    }
    for (const [sql, params] of calls("B", "m5@B", "tB", "m5"))
      expect
        .soft(await as("admin", sql, [...params]), `admin → B: ${sql}`)
        .toEqual([])
  })

  it("member-rights: delta rows are via delta, archetype rows via archetype", async () => {
    const rows = await member("admin", ORG_KIND_ID, key("A"), key("m2@A"))
    expect.soft(rows).toContainEqual(
      expect.objectContaining({
        object: "task",
        action: "update",
        extent: "own",
        custom_role: key("custom"),
        via: "delta",
      })
    )
    expect.soft(rows).toContainEqual(
      expect.objectContaining({
        object: "task",
        action: "read",
        extent: "own",
        role_id: ORG_MEMBER_ROLE_ID,
        via: "archetype",
      })
    )
    expect
      .soft(
        rows.filter(
          (r) =>
            r.object === "task" && r.action === "read" && r.extent === "any"
        )
      )
      .toEqual([])
  })

  it("who: members with the right; everyUser in the global form", async () => {
    expect
      .soft(usersOf(await who("admin", "read", "task", ORG_KIND_ID, key("A"))))
      .toEqual(keys(["ab", "admin", "m1", "m2", "m3", "m4", "u8"]))
    // Нескоуплені «Користувачі» на рівні скоупу — лише ролі цього рівня.
    expect
      .soft(usersOf(await who("admin", "read", "users", ORG_KIND_ID, key("A"))))
      .toEqual(keys(["m1", "m2", "m3", "u8"]))
    // Глобальна форма — рівно глобальні власники й рядок `everyUser`: рядки
    // рівня `org` (m1, m2, m3, u8 читають «Користувачів») сюди не просочуються.
    const global = await who("g", "read", "users", ZERO, ZERO)
    expect
      .soft(
        [
          ...new Set(
            global.map((r) => JSON.stringify([r.user_id, r.member, r.role_id]))
          ),
        ].sort()
      )
      .toEqual(
        [
          [key("g"), null, GLOBAL_ADMIN_ID],
          [null, null, EVERYONE_ID],
        ]
          .map((r) => JSON.stringify(r))
          .sort()
      )
  })

  it(
    "explain-equivalence: the explanation agrees with RLS for every user",
    async () => {
      // Засів дає кожен шлях доступу: без цієї матриці RLS і пояснення могли б
      // погодитися на «нічого не видно», і звірка нічого б не доводила.
      const rows = TASKS_A.map(key)
      for (const [user, expected] of [
        ["m1", ["t1", "t2", "t3", "t4"]],
        ["m2", ["t2"]],
        ["m3", ["t3", "t4"]],
        ["m4", ["t1"]],
        ["m6", []],
        ["m5", []],
      ] as const)
        expect
          .soft([...(await seenBy(user, "task", rows))].sort(), user)
          .toEqual(keys([...expected]))
      expect(
        await equivalence("admin", "task", "task", TASKS_A.map(key))
      ).toBeGreaterThan(0)
    },
    EQUIVALENCE_TIMEOUT
  )

  it("explain-oracle: rows and users outside the caller's scope — empty", async () => {
    expect
      .soft(await explain("admin", "task", [key("tB")], key("m5")))
      .toEqual([])
    expect
      .soft(await explain("admin", "task", [randomUUID()], key("m1")))
      .toEqual([])
    // ab бачить tB (`OrgMember` у B) і m5 належить B, але адмініструє ab лише
    // A: гейт пояснення береться зі скоупу рядка, а не з будь-якого скоупу.
    expect.soft(await explain("ab", "task", [key("tB")], key("m5"))).toEqual([])
    expect
      .soft((await explain("bAdmin", "task", [key("tB")], key("m5"))).length)
      .toBeGreaterThan(0)
    // m5 належить лише B: факти про нього в A адміністратор A не дізнається.
    expect
      .soft(await explain("admin", "task", [key("t1")], key("m5")))
      .toEqual([])
  })

  it("cross-kind: an administrator of team with the same scope id sees nothing of org", async () => {
    expect
      .soft(await who("tAdmin", "read", "task", TEAM_KIND_ID, key("A")))
      .toEqual([])
    // Контроль: гейт `team` пройдено — свої права учасників команди видно.
    expect
      .soft(
        usersOf(
          await who(
            "tAdmin",
            "administerRights",
            "team_role_assignments",
            TEAM_KIND_ID,
            key("A")
          )
        )
      )
      .toEqual(keys(["tAdmin"]))
    expect
      .soft(await member("tAdmin", TEAM_KIND_ID, key("A"), key("u8@A")))
      .toEqual([])
    expect
      .soft(
        (await member("tAdmin", TEAM_KIND_ID, key("A"), key("tAdmin@T"))).length
      )
      .toBeGreaterThan(0)
    await orgChange("admin", async (id) => {
      const team = await journal("tAdmin", TEAM_KIND_ID, key("A"))
      expect
        .soft(team.filter((r) => r.scope_kind_id !== TEAM_KIND_ID))
        .toEqual([])
      expect.soft(team.map((r) => r.row_id)).not.toContain(id)
      expect
        .soft(
          (await journal("admin", ORG_KIND_ID, key("A"))).map((r) => r.row_id)
        )
        .toContain(id)
    })
    const id = randomUUID()
    await inCommand(
      "tAdmin",
      ["team_role_assignments", id],
      `INSERT INTO public.team_role_assignments (id, team_id, subject, archetype) VALUES ('${id}', '${key("A")}', '${key("u8@T")}', '${TEAM_RIGHTS_ADMIN_ID}')`,
      async () => {
        expect
          .soft(
            (await journal("tAdmin", TEAM_KIND_ID, key("A"))).map(
              (r) => r.row_id
            )
          )
          .toContain(id)
      }
    )
  })

  it("public-read: one public_read row, visible to anyone, no existence oracle", async () => {
    const expected = [
      {
        row: key("b1"),
        policy: accessPolicyNames({ name: BULLETIN_TABLE }).publicRead,
        kind: "permissive",
        extent: null,
        has_right: true,
        carrier_match: true,
        roles: [],
      },
    ]
    expect
      .soft(await explain("admin", "bulletin", [key("b1")], key("m1")))
      .toEqual(expected)
    expect
      .soft(await explain("admin", "bulletin", [key("b1")], key("m5")))
      .toEqual(expected)
    expect
      .soft(await explain("admin", "bulletin", [randomUUID()], key("m1")))
      .toEqual([])
  })

  it(
    "explain-users: the explanation of Users agrees with RLS",
    async () => {
      expect(
        await equivalence("g", "users", "users", USERS.map(key))
      ).toBeGreaterThan(0)
    },
    EQUIVALENCE_TIMEOUT
  )

  it("journal-of: a change in A is in A's journal only", async () => {
    await orgChange("admin", async (id) => {
      const rows = await journal("admin", ORG_KIND_ID, key("A"))
      expect
        .soft(rows)
        .toContainEqual(
          expect.objectContaining({ row_id: id, actor: key("admin") })
        )
      expect.soft(await journal("bAdmin", ORG_KIND_ID, key("A"))).toEqual([])
      expect
        .soft(
          (await journal("bAdmin", ORG_KIND_ID, key("B"))).map((r) => r.row_id)
        )
        .not.toContain(id)
    })
  })

  it(
    "explain-caller-visibility: no read on the object — nothing to explain",
    async () => {
      // blind проходить гейт A: порожнеча нижче — від видимості рядка, не від гейта.
      expect
        .soft(
          (await member("blind", ORG_KIND_ID, key("A"), key("m1@A"))).length
        )
        .toBeGreaterThan(0)
      for (const user of USERS)
        expect
          .soft(
            await explain("blind", "task", TASKS_A.map(key), key(user)),
            user
          )
          .toEqual([])
      expect(
        (await explain("admin", "task", [key("t1")], key("m1"))).length
      ).toBeGreaterThan(0)
    },
    EQUIVALENCE_TIMEOUT
  )
})

/**
 * Нескоуплений контейнер (Р2d2-18) — лише в однотенантному проєкті: у проєкті
 * з видами скоупу носій контейнера мусить бути скоуплений
 * (`rights.carrier-cross-tenant`). Призначення контейнера лежать у
 * глобальному довіднику, і їх бачить глобальний запит аналізу. Рівня скоупу
 * в такому проєкті немає взагалі, тож кейс доводить лише глобальне плече
 * (Р2d2-18); що форма скоупу цих рядків не бачить, у проєкті з видами скоупу
 * недосяжно перевірити — нескоупленого контейнера там не буває.
 */
describe("rights analysis of an unscoped container", () => {
  const tx = describeTransaction()
  const ids: Seed = {}

  beforeAll(async () => {
    const result = await compileRights(
      singleTenantRights({
        [ROLE_FILE("GlobalAdmin")]: role(
          GLOBAL_ADMIN_ID,
          "GlobalAdmin",
          "global",
          {
            fullAccess: true,
          }
        ),
      })
    )
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    for (const user of ["g", "lead"]) ids[user] = await signUp(client)
    ids.P1 = randomUUID()
    await insert(client, "project", { id: ids.P1 })
    await insert(
      client,
      "global_role_assignments",
      assignmentRow(ids.g!, { archetype: GLOBAL_ADMIN_ID })
    )
    await insert(
      client,
      "global_role_assignments",
      assignmentRow(ids.lead!, {
        archetype: PROJECT_LEAD_ID,
        container: ids.P1,
      })
    )
  }, 120_000)

  afterAll(() => tx.close())

  const as = async (sql: string, params: unknown[]) => {
    const result = await queryAs<pg.QueryResultRow>(
      tx.client(),
      "authenticated",
      { sub: ids.g, role: "authenticated" },
      sql,
      params
    )
    if (!("rows" in result)) throw new Error(result.code)
    return result.rows
  }

  it("unscoped-container: the global request sees the container rows", async () => {
    const container = expect.objectContaining({
      object: "task",
      action: "read",
      role_id: PROJECT_LEAD_ID,
      container: ids.P1,
    })
    expect
      .soft(
        await as("SELECT * FROM simetra.rights_member($1, $1, $2)", [
          ZERO,
          ids.lead,
        ])
      )
      .toContainEqual(container)
    // Точна множина: глобальний власник і власник контейнера, нічого більше.
    const who = (
      await as("SELECT * FROM simetra.rights_who('read', 'task', $1, $1)", [
        ZERO,
      ])
    ).map((r) => JSON.stringify([r.user_id, r.role_id, r.container]))
    expect.soft([...new Set(who)].sort()).toEqual(
      [
        [ids.g, GLOBAL_ADMIN_ID, null],
        [ids.lead, PROJECT_LEAD_ID, ids.P1],
      ]
        .map((r) => JSON.stringify(r))
        .sort()
    )
  })
})
