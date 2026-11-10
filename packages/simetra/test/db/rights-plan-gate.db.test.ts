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
import { SNAPSHOT_TABLES } from "../../src/compiler/rights/actor-snapshot"
import { RIGHTS_FUNCTIONS } from "../../src/compiler/rights/functions"
import { signUp } from "./auth"
import { asRole, queryAs, setLocalSetting, claimsFor } from "./connection"
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
/**
 * Знімки паралельних транзакцій у таблицях знімка (план Права-3, Review
 * Focus 6): під навантаженням таблиці тримають рядки чужих xid, доки їх не
 * прибере наступний знімок. На сторінці рядків `Seq Scan` — правильний план
 * і нічого не доводить, тож гейт судить план на помітному обсязі.
 */
const BACKGROUND_TRANSACTIONS = 1000

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
/** Довідники призначень: їх читає лише жива гілка входів `rights_mine`. */
const LIVE_INPUT_TABLES = ["org_role_assignments", "global_role_assignments"]
/** Таблиці знімка (план Права-3, Р3-2, Р3-15) — ім'я відношення в плані. */
const SNAPSHOT_NAMES = Object.values(SNAPSHOT_TABLES).map((t) => t.name)
/** Таблиці рядків фактів — без заголовка, який читають умови гілок. */
const FACT_TABLE_NAMES = SNAPSHOT_NAMES.filter(
  (name) =>
    name !== SNAPSHOT_TABLES.header.name && name !== SNAPSHOT_TABLES.start.name
)
/**
 * Сталі функції компіляції (рішення архітекторки плану Права-3): цикл, чия
 * зовнішня сторона виведена лише з них, повторює CTE стале число разів.
 */
const CONSTANT_FUNCTIONS = new Set(
  [
    RIGHTS_FUNCTIONS.projection,
    RIGHTS_FUNCTIONS.requires,
    RIGHTS_FUNCTIONS.domain,
  ].map((f) => f.name)
)
/** Ім'я функції для тексту запиту. */
const fn = (name: { schema: string; name: string }) =>
  `${name.schema}.${name.name}`

/** Випадок гейта тіл, де діють диспетчери решти фактів (Р3-3). */
const SET_FUNCTIONS = "set functions of a task policy"

/**
 * Живі гілки диспетчерів фактів, які кличуть політики задачі: оператор гілки
 * кличе живий варіант (`rights_my_scopes` — через `rights_my_members`).
 */
const LIVE_FACT_BRANCHES = [
  RIGHTS_FUNCTIONS.myScopesLive,
  RIGHTS_FUNCTIONS.dimensionValuesLive,
]

/** Чи оператор плану — жива гілка диспетчера, що кличе варіант `live`. */
const liveBranch = (
  plan: Record<string, unknown>,
  live: { schema: string; name: string }
) => {
  const text = String(plan["Query Text"])
  return (
    text.trimStart().startsWith("SELECT l.") && text.includes(`${fn(live)}(`)
  )
}

/** Пара гейта (Р3-16): читання задачі, через яке йдуть функції множин політики. */
const PAIR_SQL = `SELECT count(*) FROM ${fn(RIGHTS_FUNCTIONS.minePair)}('read', '${TASK}')`

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
  /** Глобальна кастомна роль власника `fullAccess`. */
  fullGlobalRole: string
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
  await setLocalSetting(client, RIGHTS_MAINTENANCE_SETTING, "on")
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
  await setLocalSetting(client, RIGHTS_MAINTENANCE_SETTING, "off")
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
    fullGlobalRole,
    point: { [TASK]: visible.task, [CHECKLIST]: visible.line },
  }
}

/**
 * Рядки `BACKGROUND_TRANSACTIONS` чужих знімків у кожній таблиці знімка, за
 * формою рядків актора з кількома призначеннями й дельтами. xid — від'ємні:
 * справжнього xid з ними не сплутати. Тіло знімка прибирає їх у точці
 * збереження випадку (рядки інших xid), і план гілки знімка тоді читає
 * таблиці, статистика яких каже «помітний обсяг», — стан після прибирання.
 */
