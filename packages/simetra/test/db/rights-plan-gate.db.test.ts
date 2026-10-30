import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import {
  COMMAND_SETTING,
  PLATFORM_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
} from "simetra/model"
import {
  CHECKLIST_TABLE,
  HOURS_TABLES,
  ORG_ADMIN_ID,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  RIGHTS_ADMIN_ID,
  SUPPORT_ID,
  adminRoles,
  compileRights,
  policyDomain,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { asRole, queryAs } from "./connection"
import {
  type PlanNode,
  functionScans,
  repeatedCteScans,
  scansOf,
  subPlans,
} from "./explain-plan"
import {
  assignmentRow,
  deploy,
  describeTransaction,
  globalDeltaRow,
  insert,
  orgDeltaRow,
} from "./rights-seed"

/**
 * Гейт планів політик прав (спека прав §5.4): чи читають
 * політики дані помітного обсягу індексом, а функції прав рахуються раз на
 * запит, — вирішує планувальник Postgres на засіві з реальною статистикою;
 * компілятор бачить лише текст політик. Одне розгортання й один засів на
 * опис; транзакція опису відкочується.
 *
 * Засів (спека прав §5.4): 1 000 тенантів по 20 задач — 20 000 `task`, 100 000
 * `task_checklist`, 10 000 рухів `task_hours`, кожна таблиця одним
 * `INSERT … SELECT`, упорядкованим за тенантом; журнал прав — 20 000 рядків
 * на 1 000 скоупів; довідник прав — 10 призначень, кастомна роль і її
 * дельта на тенант (≥ 10 000 призначень); глобальний довідник — у тій самій
 * формі: кастомна роль з дельтою й призначення на кожного з
 * `GLOBAL_ROLES` користувачів. Користувач гейта — учасник одного тенанта з роллю, що
 * дає `own` і вимір: усі політики `PERMISSIVE` складаються через OR, а розмір
 * множин планувальнику невідомий (`InitPlan`), тож форма плану від ролі не
 * залежить.
 */

const TENANTS = 1000
const TASKS_PER_TENANT = 20
const LINES_PER_TASK = 5
const MOVEMENTS_PER_TENANT = 10
const JOURNAL_PER_SCOPE = 20
/**
 * Скоупи власника `fullAccess` (спека прав §5.4): досить, щоб квадратичне замикання
 * мало корельований підплан з тисячами циклів, і мало, щоб старе тіло не
 * роздувало бюджет файлу.
 */
const FULL_ACCESS_SCOPES = 30
/**
 * Довідник прав помітного обсягу: учасники з призначеннями в кожному
 * тенанті, кастомна роль з дельтою на тенант — тоді перевірка на COMMIT, що
 * читає таблицю повним перебором, видна в плані як `Seq Scan`.
 */
const ASSIGNMENTS_PER_TENANT = 10
/**
 * Глобальні кастомні ролі, кожна з дельтою й призначенням своєму
 * користувачу: доступ до глобального довідника вибірковий за роллю, як і до
 * довідника `org`, тож повторне читання глобальних дельт у тілі функції прав
 * видно як `Seq Scan` з циклами.
 */
const GLOBAL_ROLES = 500

/** Колонка скоупу (межа тенанта) таблиць гейта. */
const SCOPE_COLUMN = /\borg_id\b/

const TASK = "task"
const CHECKLIST = CHECKLIST_TABLE
const HOURS = HOURS_TABLES.movements
const JOURNAL = "rights_journal"
/** Таблиці прав: довідники призначень, ролей і дельт, журнал прав. */
const RIGHTS_TABLES = [
  "org_role_assignments",
  "org_roles",
  "org_roles_delta",
  "global_role_assignments",
  "global_roles",
  "global_roles_delta",
  JOURNAL,
]

type Form = "list" | "count" | "point"

/** Ключ сортування списку: uuid-ключ чи ключ рухів регістра. */
const ORDER: Record<string, string> = {
  [TASK]: "id",
  [CHECKLIST]: "id",
  [HOURS]: "recorder_id, line_number",
}

interface Gate {
  org: string
  user: string
  admin: string
  /** Власник `OrgAdmin` (`fullAccess`) у `FULL_ACCESS_SCOPES` інших тенантах. */
  full: string
  /** Задача одного з тенантів власника `fullAccess`. */
  fullPoint: string
  /** Тенант власника `fullAccess`: його учасник, кастомна роль і її дельта. */
  fullOrg: { id: string; member: string; role: string; delta: string }
  /** id видимого користувачу рядка таблиці — для точкового читання. */
  point: Record<string, string>
}

/**
 * Тенант гейта: учасник із кастомною роллю на `OrgMember` з `deny read@any`
 * (лишаються `own` і вимір `region`), адміністратор прав. Решта тенантів —
 * масовим засівом.
 */
async function seed(client: pg.Client): Promise<Gate> {
  const org = randomUUID()
  const region = randomUUID()
  const member = randomUUID()
  const adminMember = randomUUID()
  const role = randomUUID()
  const user = await signUp(client)
  const admin = await signUp(client)
  const full = await signUp(client)
  await insert(client, "organization", { id: org })
  await insert(client, "region", { id: region, org_id: org })
  await insert(client, "org_member", { id: member, org_id: org, user_id: user })
  await insert(client, "org_member", {
    id: adminMember,
    org_id: org,
    user_id: admin,
  })
  await insert(client, "org_roles", {
    id: role,
    org_id: org,
    archetype: ORG_MEMBER_ROLE_ID,
  })
  await insert(
    client,
    "org_roles_delta",
    orgDeltaRow(org, role, 1, ["deny", TASK, "read", "any"])
  )
  await insert(client, "org_role_assignments", {
    org_id: org,
    ...assignmentRow(member, { customRole: role }),
  })
  await insert(client, "org_role_assignments", {
    org_id: org,
    ...assignmentRow(adminMember, { archetype: RIGHTS_ADMIN_ID }),
  })
  await insert(client, "member_region", {
    org_id: org,
    member_id: member,
    region_id: region,
  })

  await client.query(
    `INSERT INTO public.organization (id) SELECT gen_random_uuid() FROM generate_series(2, $1)`,
    [TENANTS]
  )
  await client.query(
    `INSERT INTO public.region (id, org_id) SELECT gen_random_uuid(), o.id FROM public.organization o WHERE o.id <> $1`,
    [org]
  )
  // Упорядкованість за тенантом — фізична кореляція колонки скоупу (спека прав §5.4):
  // бітова карта межі читає мало сторінок. Частина задач тенанта гейта —
  // власні для його учасника.
  await client.query(
    `INSERT INTO public.${TASK} (id, org_id, date, region_id, assignee_id)
     SELECT gen_random_uuid(), r.org_id, now(), r.id,
            CASE WHEN r.org_id = $1 AND g <= 5 THEN $2::uuid END
     FROM public.region r CROSS JOIN generate_series(1, $3) AS g
     ORDER BY r.org_id, g`,
    [org, member, TASKS_PER_TENANT]
  )
  await client.query(
    `INSERT INTO public.${CHECKLIST} (id, org_id, parent_id, line_number, note)
     SELECT gen_random_uuid(), t.org_id, t.id, g, 'line'
     FROM public.${TASK} t CROSS JOIN generate_series(1, $1) AS g
     ORDER BY t.org_id, t.id, g`,
    [LINES_PER_TASK]
  )
  await client.query(
    `INSERT INTO public.${HOURS} (org_id, period, recorder_type, recorder_id, line_number, movement_type, region_id, hours)
     SELECT t.org_id, now(), '${TASK}', t.id, 1, 'Receipt', t.region_id, 1
     FROM (SELECT *, row_number() OVER (PARTITION BY org_id ORDER BY id) AS n FROM public.${TASK}) t
     WHERE t.n <= $1
     ORDER BY t.org_id, t.id`,
    [MOVEMENTS_PER_TENANT]
  )
  // Журнал скоупу: новіші першими за `at` — як його читає `rights_journal_of`.
  await client.query(
    `INSERT INTO simetra.${JOURNAL} (xid, at, scope_kind_id, scope, reason, object, relation, operation, row_id)
     SELECT 1, now() - g * interval '1 second', $1, o.id, 'seed', 'org_role_assignments', 'org_role_assignments', 'INSERT', gen_random_uuid()
     FROM public.organization o CROSS JOIN generate_series(1, $2) AS g
     ORDER BY o.id, g`,
    [ORG_KIND_ID, JOURNAL_PER_SCOPE]
  )

  await client.query(
    `INSERT INTO public.org_member (id, org_id, user_id)
     SELECT gen_random_uuid(), o.id, $1 FROM public.organization o WHERE o.id <> $2 ORDER BY o.id LIMIT $3`,
    [full, org, FULL_ACCESS_SCOPES]
  )
  await client.query("SELECT set_config($1, 'on', true)", [
    RIGHTS_MAINTENANCE_SETTING,
  ])
  await client.query(
    `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype, deletion_mark)
     SELECT gen_random_uuid(), m.org_id, m.id, $2, false FROM public.org_member m WHERE m.user_id = $1`,
    [full, ORG_ADMIN_ID]
  )
  // Обсяг довідника прав: запрошені учасники без користувача, по
  // призначенню на кожного, і кастомна роль з дельтою в кожному тенанті, крім
  // тенанта гейта — його форма задана вище.
  await client.query(
    `INSERT INTO public.org_member (id, org_id)
     SELECT gen_random_uuid(), o.id FROM public.organization o CROSS JOIN generate_series(1, $2)
     WHERE o.id <> $1 ORDER BY o.id`,
    [org, ASSIGNMENTS_PER_TENANT]
  )
  await client.query(
    `INSERT INTO public.org_role_assignments (id, org_id, subject, archetype, deletion_mark)
     SELECT gen_random_uuid(), m.org_id, m.id, $2, false FROM public.org_member m
     WHERE m.user_id IS NULL AND m.org_id <> $1 ORDER BY m.org_id`,
    [org, ORG_MEMBER_ROLE_ID]
  )
  await client.query(
    `INSERT INTO public.org_roles (id, org_id, archetype)
     SELECT gen_random_uuid(), o.id, $2 FROM public.organization o WHERE o.id <> $1 ORDER BY o.id`,
    [org, ORG_MEMBER_ROLE_ID]
  )
  await client.query(
    `INSERT INTO public.org_roles_delta (id, org_id, parent_id, line_number, object, action, extent, effect)
     SELECT gen_random_uuid(), r.org_id, r.id, 1, $2, 'read', 'any', 'deny' FROM public.org_roles r
     WHERE r.org_id <> $1 ORDER BY r.org_id`,
    [org, TASK]
  )
  // Глобальний довідник: користувачі без членства (лише ключ у
  // «Користувачах») раніше за їхні призначення; дельта — з глобального домену
  // архетипу, інакше COMMIT відмовить `delta-domain` (спека прав §7).
  await client.query(
    `INSERT INTO public.users (id) SELECT gen_random_uuid() FROM generate_series(1, $1)`,
    [GLOBAL_ROLES]
  )
  await client.query(
    `INSERT INTO public.global_roles (id, archetype) SELECT gen_random_uuid(), $2 FROM generate_series(1, $1)`,
    [GLOBAL_ROLES, SUPPORT_ID]
  )
  await client.query(
    `INSERT INTO public.global_roles_delta (id, parent_id, line_number, object, action, extent, effect)
     SELECT gen_random_uuid(), r.id, 1, 'announcement', 'create', 'any', 'allow' FROM public.global_roles r`
  )
  await client.query(
    `INSERT INTO public.global_role_assignments (id, subject, custom_role, deletion_mark)
     SELECT gen_random_uuid(), u.id, r.id, false
     FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM public.users x
           WHERE NOT EXISTS (SELECT 1 FROM public.org_member m WHERE m.user_id = x.id)) u
     JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM public.global_roles) r USING (n)`
  )
  await client.query("SELECT set_config($1, 'off', true)", [
    RIGHTS_MAINTENANCE_SETTING,
  ])
  // Власник `fullAccess` має й глобальну кастомну роль з обома гілками
  // дельт, `allow` і `deny`, обидві на `announcement`: `task` скоуплений і
  // поза глобальним доменом (спека прав §7). Тіла функцій прав від його імені
  // читають глобальні дельти в обох гілках.
  const fullGlobalRole = randomUUID()
  await insert(client, "global_roles", {
    id: fullGlobalRole,
    archetype: SUPPORT_ID,
  })
  await insert(
    client,
    "global_roles_delta",
    globalDeltaRow(fullGlobalRole, 1, [
      "allow",
      "announcement",
      "create",
      "any",
    ])
  )
  await insert(
    client,
    "global_roles_delta",
    globalDeltaRow(fullGlobalRole, 2, ["deny", "announcement", "read", "any"])
  )
  await insert(
    client,
    "global_role_assignments",
    assignmentRow(full, { customRole: fullGlobalRole })
  )
  const { rows: fullTasks } = await client.query<{ id: string }>(
    `SELECT t.id FROM public.${TASK} t JOIN public.org_member m ON m.org_id = t.org_id
     WHERE m.user_id = $1 ORDER BY t.id LIMIT 1`,
    [full]
  )

  const { rows: fullOrgs } = await client.query<Gate["fullOrg"]>(
    `SELECT o.org_id AS id, m.id AS member, r.id AS role, d.id AS delta
     FROM public.org_member o
     JOIN public.org_member m ON m.org_id = o.org_id AND m.user_id IS NULL
     JOIN public.org_roles r ON r.org_id = o.org_id
     JOIN public.org_roles_delta d ON d.parent_id = r.id
     WHERE o.user_id = $1 ORDER BY o.org_id, m.id LIMIT 1`,
    [full]
  )

  const { rows } = await client.query<{ task: string; line: string }>(
    `SELECT t.id AS task, c.id AS line FROM public.${TASK} t
     JOIN public.${CHECKLIST} c ON c.parent_id = t.id
     WHERE t.org_id = $1 AND t.assignee_id = $2 LIMIT 1`,
    [org, member]
  )
  const visible = rows[0]
  if (visible === undefined) throw new Error("seed: no own task in gate tenant")
  return {
    org,
    user,
    admin,
    full,
    fullPoint: fullTasks[0]!.id,
    fullOrg: fullOrgs[0]!,
    point: { [TASK]: visible.task, [CHECKLIST]: visible.line },
  }
}

/** Запит форми `form` над таблицею; точкове — за uuid-ключем засіву. */
function query(table: string, form: Form, gate: Gate): string {
  if (form === "count") return `SELECT count(*) FROM public.${table}`
  if (form === "list")
    return `SELECT * FROM public.${table} ORDER BY ${ORDER[table]} LIMIT 50`
  return `SELECT * FROM public.${table} WHERE id = '${gate.point[table]}'::uuid`
}

/** Індексний вузол таблиці з умовою на колонку скоупу в умовах доступу. */
/**
 * Кожен вузол таблиці читає індекс, і кожна його гілка (кожен `Bitmap Index
 * Scan` під `BitmapOr` / `BitmapAnd`, сам `Index Scan`) має колонку скоупу в
 * `Index Cond`: гілка без скоупу — одна `PERMISSIVE`-умова, що йде індексом
 * через усіх тенантів, навіть коли інші гілки обмежені межею.
 */
const scopedIndexAccess = (nodes: PlanNode[]) =>
  nodes.length > 0 &&
  nodes.every(
    (n) =>
      n.arms.length > 0 && n.arms.every((a) => SCOPE_COLUMN.test(a.condition))
  )

/** Короткий опис вузлів для повідомлення перевірки. */
const shape = (nodes: PlanNode[]) =>
  nodes.map(
    (n) =>
      `${n.type}: ${n.arms.map((a) => `${a.index} (${a.condition})`).join("; ")}`
  )

const CASES: [string, Form][] = [
  [TASK, "list"],
  [TASK, "count"],
  [TASK, "point"],
  [CHECKLIST, "list"],
  [CHECKLIST, "count"],
  [CHECKLIST, "point"],
  [HOURS, "list"],
  [HOURS, "count"],
]

describe("rights plan gate", () => {
  const tx = describeTransaction()
  let gate: Gate

  beforeAll(async () => {
    const result = await compileRights(policyDomain(adminRoles()))
    expect(result.diagnostics).toEqual([])
    const client = await tx.open()
    await deploy(client, result.model!)
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
    )
    await client.query(
      `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
    )
    const started = Date.now()
    gate = await seed(client)
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
    // Без статистики планувальник оцінює таблиці за замовчуванням, а не за засівом.
    // Лише засіяні таблиці: ANALYZE усієї спільної бази тримав би блокування
    // чужих таблиць до відкату й переписав би їхню статистику поза транзакцією.
    await client.query(
      `ANALYZE public.organization, public.region, public.org_member, public.org_role_assignments, public.org_roles, public.org_roles_delta, public.users, public.global_role_assignments, public.global_roles, public.global_roles_delta, public.${TASK}, public.${CHECKLIST}, public.${HOURS}, simetra.${JOURNAL}`
    )
    // Не порожній засів глобального довідника: інакше гейт зелений без
    // глобальних дельт.
    const { rows: global } = await client.query<{
      roles: number
      deltas: number
    }>(
      "SELECT (SELECT count(*) FROM public.global_roles)::int AS roles, (SELECT count(*) FROM public.global_roles_delta)::int AS deltas"
    )
    expect(global[0]!.roles).toBeGreaterThan(1)
    expect(global[0]!.deltas).toBeGreaterThan(0)
    console.info(`rights plan gate: seed + ANALYZE ${Date.now() - started} ms`)
  }, 120_000)

  afterAll(() => tx.close())

  /** План `EXPLAIN (ANALYZE, FORMAT JSON)` запиту від імені `user`. */
  const explain = async (user: string, sql: string): Promise<unknown> => {
    const result = await queryAs<{ "QUERY PLAN": unknown }>(
      tx.client(),
      "authenticated",
      { sub: user, role: "authenticated" },
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`
    )
    if (!("rows" in result)) throw new Error(`EXPLAIN failed: ${result.code}`)
    return result.rows[0]!["QUERY PLAN"]
  }

  it.each(CASES)(
    "%s %s reads by index, rights once per query",
    async (table, form) => {
      const plan = await explain(gate.user, query(table, form, gate))
      const scans = scansOf(plan, table)
      expect(scans.length, "the table is read").toBeGreaterThan(0)
      expect.soft(subPlans(plan), "SubPlan nodes").toEqual([])
      expect
        .soft(
          scans.filter((n) => n.type === "Seq Scan"),
          "Seq Scan of the table"
        )
        .toEqual([])
      if (form !== "point")
        expect
          .soft(
            scopedIndexAccess(scans),
            `scope in index access: ${shape(scans).join("; ")}`
          )
          .toBe(true)
    }
  )

  /**
   * Плани операторів справжнього виклику `sql` від імені `user`, з
   * вкладеними: функція прав `SECURITY DEFINER` не інлайниться, тож зовнішній
   * план показує лише `Function Scan`. Плани дає `auto_explain` (бібліотека в
   * `shared_preload_libraries` стеку, параметри `auto_explain.*` дозволені
   * ролі стеку через supautils): кожен оператор, і вкладений оператор тіла
   * функції теж, приходить повідомленням `LOG`.
   */
  const autoExplain = async (
    user: string,
    sql: string,
    params: unknown[] = []
  ): Promise<{ plans: Record<string, unknown>[]; rows: unknown[] }> => {
    const client = tx.client()
    const plans: Record<string, unknown>[] = []
    const onNotice = (notice: { severity?: string; message?: string }) => {
      const message = notice.message ?? ""
      // Повідомлення `auto_explain`: «duration: … plan:» і план JSON.
      const start = message.indexOf("plan:")
      if (notice.severity === "LOG" && start >= 0)
        plans.push(JSON.parse(message.slice(start + "plan:".length)))
    }
    await client.query("SAVEPOINT auto_explain")
    client.on("notice", onNotice)
    try {
      for (const setting of [
        "auto_explain.log_min_duration = 0",
        "auto_explain.log_nested_statements = on",
        "auto_explain.log_analyze = on",
        "auto_explain.log_format = 'json'",
        "client_min_messages = log",
      ])
        await client.query(`SET LOCAL ${setting}`)
      await asRole(client, "authenticated", {
        sub: user,
        role: "authenticated",
      })
      const { rows } = await client.query(sql, params)
      return { plans, rows }
    } finally {
      client.off("notice", onNotice)
      // Відкат точки збереження скидає і `SET LOCAL`, і роль.
      await client.query("ROLLBACK TO SAVEPOINT auto_explain")
    }
  }

  it("rights_journal_of reads the scope journal by index", async () => {
    const { plans, rows } = await autoExplain(
      gate.admin,
      "SELECT * FROM simetra.rights_journal_of($1, $2, 100)",
      [ORG_KIND_ID, gate.org]
    )
    // Засів плюс записи журналу від призначень тенанта гейта.
    expect(rows.length, "the admin reads the journal").toBeGreaterThanOrEqual(
      JOURNAL_PER_SCOPE
    )
    const scans = plans.flatMap((p) => scansOf(p, JOURNAL))
    expect(scans.length, "the journal is read").toBeGreaterThan(0)
    expect.soft(scans.filter((n) => n.type === "Seq Scan")).toEqual([])
    expect
      .soft(
        scans.some(
          (n) =>
            n.indexes.length > 0 &&
            n.conditions.some(
              (c) => /\bscope_kind_id\b/.test(c) && /\bscope\b/.test(c)
            )
        ),
        `scope in index access: ${shape(scans).join("; ")}`
      )
      .toBe(true)
  })

  /**
   * Тіла функцій прав (спека прав §5.4): власник `fullAccess` у
   * `FULL_ACCESS_SCOPES` тенантах читає `rights_mine()` напряму й через
   * функції множин політики (точкове читання задачі). Жоден оператор — ні
   * тіло `rights_mine`, ні тіла `rights_any` / `own` / `dim` / `container` —
   * не читає CTE більше одного разу (`CTE Scan` з циклами > 1): так виглядало
   * замикання, квадратичне за скоупами (спека прав §5.4), і віднімання дельт
   * `NOT EXISTS` у `role_rows` (спека прав §5.4) — вкладений цикл, а не підплан.
   * І жоден не перебирає таблицю прав повторно (`Seq Scan` з циклами > 1):
   * дельти — не матеріалізований CTE, тож їхнє перечитування в циклі — уже
   * `Seq Scan` таблиці дельт, а не `CTE Scan`, і першого критерію не видно.
   * Індексне читання з циклами лишається дозволеним — це точковий доступ.
   */
  it.each([
    ["rights_mine()", () => "SELECT count(*) FROM simetra.rights_mine()"],
    [
      "set functions of a task policy",
      () => `SELECT * FROM public.${TASK} WHERE id = '${gate.fullPoint}'::uuid`,
    ],
  ])(
    "%s: rights function bodies read no CTE or rights table more than once",
    async (_, sql) => {
      const { plans, rows } = await autoExplain(gate.full, sql())
      expect(rows.length, "the full-access holder reads").toBe(1)
      // Не порожній доказ: план тіла `rights_mine` захоплено, і він рахує
      // замикання — читає `rights_requires`.
      const bodies = plans.filter((p) =>
        String(p["Query Text"]).includes("closure_1")
      )
      expect(bodies.length, "plans of the rights_mine body").toBeGreaterThan(0)
      for (const body of bodies)
        expect(functionScans(body)).toContain("rights_requires")
      expect
        .soft(
          plans.flatMap((p) =>
            repeatedCteScans(p).map(
              (n) =>
                `CTE Scan on ${n.cte} x${n.loops}: ${String(p["Query Text"]).slice(0, 80)}`
            )
          ),
          "CTE scans repeated per outer row"
        )
        .toEqual([])
      // Не порожній доказ другого критерію: тіла читають таблиці прав.
      expect(
        plans.flatMap((p) => RIGHTS_TABLES.flatMap((t) => scansOf(p, t)))
          .length,
        "rights tables are read"
      ).toBeGreaterThan(0)
      expect
        .soft(
          plans.flatMap((p) =>
            RIGHTS_TABLES.flatMap((table) =>
              scansOf(p, table)
                .filter((n) => n.type === "Seq Scan" && (n.loops ?? 1) > 1)
                .map(
                  (n) =>
                    `Seq Scan on ${n.relation} x${n.loops}: ${String(p["Query Text"]).slice(0, 80)}`
                )
            )
          ),
          "rights tables scanned per outer row"
        )
        .toEqual([])
    }
  )

  /**
   * Плани відкладеної перевірки прав однієї команди адміністрування:
   * команда виконується як її виконає `runCommand` — роль команд, JWT-актор,
   * контекст команди, — а плани операторів перевірки (тіло тригера черги
   * посилається на `v_pending`) дає `auto_explain` на `SET CONSTRAINTS ALL
   * IMMEDIATE`, тобто там, де їх платить COMMIT.
   */
  const commitPlans = async (
    user: string,
    context: { action: string; object: string; root: string },
    sql: string
  ): Promise<Record<string, unknown>[]> => {
    const client = tx.client()
    const plans: Record<string, unknown>[] = []
    const onNotice = (notice: { severity?: string; message?: string }) => {
      const message = notice.message ?? ""
      const start = message.indexOf("plan:")
      if (notice.severity === "LOG" && start >= 0)
        plans.push(JSON.parse(message.slice(start + "plan:".length)))
    }
    await client.query("SAVEPOINT commit_plans")
    try {
      for (const setting of [
        "auto_explain.log_min_duration = 0",
        "auto_explain.log_nested_statements = on",
        "auto_explain.log_analyze = on",
        "auto_explain.log_format = 'json'",
        "client_min_messages = log",
      ])
        await client.query(`SET LOCAL ${setting}`)
      await client.query("SELECT set_config($1, $2, true)", [
        SESSION_CLAIMS_SETTING,
        JSON.stringify({ sub: user, role: "authenticated" }),
      ])
      await client.query("SELECT set_config($1, $2, true)", [
        COMMAND_SETTING,
        JSON.stringify(context),
      ])
      await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
      const { rowCount } = await client.query(sql)
      expect(rowCount, "the command changes one row").toBe(1)
      client.on("notice", onNotice)
      try {
        await client.query("SET CONSTRAINTS ALL IMMEDIATE")
      } finally {
        client.off("notice", onNotice)
      }
      return plans.filter((p) => String(p["Query Text"]).includes("v_pending"))
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT commit_plans")
    }
  }

  // Призначення кастомної ролі читає призначення, роль і її дельти; зміна
  // дельти — роль і дельти: кожна таблиця прав звужується до `to_jsonb`.
  it.each([
    [
      "assigning a custom role",
      ["org_role_assignments", "org_roles", "org_roles_delta"],
      (id: string) => ({
        context: {
          action: "administerRights",
          object: "org_role_assignments",
          root: id,
        },
        sql: `INSERT INTO public.org_role_assignments (id, org_id, subject, custom_role) VALUES ('${id}', '${gate.fullOrg.id}', '${gate.fullOrg.member}', '${gate.fullOrg.role}')`,
      }),
    ],
    [
      "changing a custom role delta",
      ["org_roles", "org_roles_delta"],
      () => ({
        context: {
          action: "administerRights",
          object: "org_roles",
          root: gate.fullOrg.role,
        },
        sql: `UPDATE public.org_roles_delta SET action = 'update' WHERE id = '${gate.fullOrg.delta}'`,
      }),
    ],
  ] as const)(
    "%s: the COMMIT check reads rights tables by index",
    async (_, read, command) => {
      const { context, sql } = command(randomUUID())
      const plans = await commitPlans(gate.full, context, sql)
      // Не порожній доказ: оператори перевірки захоплено, і вони читають
      // кожну таблицю, яку судить ця команда.
      expect(plans.length, "plans of the COMMIT check").toBeGreaterThan(0)
      for (const table of read)
        expect(
          plans.flatMap((p) => scansOf(p, table)).length,
          `${table} is read`
        ).toBeGreaterThan(0)
      expect
        .soft(
          plans.flatMap((p) =>
            RIGHTS_TABLES.flatMap((table) =>
              scansOf(p, table)
                .filter((n) => n.type === "Seq Scan")
                .map(
                  (n) =>
                    `${n.relation}: ${String(p["Query Text"]).slice(0, 80)}`
                )
            )
          ),
          "Seq Scan of rights tables"
        )
        .toEqual([])
    }
  )
})
