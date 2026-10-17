import { randomUUID } from "node:crypto"
import pg from "pg"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest"
import {
  canonicalSnapshot,
  compile,
  loadSqlParser,
  mechanicsTriggerName,
  type CompiledModel,
  type SchemaPathResolver,
  type SqlParser,
} from "simetra/compiler"
import {
  buildPlan,
  checkPermissions,
  classifySteps,
  compareWithDesired,
  engineScope,
  executePlan,
  requiredPermissions,
  renderDesiredState,
  reverseGenerate,
  type DbConnection,
  type DesiredComparison,
  type EngineDiagnostic,
  type EngineScope,
  type Extracted,
  type SchemaEngine,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  shadowAgeMinutes,
  shadowDatabaseNames,
  testDatabaseUrl,
  testRoleName,
  readReferenceDomain,
  FIXTURES,
} from "../../../../simetra/test/support"
import { dropRoles, inTarget as loadTarget } from "../../__tests__/support/db"
import {
  leftoverShadows,
  provisionedShadows,
} from "../../__tests__/support/shadows"
import {
  CLASS_FIXTURES,
  readOracle,
  type OracleShape,
} from "./fixtures/round-trip-classes"

/**
 * Повний round-trip (спека П2 §9, план E2b, задача 4): ціль — тінь із SQL
 * фікстури → extract → зворотна генерація в порожню теку → компіляція →
 * рендер → звірка з тінню рендера. Порожньої звірки замало (рішення 10):
 * незалежний читач `pg_catalog` мусить бачити властивість класу і в цілі, і
 * в тіні, тож однакова втрата з обох боків extract-у не пройде.
 */

const stack = { url: testDatabaseUrl() }

/**
 * Тіні, які створив двигун цього файлу, — єдине правило «наша» і для
 * відмови, і для прибирання: облік провізій setupFile-у DB-проєкту
 * (`__tests__/support/shadows.ts`). Наша — й тінь, на якій тест упав раніше
 * за своє тіло: `planAndRun` застосовує бажаний SQL, двічі читає каталоги й
 * будує план до виклику `fn`. Тінь паралельної сесії в облік не потрапить:
 * її створив інший процес.
 */
const engine: SchemaEngine = createPgDeltaEngine()
const dbs = {
  reader: createApplyDatabase({ readOnly: true }),
  scratch: createApplyDatabase({ readOnly: false }),
}
const writer = createApplyDatabase({ readOnly: false })

/**
 * Тінь, старша за цей вік, не належить живому прогонові: тінь живе один
 * тест (тайм-аут — 60 с), а повний прогін DB-тестів designer — близько 20
 * хвилин. Така тінь — сирота вбитого прогону, `finally` якого не відбувся.
 */
const STALE_SHADOW_MINUTES = 30

async function dropShadow(name: string): Promise<void> {
  await withClient(stack, (c) =>
    c.query(
      `DROP DATABASE IF EXISTS "${name.replaceAll('"', '""')}" WITH (FORCE)`
    )
  )
}

/**
 * Видаляє кожну тінь зі списку: збій одного `DROP` не зупиняє решту й не
 * губиться — збої повертаються викликачеві.
 */
async function dropEach(names: readonly string[]): Promise<unknown[]> {
  const failures: unknown[] = []
  for (const name of names) {
    try {
      await dropShadow(name)
    } catch (error) {
      failures.push(error)
    }
  }
  return failures
}

/**
 * Відмова guard'а після прибирання: спершу результат перевірки, а збої
 * `DROP` — поруч із ним, а не замість нього.
 */
function failGuard(assertion: Error | undefined, dropFailures: unknown[]) {
  if (dropFailures.length === 0) {
    if (assertion !== undefined) throw assertion
    return
  }
  throw new AggregateError(
    assertion === undefined ? dropFailures : [assertion, ...dropFailures],
    `${dropFailures.length} shadow database(s) of this test file could not be dropped`
  )
}

