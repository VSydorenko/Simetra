import { randomBytes, randomUUID } from "node:crypto"
import { afterAll, describe, expect, it } from "vitest"
import pg from "pg"
import { buildRuntimeCatalog, compile } from "simetra/compiler"
import {
  PLATFORM_ROLES,
  RIGHTS_MAINTENANCE_SETTING,
  TABULAR_LINES_MAX,
  catalogIndex,
  jsonBytes,
  operationToWire,
  readResultToWire,
  type Operation,
  type SessionClaims,
} from "simetra/model"
import { desiredForApply } from "simetra/schema"
import { createCommandRuntime, fromPgPool, readRoleOf } from "simetra/server"
import {
  GAUGE_FILE,
  GAUGE_WRITER_ID,
  policyDomain,
  runtimeValuesLayer,
} from "../src/compiler/__tests__/fixtures/rights"
import { uuid } from "../src/compiler/__tests__/helpers"
import {
  testDatabaseName,
  testDatabaseUrl,
  testRoleName,
  testSuperuserUrl,
  setLocalSetting,
  loginUrl,
} from "../test/db/connection"

/**
 * Бенчмарк ТЧ (план P4-B1d, задача 7): чи лишається `TABULAR_LINES_MAX`
 * = 5 000. Міряється те, що межа реально важить, — повний запис ТЧ з 8
 * реквізитів через `runtime.run` (транзакція з `COMMIT`, відкладені
 * запобіжники), розмір операції у формі передачі (тіло запиту, межа 4 МіБ) і
 * розмір відповіді картки з ТЧ (бюджет відповіді, 4 МіБ). Поза `test:db` і
 * CI: це заміри однієї машини, а не поріг перевірки.
 *
 * Рантайм працює через пул, тобто кожна команда — окрема закомічена
 * транзакція, тож відкат сценарію, як у `rights.bench`, тут неможливий: база
 * прогону своя, тегована, і зникає в `afterAll` на будь-якому шляху.
 */

const SIZES = [1, 1_000, 2_500, 5_000]
/** Повтори після прогріву: медіана й p90 відсіюють випадкові піки стеку. */
const RUNS = 10
const MIB = 1024 * 1024
/** Правило рішення (план, крок 3): запас до межі тіла й бюджету відповіді 4 МіБ. */
const RUN_MAX_MS = 2_000
const BYTES_MAX = 3 * MIB

const GAUGE = { kind: "Catalog", name: "Gauge" } as const
const REQUEST_ROLE = readRoleOf("supabase")!

/** ТЧ з 8 реквізитів різних типів, як у типовому документі: заміна `lines` фікстури. */
const lines = {
  id: uuid(7511),
  name: "lines",
  physicalName: "gauge_lines",
  attributes: [
    {
      id: uuid(7601),
      name: "title",
      physicalName: "title",
      type: "String",
      length: 50,
    },
    {
      id: uuid(7602),
      name: "amount",
      physicalName: "amount",
      type: "Numeric",
      precision: 15,
      scale: 2,
    },
    {
      id: uuid(7603),
      name: "quantity",
      physicalName: "quantity",
      type: "Integer",
    },
    { id: uuid(7604), name: "due", physicalName: "due", type: "Date" },
    { id: uuid(7605), name: "flag", physicalName: "flag", type: "Boolean" },
    {
      id: uuid(7606),
      name: "project",
      physicalName: "project_id",
      type: "Ref",
      ref: { kind: "Catalog", name: "Project" },
    },
    {
      id: uuid(7607),
      name: "noteA",
      physicalName: "note_a",
      type: "String",
      length: 100,
    },
    {
      id: uuid(7608),
      name: "noteB",
      physicalName: "note_b",
      type: "String",
      length: 100,
    },
  ],
}

const ms = (value: number) => `${value.toFixed(1)} ms`
const sorted = (values: number[]) => [...values].sort((a, b) => a - b)
const median = (values: number[]) =>
  sorted(values)[Math.floor(values.length / 2)]!
