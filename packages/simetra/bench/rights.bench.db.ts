import { randomUUID } from "node:crypto"
import { statfsSync } from "node:fs"
import { afterAll, describe, expect, it } from "vitest"
import pg from "pg"
import { carrierBackfillStatements, type CompiledModel } from "simetra/compiler"
import {
  COMMAND_SETTING,
  CURRENT_USER_FUNCTION_NAME,
  PLATFORM_ROLES,
  PLATFORM_SCHEMA,
  RIGHTS_MAINTENANCE_SETTING,
  SESSION_CLAIMS_SETTING,
} from "simetra/model"
import {
  BENCH_TEAM_SEAT_TABLE,
  BENCH_TEAM_SET_FUNCTION,
  BENCH_ZONE_TABLE,
  CHECKLIST_TABLE,
  ORG_ADMIN_ID,
  ORG_MEMBER_ROLE_ID,
  TASK_VIEWER_ID,
  TEAM_KIND_ID,
  adminRoles,
  compileRights,
  policyDomain,
  snapshotBenchDomain,
  tenantSelfService,
} from "../src/compiler/__tests__/fixtures/rights"
import { SNAPSHOT_TABLES } from "../src/compiler/rights/actor-snapshot"
import { RIGHTS_FUNCTIONS } from "../src/compiler/rights/functions"
import { rootCreatorFunctionName } from "../src/compiler/rights/root-creator-units"
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

/**
 * Димовий прогін (`RIGHTS_BENCH_SMOKE=1`): лише доказ, що рядки
 * виконуються, — менші обсяги нових рядків і менше повторів. Типово —
 * справжній замір; числа димового прогону не порівнюються ні з чим.
 */
const SMOKE = process.env.RIGHTS_BENCH_SMOKE === "1"
/** Повтори запиту після прогріву: медіана відсіює випадкові піки стеку. */
const RUNS = SMOKE ? 1 : 5
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

/** Медіана прогонів і кожен прогін. */
const runsCell = (times: number[]) =>
  `${ms(median(times))} (runs ${times.map((t) => t.toFixed(1)).join(", ")} ms)`

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
      // Таблиці знімка (план Права-3, Задача 5 крок 1): статистика порожніх
      // таблиць, як між транзакціями застосунку, а не оцінка за замовчуванням.
      await client.query(`ANALYZE ${SNAPSHOT_NAMES}`)
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

/** Таблиці знімка (план Права-3, Р3-2, Р3-15) для тексту запиту. */
const SNAPSHOT_NAMES = Object.values(SNAPSHOT_TABLES)
  .map((t) => `${t.schema}.${t.name}`)
  .join(", ")
const HEADER = `${SNAPSHOT_TABLES.header.schema}.${SNAPSHOT_TABLES.header.name}`
/** Ім'я функції прав для тексту запиту. */
const rightsFn = (name: keyof typeof RIGHTS_FUNCTIONS) =>
  `${RIGHTS_FUNCTIONS[name].schema}.${RIGHTS_FUNCTIONS[name].name}`