let parse: SqlParser
beforeAll(async () => {
  parse = await loadSqlParser()
  // Сироти вбитих прогонів лише називаються, а не видаляються: автоматичне
  // прибирання чужих баз — окреме рішення власника
  const stale = (await shadowDatabaseNames()).flatMap((name) => {
    const age = shadowAgeMinutes(name)
    if (age !== undefined && age < STALE_SHADOW_MINUTES) return []
    return [
      `${name} (${age === undefined ? "age unknown" : `${Math.round(age)} min`})`,
    ]
  })
  // Попередження — прямо в stderr: вивід `console` тесту, що пройшов,
  // звіт vitest не показує
  if (stale.length > 0)
    process.stderr.write(
      `Shadow databases older than ${STALE_SHADOW_MINUTES} minutes are left on the stack, likely from a killed run; they are not removed: ${stale.join(", ")}\n`
    )
})

let shadowsBefore: ReadonlySet<string> = new Set()
beforeEach(async () => {
  shadowsBefore = new Set(await shadowDatabaseNames())
})
afterEach(async () => {
  // Наша тінь, що пережила тест, — тест, що вийшов за тайм-аут (vitest
  // запускає afterEach одразу, а тіло ще тримає тінь, і воркер завершиться
  // раніше за `finally` порту), або прибирання pg-delta, яке ковтає збій
  // `DROP DATABASE`. Вона валить тест і прибирається — і тоді, коли тест
  // упав ще до свого тіла. `leftoverShadows` спершу чекає провізій, що ще
  // йдуть: ім'я тіні відоме лише з результату провізії
  const leaked = await leftoverShadows()
  // Нова тінь, якої цей файл не створював, — паралельна сесія: її лише
  // названо, тест вона не валить і не видаляється. Облік читається після
  // знімка стеку: провізія, що завершилась між ними, інакше вийшла б чужою
  const onStack = await shadowDatabaseNames()
  const ours = new Set(provisionedShadows())
  const foreign = onStack.filter(
    (name) => !ours.has(name) && !shadowsBefore.has(name)
  )
  if (foreign.length > 0)
    process.stderr.write(
      `Shadow databases appeared during the test that this test file did not create (another session?); not removed: ${foreign.join(", ")}\n`
    )
  const dropFailures = await dropEach(leaked)
  let assertion: Error | undefined
  try {
    expect(leaked, "shadow databases this test file left behind").toEqual([])
  } catch (error) {
    assertion = error instanceof Error ? error : new Error(String(error))
  }
  failGuard(assertion, dropFailures)
})
afterAll(async () => {
  // Тіло, що вийшло за тайм-аут, іде далі й може почати провізію вже після
  // свого afterEach. Її тінь ловить afterEach наступного тесту, а після
  // останнього — цей хук, дочекавшись провізій, що ще йдуть. Лишається
  // вікно, якого процес не закриє: провізія, яку тіло почне вже після цього
  // хука, перед виходом воркера, і вбитий прогін
  const late = await leftoverShadows()
  if (late.length > 0)
    process.stderr.write(
      `Shadow databases of this test file outlived their tests; dropping: ${late.join(", ")}\n`
    )
  failGuard(undefined, await dropEach(late))
})

const schemaPath: SchemaPathResolver = (_file, schemaFile) =>
  `schemas/${schemaFile}`

const errors = (diagnostics: readonly { severity: string }[]) =>
  diagnostics.filter((d) => d.severity === "error")

async function withClient<T>(
  db: DbConnection,
  fn: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: db.url })
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end()
  }
}

/**
 * Розгортає `sql` у тінь-ціль поруч зі стеком; тінь прибирає порт. Від
 * спільного `inTarget` відрізняється лише тим, що `fn` дістає `DbConnection`
 * для порту двигуна, а не URL.
 */
const inTarget = <T>(
  sql: string,
  scope: EngineScope,
  fn: (target: DbConnection) => Promise<T>
): Promise<T> => loadTarget(sql, scope, (url) => fn({ url }))

