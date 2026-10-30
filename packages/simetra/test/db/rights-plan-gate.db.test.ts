import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type pg from "pg"
import {
  CHECKLIST_TABLE,
  HOURS_TABLES,
  ORG_KIND_ID,
  ORG_MEMBER_ROLE_ID,
  RIGHTS_ADMIN_ID,
  adminRoles,
  compileRights,
  policyDomain,
} from "../../src/compiler/__tests__/fixtures/rights"
import { signUp } from "./auth"
import { asRole, queryAs } from "./connection"
import { type PlanNode, scansOf, subPlans } from "./explain-plan"
import {
  assignmentRow,
  deploy,
  describeTransaction,
  insert,
  orgDeltaRow,
} from "./rights-seed"

/**
 * Гейт планів політик прав (спека прав §5.4, Р2d2-8, Р2d2-12): чи читають
 * політики дані помітного обсягу індексом, а функції прав рахуються раз на
 * запит, — вирішує планувальник Postgres на засіві з реальною статистикою;
 * компілятор бачить лише текст політик. Одне розгортання й один засів на
 * опис; транзакція опису відкочується.
 *
 * Засів (Р2d2-8): 1 000 тенантів по 20 задач — 20 000 `task`, 100 000
 * `task_checklist`, 10 000 рухів `task_hours`, кожна таблиця одним
 * `INSERT … SELECT`, упорядкованим за тенантом; журнал прав — 20 000 рядків
 * на 1 000 скоупів. Користувач гейта — учасник одного тенанта з роллю, що
 * дає `own` і вимір: усі політики `PERMISSIVE` складаються через OR, а розмір
 * множин планувальнику невідомий (`InitPlan`), тож форма плану від ролі не
 * залежить.
 */

const TENANTS = 1000
const TASKS_PER_TENANT = 20
const LINES_PER_TASK = 5
const MOVEMENTS_PER_TENANT = 10
const JOURNAL_PER_SCOPE = 20

/** Колонка скоупу (межа тенанта) таблиць гейта. */
const SCOPE_COLUMN = /\borg_id\b/

const TASK = "task"
const CHECKLIST = CHECKLIST_TABLE
const HOURS = HOURS_TABLES.movements
const JOURNAL = "rights_journal"

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
  // Упорядкованість за тенантом — фізична кореляція колонки скоупу (Р2d2-8):
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
    const started = Date.now()
    gate = await seed(client)
    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
    await client.query("SET CONSTRAINTS ALL DEFERRED")
    // Без статистики планувальник оцінює таблиці за замовчуванням, а не за засівом.
    // Лише засіяні таблиці: ANALYZE усієї спільної бази тримав би блокування
    // чужих таблиць до відкату й переписав би їхню статистику поза транзакцією.
    await client.query(
      `ANALYZE public.organization, public.region, public.${TASK}, public.${CHECKLIST}, public.${HOURS}, simetra.${JOURNAL}`
    )
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
   * `rights_journal_of` — `SECURITY DEFINER`: зовнішній план показує лише
   * `Function Scan`. План справжнього виклику — з `auto_explain` (бібліотека
   * в `shared_preload_libraries` стеку, параметри `auto_explain.*` дозволені
   * ролі стеку через supautils), вкладений оператор тіла приходить
   * повідомленням `LOG`.
   */
  it("rights_journal_of reads the scope journal by index", async () => {
    const client = tx.client()
    const plans: unknown[] = []
    const onNotice = (notice: { severity?: string; message?: string }) => {
      const message = notice.message ?? ""
      // Повідомлення `auto_explain`: «duration: … plan:» і план JSON.
      const start = message.indexOf("plan:")
      if (notice.severity === "LOG" && start >= 0)
        plans.push(JSON.parse(message.slice(start + "plan:".length)))
    }
    await client.query("SAVEPOINT journal_plan")
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
        sub: gate.admin,
        role: "authenticated",
      })
      const { rows } = await client.query(
        "SELECT * FROM simetra.rights_journal_of($1, $2, 100)",
        [ORG_KIND_ID, gate.org]
      )
      // Засів плюс записи журналу від призначень тенанта гейта.
      expect(rows.length, "the admin reads the journal").toBeGreaterThanOrEqual(
        JOURNAL_PER_SCOPE
      )
    } finally {
      client.off("notice", onNotice)
      // Відкат точки збереження скидає і `SET LOCAL`, і роль.
      await client.query("ROLLBACK TO SAVEPOINT journal_plan")
    }
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
})
