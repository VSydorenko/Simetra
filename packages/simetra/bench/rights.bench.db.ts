import { randomUUID } from "node:crypto"
import { statfsSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import pg from "pg"
import { carrierBackfillStatements, type CompiledModel } from "simetra/compiler"
import {
  COMMAND_SETTING,
  PLATFORM_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
} from "simetra/model"
import {
  CHECKLIST_TABLE,
  ORG_ADMIN_ID,
  ORG_MEMBER_ROLE_ID,
  TASK_VIEWER_ID,
  adminRoles,
  compileRights,
  policyDomain,
} from "../src/compiler/__tests__/fixtures/rights"
import { signUp } from "../test/db/auth"
import { asRole, testDatabaseUrl } from "../test/db/connection"
import {
  assignmentRow,
  deploy,
  insert,
  orgDeltaRow,
} from "../test/db/rights-seed"

/**
 * Бенчмарк меж прав (спека прав §5.4): скільки витримують функції
 * прав і запобіжники на обсягах, яких компілятор не бачить, — бо це обсяги
 * даних, а не метаданих. Поза `test:db` і CI: прогін — хвилини, а результат —
 * заміри однієї машини, що йдуть у таблицю «Supported limits» скілу
 * споживача (спека прав §5.4), а не поріг перевірки.
 *
 * Кожен сценарій — власна транзакція з відкатом: розгортання, засів і
 * заміри не лишають на спільному стеку нічого. Засів — у режимі
 * обслуговування, одним `INSERT … SELECT` на таблицю; `ANALYZE`
 * лише засіяних таблиць, як у гейті планів: інакше планувальник оцінює
 * таблиці за замовчуванням, а не за засівом.
 */

const ORG = "organization"
const REGION = "region"
const MEMBER = "org_member"
const ASSIGNMENTS = "org_role_assignments"
const TASK = "task"
const CHECKLIST = CHECKLIST_TABLE

/** Повтори запиту після прогріву: медіана відсіює випадкові піки стеку. */
const RUNS = 5
/** Межа вільного місця перед сценарієм на мільйон рядків (з WAL і індексами). */
const MIN_FREE_BYTES = 8 * 1024 ** 3
const TIMEOUT = 30 * 60_000
/** Межа одного читання: довше — межу знайдено, міряти далі нема чого. */
const READ_LIMIT = "60s"
/** Межа будь-якого оператора сценарію, засіву теж: страховка спільного стеку. */
const SCENARIO_LIMIT = "10min"
/** Повільніший за це запит міряється одним прогоном. */
const SLOW_MS = 5_000

interface Row {
  scenario: string
  volume: string
  list?: string
  point?: string
  count?: string
  operator?: string
}
const rows: Row[] = []

const ms = (value: number) => `${value.toFixed(1)} ms`
const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}
/** Медіана повторів і перший (холодний) прогін — кожен запит API іде окремою транзакцією. */
const timing = (first: number, warm: number[]) =>
  `${ms(median(warm))} (first ${ms(first)})`

async function elapsed(fn: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  await fn()
  return performance.now() - started
}

/**
 * Транзакція сценарію: розгортання моделі в ній і відкат наприкінці. Межа
 * оператора сценарію — `statement_timeout` на боці сервера: збій чи
 * переривання клієнта не лишає важкий запит виконуватися на спільному стеку,
 * а після відкату перевіряється, що бекенд сценарію не активний.
 */