/** p90 за методом найближчого рангу: на 10 прогонах — дев'ятий за величиною. */
const p90 = (values: number[]) =>
  sorted(values)[Math.ceil(0.9 * values.length) - 1]!

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`

interface Result {
  rows: number
  insertMs: number
  runMedian: number
  runP90: number
  runs: number[]
  operationBytes: number
  cardBytes: number
  cardReadMedian: number
}
const results: Result[] = []

describe("tabular section limit", () => {
  const admin = new pg.Client({ connectionString: testSuperuserUrl() })
  const database = testDatabaseName("tabular_bench")
  const login = testRoleName(`tabular_${randomBytes(4).toString("hex")}`)
  const password = randomBytes(12).toString("hex")
  const created = { database: false, role: false }
  let owner: pg.Client | undefined
  let pool: pg.Pool | undefined

  const urlOf = () => {
    const url = new URL(testDatabaseUrl())
    url.pathname = `/${database}`
    return url.toString()
  }

  afterAll(async () => {
    // Прибирання на всіх шляхах, зокрема після збою посеред підготовки:
    // видаляється лише те, що цей прогін створив
    await pool?.end().catch(() => undefined)
    await owner?.end().catch(() => undefined)
    try {
      if (created.database)
        await admin.query(
          `drop database if exists ${quoted(database)} with (force)`
        )
      if (created.role)
        await admin.query(`drop role if exists ${quoted(login)}`)
    } finally {
      await admin.end()
    }
  })

  it("measures run, operation and card at the limit", async () => {
    const compiled = await compile(
      policyDomain(
        (() => {
          const layer = runtimeValuesLayer()
          const gauge = layer[GAUGE_FILE] as Record<string, unknown>
          return {
            ...layer,
            [GAUGE_FILE]: { ...gauge, tabularSections: [lines] },
          }
        })()
      )
    )
    expect(compiled.diagnostics).toEqual([])
    const model = compiled.model!
    const catalog = buildRuntimeCatalog(model)
    const index = catalogIndex(catalog.objects)
    const desired = await desiredForApply(model)

    await admin.connect()
    await admin.query(`create database ${quoted(database)} owner postgres`)
    created.database = true
    // Нова база не має схеми автентифікації провайдера, а модель на неї
    // посилається: мінімальна підміна лише з тим, що читає модель
    const base = new pg.Client({
      connectionString: testSuperuserUrl().replace(/\/[^/]*$/, `/${database}`),
    })
    await base.connect()
    try {
      await base.query(`
          CREATE SCHEMA auth AUTHORIZATION postgres;
          CREATE TABLE auth.users (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            email text,
            phone text,
            raw_user_meta_data jsonb,
            deleted_at timestamptz,
            is_anonymous boolean NOT NULL DEFAULT false
          );
          ALTER TABLE auth.users OWNER TO postgres;
        `)
    } finally {
      await base.end()
    }
    owner = new pg.Client({ connectionString: urlOf() })
    await owner.connect()
    await owner.query(desired.sql)

    // Закомічений засів власником під режимом обслуговування прав
    const org = randomUUID()
    const member = randomUUID()
    const project = randomUUID()
    const user = randomUUID()
    await owner.query("BEGIN")
    await setLocalSetting(owner, RIGHTS_MAINTENANCE_SETTING, "on")
    await owner.query("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [
      user,
      `${user}@example.test`,
    ])
    await owner.query("INSERT INTO public.organization (id) VALUES ($1)", [org])
    await owner.query(
      "INSERT INTO public.org_member (id, org_id, user_id) VALUES ($1, $2, $3)",
      [member, org, user]
    )
    await owner.query(
      "INSERT INTO public.org_role_assignments (id, org_id, subject, archetype) VALUES ($1, $2, $3, $4)",
      [randomUUID(), org, member, GAUGE_WRITER_ID]
    )
    await owner.query(
      "INSERT INTO public.project (id, org_id) VALUES ($1, $2)",
      [project, org]
    )
    await owner.query("SET CONSTRAINTS ALL IMMEDIATE")
    await setLocalSetting(owner, RIGHTS_MAINTENANCE_SETTING, "off")
    await owner.query("COMMIT")
    await owner.query(
      `INSERT INTO simetra.marker (format, snapshot_hash, snapshot, scope, catalog, engine_name, engine_version, fingerprint, fingerprint_version, platform_version, plan_hash)
         VALUES (1, $1, '{}', '{}', '{}', 'engine', '1', '{}', 1, '0', 'plan')
         ON CONFLICT (singleton) DO UPDATE SET snapshot_hash = EXCLUDED.snapshot_hash`,
      [model.hash]
    )

    // Роль входу рантайму: лише членства, як `simetra_runtime`
    await admin.query(
      `create role ${quoted(login)} login noinherit password '${password}'`
    )
    created.role = true
    for (const role of [PLATFORM_ROLES.command, REQUEST_ROLE])
      await admin.query(
        `grant ${quoted(role)} to ${quoted(login)} with inherit false, set true`
      )
    pool = new pg.Pool({
      connectionString: loginUrl(urlOf(), login, password),
      max: 2,
    })
    const runtime = await createCommandRuntime({
      database: fromPgPool(pool),
      catalog,
    })
    const session: SessionClaims = { sub: user, role: REQUEST_ROLE }

    expect(SIZES.at(-1)).toBeLessThanOrEqual(TABULAR_LINES_MAX)

    for (const size of SIZES) {
      const refs = Array.from({ length: size }, () => randomUUID())
      // Кожен прогін змінює всі поля всіх рядків: ТЧ записується цілком
      const body = (round: number) =>
        refs.map((ref, i) => ({
          ref,
          title: `line ${i} round ${round} ${"t".repeat(30)}`,
          amount: `${(i * 7 + round).toString()}.25`,
          quantity: i + round,
          due: "2026-11-09",
          flag: (i + round) % 2 === 0,
          project,
          noteA: `note a ${i} ${"a".repeat(80)}`,
          noteB: `note b ${round} ${"b".repeat(80)}`,
        }))
      const id = randomUUID()
      const first = await runtime.run(session, {
        action: "create",
        object: GAUGE,
        id,
        values: { org },
      })
      let version = first.rows[0]!.version as number
      const update = (round: number): Operation => ({
        action: "update",
        object: GAUGE,
        id,
        expectedVersion: version,
        values: { reading: round },
        tabularSections: { lines: body(round) },
      })
      const timed = async (round: number): Promise<number> => {
        const operation = update(round)
        const started = performance.now()
        const result = await runtime.run(session, operation, {
          fullTabularArrays: true,
        })
        const elapsed = performance.now() - started
        version = result.rows[0]!.version as number
        return elapsed
      }
      // Прогрів — перший запис: вставка рядків; решта — зміна всіх рядків
      const insertMs = await timed(0)
      const times: number[] = []
      for (let round = 1; round <= RUNS; round++) times.push(await timed(round))

      const wire = operationToWire(index, update(RUNS + 1))
      if (!wire.ok)
        throw new Error(`operation not mapped: ${JSON.stringify(wire)}`)
      const operationBytes = jsonBytes({ operation: wire.value })

      const query = { object: GAUGE, id, tabularSections: true } as const
      const reads: number[] = []
      let cardBytes = 0
      for (let n = 0; n < 1 + RUNS; n++) {
        const started = performance.now()
        const card = await runtime.read(session, query)
        const elapsed = performance.now() - started
        if (n === 0) {
          cardBytes = jsonBytes({
            ok: true,
            value: readResultToWire(index, query, card),
            serverHash: model.hash,
          })
        } else reads.push(elapsed)
      }
      results.push({
        rows: size,
        insertMs,
        runMedian: median(times),
        runP90: p90(times),
        runs: times,
        operationBytes,
        cardBytes,
        cardReadMedian: median(reads),
      })
    }

    const report = results
      .map(
        (r) =>
          `rows=${r.rows} insert=${ms(r.insertMs)} run median=${ms(r.runMedian)} p90=${ms(r.runP90)} ` +
          `operation=${r.operationBytes} B (${(r.operationBytes / MIB).toFixed(3)} MiB) ` +
          `card=${r.cardBytes} B (${(r.cardBytes / MIB).toFixed(3)} MiB) cardRead median=${ms(r.cardReadMedian)} ` +
          `runs=[${r.runs.map((t) => t.toFixed(0)).join(", ")}]`
      )
      .join("\n")
    process.stderr.write(`\ntabular bench\n${report}\n`)
    const top = results.at(-1)!
    process.stderr.write(
      `rule at ${top.rows}: run median ${ms(top.runMedian)} ${top.runMedian <= RUN_MAX_MS ? "<=" : ">"} ${RUN_MAX_MS} ms; ` +
        `operation ${top.operationBytes <= BYTES_MAX ? "<=" : ">"} 3 MiB; card ${top.cardBytes <= BYTES_MAX ? "<=" : ">"} 3 MiB\n`
    )
  })
})