async function snapshotBackground(client: pg.Client): Promise<void> {
  const T = SNAPSHOT_TABLES
  const xids = `generate_series(1, ${BACKGROUND_TRANSACTIONS}) AS x`
  const per = (n: number) => `generate_series(1, ${n}) AS g`
  for (const sql of [
    `INSERT INTO ${fn(T.header)} (xid, fact, actor) SELECT -x, f, gen_random_uuid() FROM ${xids} CROSS JOIN unnest(ARRAY['rights', 'scopes', 'values', 'scopeSets']) AS f`,
    `INSERT INTO ${fn(T.typed)} (xid, storage, scope_kind_id, scope, archetype, level, level_id) SELECT -x, 'scope', '${ORG_KIND_ID}', gen_random_uuid(), '${ORG_MEMBER_ROLE_ID}', 'scope', '${ORG_KIND_ID}' FROM ${xids} CROSS JOIN ${per(20)}`,
    `INSERT INTO ${fn(T.containers)} (xid, level_id, container, scope_kind_id, scope) SELECT -x, gen_random_uuid(), gen_random_uuid(), '${ORG_KIND_ID}', gen_random_uuid() FROM ${xids} CROSS JOIN ${per(5)}`,
    `INSERT INTO ${fn(T.deltas)} (xid, storage, storage_id, custom_role, scope_key, effect, object, action, extent) SELECT -x, 'scope', '${ORG_KIND_ID}', gen_random_uuid(), gen_random_uuid(), CASE WHEN g % 2 = 0 THEN 'allow' ELSE 'deny' END, '${TASK}', 'read', 'any' FROM ${xids} CROSS JOIN ${per(10)}`,
    `INSERT INTO ${fn(T.holders)} (xid, level, level_id, scope) SELECT -x, 'scope', '${ORG_KIND_ID}', gen_random_uuid() FROM ${xids} CROSS JOIN ${per(5)}`,
    `INSERT INTO ${fn(T.scopes)} (xid, scope_kind_id, scope, member, catalog) SELECT -x, '${ORG_KIND_ID}', gen_random_uuid(), gen_random_uuid(), true FROM ${xids} CROSS JOIN ${per(20)}`,
    `INSERT INTO ${fn(T.values)} (xid, dimension_id, value) SELECT -x, gen_random_uuid(), gen_random_uuid() FROM ${xids} CROSS JOIN ${per(20)}`,
    `INSERT INTO ${fn(T.scopeSets)} (xid, scope_kind_id, scope) SELECT -x, gen_random_uuid(), gen_random_uuid() FROM ${xids} CROSS JOIN ${per(5)}`,
  ])
    await client.query(sql)
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
    // Таблиці знімка (план Права-3, Задача 5 крок 1): статистика обсягу
    // паралельних знімків, а не оцінка за замовчуванням.
    await snapshotBackground(client)
    await client.query(
      `ANALYZE ${Object.values(SNAPSHOT_TABLES).map(fn).join(", ")}`
    )
    // Точний засів глобального довідника: інакше гейт зелений без глобальних
    // дельт. Масовий засів дає по одній дельті на роль, роль власника
    // `fullAccess` — дві (гілки `allow` і `deny`).
    const { rows: global } = await client.query<{
      roles: number
      deltas: number
    }>(
      "SELECT (SELECT count(*) FROM public.global_roles)::int AS roles, (SELECT count(*) FROM public.global_roles_delta)::int AS deltas"
    )
    expect(global[0]!.roles).toBe(GLOBAL_ROLES + 1)
    expect(global[0]!.deltas).toBe(GLOBAL_ROLES + 2)
    // Гілка `allow` тіл функцій прав від імені `fullAccess` читає глобальні
    // дельти через його призначення глобальної ролі; гілка `deny` читає їх
    // усі незалежно від призначень.
    const { rows: fullAssigned } = await client.query(
      "SELECT 1 FROM public.global_role_assignments WHERE subject = $1 AND custom_role = $2",
      [gate.full, gate.fullGlobalRole]
    )
    expect(
      fullAssigned.length,
      "gate.full has a global custom role assignment"
    ).toBe(1)
    console.info(`rights plan gate: seed + ANALYZE ${Date.now() - started} ms`)
  }, 120_000)

  afterAll(() => tx.close())

  /** План `EXPLAIN (ANALYZE, FORMAT JSON)` запиту від імені `user`. */
  const explain = async (user: string, sql: string): Promise<unknown> => {
    const result = await queryAs<{ "QUERY PLAN": unknown }>(
      tx.client(),
      "user",
      claimsFor("user", user),
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
   * функції теж, приходить повідомленням `LOG`. `user = null` — виклик від
   * власника (функції, які кличуть лише запобіжники). `before` — оператор
   * від власника з claims `user` і контекстом команди до підписки на
   * повідомлення: запис у джерело фактів бере знімок (спека прав §7), і
   * `headers` — заголовки фактів цього xid після нього.
   */
  const autoExplain = async (
    user: string | null,
    sql: string,
    {
      params = [],
      before,
    }: {
      params?: unknown[]
      before?: { sql: string; context: Record<string, string> }
    } = {}
  ): Promise<{
    plans: Record<string, unknown>[]
    rows: unknown[]
    headers: { fact: string; actor: string }[]
  }> => {
    const client = tx.client()
    const plans: Record<string, unknown>[] = []
    let headers: { fact: string; actor: string }[] = []
    const onNotice = (notice: { severity?: string; message?: string }) => {
      const message = notice.message ?? ""
      // Повідомлення `auto_explain`: «duration: … plan:» і план JSON.
      const start = message.indexOf("plan:")
      if (notice.severity === "LOG" && start >= 0)
        plans.push(JSON.parse(message.slice(start + "plan:".length)))
    }
    await client.query("SAVEPOINT auto_explain")
    try {
      if (before !== undefined) {
        await setLocalSetting(
          client,
          SESSION_CLAIMS_SETTING,
          JSON.stringify(claimsFor("user", user))
        )
        await setLocalSetting(
          client,
          COMMAND_SETTING,
          JSON.stringify(before.context)
        )
        await client.query(before.sql)
        const { rows: taken } = await client.query<{
          fact: string
          actor: string
        }>(
          `SELECT fact, actor FROM ${fn(SNAPSHOT_TABLES.header)} WHERE xid = txid_current() ORDER BY fact`
        )
        headers = taken
      }
      client.on("notice", onNotice)
      for (const setting of [
        "auto_explain.log_min_duration = 0",
        "auto_explain.log_nested_statements = on",
        "auto_explain.log_analyze = on",
        "auto_explain.log_format = 'json'",
        "client_min_messages = log",
      ])
        await client.query(`SET LOCAL ${setting}`)
      if (user !== null) await asRole(client, "user", claimsFor("user", user))
      const { rows } = await client.query(sql, params)
      return { plans, rows, headers }
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
      { params: [ORG_KIND_ID, gate.org] }
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
   * Випадки гейта тіл: ім'я, запит і чи діє правило циклів над сталими —
   * для повного `rights_mine()` ні.
   */
  const BODY_CASES = (): [string, () => string, boolean][] => [
    [
      "rights_mine()",
      () => "SELECT count(*) FROM simetra.rights_mine()",
      false,
    ],
    ["rights_mine(p_action, p_object)", () => PAIR_SQL, true],
    [
      SET_FUNCTIONS,
      () => `SELECT * FROM public.${TASK} WHERE id = '${gate.fullPoint}'::uuid`,
      true,
    ],
  ]

  /** Повідомлення перевірки: вузол і початок тексту його оператора. */
  const where = (p: Record<string, unknown>) =>
    String(p["Query Text"]).slice(0, 80)

  /**
   * Критерії тіл функцій прав (спека прав §5.4), спільні для читання без
   * знімка й зі знімком. Жоден оператор — ні тіло `rights_mine`, ні тіла
   * `rights_any` / `own` / `dim` / `container` — не читає CTE більше одного
   * разу (`CTE Scan` з циклами > 1): так виглядало замикання, квадратичне за
   * скоупами, і віднімання дельт `NOT EXISTS` у `role_rows` — вкладений
   * цикл, а не підплан. `constantLoops` — правило циклів архітекторки (план
   * Права-3): цикл над сталими функціями компіляції дозволено; для повного
   * `rights_mine()` його не ввімкнено. І жоден не перебирає таблицю прав чи
   * знімка повторно (`Seq Scan` з циклами > 1): дельти — не матеріалізований
   * CTE, тож їхнє перечитування в циклі — уже `Seq Scan`, а не `CTE Scan`.
   * Індексне читання з циклами лишається дозволеним — це точковий доступ.
   */
  const judgeBodies = (
    plans: Record<string, unknown>[],
    constantLoops: boolean
  ) => {
    expect
      .soft(
        plans.flatMap((p) =>
          repeatedCteScans(
            p,
            constantLoops ? CONSTANT_FUNCTIONS : undefined
          ).map((n) => `CTE Scan on ${n.cte} x${n.loops}: ${where(p)}`)
        ),
        "CTE scans repeated per outer row"
      )
      .toEqual([])
    expect
      .soft(
        plans.flatMap((p) =>
          [...RIGHTS_TABLES, ...SNAPSHOT_NAMES].flatMap((table) =>
            scansOf(p, table)
              .filter((n) => n.type === "Seq Scan" && (n.loops ?? 1) > 1)
              .map((n) => `Seq Scan on ${n.relation} x${n.loops}: ${where(p)}`)
          )
        ),
        "rights and snapshot tables scanned per outer row"
      )
      .toEqual([])
  }

  /**
   * Плани тіла `rights_mine` (повного й пари): тіло рахує замикання — читає
   * `rights_requires`. Не порожній доказ: план тіла захоплено.
   */
  const mineBodies = (plans: Record<string, unknown>[]) => {
    const bodies = plans.filter((p) =>
      String(p["Query Text"]).includes("closure_1")
    )
    expect(bodies.length, "plans of the rights_mine body").toBeGreaterThan(0)
    for (const body of bodies)
      expect(functionScans(body)).toContain(RIGHTS_FUNCTIONS.requires.name)
    return bodies
  }

  /** Чи план читає таблицю виконаним вузлом (`PlanNode` тримає й loops = 0). */
  const executes = (plan: unknown, table: string) =>
    scansOf(plan, table).some((n) => (n.loops ?? 0) > 0)

  /**
   * Тіла функцій прав від власника `fullAccess` у `FULL_ACCESS_SCOPES`
   * тенантах: `rights_mine()` напряму, права пари (Р3-16) і функції множин
   * політики (точкове читання задачі). Без знімка диспетчер `rights_mine`
   * (Р3-15) виконує живу гілку: план її `RETURN QUERY` у журналі є
   * (`log_nested_statements`) і читає довідники призначень, а план гілки
   * знімка не виконувався — вхідних таблиць знімка тіла не читають. Решта
   * функцій фактів (Р3-3) — той самий диспетчер: їхні живі гілки виконано, а
   * таблиць рядків знімка не планує жоден оператор.
   */
  it.each(BODY_CASES())(
    "%s: rights function bodies read no CTE or rights table more than once",
    async (name, sql, pair) => {
      const { plans, rows } = await autoExplain(gate.full, sql())
      expect(rows.length, "the full-access holder reads").toBe(1)
      for (const body of mineBodies(plans)) {
        expect
          .soft(
            LIVE_INPUT_TABLES.some((t) => executes(body, t)),
            `the live branch ran: ${where(body)}`
          )
          .toBe(true)
        expect
          .soft(
            FACT_TABLE_NAMES.filter((t) => scansOf(body, t).length > 0),
            `the snapshot branch is not planned: ${where(body)}`
          )
          .toEqual([])
      }
      if (name === SET_FUNCTIONS) {
        expect(
          LIVE_FACT_BRANCHES.filter(
            (branch) => !plans.some((p) => liveBranch(p, branch))
          ),
          "the live branches of the fact functions ran"
        ).toEqual([])
        expect
          .soft(
            plans.flatMap((p) =>
              FACT_TABLE_NAMES.flatMap((t) => scansOf(p, t)).map(
                (n) => `${n.relation}: ${where(p)}`
              )
            ),
            "the snapshot branches are not planned without a snapshot"
          )
          .toEqual([])
      }
      judgeBodies(plans, pair)
      // Не порожній доказ другого критерію: тіла читають таблиці прав.
      expect(
        plans.flatMap((p) => RIGHTS_TABLES.flatMap((t) => scansOf(p, t)))
          .length,
        "rights tables are read"
      ).toBeGreaterThan(0)
      // Гілка `deny` читає всі глобальні дельти без з'єднання з
      // призначеннями, тож тут вимагається виконаний доступ гілки `allow` за
      // власником рядка ТЧ. Він виконується на кожен рядок `held`, тож
      // прив'язку до призначення `gate.full` форма плану не доводить — її
      // тримає перевірка призначення в `beforeAll`.
      expect(
        plans
          .flatMap((p) => scansOf(p, "global_roles_delta"))
          .some(
            (n) =>
              (n.loops ?? 0) > 0 &&
              n.conditions.some((c) => /\bparent_id\b/.test(c))
          ),
        "global_roles_delta is read by owner in the allow branch"
      ).toBe(true)
    }
  )

  /**
   * Те саме зі знімком (план Права-3, Задача 5 крок 3): до читання запис
   * власника з контекстом команди в «Користувачів» — тригер оператора знімає
   * всі факти і на нулі рядків. Диспетчери виконують гілки знімка: план
   * кожного `RETURN QUERY` у журналі є, читає таблиці знімка за індексом
   * (`Seq Scan` таблиці знімка — ні разу), а живих гілок не планує жоден
   * оператор. Критерії тіл — ті самі.
   */
  it.each(BODY_CASES())(
    "%s with a snapshot: fact functions read the snapshot by index",
    async (name, sql, pair) => {
      const { plans, rows, headers } = await autoExplain(gate.full, sql(), {
        before: {
          sql: "UPDATE public.users SET id = id WHERE false",
          context: { action: "update", object: "users", root: randomUUID() },
        },
      })
      expect(headers, "the write takes the facts").toEqual(
        ["rights", "scopes", "values"].map((fact) => ({
          fact,
          actor: gate.full,
        }))
      )
      expect(rows.length, "the full-access holder reads").toBe(1)
      for (const body of mineBodies(plans)) {
        expect
          .soft(
            executes(body, SNAPSHOT_TABLES.typed.name),
            `the snapshot branch ran: ${where(body)}`
          )
          .toBe(true)
        expect
          .soft(
            LIVE_INPUT_TABLES.filter((t) => scansOf(body, t).length > 0),
            `the live branch is not planned: ${where(body)}`
          )
          .toEqual([])
      }
      expect(
        plans.some((p) => executes(p, SNAPSHOT_TABLES.header.name)),
        "the branch conditions read the header"
      ).toBe(true)
      if (name === SET_FUNCTIONS) {
        expect(
          [SNAPSHOT_TABLES.scopes.name, SNAPSHOT_TABLES.values.name].filter(
            (t) => !plans.some((p) => executes(p, t))
          ),
          "the snapshot branches of the fact functions ran"
        ).toEqual([])
        expect
          .soft(
            plans.flatMap((p) =>
              LIVE_FACT_BRANCHES.some((branch) => liveBranch(p, branch))
                ? [where(p)]
                : []
            ),
            "the live branches are not planned with a snapshot"
          )
          .toEqual([])
      }
      expect
        .soft(
          plans.flatMap((p) =>
            SNAPSHOT_NAMES.flatMap((table) =>
              scansOf(p, table)
                .filter((n) => n.type === "Seq Scan" && (n.loops ?? 0) > 0)
                .map((n) => `Seq Scan on ${n.relation}: ${where(p)}`)
            )
          ),
          "snapshot tables read without an index"
        )
        .toEqual([])
      judgeBodies(plans, pair)
    }
  )

  /**
   * Тіло `rights_role_grants` (борг прав §2): запобіжники кличуть його на
   * кожну роль, що змінилась, тож дельта з 200 рядків `allow` і `deny` над
   * доменом рівня не повинна перечитувати CTE на кожен рядок.
   */
  it("rights_role_grants body reads no CTE more than once", async () => {
    const { rows: domain } = await tx.client().query<{
      object: string
      action: string
      extent: string
      dimension_id: string | null
    }>(
      `SELECT d.object, d.action, d.extent, d.dimension_id FROM ${fn(RIGHTS_FUNCTIONS.domain)}() d
       WHERE d.level = 'scope' AND d.level_id = $1
       ORDER BY d.object, d.action, d.extent, d.dimension_id`,
      [ORG_KIND_ID]
    )
    expect(domain.length, "the level has a domain").toBeGreaterThan(0)
    // Рядки домену по колу, `allow` і `deny` навперемін: обидві гілки
    // `role_rows` мають помітний обсяг.
    const delta = Array.from({ length: 200 }, (_, i) => {
      const d = domain[i % domain.length]!
      return {
        object: d.object,
        action: d.action,
        extent: d.extent,
        dimension: d.dimension_id,
        effect: i % 2 === 0 ? "allow" : "deny",
      }
    })
    const { plans, rows } = await autoExplain(
      null,
      `SELECT count(*) AS n FROM ${fn(RIGHTS_FUNCTIONS.roleGrants)}('scope', $1, $2, $3::jsonb)`,
      { params: [ORG_KIND_ID, ORG_ADMIN_ID, JSON.stringify(delta)] }
    )
    expect(
      Number((rows[0] as { n: string }).n),
      "the role grants rows"
    ).toBeGreaterThan(0)
    const bodies = plans.filter((p) =>
      String(p["Query Text"]).includes("closure_1")
    )
    expect(bodies.length, "plans of the rights_role_grants body").toBe(1)
    expect
      .soft(
        bodies.flatMap((p) =>
          repeatedCteScans(p).map(
            (n) => `CTE Scan on ${n.cte} x${n.loops}: ${where(p)}`
          )
        ),
        "CTE scans repeated per outer row"
      )
      .toEqual([])
  })

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
      await setLocalSetting(
        client,
        SESSION_CLAIMS_SETTING,
        JSON.stringify(claimsFor("user", user))
      )
      await setLocalSetting(client, COMMAND_SETTING, JSON.stringify(context))
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