async function scenario(
  model: CompiledModel,
  fn: (client: pg.Client) => Promise<void>
): Promise<void> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() })
  await client.connect()
  const { rows: backend } = await client.query<{ pid: number }>(
    "SELECT pg_backend_pid() AS pid"
  )
  const pid = backend[0]!.pid
  try {
    await client.query("BEGIN")
    try {
      await client.query(`SET LOCAL statement_timeout = '${SCENARIO_LIMIT}'`)
      await deploy(client, model)
      await fn(client)
    } finally {
      // Відкат після збою сценарію може сам впасти — першопричину це не затирає
      await client.query("ROLLBACK").catch(() => undefined)
    }
  } finally {
    await client.end()
  }
  const admin = new pg.Client({ connectionString: testDatabaseUrl() })
  await admin.connect()
  try {
    const { rows: left } = await admin.query<{ state: string }>(
      "SELECT state FROM pg_stat_activity WHERE pid = $1 AND state <> 'idle'",
      [pid]
    )
    expect(left, `backend ${pid} of the scenario is not active`).toEqual([])
    process.stderr.write(`bench: backend ${pid} not active after rollback\n`)
  } finally {
    await admin.end()
  }
}

/** Масовий засів таблиць прав: поза режимом обслуговування — `rights-context`. */
async function maintenance(
  client: pg.Client,
  fn: () => Promise<unknown>
): Promise<void> {
  await client.query("SELECT set_config($1, 'on', true)", [
    RIGHTS_MAINTENANCE_SETTING,
  ])
  await fn()
  await client.query("SELECT set_config($1, 'off', true)", [
    RIGHTS_MAINTENANCE_SETTING,
  ])
}

/** Обсяг у точці збереження: засів одного обсягу не тягнеться в наступний. */
async function volume(
  client: pg.Client,
  fn: () => Promise<void>
): Promise<void> {
  await client.query("SAVEPOINT volume")
  try {
    await fn()
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT volume")
  }
}

/** Час запиту в мс або `undefined`, якщо він перевищив межу заміру. */
async function timed(
  client: pg.Client,
  sql: string
): Promise<number | undefined> {
  await client.query("SAVEPOINT timed")
  try {
    return await elapsed(() => client.query(sql))
  } catch (error) {
    if (error instanceof pg.DatabaseError && error.code === "57014")
      return undefined
    throw error
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT timed")
  }
}

const TIMED_OUT = `> ${READ_LIMIT} (statement timeout)`

/** Обсяг після перевищення меншим обсягом: час лише більший, а стек спільний. */
const notMeasured = (scenario: string, volume: string): Row => {
  const cell = "not measured (a smaller volume timed out)"
  return { scenario, volume, list: cell, point: cell, count: cell }
}

/**
 * Список, точкове читання й підрахунок `task` від імені користувача — так,
 * як їх виконає PostgREST: роль `authenticated` з claims у точці збереження.
 * Запит, повільніший за `SLOW_MS`, не повторюється: медіана повторів
 * хвилинного запиту лише тримала б спільний стек. `timedOut` — хоч одна
 * форма перевищила межу: більший обсяг не міряється.
 */
async function readForms(
  client: pg.Client,
  user: string,
  point: string
): Promise<{
  cells: Pick<Row, "list" | "point" | "count">
  timedOut: boolean
}> {
  const forms = {
    list: `SELECT * FROM public.${TASK} ORDER BY id LIMIT 50`,
    point: `SELECT * FROM public.${TASK} WHERE id = '${point}'::uuid`,
    count: `SELECT count(*) FROM public.${TASK}`,
  }
  const cells: Pick<Row, "list" | "point" | "count"> = {}
  let timedOut = false
  await client.query("SAVEPOINT reader")
  try {
    await asRole(client, "authenticated", { sub: user, role: "authenticated" })
    await client.query(`SET LOCAL statement_timeout = '${READ_LIMIT}'`)
    // Точковий рядок видимий: інакше замір читав би порожню відповідь
    const visible = await timed(client, forms.point)
    if (visible !== undefined) {
      const { rows: found } = await client.query(forms.point)
      expect(found, "the point row is visible").toHaveLength(1)
    }
    for (const [form, sql] of Object.entries(forms) as [
      keyof typeof forms,
      string,
    ][]) {
      const first = await timed(client, sql)
      if (first === undefined) {
        cells[form] = TIMED_OUT
        timedOut = true
        continue
      }
      if (first > SLOW_MS) {
        cells[form] = `${ms(first)} (single run)`
        continue
      }
      const warm: number[] = []
      for (let i = 0; i < RUNS; i++) warm.push((await timed(client, sql))!)
      cells[form] = timing(first, warm)
    }
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT reader")
  }
  return { cells, timedOut }
}