interface Project {
  /** Ім'я наявного проєкту; без нього — ім'я нового. */
  name?: string
  defaultSchema: string
  attributeCase: CompiledModel["project"]["naming"]["attributeCase"]
  databaseProvider: CompiledModel["project"]["database"]["provider"]
}

/**
 * Що round-trip свідомо втрачає: тригери механіки таблиць виду, повернутих
 * як `CustomTable`. Межа без них — межа джерела без одиниць механіки.
 */
interface Loss {
  schemas: string[]
  triggers: { schema: string; table: string; name: string }[]
}

const NO_LOSS = (scope: EngineScope): Loss => ({
  schemas: [...scope.schemas],
  triggers: [],
})

const dropTrigger = (t: Loss["triggers"][number]) =>
  `DROP TRIGGER "${t.name}" ON "${t.schema}"."${t.table}"`

interface RoundTrip {
  extracted: Extracted
  model: CompiledModel
  scope: EngineScope
  comparison: Extract<DesiredComparison, { status: "compared" }>
  target: OracleShape
  shadow: OracleShape
}

/**
 * Повторний introspect у ту саму теку не змінює мітки виду: її призначено
 * раз. Мітки свідомо зсунуто від тих, що дало б доповнення, — інакше загублену
 * мітку непомітно відновило б саме доповнення.
 */
async function expectKindLabelsKept(
  extracted: Extracted,
  project: Project,
  files: ReadonlyMap<string, string>
): Promise<void> {
  const labels = (map: ReadonlyMap<string, string>) =>
    new Map(
      [...map].flatMap(([path, text]) => {
        if (!path.endsWith(".meta.json")) return []
        const label = (JSON.parse(text) as { kindLabel?: unknown }).kindLabel
        return typeof label === "string" ? [[path, label] as const] : []
      })
    )
  const existing = new Map(files)
  for (const [path, label] of labels(files)) {
    existing.set(
      path,
      JSON.stringify({
        ...(JSON.parse(files.get(path)!) as object),
        kindLabel: `kept_${label}`,
      })
    )
  }
  const again = await reverseGenerate(extracted.model, {
    project: { name: "RoundTrip", ...project },
    existing,
    newId: () => randomUUID(),
    schemaPath,
    parse,
  })
  expect(errors(again.diagnostics)).toEqual([])
  expect(labels(again.files)).toEqual(labels(existing))
}

/**
 * Ланцюжок §9 над уже розгорнутою ціллю. Кожна ланка — без помилок, звірка —
 * порожня, а оракул читає ціль і окрему тінь того самого рендера.
 */