/** Зняті факти поточної транзакції (заголовки знімка). */
async function snapshotFacts(client: pg.Client): Promise<string[]> {
  const { rows: facts } = await client.query<{ fact: string }>(
    `SELECT fact FROM ${HEADER} WHERE xid = txid_current_if_assigned()`
  )
  return facts.map((f) => f.fact).sort()
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

const compiled = async (files = policyDomain(adminRoles())) => {
  const result = await compileRights(files)
  expect(result.diagnostics).toEqual([])
  return result.model!
}

/**
 * Роль команд з повним DML і членством з SET, як у DB-тестах запобіжників:
 * розгортання їх не дає, і без них `SET ROLE` ролі команд відмовляє.
 */
async function commandRole(client: pg.Client): Promise<void> {
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${PLATFORM_ROLES.command}`
  )
  await client.query(
    `GRANT ${PLATFORM_ROLES.command} TO CURRENT_USER WITH SET TRUE`
  )
}

/**
 * Актор сценаріїв 7 і 8: `OrgAdmin` у `scopes` тенантах (домашній — перший)
 * і `values` значень виміру `region` у домашньому, з контейнером, рядком
 * таблиці дослівної функції виміру й місцем у команді — цілі першого запису.
 */
async function seedActor(client: pg.Client, scopes: number, values: number) {
  const user = await signUp(client)
  const home = randomUUID()
  await insert(client, ORG, { id: home })
  await client.query(
    `INSERT INTO public.${ORG} (id) SELECT gen_random_uuid() FROM generate_series(1, $1)`,
    [scopes - 1]
  )
  // Тенанти актора — домашній і ще не зайняті іншим актором
  await client.query(
    `INSERT INTO public.${MEMBER} (id, org_id, user_id)
       SELECT gen_random_uuid(), o.id, $1 FROM public.${ORG} o
       WHERE o.id = $2 OR NOT EXISTS (SELECT 1 FROM public.${MEMBER} m WHERE m.org_id = o.id)`,
    [user, home]
  )
  await maintenance(client, () =>
    client.query(
      `INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype, deletion_mark)
         SELECT gen_random_uuid(), m.org_id, m.id, $2, false
         FROM public.${MEMBER} m WHERE m.user_id = $1`,
      [user, ORG_ADMIN_ID]
    )
  )
  const { rows: member } = await client.query<{ id: string }>(
    `SELECT id FROM public.${MEMBER} WHERE org_id = $1 AND user_id = $2`,
    [home, user]
  )
  await client.query(
    `INSERT INTO public.${REGION} (id, org_id) SELECT gen_random_uuid(), $1 FROM generate_series(1, $2)`,
    [home, values]
  )
  await client.query(
    `INSERT INTO public.member_region (org_id, member_id, region_id)
       SELECT $1, $2, r.id FROM public.${REGION} r WHERE r.org_id = $1`,
    [home, member[0]!.id]
  )
  const project = randomUUID()
  const zone = randomUUID()
  await insert(client, "project", { id: project, org_id: home })
  await insert(client, BENCH_ZONE_TABLE, {
    id: zone,
    org_id: home,
    keeper_id: user,
  })
  await client.query(
    `INSERT INTO public.${BENCH_TEAM_SEAT_TABLE} (id, user_id, team) VALUES (gen_random_uuid(), $1, gen_random_uuid())`,
    [user]
  )
  return {
    user,
    home,
    label: `${scopes.toLocaleString("en")} fullAccess scopes, ${values.toLocaleString("en")} dimension values`,
    targets: [
      { name: "container", table: "project", id: project },
      {
        name: "verbatim dimension table",
        table: BENCH_ZONE_TABLE,
        id: zone,
      },
      { name: "membership catalog", table: MEMBER, id: member[0]!.id },
    ],
  }
}

/**
 * Звичайний і найбільший актор сценаріїв 7 і 8 (обсяги сценаріїв 1 і 2
 * разом) з відкладеними перевірками засіву й `ANALYZE` засіяних таблиць —
 * тут, а не в замірах (як у сценарії 5).
 */
async function benchActors(client: pg.Client) {
  const actors = [
    { kind: "ordinary actor", ...(await seedActor(client, 1, 1)) },
    {
      kind: "largest actor",
      ...(await (SMOKE
        ? seedActor(client, 100, 1000)
        : seedActor(client, 2000, 20000))),
    },
  ]
  await client.query("SET CONSTRAINTS ALL IMMEDIATE")
  await client.query("SET CONSTRAINTS ALL DEFERRED")
  await client.query(
    `ANALYZE public.${ORG}, public.${MEMBER}, public.${ASSIGNMENTS}, public.${REGION}, public.member_region, public.project, public.${BENCH_ZONE_TABLE}, public.${BENCH_TEAM_SEAT_TABLE}`
  )
  return actors
}

/** Зразки серверного заміру на функцію (Р3-9 (а)): не менше 31. */
const FACT_SAMPLES = SMOKE ? 3 : 31
/** Викликів функції в одному зразку. */
const FACT_CALLS = SMOKE ? 20 : 1000

/**
 * Рядок сценарію 6: функція факту, її варіант і медіана часу виклику з
 * довірчим інтервалом. Варіант — окремий рядок, а не колонка: публічна
 * функція без знімка й зі знімком, живий варіант і їхня парна різниця.
 */
interface FactRow {
  fact: string
  variant: string
  volume: string
  median: string
  ci: string
}
const factRows: FactRow[] = []

const us = (value: number) => `${value.toFixed(2)} µs`

/**
 * 95 % довірчий інтервал медіани за порядковими статистиками (без
 * припущення про розподіл): ранги n/2 ∓ 1,96·√n/2. Зразки мікросекунд мають
 * важкий правий хвіст піків стеку, тож нормальне наближення середнього тут
 * збрехало б.
 */
function medianInterval(values: number[]): [number, number] {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const half = (1.96 * Math.sqrt(n)) / 2
  const low = Math.max(1, Math.floor(n / 2 - half))
  const high = Math.min(n, Math.ceil(n / 2 + half))
  return [sorted[low - 1]!, sorted[high - 1]!]
}

/**
 * Функція, яку міряє сценарій 6: `from` — вираз `FROM` однієї форми для
 * кожної сторони (`PERFORM count(*) FROM <from>`).
 */
interface FactCall {
  fact: string
  variant: string
  from: string
}

/**
 * Серверний замір функцій фактів (Р3-9 (а)): на кожну функцію — тимчасова
 * plpgsql-функція з циклом `FACT_CALLS` викликів між двома
 * `clock_timestamp()`, тож мережа й розбір запиту в замір не входять, а
 * план `PERFORM` кешований. Зразки чергуються між функціями зі зсувом
 * порядку на кожному колі: дрейф стеку лягає на всі функції порівну. Перше
 * коло — прогрів, не зразок. Тимчасові функції зникають з відкатом сценарію;
 * ім'я — з номером заміру, бо сценарій міряє кілька наборів. Повертає зразки
 * кожної функції за колами — для парних різниць.
 */
let sampling = 0
async function sampleFacts(
  client: pg.Client,
  calls: readonly FactCall[],
  volume: string
): Promise<number[][]> {
  const set = sampling++
  const name = (i: number) => `pg_temp.bench_fact_${set}_${i}`
  for (const [i, call] of calls.entries()) {
    await client.query(
      `CREATE FUNCTION ${name(i)}(k int) RETURNS double precision LANGUAGE plpgsql AS $bench$
       DECLARE t0 timestamptz;
       BEGIN
         t0 := clock_timestamp();
         FOR i IN 1..k LOOP
           PERFORM count(*) FROM ${call.from};
         END LOOP;
         RETURN extract(epoch FROM clock_timestamp() - t0) * 1e6 / k;
       END $bench$`
    )
  }
  const samples = calls.map((): number[] => [])
  for (let round = 0; round <= FACT_SAMPLES; round++) {
    for (let j = 0; j < calls.length; j++) {
      const i = (j + round) % calls.length
      const { rows: t } = await client.query<{ us: number }>(
        `SELECT ${name(i)}($1) AS us`,
        [FACT_CALLS]
      )
      if (round > 0) samples[i]!.push(t[0]!.us)
    }
  }
  for (const [i, call] of calls.entries()) {
    const [low, high] = medianInterval(samples[i]!)
    factRows.push({
      fact: call.fact,
      variant: call.variant,
      volume,
      median: us(median(samples[i]!)),
      ci: `${us(low)} – ${us(high)}`,
    })
  }
  return samples
}

/**
 * Парна різниця двох функцій одного заміру (Р3-9 (а)): різниця зразків
 * одного кола — дрейф стеку між колами в неї не входить.
 */
function pairedDifference(
  samples: number[][],
  [a, b]: [number, number],
  row: Omit<FactRow, "median" | "ci">
): void {
  const differences = samples[a]!.map((value, k) => value - samples[b]![k]!)
  const [low, high] = medianInterval(differences)
  factRows.push({
    ...row,
    median: us(median(differences)),
    ci: `${us(low)} – ${us(high)}`,
  })
}

/**
 * Оператори заповнення знімка (Р3-9 (в)) — з тіл тригерів знімка, які
 * розгорнуто, а не переписані тут: блок факту — між умовою його заголовка
 * й записом заголовка, оператор — `INSERT` у таблицю знімка. Актора тіла
 * (`v_actor`) замінює поточний користувач — його ж бере тіло. Факт
 * береться з першого джерела, що його знімає: тіло факту в усіх джерел
 * однакове.
 */
async function snapshotFillers(
  client: pg.Client
): Promise<{ table: string; sql: string }[]> {
  const bodies = await snapshotBodies(client)
  const seen = new Set<string>()
  const fillers: { table: string; sql: string }[] = []
  for (const { body } of bodies)
    for (const [fact, block] of factBlocks(body)) {
      if (seen.has(fact)) continue
      seen.add(fact)
      for (const sql of block.split(/;\s*(?:\n|$)/).map((s) => s.trim())) {
        if (sql === "") continue
        const target = /^INSERT INTO\s+(?:[\w"]+\.)?"?(\w+)"?/.exec(sql)
        if (target === null)
          throw new Error(`not a snapshot insert: ${sql.slice(0, 80)}`)
        fillers.push({
          table: target[1]!.replace(/^rights_tx_/, ""),
          sql: sql.replace(
            /\bv_actor\b/g,
            `(SELECT ${PLATFORM_SCHEMA}.${CURRENT_USER_FUNCTION_NAME}())`
          ),
        })
      }
    }
  expect([...seen].sort(), "every fact has a filler").toEqual([
    "rights",
    "scopeSets",
    "scopes",
    "values",
  ])
  return fillers
}

/**
 * Σ операторів заповнення знімка (Р3-9 (в), розвилка (2)) з розбивкою за
 * таблицями фактів — ті самі оператори, що в тілі тригера знімка, окремими
 * запитами клієнта в точці збереження з відкатом, у стані до першого запису
 * (знімка ще немає). `written` — рядки першого прогону.
 */
async function snapshotFill(
  client: pg.Client,
  fillers: { table: string; sql: string }[],
  user: string
): Promise<{
  times: Map<string, number[]>
  written: Map<string, number>
  sums: number[]
}> {
  const times = new Map<string, number[]>()
  const written = new Map<string, number>()
  const sums: number[] = []
  for (let i = 0; i < 2 * RUNS - 1; i++) {
    await client.query("SAVEPOINT fill")
    try {
      await client.query("SELECT set_config($1, $2, true)", [
        SESSION_CLAIMS_SETTING,
        JSON.stringify({ sub: user, role: "authenticated" }),
      ])
      const run = new Map<string, number>()
      for (const filler of fillers) {
        let n = 0
        const time = await elapsed(async () => {
          n = (await client.query(filler.sql)).rowCount ?? 0
        })
        run.set(filler.table, (run.get(filler.table) ?? 0) + time)
        if (i === 0)
          written.set(filler.table, (written.get(filler.table) ?? 0) + n)
      }
      for (const [table, time] of run)
        times.set(table, [...(times.get(table) ?? []), time])
      sums.push([...run.values()].reduce((x, y) => x + y, 0))
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT fill")
    }
  }
  return { times, written, sums }
}

/** Тіла тригерів знімка кожного джерела й решта тригерів прав джерела. */
async function snapshotBodies(
  client: pg.Client
): Promise<{ source: string; body: string; guards: string[] }[]> {
  const { rows: bodies } = await client.query<{
    source: string
    body: string
    guards: string[]
  }>(
    `SELECT n.nspname || '.' || c.relname AS source, p.prosrc AS body,
            ARRAY(SELECT o.tgname::text FROM pg_trigger o WHERE o.tgrelid = c.oid AND NOT o.tgisinternal AND o.oid <> t.oid ORDER BY 1) AS guards
     FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE NOT t.tgisinternal AND t.tgname LIKE '%simetra_rights_snapshot%'
     ORDER BY 1`
  )
  return bodies
}

/** Блоки фактів тіла знімка: факт і його оператори. */
function factBlocks(body: string): [string, string][] {
  const block =
    /IF NOT EXISTS \(SELECT 1 FROM \S*rights_tx_header WHERE xid = txid_current\(\) AND fact = '(\w+)'\) THEN\n([\s\S]*?)\n\s*INSERT INTO \S*rights_tx_header/g
  return [...body.matchAll(block)].map((m) => [m[1]!, m[2]!])
}

/**
 * Джерела знімка (Р3-9 (в)): бізнес-дані — таблиці без власних
 * запобіжників прав (довідників прав, членства, «Користувачів»): контейнери,
 * зв'язки вимірів, таблиці дослівних функцій. Перший запис команди в них
 * платить знімок, хоч права не змінює.
 */
async function snapshotSources(
  client: pg.Client
): Promise<{ table: string; facts: string; business: boolean }[]> {
  const rightsGuard = /simetra_rights_(insert|update|delete|members_|users_)/
  return (await snapshotBodies(client)).map(({ source, body, guards }) => ({
    table: source,
    facts: factBlocks(body)
      .map(([fact]) => fact)
      .join(", "),
    business: !guards.some((g) => rightsGuard.test(g)),
  }))
}
const sourceRows: { table: string; facts: string; business: boolean }[] = []

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
        // План Права-3, Задача 5 крок 1: функції фактів читають заголовок
        // знімка лише з призначеним xid, і транзакція сценарію його має.
        "reads run with an assigned xid",
        ...(SMOKE ? ["", "SMOKE RUN: reduced volumes, not a measurement"] : []),
        "",
        "| Scenario | Volume | List | Point | Count | Operator |",
        "| --- | --- | --- | --- | --- | --- |",
        ...rows.map(
          (r) =>
            `| ${r.scenario} | ${r.volume} | ${cell(r.list)} | ${cell(r.point)} | ${cell(r.count)} | ${cell(r.operator)} |`
        ),
        "",
        ...(factRows.length === 0
          ? []
          : [
              `6 fact functions, server-side: ${FACT_CALLS.toLocaleString("en")} calls per sample, ${FACT_SAMPLES} interleaved samples, median per call with 95% CI of the median`,
              "",
              "| Fact | Variant | Volume | Median per call | 95% CI |",
              "| --- | --- | --- | --- | --- |",
              ...factRows.map(
                (r) =>
                  `| ${r.fact} | ${r.variant} | ${r.volume} | ${r.median} | ${r.ci} |`
              ),
              "",
            ]),
        ...(sourceRows.length === 0
          ? []
          : [
              "7 snapshot sources: a business-data source pays the snapshot on an ordinary write",
              "",
              "| Source | Facts | Business data |",
              "| --- | --- | --- |",
              ...sourceRows.map(
                (r) =>
                  `| ${r.table} | ${r.facts} | ${r.business ? "yes" : "no"} |`
              ),
              "",
            ]),
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
        await commandRole(client)
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

  /**
   * (6) Серверний замір публічних функцій фактів актора (план Права-3,
   * Р3-9 (а)) на малому обсязі: користувач — учасник трьох тенантів
   * (`OrgAdmin`, `OrgMember`, `TaskViewer`), 10 значень виміру `region`,
   * 5 зон і 5 місць у командах. Функції кличе власник із claims
   * користувача: вони `SECURITY DEFINER`, тож роль викликача змінила б лише
   * перевірку `EXECUTE`. Перший замір — базова лінія тієї самої форми, що й
   * до блоку Права-3 (`BENCH_BASE`); далі — публічна функція проти живого
   * варіанта в одному чергуванні без знімка і зі знімком, з парною різницею,
   * плюс права пари (Р3-16) і `rights_any` на ній.
   */
  it(
    "6 fact function overhead",
    async () => {
      await scenario(await compiled(snapshotBenchDomain()), async (client) => {
        const user = await signUp(client)
        const tenants = [ORG_ADMIN_ID, ORG_MEMBER_ROLE_ID, TASK_VIEWER_ID].map(
          (archetype) => ({
            org: randomUUID(),
            member: randomUUID(),
            archetype,
          })
        )
        for (const t of tenants) {
          await insert(client, ORG, { id: t.org })
          await insert(client, MEMBER, {
            id: t.member,
            org_id: t.org,
            user_id: user,
          })
          await insert(client, ASSIGNMENTS, {
            org_id: t.org,
            ...assignmentRow(t.member, { archetype: t.archetype }),
          })
        }
        const home = tenants[0]!
        await client.query(
          `INSERT INTO public.${REGION} (id, org_id) SELECT gen_random_uuid(), $1 FROM generate_series(1, 10)`,
          [home.org]
        )
        await client.query(
          `INSERT INTO public.member_region (org_id, member_id, region_id)
           SELECT $1, $2, r.id FROM public.${REGION} r WHERE r.org_id = $1`,
          [home.org, home.member]
        )
        await client.query(
          `INSERT INTO public.${BENCH_ZONE_TABLE} (id, org_id, keeper_id) SELECT gen_random_uuid(), $1, $2 FROM generate_series(1, 5)`,
          [home.org, user]
        )
        await client.query(
          `INSERT INTO public.${BENCH_TEAM_SEAT_TABLE} (id, user_id, team) SELECT gen_random_uuid(), $1, gen_random_uuid() FROM generate_series(1, 5)`,
          [user]
        )
        await client.query(
          `ANALYZE public.${ORG}, public.${MEMBER}, public.${ASSIGNMENTS}, public.${REGION}, public.member_region, public.${BENCH_ZONE_TABLE}, public.${BENCH_TEAM_SEAT_TABLE}`
        )
        await client.query("SELECT set_config($1, $2, true)", [
          SESSION_CLAIMS_SETTING,
          JSON.stringify({ sub: user, role: "authenticated" }),
        ])
        const calls: FactCall[] = [
          { fact: "rights_mine", from: "simetra.rights_mine()" },
          { fact: "rights_my_scopes", from: "simetra.rights_my_scopes()" },
          {
            fact: `${MEMBER}_member_scopes`,
            from: `public.${MEMBER}_member_scopes()`,
          },
          {
            fact: `${MEMBER}_my_member(p_scope)`,
            from: `public.${MEMBER}_my_member('${home.org}'::uuid)`,
          },
          {
            fact: "scope set of team",
            variant: `verbatim ${BENCH_TEAM_SET_FUNCTION}`,
            from: `${BENCH_TEAM_SET_FUNCTION}()`,
          },
        ].map((c) => ({ variant: "public", ...c }))
        // Кожна функція бачить засів: замір порожньої відповіді міряв би не те
        for (const call of calls) {
          const { rows: n } = await client.query<{ n: string }>(
            `SELECT count(*) AS n FROM ${call.from} f WHERE NOT (f IS NULL)`
          )
          expect(Number(n[0]!.n), `${call.fact} returns rows`).toBeGreaterThan(
            0
          )
        }
        const volume = "3 scopes, 10 dimension values, 5 zones, 5 team seats"
        await sampleFacts(client, calls, volume)

        // Р3-9 (а) після блоку Права-3: публічна функція проти живого
        // варіанта в одному чергуванні. Без знімка xid уже призначено засівом
        // — записом без контексту команди, тож знімка немає, а гілки читають
        // заголовок за xid, як у транзакції команди.
        const { rows: xid } = await client.query<{ assigned: boolean }>(
          "SELECT txid_current_if_assigned() IS NOT NULL AS assigned"
        )
        expect(xid[0]!.assigned, "reads run with an assigned xid").toBe(true)
        expect(await snapshotFacts(client), "no snapshot yet").toEqual([])
        // Функції членства не мають окремого живого варіанта: їхня жива
        // гілка — тіло функції до блоку, тут — тим самим текстом (тіла
        // `memberScopesFunction` і `myMemberFunction` без знімка), у формі
        // живих варіантів `rights_*_live` (`STABLE`, від викликача).
        const current = `(SELECT ${PLATFORM_SCHEMA}.${CURRENT_USER_FUNCTION_NAME}())`
        await client.query(
          `CREATE FUNCTION pg_temp.bench_live_member_scopes() RETURNS SETOF uuid LANGUAGE sql STABLE SET search_path = '' AS $live$
           SELECT m.org_id FROM public.${MEMBER} m WHERE m.user_id IS NOT NULL AND m.user_id = ${current} $live$`
        )
        await client.query(
          `CREATE FUNCTION pg_temp.bench_live_my_member(p_scope uuid) RETURNS uuid LANGUAGE sql STABLE SET search_path = '' AS $live$
           SELECT m.id FROM public.${MEMBER} m WHERE m.org_id = bench_live_my_member.p_scope AND m.user_id IS NOT NULL AND m.user_id = ${current} $live$`
        )
        const team = `'${TEAM_KIND_ID}'::uuid`
        const facts: [fact: string, publicFrom: string, liveFrom: string][] = [
          ["rights_mine", `${rightsFn("mine")}()`, `${rightsFn("mineLive")}()`],
          [
            "rights_my_scopes",
            `${rightsFn("myScopes")}()`,
            `${rightsFn("myScopesLive")}()`,
          ],
          [
            `${MEMBER}_member_scopes`,
            `public.${MEMBER}_member_scopes()`,
            "pg_temp.bench_live_member_scopes()",
          ],
          [
            `${MEMBER}_my_member(p_scope)`,
            `public.${MEMBER}_my_member('${home.org}'::uuid)`,
            `pg_temp.bench_live_my_member('${home.org}'::uuid)`,
          ],
          [
            "scope set of team",
            `${rightsFn("scopeSet")}(${team})`,
            `${rightsFn("scopeSetLive")}(${team})`,
          ],
        ]
        // Права пари (Р3-16) і перевірка політики над нею: живого варіанта
        // пари немає — її тіло та сама гілка диспетчера.
        const pair = `'read', '${TASK}'`
        const pairCalls = [
          {
            fact: "rights_mine(p_action, p_object)",
            from: `${rightsFn("minePair")}(${pair})`,
          },
          {
            fact: "rights_any on the pair",
            from: `${rightsFn("any")}(${pair})`,
          },
        ]
        const round = async (snapshot: boolean) => {
          const variant = snapshot
            ? "public, with snapshot"
            : "public, no snapshot"
          const live = snapshot ? "live, with-snapshot round" : "live"
          const round: FactCall[] = [
            ...facts.flatMap(([fact, from, liveFrom]) => [
              { fact, variant, from },
              { fact, variant: live, from: liveFrom },
            ]),
            ...pairCalls.map((c) => ({ ...c, variant })),
          ]
          for (const call of round) {
            const { rows: n } = await client.query<{ n: string }>(
              `SELECT count(*) AS n FROM ${call.from} f WHERE NOT (f IS NULL)`
            )
            expect(
              Number(n[0]!.n),
              `${call.fact} (${call.variant}) returns rows`
            ).toBeGreaterThan(0)
          }
          const samples = await sampleFacts(client, round, volume)
          facts.forEach(([fact], k) =>
            pairedDifference(samples, [2 * k, 2 * k + 1], {
              fact,
              variant: `${variant} − live, paired`,
              volume,
            })
          )
        }
        await round(false)
        // Зі знімком: запис власника з контекстом команди в «Користувачів» —
        // джерело всіх чотирьох фактів — знімає їх і на нулі рядків.
        await client.query("SAVEPOINT snapshot")
        try {
          await client.query("SELECT set_config($1, $2, true)", [
            COMMAND_SETTING,
            JSON.stringify({ action: "update", object: "users", root: user }),
          ])
          await client.query("UPDATE public.users SET id = id WHERE false")
          expect(
            await snapshotFacts(client),
            "the write takes every fact"
          ).toEqual(["rights", "scopeSets", "scopes", "values"])
          await round(true)
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT snapshot")
        }
      })
    },
    TIMEOUT
  )

  /**
   * (7) Перший запис команди (план Права-3, Р3-9 (в)) у моделі бенчмарку
   * знімка: у контейнер (`project`), у таблицю, яку читає дослівна функція
   * виміру (`zone`), і в довідник членства — для звичайного актора
   * (`OrgAdmin` одного тенанта, одне значення виміру) і для актора
   * найбільших обсягів сценаріїв 1 і 2 разом: `OrgAdmin` у 2 000 тенантів і
   * 20 000 значень виміру в одному з них. Кожен прогін — точка збереження з
   * відкатом замість окремої транзакції (розгортання моделі не комітиться):
   * відкат прибирає й усе, що перший запис зробив у транзакції. Час —
   * оператор, виміряний клієнтом. Після базових рядків — Σ операторів
   * заповнення знімка з розбивкою за таблицями (Р3-9 (в)), `rights_any` на
   * парі, COMMIT пакета призначень, оберт рядків знімка й джерела знімка,
   * що є бізнес-даними, — для найбільшого актора.
   */
  it(
    "7 first command write",
    async () => {
      await scenario(await compiled(snapshotBenchDomain()), async (client) => {
        await commandRole(client)
        const actors = await benchActors(client)

        /** Перший оператор команди в «свіжій» транзакції — точці збереження. */
        const firstWrite = async (
          user: string,
          target: { table: string; id: string }
        ): Promise<number> => {
          await client.query("SAVEPOINT first_write")
          try {
            await client.query("SELECT set_config($1, $2, true)", [
              SESSION_CLAIMS_SETTING,
              JSON.stringify({ sub: user, role: "authenticated" }),
            ])
            await client.query("SELECT set_config($1, $2, true)", [
              COMMAND_SETTING,
              JSON.stringify({
                action: "update",
                object: target.table,
                root: target.id,
              }),
            ])
            await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
            let written = 0
            const time = await elapsed(async () => {
              const result = await client.query(
                `UPDATE public.${target.table} SET description = 'bench' WHERE id = $1`,
                [target.id]
              )
              written = result.rowCount ?? 0
            })
            await client.query("RESET ROLE")
            expect(written, `${target.table} row is written`).toBe(1)
            return time
          } finally {
            await client.query("ROLLBACK TO SAVEPOINT first_write")
          }
        }
        for (const a of actors) {
          for (const target of a.targets) {
            const times: number[] = []
            for (let i = 0; i < 2 * RUNS - 1; i++)
              times.push(await firstWrite(a.user, target))
            rows.push({
              scenario: `7 first command write, ${target.name}, ${a.kind}`,
              volume: a.label,
              operator: `${ms(median(times))} (runs ${times.map((t) => t.toFixed(1)).join(", ")} ms)`,
            })
          }
        }
        const claims = (user: string) =>
          client.query("SELECT set_config($1, $2, true)", [
            SESSION_CLAIMS_SETTING,
            JSON.stringify({ sub: user, role: "authenticated" }),
          ])

        // Р3-9 (в), розвилка (2): Σ операторів заповнення знімка з розбивкою
        // за таблицями фактів (`snapshotFill`).
        const fillers = await snapshotFillers(client)
        for (const a of actors) {
          const { times, written, sums } = await snapshotFill(
            client,
            fillers,
            a.user
          )
          for (const [table, values] of times)
            rows.push({
              scenario: `7 snapshot fill, ${table}, ${a.kind}`,
              volume: `${a.label}; ${(written.get(table) ?? 0).toLocaleString("en")} rows`,
              operator: runsCell(values),
            })
          rows.push({
            scenario: `7 snapshot fill, sum of statements, ${a.kind}`,
            volume: a.label,
            operator: runsCell(sums),
          })
        }

        // Найбільший актор: перевірка політики на парі (Р3-16) без знімка й
        // зі знімком, взятим першим записом у контейнер.
        const largest = actors[1]!
        const container = largest.targets[0]!
        const anyPair = `SELECT count(*) AS n FROM ${rightsFn("any")}('update', 'project')`
        for (const snapshot of [false, true]) {
          await client.query("SAVEPOINT any_pair")
          try {
            await claims(largest.user)
            if (snapshot) {
              await client.query("SELECT set_config($1, $2, true)", [
                COMMAND_SETTING,
                JSON.stringify({
                  action: "update",
                  object: container.table,
                  root: container.id,
                }),
              ])
              await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
              await client.query(
                `UPDATE public.${container.table} SET description = 'bench' WHERE id = $1`,
                [container.id]
              )
              await client.query("RESET ROLE")
            }
            expect(
              (await snapshotFacts(client)).includes("rights"),
              "the snapshot state of the check"
            ).toBe(snapshot)
            const times: number[] = []
            for (let i = 0; i < 2 * RUNS - 1; i++) {
              let n = 0
              times.push(
                await elapsed(async () => {
                  const { rows: found } = await client.query<{ n: string }>(
                    anyPair
                  )
                  n = Number(found[0]!.n)
                })
              )
              expect(n, "the largest actor updates its scopes").toBeGreaterThan(
                0
              )
            }
            rows.push({
              scenario: `7 rights_any on the pair, largest actor, ${snapshot ? "with snapshot" : "no snapshot"}`,
              volume: largest.label,
              operator: runsCell(times),
            })
          } finally {
            await client.query("ROLLBACK TO SAVEPOINT any_pair")
          }
        }

        // COMMIT пакета призначень найбільшого актора (Р3-9 (в)): команда на
        // рядок, як у сценарії 5; запрошені учасники — у його тенантах, у
        // точці збереження: засів базових рядків сценарію не змінюється.
        const batchSize = SMOKE ? 50 : 1000
        await client.query("SAVEPOINT batch")
        try {
          await client.query(
            `INSERT INTO public.${MEMBER} (id, org_id)
             SELECT gen_random_uuid(), m.org_id FROM public.${MEMBER} m WHERE m.user_id = $1 ORDER BY m.org_id LIMIT $2`,
            [largest.user, batchSize]
          )
          await client.query("SET CONSTRAINTS ALL IMMEDIATE")
          await client.query("SET CONSTRAINTS ALL DEFERRED")
          const block = (commands: number) => `DO $bench$
            DECLARE m record; v_id uuid;
            BEGIN
              FOR m IN SELECT g.id, g.org_id FROM public.${MEMBER} g
                JOIN public.${MEMBER} a ON a.org_id = g.org_id AND a.user_id = '${largest.user}'
                WHERE g.user_id IS NULL ORDER BY g.id LIMIT ${commands} LOOP
                v_id := gen_random_uuid();
                PERFORM set_config('${COMMAND_SETTING}', json_build_object('action', 'administerRights', 'object', '${ASSIGNMENTS}', 'root', v_id)::text, true);
                INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype, deletion_mark)
                VALUES (v_id, m.org_id, m.id, '${TASK_VIEWER_ID}', false);
              END LOOP;
            END $bench$`
          for (const commands of [1, batchSize]) {
            const times: number[] = []
            for (let i = 0; i < (commands === 1 ? 2 * RUNS - 1 : RUNS); i++) {
              await client.query("SAVEPOINT command")
              try {
                await claims(largest.user)
                await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
                times.push(
                  await elapsed(async () => {
                    await client.query(block(commands))
                    await client.query("SET CONSTRAINTS ALL IMMEDIATE")
                  })
                )
                await client.query("RESET ROLE")
                const { rows: n } = await client.query<{ n: string }>(
                  `SELECT count(*) AS n FROM public.${ASSIGNMENTS} WHERE archetype = $1`,
                  [TASK_VIEWER_ID]
                )
                expect(Number(n[0]!.n), "every assignment is written").toBe(
                  commands
                )
              } finally {
                await client.query("ROLLBACK TO SAVEPOINT command")
              }
            }
            rows.push({
              scenario: "7 COMMIT of an assignment batch, largest actor",
              volume: `${commands.toLocaleString("en")} assignment rows, ${largest.label}`,
              operator: runsCell(times),
            })
          }
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT batch")
        }

        // Оберт рядків знімка (Review Focus 6): CHURN знімків найбільшого
        // актора з відкатом без ANALYZE — мертві рядки в таблицях і
        // індексах знімка, — потім перший запис і точкове читання зі знімком
        // проти тих самих замірів до оберту.
        const churn = SMOKE ? 3 : 100
        const probe = async (): Promise<{ write: number; read: number }> => {
          await client.query("SAVEPOINT probe")
          try {
            await claims(largest.user)
            await client.query("SELECT set_config($1, $2, true)", [
              COMMAND_SETTING,
              JSON.stringify({
                action: "update",
                object: container.table,
                root: container.id,
              }),
            ])
            await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
            const write = await elapsed(() =>
              client.query(
                `UPDATE public.${container.table} SET description = 'bench' WHERE id = $1`,
                [container.id]
              )
            )
            await client.query("RESET ROLE")
            await asRole(client, "authenticated", {
              sub: largest.user,
              role: "authenticated",
            })
            let found = 0
            const read = await elapsed(async () => {
              found =
                (
                  await client.query(
                    `SELECT * FROM public.${container.table} WHERE id = $1`,
                    [container.id]
                  )
                ).rowCount ?? 0
            })
            expect(found, "the point row is visible").toBe(1)
            return { write, read }
          } finally {
            await client.query("ROLLBACK TO SAVEPOINT probe")
          }
        }
        const probes = async (label: string) => {
          const results: { write: number; read: number }[] = []
          for (let i = 0; i < 2 * RUNS - 1; i++) results.push(await probe())
          rows.push(
            {
              scenario: `7 first write with snapshot, largest actor, ${label}`,
              volume: largest.label,
              operator: runsCell(results.map((r) => r.write)),
            },
            {
              scenario: `7 point read with snapshot, largest actor, ${label}`,
              volume: largest.label,
              operator: runsCell(results.map((r) => r.read)),
            }
          )
        }
        await probes("before churn")
        for (let i = 0; i < churn; i++)
          await firstWrite(largest.user, container)
        await probes(`after ${churn} snapshots and rollbacks without ANALYZE`)
        const { rows: tables } = await client.query<{
          relname: string
          bytes: string
          inserted: string
          deleted: string
        }>(
          `SELECT relname, pg_total_relation_size(relid) AS bytes, n_tup_ins AS inserted, n_tup_del AS deleted
           FROM pg_stat_xact_user_tables WHERE schemaname = $1 AND relname = ANY ($2) ORDER BY relname`,
          [
            SNAPSHOT_TABLES.header.schema,
            Object.values(SNAPSHOT_TABLES).map((t) => t.name),
          ]
        )
        for (const t of tables)
          rows.push({
            scenario: `7 snapshot table after churn, ${t.relname}`,
            volume: `${Number(t.inserted).toLocaleString("en")} inserted, ${Number(t.deleted).toLocaleString("en")} deleted in the transaction`,
            operator: `${(Number(t.bytes) / 1024).toFixed(0)} KiB with indexes`,
          })

        sourceRows.push(...(await snapshotSources(client)))
      })
    },
    TIMEOUT
  )

  /**
   * (8) Створення тенанта (план П4-A6, Р-A6-17): модель сценарію 7 плюс
   * `tenantSelfService()` — «кожен користувач» створює `Organization`
   * (`create@own`), творець отримує `TenantOwner` з `fullAccess`. Актори —
   * сценарію 7. Ядро кореня — під контекстом `create` кореня від ролі команд,
   * «COMMIT» — `SET CONSTRAINTS ALL IMMEDIATE` у транзакції сценарію, як у
   * сценарії 7. Пороги погоджено архітекторкою: таблиця їх друкує поруч із
   * заміром, а рішення про перевищення — за архітекторкою, як і решта меж
   * бенчмарку (спека прав §5.4), тож це не перевірка тесту.
   */
  it(
    "8 tenant creation",
    async () => {
      await scenario(
        await compiled(snapshotBenchDomain(tenantSelfService())),
        async (client) => {
          await commandRole(client)
          const actors = await benchActors(client)
          const claims = (user: string) =>
            client.query("SELECT set_config($1, $2, true)", [
              SESSION_CLAIMS_SETTING,
              JSON.stringify({ sub: user, role: "authenticated" }),
            ])
          const context = (action: string, object: string, root: string) =>
            client.query("SELECT set_config($1, $2, true)", [
              COMMAND_SETTING,
              JSON.stringify({ action, object, root }),
            ])
          const limit = (median: number, max: number, label: string) =>
            `limit ${label}: ${median <= max ? "within" : "EXCEEDED"}`
          /** Сирий `INSERT` кореня під `create` (маркер ставить тригер ефектів). */
          const rawRoot = async (user: string, root: string) => {
            await claims(user)
            await context("create", ORG, root)
            await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
            await client.query(`INSERT INTO public.${ORG} (id) VALUES ($1)`, [
              root,
            ])
            await client.query("RESET ROLE")
            expect(
              await snapshotFacts(client),
              "the root insert takes no snapshot"
            ).toEqual([])
          }
          const fillers = await snapshotFillers(client)
          const grant = rootCreatorFunctionName({ physicalName: "org_id" })

          for (const a of actors) {
            // Σ операторів заповнення знімка того самого актора — орієнтир для
            // розбивки ядра; межу ядра найбільшого актора задає архітекторка.
            const { sums } = await snapshotFill(client, fillers, a.user)
            rows.push({
              scenario: `8 snapshot fill, sum of statements, ${a.kind}`,
              volume: a.label,
              operator: runsCell(sums),
            })

            const core: number[] = []
            const commit: number[] = []
            for (let i = 0; i < 2 * RUNS - 1; i++) {
              await client.query("SAVEPOINT tenant")
              try {
                const root = randomUUID()
                await claims(a.user)
                await context("create", ORG, root)
                await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
                let result: { root: unknown; member: unknown } | undefined
                core.push(
                  await elapsed(async () => {
                    const { rows: r } = await client.query<{
                      r: { root: unknown; member: unknown }
                    }>(
                      `SELECT public.${ORG}_create_root($1::jsonb, $2::jsonb, $3::uuid)::jsonb AS r`,
                      [JSON.stringify({ id: root }), "{}", randomUUID()]
                    )
                    result = r[0]!.r
                  })
                )
                await client.query("RESET ROLE")
                expect(
                  result?.member,
                  "the creator member is written"
                ).not.toBe(null)
                commit.push(
                  await elapsed(() =>
                    client.query("SET CONSTRAINTS ALL IMMEDIATE")
                  )
                )
                await client.query("SET CONSTRAINTS ALL DEFERRED")
              } finally {
                await client.query("ROLLBACK TO SAVEPOINT tenant")
              }
            }
            const ordinary = a.kind === "ordinary actor"
            const coreMax = ordinary ? 30 : 300
            const commitMax = ordinary ? 30 : 6_000
            rows.push(
              {
                scenario: `8 tenant creation, ${a.kind}`,
                volume: a.label,
                operator: `${runsCell(core)}; ${limit(median(core), coreMax, ordinary ? "≤ 30 ms" : "≤ 300 ms")}`,
              },
              {
                scenario: `8 tenant creation COMMIT, ${a.kind}`,
                volume: a.label,
                operator: `${runsCell(commit)}; ${limit(median(commit), commitMax, ordinary ? "≤ 30 ms" : "≤ 6 s")}`,
              }
            )

            // Розбивка ядра: (а) вставка членства із заповненням знімка — та
            // сама вставка, що крок (4) функції гранту: від власника з
            // `row_security = off` під контекстом `create` членства, у щойно
            // вставлений корінь (знімка ще немає); (б) тіло функції гранту без
            // знімка — виклик функції після знімка, взятого раніше в
            // транзакції (Р-A6-3 це дозволяє): записом власника з контекстом
            // команди в «Користувачів» на нулі рядків, як у сценарії 6, — він
            // знімає факти, не чіпаючи кешу початку (перевірка (6) функції).
            const membership: number[] = []
            const body: number[] = []
            for (let i = 0; i < 2 * RUNS - 1; i++) {
              await client.query("SAVEPOINT breakdown")
              try {
                const root = randomUUID()
                const member = randomUUID()
                await rawRoot(a.user, root)
                await context("create", MEMBER, member)
                await client.query("SET LOCAL row_security = off")
                membership.push(
                  await elapsed(() =>
                    client.query(
                      `INSERT INTO public.${MEMBER} (id, org_id, user_id) VALUES ($1, $2, (SELECT ${PLATFORM_SCHEMA}.${CURRENT_USER_FUNCTION_NAME}()))`,
                      [member, root]
                    )
                  )
                )
                expect(
                  await snapshotFacts(client),
                  "the membership insert takes the snapshot"
                ).toEqual(["rights", "scopes", "values"])
              } finally {
                await client.query("ROLLBACK TO SAVEPOINT breakdown")
              }
              await client.query("SAVEPOINT breakdown")
              try {
                const root = randomUUID()
                await rawRoot(a.user, root)
                await context("update", "users", a.user)
                await client.query(
                  "UPDATE public.users SET id = id WHERE false"
                )
                expect(
                  await snapshotFacts(client),
                  "the snapshot is taken earlier"
                ).toEqual(["rights", "scopeSets", "scopes", "values"])
                const { rows: start } = await client.query<{ n: string }>(
                  `SELECT count(*) AS n FROM ${SNAPSHOT_TABLES.start.schema}.${SNAPSHOT_TABLES.start.name} WHERE xid = txid_current()`
                )
                expect(start[0]!.n, "the start cache is empty").toBe("0")
                await context("create", ORG, root)
                await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
                body.push(
                  await elapsed(() =>
                    client.query(
                      `SELECT ${grant.schema}.${grant.name}($1::uuid, $2::uuid, '{}'::jsonb)`,
                      [root, randomUUID()]
                    )
                  )
                )
                await client.query("RESET ROLE")
              } finally {
                await client.query("ROLLBACK TO SAVEPOINT breakdown")
              }
            }
            rows.push(
              {
                scenario: `8 tenant creation: membership insert with snapshot fill, ${a.kind}`,
                volume: a.label,
                operator: runsCell(membership),
              },
              {
                scenario: `8 tenant creation: grant function body without snapshot fill, ${a.kind}`,
                volume: a.label,
                operator: runsCell(body),
              }
            )
          }

          // Звичайне призначення найбільшим актором (ціна гілки причини
          // журналу Р-A6-5): запрошений учасник у домашньому тенанті —
          // перший запис команди, він бере знімок; заміряний оператор —
          // вставка призначення, «COMMIT» — окремо. Порівняння «до/після» —
          // той самий замір на `main` до блоку A6, у звіті плану.
          const largest = actors[1]!
          const write: number[] = []
          const writeCommit: number[] = []
          for (let i = 0; i < 2 * RUNS - 1; i++) {
            await client.query("SAVEPOINT assignment")
            try {
              const member = randomUUID()
              const assignment = randomUUID()
              await claims(largest.user)
              await context("create", MEMBER, member)
              await client.query(`SET LOCAL ROLE ${PLATFORM_ROLES.command}`)
              await client.query(
                `INSERT INTO public.${MEMBER} (id, org_id) VALUES ($1, $2)`,
                [member, largest.home]
              )
              await context("administerRights", ASSIGNMENTS, assignment)
              write.push(
                await elapsed(() =>
                  client.query(
                    `INSERT INTO public.${ASSIGNMENTS} (id, org_id, subject, archetype, deletion_mark) VALUES ($1, $2, $3, $4, false)`,
                    [assignment, largest.home, member, TASK_VIEWER_ID]
                  )
                )
              )
              await client.query("RESET ROLE")
              writeCommit.push(
                await elapsed(() =>
                  client.query("SET CONSTRAINTS ALL IMMEDIATE")
                )
              )
              await client.query("SET CONSTRAINTS ALL DEFERRED")
            } finally {
              await client.query("ROLLBACK TO SAVEPOINT assignment")
            }
          }
          rows.push(
            {
              scenario: "8 assignment write, largest actor",
              volume: `1 assignment row, ${largest.label}`,
              operator: runsCell(write),
            },
            {
              scenario: "8 assignment write COMMIT, largest actor",
              volume: `1 assignment row, ${largest.label}`,
              operator: runsCell(writeCommit),
            }
          )
        }
      )
    },
    TIMEOUT
  )
})