const compiled = async () => {
  const result = await compileRights(policyDomain(adminRoles()))
  expect(result.diagnostics).toEqual([])
  return result.model!
}

describe("rights limits benchmark", () => {
  afterAll(async () => {
    const { rows: version } = await (async () => {
      const client = new pg.Client({ connectionString: testDatabaseUrl() })
      await client.connect()
      try {
        return await client.query<{ version: string }>("SELECT version()")
      } finally {
        await client.end()
      }
    })()
    const cell = (value?: string) => value ?? "—"
    // Вивід консолі vitest ховає для зелених тестів — таблицю пише прямо в stdout
    process.stdout.write(
      [
        "",
        `Postgres: ${version[0]?.version ?? "unknown"}`,
        "",
        "| Scenario | Volume | List | Point | Count | Operator |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows.map(
          (r) =>
            `| ${r.scenario} | ${r.volume} | ${cell(r.list)} | ${cell(r.point)} | ${cell(r.count)} | ${cell(r.operator)} |`
        ),
        "",
      ].join("\n")
    )
  })

  /**
   * (1) Потужність значень виміру: учасник одного тенанта з роллю `deny
   * read@any` (лишаються `own` і вимір `region`, як у гейті планів) і N
   * значеннями виміру. Тенант має 20 000 регіонів по задачі на кожен, решта
   * — 1 000 тенантів по 100 задач; учасник бачить N задач свого виміру.
   */
  it(
    "1 dimension value cardinality",
    async () => {
      await scenario(await compiled(), async (client) => {
        const org = randomUUID()
        const member = randomUUID()
        const role = randomUUID()
        const user = await signUp(client)
        await insert(client, ORG, { id: org })
        await insert(client, MEMBER, { id: member, org_id: org, user_id: user })
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
        await insert(client, ASSIGNMENTS, {
          org_id: org,
          ...assignmentRow(member, { customRole: role }),
        })
        await client.query(
          `INSERT INTO public.${ORG} (id) SELECT gen_random_uuid() FROM generate_series(1, 1000)`
        )
        // Регіони тенанта упорядковані: перші N — значення виміру учасника
        await client.query(
          `INSERT INTO public.${REGION} (id, org_id) SELECT gen_random_uuid(), o.id FROM public.${ORG} o WHERE o.id <> $1`,
          [org]
        )
        await client.query(
          `INSERT INTO public.${REGION} (id, org_id) SELECT gen_random_uuid(), $1 FROM generate_series(1, 20000)`,
          [org]
        )
        await client.query(
          `INSERT INTO public.${TASK} (id, org_id, date, region_id)
           SELECT gen_random_uuid(), r.org_id, now(), r.id
           FROM public.${REGION} r CROSS JOIN generate_series(1, 100) AS g
           WHERE r.org_id <> $1 ORDER BY r.org_id, g`,
          [org]
        )
        await client.query(
          `INSERT INTO public.${TASK} (id, org_id, date, region_id)
           SELECT gen_random_uuid(), r.org_id, now(), r.id
           FROM public.${REGION} r WHERE r.org_id = $1 ORDER BY r.id`,
          [org]
        )
        await client.query(
          `ANALYZE public.${ORG}, public.${REGION}, public.${TASK}`
        )
        let exceeded = false
        for (const values of [1000, 5000, 20000]) {
          const label = `${values.toLocaleString("en")} values, 120,000 tasks`
          if (exceeded) {
            rows.push(notMeasured("1 dimension values per user", label))
            continue
          }
          await volume(client, async () => {
            await client.query(
              `INSERT INTO public.member_region (org_id, member_id, region_id)
               SELECT $1, $2, r.id FROM public.${REGION} r WHERE r.org_id = $1
               ORDER BY r.id LIMIT $3`,
              [org, member, values]
            )
            await client.query("ANALYZE public.member_region")
            const { rows: visible } = await client.query<{ id: string }>(
              `SELECT t.id FROM public.${TASK} t JOIN public.member_region m ON m.region_id = t.region_id
               WHERE m.member_id = $1 ORDER BY t.id DESC LIMIT 1`,
              [member]
            )
            const { cells, timedOut } = await readForms(
              client,
              user,
              visible[0]!.id
            )
            exceeded = timedOut
            rows.push({
              scenario: "1 dimension values per user",
              volume: label,
              ...cells,
            })
          })
        }
      })
    },
    TIMEOUT
  )

  /**
   * (2) Скоупи `fullAccess`: користувач — учасник N тенантів з роллю
   * `OrgAdmin` у кожному; 2 000 тенантів по 50 задач.
   */
  it(
    "2 fullAccess scopes",
    async () => {
      await scenario(await compiled(), async (client) => {
        const user = await signUp(client)
        await client.query(
          `INSERT INTO public.${ORG} (id) SELECT gen_random_uuid() FROM generate_series(1, 2000)`
        )
        await client.query(
          `INSERT INTO public.${REGION} (id, org_id) SELECT gen_random_uuid(), o.id FROM public.${ORG} o`
        )
        await client.query(
          `INSERT INTO public.${TASK} (id, org_id, date, region_id)
           SELECT gen_random_uuid(), r.org_id, now(), r.id
           FROM public.${REGION} r CROSS JOIN generate_series(1, 50) AS g
           ORDER BY r.org_id, g`
        )
        await client.query(
          `ANALYZE public.${ORG}, public.${REGION}, public.${TASK}`
        )
        let exceeded = false
        // 10 і 30 — понад точки сценарію: межа потрібна й там, де читання ще прийнятне
        for (const scopes of [10, 30, 100, 500, 2000]) {
          const label = `${scopes.toLocaleString("en")} scopes, 100,000 tasks`
          if (exceeded) {
            rows.push(notMeasured("2 fullAccess scopes per user", label))
            continue
          }
          await volume(client, async () => {
            await client.query(
              `INSERT INTO public.${MEMBER} (id, org_id, user_id)
               SELECT gen_random_uuid(), o.id, $1 FROM public.${ORG} o ORDER BY o.id LIMIT $2`,
              [user, scopes]
            )
            await maintenance(client, () =>
              client.query(
                `INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype, deletion_mark)
                 SELECT gen_random_uuid(), m.org_id, m.id, $2, false
                 FROM public.${MEMBER} m WHERE m.user_id = $1`,
                [user, ORG_ADMIN_ID]
              )
            )
            await client.query(
              `ANALYZE public.${MEMBER}, public.${ASSIGNMENTS}`
            )
            const { rows: visible } = await client.query<{ id: string }>(
              `SELECT t.id FROM public.${TASK} t JOIN public.${MEMBER} m ON m.org_id = t.org_id
               WHERE m.user_id = $1 ORDER BY t.id DESC LIMIT 1`,
              [user]
            )
            const { cells, timedOut } = await readForms(
              client,
              user,
              visible[0]!.id
            )
            exceeded = timedOut
            rows.push({
              scenario: "2 fullAccess scopes per user",
              volume: label,
              ...cells,
            })
          })
        }
      })
    },
    TIMEOUT
  )

  /**
   * (3) Розгалуження ТЧ: зміна носія власника (`region`) задачі з N рядками
   * ТЧ — тригер поширення копій носіїв переписує копію в кожному рядку. Час —
   * оператор і відкладені перевірки, які інакше заплатив би `COMMIT`.
   */
  it(
    "3 tabular section fan-out",
    async () => {
      await scenario(await compiled(), async (client) => {
        const org = randomUUID()
        const regions = [randomUUID(), randomUUID()]
        const task = randomUUID()
        await insert(client, ORG, { id: org })
        for (const id of regions)
          await insert(client, REGION, { id, org_id: org })
        await insert(client, TASK, {
          id: task,
          org_id: org,
          date: new Date(),
          region_id: regions[0],
        })
        for (const lines of [100_000, 300_000]) {
          await volume(client, async () => {
            await client.query(
              `INSERT INTO public.${CHECKLIST} (id, org_id, parent_id, line_number, note)
               SELECT gen_random_uuid(), $1, $2, g, 'line' FROM generate_series(1, $3) AS g`,
              [org, task, lines]
            )
            await client.query(`ANALYZE public.${TASK}, public.${CHECKLIST}`)
            const times: number[] = []
            for (let i = 0; i < 3; i++) {
              const target = regions[(i + 1) % 2]
              times.push(
                await elapsed(async () => {
                  await client.query(
                    `UPDATE public.${TASK} SET region_id = $1 WHERE id = $2`,
                    [target, task]
                  )
                  await client.query("SET CONSTRAINTS ALL IMMEDIATE")
                })
              )
              await client.query("SET CONSTRAINTS ALL DEFERRED")
            }
            // Копія дійшла до кожного рядка: інакше замір міряв би не поширення
            const { rows: stale } = await client.query<{ n: string }>(
              `SELECT count(*) AS n FROM public.${CHECKLIST} WHERE parent_id = $1 AND region_id IS DISTINCT FROM $2`,
              [task, regions[1]]
            )
            expect(stale[0]!.n).toBe("0")
            rows.push({
              scenario: "3 owner carrier change, tabular section fan-out",
              volume: `${lines.toLocaleString("en")} section rows`,
              operator: `${ms(median(times))} (runs ${times.map((t) => t.toFixed(0)).join(", ")} ms)`,
            })
          })
        }
      })
    },
    TIMEOUT
  )

  /**
   * (4) Крок копій носіїв на 1 000 000 рядків ТЧ з порожніми копіями (як після
   * додавання поля прав): SQL — `carrierBackfillStatements` над знімком
   * фікстури, під `row_security = off`, як його виконує застосування.
   * Засів — з вимкненими тригерами користувача, інакше тригер виведення
   * заповнив би копії ще на вставці.
   */
  it(
    "4 carrier backfill step",
    async () => {
      const free = statfsSync("/")
      const bytes = free.bavail * free.bsize
      if (bytes < MIN_FREE_BYTES)
        throw new Error(
          `not enough free disk for 1,000,000 rows: ${(bytes / 1024 ** 3).toFixed(1)} GiB`
        )
      const model = await compiled()
      const table = model.physical.tables.find(
        (t) => t.schema === "public" && t.name === CHECKLIST
      )!
      const copies = table.columns
        .filter((c) => c.origin.copyOf !== undefined)
        .map((c) => c.name)
      expect(copies.length, "the section has carrier copies").toBeGreaterThan(0)
      const statements = carrierBackfillStatements(model.physical, [
        { table: { schema: "public", name: CHECKLIST }, columns: copies },
      ])
      await scenario(model, async (client) => {
        await client.query(
          `INSERT INTO public.${ORG} (id) SELECT gen_random_uuid() FROM generate_series(1, 100)`
        )
        await client.query(
          `INSERT INTO public.${REGION} (id, org_id) SELECT gen_random_uuid(), o.id FROM public.${ORG} o`
        )
        await client.query(
          `INSERT INTO public.${TASK} (id, org_id, date, region_id)
           SELECT gen_random_uuid(), r.org_id, now(), r.id
           FROM public.${REGION} r CROSS JOIN generate_series(1, 100) AS g
           ORDER BY r.org_id, g`
        )
        await client.query(
          `ALTER TABLE public.${CHECKLIST} DISABLE TRIGGER USER`
        )
        await client.query(
          `INSERT INTO public.${CHECKLIST} (id, org_id, parent_id, line_number, note)
           SELECT gen_random_uuid(), t.org_id, t.id, g, 'line'
           FROM public.${TASK} t CROSS JOIN generate_series(1, 100) AS g
           ORDER BY t.org_id, t.id, g`
        )
        await client.query(
          `ALTER TABLE public.${CHECKLIST} ENABLE TRIGGER USER`
        )
        await client.query(`ANALYZE public.${TASK}, public.${CHECKLIST}`)
        await client.query("SET LOCAL row_security = off")
        let written = 0
        const time = await elapsed(async () => {
          for (const s of statements)
            written += (await client.query(s.sql)).rowCount ?? 0
        })
        await client.query("RESET row_security")
        expect(written, "the step wrote every row").toBe(1_000_000)
        rows.push({
          scenario: "4 carrier backfill step",
          volume: "1,000,000 section rows",
          operator: ms(time),
        })
      })
    },
    TIMEOUT
  )

  /**
   * (5) Ціна запобіжників прав на 1 000 рядків призначень у контексті
   * команди з JWT-актором — перевірка приросту, журнал і ключ
   * `actor`; режим обслуговування їх пропускає, тож там лише довідковий
   * рядок. Команда пише лише свій кореневий рядок (спека прав §4.6, тригер ефектів),
   * тож одного оператора на 1 000 призначень у команді не буває: міряється
   * одна команда у власній транзакції і транзакція з 1 000 команд по рядку —
   * блок `DO` за один виклик, щоб час
   * був часом сервера, а не мережі. Час — блок і відкладені перевірки
   * (`SET CONSTRAINTS ALL IMMEDIATE`), які інакше заплатив би `COMMIT`. Фон —
   * 1 000 тенантів по 10 призначень.
   */
  it(
    "5 guard trigger cost",
    async () => {
      await scenario(await compiled(), async (client) => {
        // Роль команд і членство з SET, як у DB-тестах запобіжників: розгортання
        // їх не дає, і без них `SET ROLE` ролі команд відмовляє
        await client.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
        )
        await client.query(
          `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
        )
        const org = randomUUID()
        const adminMember = randomUUID()
        const admin = await signUp(client)
        await insert(client, ORG, { id: org })
        await insert(client, MEMBER, {
          id: adminMember,
          org_id: org,
          user_id: admin,
        })
        await insert(client, ASSIGNMENTS, {
          org_id: org,
          ...assignmentRow(adminMember, { archetype: ORG_ADMIN_ID }),
        })
        await client.query(
          `INSERT INTO public.${ORG} (id) SELECT gen_random_uuid() FROM generate_series(1, 1000)`
        )
        // Провізія створює «Користувачів» з тим самим id, що й облікові
        // записи; номер у пошті розкладає їх по тенантах: перші 10 000 — по 10
        // на фоновий тенант, решта 1 000 — цілі команди в тенанті адміністратора.
        const marker = randomUUID()
        await client.query(
          `INSERT INTO auth.users (id, email)
           SELECT gen_random_uuid(), 'bench-' || g || '-' || $1 || '@example.test' FROM generate_series(1, 11000) AS g`,
          [marker]
        )
        await client.query(
          `INSERT INTO public.${MEMBER} (id, org_id, user_id)
           SELECT gen_random_uuid(), CASE WHEN u.n > 10000 THEN $1 ELSE o.id END, u.id
           FROM (SELECT id, split_part(email, '-', 2)::int AS n FROM auth.users WHERE email LIKE '%-' || $2 || '@example.test') u
           LEFT JOIN (SELECT id, row_number() OVER (ORDER BY id) - 1 AS k FROM public.${ORG} WHERE id <> $1) o
             ON u.n <= 10000 AND (u.n - 1) / 10 = o.k`,
          [org, marker]
        )
        await maintenance(client, () =>
          client.query(
            `INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype, deletion_mark)
             SELECT gen_random_uuid(), m.org_id, m.id, $2, false
             FROM public.${MEMBER} m WHERE m.org_id <> $1`,
            [org, TASK_VIEWER_ID]
          )
        )
        // Відкладені перевірки засіву — тут, а не в замірах: інакше
        // кожна точка збереження з відкатом платила б їх знову (~5 с).
        await client.query("SET CONSTRAINTS ALL IMMEDIATE")
        await client.query("SET CONSTRAINTS ALL DEFERRED")
        await client.query(
          `ANALYZE public.${ORG}, public.${MEMBER}, public.${ASSIGNMENTS}`
        )
        const { rows: targets } = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM public.${MEMBER} WHERE org_id = $1 AND id <> $2`,
          [org, adminMember]
        )
        expect(targets[0]!.n).toBe("1000")
        // Рядок за рядком, кожен — команда зі своїм коренем: так їх пише
        // `runCommand`, і так їх судить тригер ефектів
        const block = (context: boolean, commands: number) => `DO $bench$
          DECLARE m record; v_id uuid;
          BEGIN
            FOR m IN SELECT id FROM public.${MEMBER} WHERE org_id = '${org}' AND id <> '${adminMember}' ORDER BY id LIMIT ${commands} LOOP
              v_id := gen_random_uuid();
              ${context ? `PERFORM set_config('${COMMAND_SETTING}', json_build_object('action', 'administerRights', 'object', '${ASSIGNMENTS}', 'root', v_id)::text, true);` : ""}
              INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype, deletion_mark)
              VALUES (v_id, '${org}', m.id, '${TASK_VIEWER_ID}', false);
            END LOOP;
          END $bench$`
        const written = async (commands: number) => {
          const { rows: n } = await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM public.${ASSIGNMENTS} WHERE org_id = $1`,
            [org]
          )
          // Нові призначення і призначення самого адміністратора
          expect(n[0]!.n, "every assignment is written").toBe(
            String(commands + 1)
          )
        }

        const command = async (commands: number): Promise<number> => {
          await client.query("SAVEPOINT command")
          try {
            await client.query("SELECT set_config($1, $2, true)", [
              SESSION_CLAIMS_SETTING,
              JSON.stringify({ sub: admin, role: "authenticated" }),
            ])
            await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
            const time = await elapsed(async () => {
              await client.query(block(true, commands))
              await client.query("SET CONSTRAINTS ALL IMMEDIATE")
            })
            await client.query("RESET ROLE")
            await written(commands)
            return time
          } finally {
            await client.query("ROLLBACK TO SAVEPOINT command")
          }
        }
        const reference = async (): Promise<number> => {
          await client.query("SAVEPOINT reference")
          try {
            const time = await elapsed(async () => {
              await maintenance(client, () => client.query(block(false, 1000)))
              await client.query("SET CONSTRAINTS ALL IMMEDIATE")
            })
            await written(1000)
            return time
          } finally {
            await client.query("ROLLBACK TO SAVEPOINT reference")
          }
        }
        const runs = async (fn: () => Promise<number>, n = RUNS) => {
          const times: number[] = []
          for (let i = 0; i < n; i++) times.push(await fn())
          return `${ms(median(times))} (runs ${times.map((t) => t.toFixed(0)).join(", ")} ms)`
        }
        // Одна команда — так її платить API: точка збереження з відкатом
        // стоїть за власну транзакцію, `SET CONSTRAINTS` — за її COMMIT.
        rows.push({
          scenario:
            "5 guard triggers, 1 command with JWT actor in its own transaction",
          volume: "1 assignment row, 11,000 in the table",
          operator: await runs(() => command(1), 2 * RUNS - 1),
        })
        rows.push({
          scenario:
            "5 guard triggers, 1,000 commands with JWT actor in one transaction",
          volume: "1,000 assignment rows",
          operator: await runs(() => command(1000)),
        })
        rows.push({
          scenario: "5 same rows, maintenance mode (reference)",
          volume: "1,000 assignment rows",
          operator: await runs(reference),
        })
      })
    },
    TIMEOUT
  )
})