async function roundTripOf(
  target: DbConnection,
  extractScope: EngineScope,
  project: Project,
  existing: ReadonlyMap<string, string> = new Map(),
  loss: Loss = NO_LOSS(extractScope)
): Promise<RoundTrip> {
  const extracted = await engine.extract(target, extractScope)
  expect(errors(extracted.diagnostics)).toEqual([])

  const reversed = await reverseGenerate(extracted.model, {
    project: { name: "RoundTrip", ...project },
    existing,
    newId: () => randomUUID(),
    schemaPath,
    parse,
  })
  expect(errors(reversed.diagnostics)).toEqual([])
  await expectKindLabelsKept(extracted, project, reversed.files)

  const compiled = await compile(reversed.files)
  expect(errors(compiled.diagnostics)).toEqual([])
  const model = compiled.model!
  const sql = renderDesiredState(model).sql
  const { scope, diagnostics } = await engineScope(model)
  // Межа з метаданих — та сама, що й межа читання (без схем, які давала лише
  // втрачена механіка): інакше звірка дивилася б не на ті схеми
  expect([...scope.schemas].sort()).toEqual([...loss.schemas].sort())

  const comparison = await compareWithDesired(
    engine,
    { target: target },
    sql,
    scope,
    diagnostics
  )
  expect(
    comparison.status === "compared" ? [] : comparison.diagnostics
  ).toEqual([])
  if (comparison.status !== "compared") throw new Error("shadow failed")
  // Спершу — що саме не порожнє, а не голе `false`. Різниця — рівно втрачена
  // механіка, нічого понад неї
  expect({
    actions: comparison.plan.actions.map((a) => a.sql).sort(),
    differences: [...comparison.differences].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    ),
    errors: errors(comparison.diagnostics),
  }).toEqual({
    actions: loss.triggers.map(dropTrigger).sort(),
    differences: loss.triggers
      .map((t) => ({
        detail: "absent in second model",
        kind: "missing",
        path: `units.trigger:${t.schema}.${t.table}.${t.name}`,
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    errors: [],
  })
  expect(comparison.empty).toBe(loss.triggers.length === 0)

  const schemas = [...scope.schemas]
  const oracle = await engine.withDesiredShadow(
    { target: target },
    sql,
    scope,
    async (shadow) => ({
      target: await withClient(target, (c) => readOracle(c, schemas)),
      shadow: await withClient(shadow, (c) => readOracle(c, schemas)),
    })
  )
  if (oracle.status !== "loaded") throw new Error("oracle shadow failed")
  return { extracted, model, scope, comparison, ...oracle.value }
}

const scopeOf = (schemas: string[]): EngineScope => ({
  schemas,
  provider: "supabase",
})

describe("class fixtures survive the round trip", () => {
  for (const fixture of CLASS_FIXTURES) {
    it(fixture.name, async () => {
      const scope = scopeOf(fixture.schemas)
      await inTarget(fixture.sql, scope, async (target) => {
        // Схема за замовчуванням — завжди в межі (§6.9), тож це перша
        // керована схема фікстури, а не вшита `app`
        const result = await roundTripOf(target, scope, {
          defaultSchema: fixture.schemas[0]!,
          attributeCase: "snake_case",
          databaseProvider: "supabase",
        })
        // Властивість класу є в цілі (фікстура її створила) і в тіні
        expect(fixture.property(result.target)).toEqual(fixture.expected)
        expect(fixture.property(result.shadow)).toEqual(fixture.expected)
        expect(result.shadow).toEqual(result.target)
      })
    })
  }
})

describe("the builtin PUBLIC privilege beside a schema ADP", () => {
  const roundTripOptions = {
    defaultSchema: "app",
    attributeCase: "snake_case" as const,
    databaseProvider: "supabase" as const,
  }
  const publicAcl = (object: string) => (shape: OracleShape) =>
    shape.acls
      .find((a) => a.object === object)
      ?.acl.filter((item) => item.startsWith("="))

  // Маркер двигуна для рядка ADP схеми не означає відкликання: вбудований
  // `EXECUTE`/`USAGE` для `PUBLIC` не має ставати ні `GRANT`, ні `REVOKE`,
  // ні одиницею ADP
  it("builtin PUBLIC execute beside a schema ADP writes no PUBLIC unit", async () => {
    const scope = scopeOf(["app"])
    await inTarget(
      `CREATE SCHEMA app;
       ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO anon;
       CREATE FUNCTION app.open() RETURNS int LANGUAGE sql AS $$ select 1 $$;`,
      scope,
      async (target) => {
        const result = await roundTripOf(target, scope, roundTripOptions)
        expect(
          result.extracted.model.units.filter((u) => /\bPUBLIC\b/i.test(u.sql))
        ).toEqual([])
        const acl = publicAcl("f:app.open()")
        expect(acl(result.target)).toEqual(["=X/postgres"])
        expect(acl(result.shadow)).toEqual(["=X/postgres"])
      }
    )
  })

  it("builtin PUBLIC usage on a type beside a schema ADP writes no PUBLIC unit", async () => {
    const scope = scopeOf(["app"])
    await inTarget(
      `CREATE SCHEMA app;
       ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE ON TYPES TO anon;
       CREATE TYPE app.mood AS ENUM ('ok', 'bad');`,
      scope,
      async (target) => {
        const result = await roundTripOf(target, scope, roundTripOptions)
        expect(
          result.extracted.model.units.filter((u) => /\bPUBLIC\b/i.test(u.sql))
        ).toEqual([])
        const acl = publicAcl("T:app.mood")
        expect(acl(result.target)).toEqual(["=U/postgres"])
        expect(acl(result.shadow)).toEqual(["=U/postgres"])
      }
    )
  })

  it("a schema ADP that grants to PUBLIC is kept as a unit", async () => {
    const scope = scopeOf(["app"])
    await inTarget(
      `CREATE SCHEMA app;
       CREATE TABLE app.note (id uuid PRIMARY KEY);
       ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT ON TABLES TO PUBLIC;`,
      scope,
      async (target) => {
        const result = await roundTripOf(target, scope, roundTripOptions)
        expect(
          result.extracted.model.units
            .filter((u) => u.class === "defaultPrivileges")
            .map((u) => u.sql)
        ).toEqual([expect.stringMatching(/GRANT SELECT ON TABLES TO PUBLIC/i)])
        expect(result.shadow.defaultAcls).toEqual(result.target.defaultAcls)
        expect(result.target.defaultAcls).not.toEqual([])
      }
    )
  })
})

describe("a role of the application's own", () => {
  it("is assumed, and a grant to it survives the round trip", async () => {
    // Роль — інфраструктура кластера (спека §6.9): межа керує грантами на неї,
    // а не нею самою. Роль кластерна, тож видна й тіні поруч із ціллю;
    // прибирається в `finally`
    const role = testRoleName("round_trip_reader")
    const admin = { url: testDatabaseUrl() }
    await withClient(admin, async (c) => {
      await c.query(`CREATE ROLE ${role} NOLOGIN`)
    })
    try {
      const scope = scopeOf(["app"])
      await inTarget(
        `CREATE SCHEMA app;
         CREATE TABLE app.report (id uuid PRIMARY KEY, body text);
         GRANT SELECT ON app.report TO ${role};`,
        scope,
        async (target) => {
          const result = await roundTripOf(target, scope, {
            defaultSchema: "app",
            attributeCase: "snake_case",
            databaseProvider: "supabase",
          })
          expect(
            result.extracted.model.units
              .filter((u) => u.class === "grant")
              .map((u) => u.sql)
          ).toEqual([expect.stringContaining(role)])
          const granted = (shape: OracleShape) =>
            shape.acls
              .find((a) => a.object === "r:app.report")
              ?.acl.filter((item) => item.startsWith(`${role}=`))
          expect(granted(result.target)).toEqual([`${role}=r/postgres`])
          expect(granted(result.shadow)).toEqual([`${role}=r/postgres`])
        }
      )
    } finally {
      await dropRoles(role)
    }
  })
})

/** Ключ таблиці моделі: схема й фізичне ім'я. */
const tableKeys = (model: CompiledModel) =>
  model.physical.tables.map((t) => `${t.schema}.${t.name}`).sort()

/**
 * Механіка джерела, якої не буде після прийому з нуля: таблиця виду стає
 * `CustomTable` без стандартних колонок, а introspect механіки не пише
 * (рішення 9 плану П3-3a2). Повертає механіку лише промоція у вид.
 */
async function mechanicsLoss(source: CompiledModel): Promise<Loss> {
  const identities = new Set(
    source.sqlUnits
      .filter((u) => u.generator === "mechanics" && u.class === "trigger")
      .map((u) => u.identity)
  )
  const triggers = source.physical.tables
    .map((t) => ({
      schema: t.schema,
      table: t.name,
      name: mechanicsTriggerName(t.name),
    }))
    .filter((t) => identities.has(`trigger:${t.schema}.${t.table}.${t.name}`))
  expect(triggers).toHaveLength(identities.size)
  const { scope } = await engineScope({
    ...source,
    sqlUnits: source.sqlUnits.filter((u) => u.generator !== "mechanics"),
  })
  return { schemas: [...scope.schemas], triggers }
}

/**
 * Втрата механіки гучна: кроки, що знімають тригери механіки, — клас
 * `relaxation`, якому потрібен явний дозвіл, і без дозволу застосування
 * відмовляє. Класи й дозволи — ті самі чисті функції, що в `buildPlan` і
 * першій перевірці `executePlan`: тут вони звіряють клас кожного кроку
 * точно, а наскрізний прогін нижче лише підтверджує, що повний конвеєр
 * просить дозволу рівно на ці кроки. Повертає ідентифікатори кроків утрати.
 */
function expectLossNeedsPermission(trip: RoundTrip, loss: Loss): string[] {
  const steps = classifySteps(
    trip.comparison.plan.actions,
    trip.comparison.target.model,
    parse
  )
  const byText = <T extends { sql: string }>(list: T[]) =>
    [...list].sort((a, b) => (a.sql < b.sql ? -1 : a.sql > b.sql ? 1 : 0))
  expect(byText(steps.map((s) => ({ sql: s.sql, class: s.class })))).toEqual(
    byText(
      loss.triggers.map((t) => ({ sql: dropTrigger(t), class: "relaxation" }))
    )
  )
  const subject = { steps, drift: null, promotion: null }
  const ids = steps.map((s) => s.id)
  expect(requiredPermissions(subject)).toEqual(ids)
  expect(checkPermissions(subject, [])).toEqual([
    expect.objectContaining({
      code: "apply.permission-required",
      severity: "error",
      params: { items: ids.join(", ") },
    }),
  ])
  expect(checkPermissions(subject, ids)).toEqual([])
  return ids
}

/** Тригери оракула без втраченої механіки. */
const withoutLost = (shape: OracleShape, loss: Loss): OracleShape => {
  const lost = new Set(
    loss.triggers.map((t) => `${t.schema}.${t.table} ${t.name}`)
  )
  return {
    ...shape,
    triggers: shape.triggers.filter((t) => !lost.has(`${t.table} ${t.name}`)),
  }
}

/**
 * Повний конвеєр над ціллю: план повернутої моделі проходить доказ на копії,
 * а застосування без дозволів або нічого не має робити (без утрати), або
 * відмовляє рівно на кроках утрати. Так round-trip доводить не лише порожню
 * звірку, а й те, що інструмент `apply` прийме повернуту теку як є.
 */
async function expectPlanAndApply(
  target: DbConnection,
  model: CompiledModel,
  lossSteps: readonly string[]
): Promise<void> {
  const outcome = await buildPlan(engine, dbs, model, { target }, [])
  expect({
    status: outcome.status,
    errors: errors(outcome.diagnostics),
  }).toEqual({ status: "planned", errors: [] })
  if (outcome.status !== "planned") throw new Error("plan refused")
  const artifact = outcome.artifact
  expect(artifact.requiredPermissions).toEqual(lossSteps)

  const applied = await executePlan(writer, target, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow: [],
    snapshot: canonicalSnapshot(model),
  })
  if (lossSteps.length === 0) {
    expect({
      status: applied.status,
      errors: errors(applied.diagnostics),
    }).toEqual({ status: "committed", errors: [] })
    return
  }
  expect(applied.status).toBe("refused")
  expect(applied.diagnostics).toEqual([
    expect.objectContaining({
      code: "apply.permission-required",
      severity: "error",
      params: { items: lossSteps.join(", ") },
    }),
  ])
}

/**
 * Розгортає скомпільовану теку в ціль і веде її ланцюжком §9. Без збереженої
 * теки (`existing` порожній) механіка видів — відома втрата, і вона гучна.
 * `endToEnd` веде повернуту модель ще й повним конвеєром плану й застосування.
 */
async function deployedRoundTrip(
  files: Map<string, string>,
  existing: ReadonlyMap<string, string>,
  endToEnd: boolean
): Promise<{ source: CompiledModel; result: RoundTrip }> {
  const original = await compile(files)
  expect(errors(original.diagnostics)).toEqual([])
  const source = original.model!
  const { scope } = await engineScope(source)
  const loss =
    existing.size === 0 ? await mechanicsLoss(source) : NO_LOSS(scope)
  const result = await inTarget(
    renderDesiredState(source).sql,
    scope,
    async (target) => {
      const trip = await roundTripOf(
        target,
        scope,
        {
          name: source.project.name,
          defaultSchema: source.project.defaultSchema,
          attributeCase: source.project.naming.attributeCase,
          databaseProvider: source.project.database.provider,
        },
        existing,
        loss
      )
      const lossSteps =
        loss.triggers.length > 0 ? expectLossNeedsPermission(trip, loss) : []
      if (endToEnd) await expectPlanAndApply(target, trip.model, lossSteps)
      return trip
    }
  )
  expect(result.shadow).toEqual(withoutLost(result.target, loss))
  return { source, result }
}

const kindsOf = (model: CompiledModel) =>
  [...new Set(model.objects.map((o) => o.kind))].sort()

describe("adoption from scratch: the E1 corpus survives the round trip", () => {
  for (const [name, fixture] of FIXTURES) {
    it(name, async () => {
      const { source, result } = await deployedRoundTrip(
        fixture(),
        new Map(),
        true
      )
      // Види 1С повертаються як `CustomTable` з тими самими фізичними іменами
      expect(tableKeys(result.model)).toEqual(tableKeys(source))
      expect(
        kindsOf(result.model).filter(
          (kind) => kind !== "CustomTable" && kind !== "PgEnum"
        )
      ).toEqual([])
    })
  }
})

// Референсний домен має довідник «Користувачі», тож база несе платформний
// шар у схемі `simetra`. Прийом такої бази з нуля не визначений (спека
// користувачів §12): свіжий introspect розклав би `simetra` у метадані
// застосунку, а схема зарезервована. Тому домен проходить round-trip поверх
// власної теки: шар і види 1С описані в ній, генератор їх не дублює.
describe("over existing metadata: the reference domain survives the round trip", () => {
  it("reference domain", async () => {
    const files = readReferenceDomain()
    const { source, result } = await deployedRoundTrip(files, files, false)
    // Види 1С і платформний шар лишаються описаними власною текою
    expect(tableKeys(result.model)).toEqual(tableKeys(source))
    expect(kindsOf(result.model)).toEqual(kindsOf(source))
    expect(result.model.sqlUnits.map((u) => u.identity).sort()).toEqual(
      source.sqlUnits.map((u) => u.identity).sort()
    )
  })
})

/** Діагностики extract-у цілі з `sql`. */
async function extractDiagnostics(
  sql: string,
  schemas: string[]
): Promise<EngineDiagnostic[]> {
  const scope = scopeOf(schemas)
  return inTarget(
    sql,
    scope,
    async (target) => (await engine.extract(target, scope)).diagnostics
  )
}

describe("what the round trip cannot carry is loud", () => {
  it("an exclusion constraint is unrepresentable by name", async () => {
    const diagnostics = await extractDiagnostics(
      `CREATE SCHEMA app;
       CREATE TABLE app.booking (
         id uuid PRIMARY KEY,
         during tstzrange NOT NULL,
         CONSTRAINT booking_no_overlap EXCLUDE USING gist (during WITH &&)
       );`,
      ["app"]
    )
    // Модель каталогу не має поля для EXCLUDE, тож до генератора воно не
    // доходить: гучно його називає вже extract, і `introspect` не пише нічого
    const messages = diagnostics
      .filter((d) => d.code === "engine.unrepresentable")
      .map((d) => d.message)
    expect(messages).toEqual([
      expect.stringMatching(/booking_no_overlap.*exclusion/),
    ])
    expect(messages[0]).toContain("app.booking")
  })

  it("an owner other than the session role is unrepresentable by name", async () => {
    // Таблицю ролі провайдера (`authenticated`) політика двигуна виключає, і
    // її ловить перепис; власника поза ролями провайдера двигун читає ребром
    // `owner`, якого модель не має. Роль кластерна — прибирається в `finally`
    const role = testRoleName("round_trip_owner")
    const admin = { url: testDatabaseUrl() }
    await withClient(admin, async (c) => {
      await c.query(`CREATE ROLE ${role} NOLOGIN`)
      await c.query(`GRANT ${role} TO current_user`)
    })
    try {
      const diagnostics = await extractDiagnostics(
        `CREATE SCHEMA app;
         CREATE TABLE app.ledger (id uuid PRIMARY KEY);
         GRANT CREATE ON SCHEMA app TO ${role};
         ALTER TABLE app.ledger OWNER TO ${role};`,
        ["app"]
      )
      // Сама роль — припущена інфраструктура кластера, не помилка: гучна
      // лише таблиця з чужим власником
      expect(
        diagnostics
          .filter((d) => d.code === "engine.unrepresentable")
          .map((d) => d.message)
      ).toEqual([
        `table:app.ledger: property owner cannot be represented in the catalog model: owner role:${role} is not the default owner`,
      ])
    } finally {
      await dropRoles(role)
    }
  })

  it("a cast is an unmodeled class", async () => {
    const diagnostics = await extractDiagnostics(
      `CREATE SCHEMA app;
       CREATE TYPE app.pair AS (a int, b int);
       CREATE CAST (app.pair AS text) WITH INOUT;`,
      ["app"]
    )
    expect(
      diagnostics
        .filter((d) => d.code === "engine.unmodeled-class")
        .map((d) => d.message)
    ).toEqual([expect.stringMatching(/^1 object\(s\) of class cast /)])
  })
})

describe("function volatility is read under the extraction search_path", () => {
  // Ідентичність двигуна кваліфікує типи аргументів, бо витяг іде під
  // `search_path = pg_catalog`; факт волатильності під типовим шляхом сесії
  // дав би некваліфікований тип зі схеми на шляху, і функція мовчки лишилася б
  // без явної VOLATILE — тобто боргом закритої оболонки
  it.each([
    [
      "public",
      `CREATE TYPE public.mood AS ENUM ('ok', 'bad');
       CREATE FUNCTION app.rate(a public.mood) RETURNS integer
         LANGUAGE sql VOLATILE AS $$ SELECT 1 $$;`,
    ],
    [
      "extensions",
      // Рядковий тип представлення розширення стеку: без DDL у `extensions`
      `CREATE FUNCTION app.rate(a extensions.pg_stat_statements_info)
         RETURNS integer LANGUAGE sql VOLATILE AS $$ SELECT 1 $$;`,
    ],
  ])(
    "a VOLATILE function over a type in %s gets explicit VOLATILE and is not debt",
    async (_schema, sql) => {
      const scope = scopeOf(["app", "public"])
      await inTarget(`CREATE SCHEMA app;\n${sql}`, scope, async (target) => {
        const extracted = await engine.extract(target, scope)
        expect(errors(extracted.diagnostics)).toEqual([])
        const unit = extracted.model.units.find(
          (u) => u.class === "function" && u.name === "rate"
        )
        expect(unit?.volatility).toBe("volatile")
        const reversed = await reverseGenerate(extracted.model, {
          project: {
            name: "RoundTrip",
            defaultSchema: "app",
            attributeCase: "snake_case",
            databaseProvider: "supabase",
          },
          existing: new Map(),
          newId: () => randomUUID(),
          schemaPath,
          parse,
        })
        expect(errors(reversed.diagnostics)).toEqual([])
        const text = [...reversed.files].find(([path]) =>
          path.includes("/rate")
        )?.[1]
        expect(text).toMatch(/\bVOLATILE\b/)
        const debt = JSON.parse(
          reversed.files.get("sql-debt.json") ?? "{}"
        ) as { units?: string[] }
        expect(debt.units ?? []).not.toContain(unit!.identity)
      })
    }
  )
})
