import { randomUUID } from "node:crypto"
import pg from "pg"
import { afterAll, afterEach, beforeAll, beforeEach, expect } from "vitest"
import {
  canonicalSnapshot,
  compile,
  loadSqlParser,
  platformTriggers,
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
  testProvider,
} from "../../../../simetra/test/support"
import { inTarget as loadTarget } from "../../__tests__/support/db"
import {
  leftoverShadows,
  provisionedShadows,
} from "../../__tests__/support/shadows"
import {
  classFixtures,
  readOracle,
  type ClassFixture,
  type OracleShape,
} from "./fixtures/round-trip-classes"

/**
 * Спільна підготовка тестів повного round-trip (спека П2 §9): ціль — тінь із SQL
 * фікстури → extract → зворотна генерація в порожню теку → компіляція →
 * рендер → звірка з тінню рендера. Порожньої звірки замало:
 * незалежний читач `pg_catalog` мусить бачити властивість класу і в цілі, і
 * в тіні, тож однакова втрата з обох боків extract-у не пройде.
 */

export const stack = { url: testDatabaseUrl() }

/**
 * Тіні, які створив двигун цього файлу, — єдине правило «наша» і для
 * відмови, і для прибирання: облік провізій setupFile-у DB-проєкту
 * (`__tests__/support/shadows.ts`). Наша — й тінь, на якій тест упав раніше
 * за своє тіло: `planAndRun` застосовує бажаний SQL, двічі читає каталоги й
 * будує план до виклику `fn`. Тінь паралельної сесії в облік не потрапить:
 * її створив інший процес.
 */
export const engine: SchemaEngine = createPgDeltaEngine()
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

export const parser = (): SqlParser => parse

/**
 * Хуки файла: сироти вбитих прогонів, облік тіней двигуна і прибирання. Кожен
 * файл round-trip кличе це на верхньому рівні, бо хуки в модулі підтримки без
 * виклику не реєструвалися б у файлі.
 */
export function useRoundTrip(): void {
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
}

export const schemaPath: SchemaPathResolver = (_file, schemaFile) =>
  `schemas/${schemaFile}`

export const errors = (diagnostics: readonly { severity: string }[]) =>
  diagnostics.filter((d) => d.severity === "error")

export async function withClient<T>(
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
export const inTarget = <T>(
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
 * як `CustomTable`, і функції таблиці, які кличуть лише вони (ієрархія,
 * спека П4 §6.6), разом із їхніми грантами. Межа без них — межа джерела без одиниць
 * механіки. `identities` — втрачені одиниці, які звірка бачить відсутніми.
 */
interface Loss {
  schemas: string[]
  triggers: { schema: string; table: string; name: string }[]
  functions: { schema: string; name: string }[]
  identities: string[]
}

const NO_LOSS = (scope: EngineScope): Loss => ({
  schemas: [...new Set([...scope.schemas, "simetra"])],
  triggers: [],
  functions: [],
  identities: [],
})

/**
 * Послідовність версій компілятор видає завжди, тож межа з метаданих завжди
 * містить `simetra`, а застосована база її має. Фікстури класів — сирий SQL
 * без платформного шару, тому ціль доповнюється так, як її доповнило б
 * перше застосування: інакше звірка бачила б послідовність як різницю, а не
 * як втрачену чи збережену одиницю.
 */
const withPlatformSequence = (target: DbConnection) =>
  withClient(target, async (c) => {
    await c.query("CREATE SCHEMA IF NOT EXISTS simetra")
    await c.query(
      "CREATE SEQUENCE IF NOT EXISTS simetra.row_version AS bigint MINVALUE 1 NO CYCLE CACHE 1"
    )
  })

const dropTrigger = (t: Loss["triggers"][number]) =>
  `DROP TRIGGER "${t.name}" ON "${t.schema}"."${t.table}"`

const dropFunction = (f: Loss["functions"][number]) =>
  `DROP FUNCTION "${f.schema}"."${f.name}"()`

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
export async function roundTripOf(
  target: DbConnection,
  extractScope: EngineScope,
  project: Project,
  existing: ReadonlyMap<string, string> = new Map(),
  loss: Loss = NO_LOSS(extractScope)
): Promise<RoundTrip> {
  await withPlatformSequence(target)
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
    actions: [
      ...loss.triggers.map(dropTrigger),
      ...loss.functions.map(dropFunction),
    ].sort(),
    differences: loss.identities
      .map((identity) => ({
        detail: "absent in second model",
        kind: "missing",
        path: `units.${identity}`,
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

/**
 * Класи профілю `supabase` без тих, що є й на `postgres`, — ті читають пресет
 * провайдера: їх веде `round-trip.supabase.db.test.ts`, решту — файл на даних
 * профілю прогону.
 */
const portableNames = (): Set<string> =>
  new Set(classFixtures("postgres").map((f) => f.name))
export const presetClassFixtures = (): ClassFixture[] =>
  classFixtures("supabase").filter((f) => !portableNames().has(f.name))
export const portableClassFixtures = (): ClassFixture[] =>
  classFixtures(testProvider()).filter((f) => portableNames().has(f.name))

export const scopeOf = (schemas: string[]): EngineScope => ({
  schemas,
  provider: testProvider(),
})

/** Ключ таблиці моделі: схема й фізичне ім'я. */
export const tableKeys = (model: CompiledModel) =>
  model.physical.tables.map((t) => `${t.schema}.${t.name}`).sort()

/**
 * Механіка джерела, якої не буде після прийому з нуля: таблиця виду стає
 * `CustomTable` без стандартних колонок, а introspect механіки не пише
 * (спека промоції §9.2). Повертає механіку лише промоція у вид. Тригери
 * незмінності ключа (спека прав §7) — та сама платформна механіка таблиці виду:
 * `CustomTable` їх не має, тож вони втрачаються так само. Так само й тригери
 * ієрархії з функцією таблиці (спека П4 §6.6): генератор `mechanics`, впізнає їх
 * reverse як платформні, повертає лише промоція.
 */
async function mechanicsLoss(source: CompiledModel): Promise<Loss> {
  const lost = (u: { generator?: string }) =>
    u.generator === "mechanics" || u.generator === "key"
  const { scope } = await engineScope({
    ...source,
    sqlUnits: source.sqlUnits.filter((u) => !lost(u)),
  })
  // Межа після прийому з нуля завжди має `simetra` (послідовність версій), тож
  // спільні функції механіки (`simetra.touch()` тощо) звірка бачить, і їх
  // втрата — така сама, як тригерів таблиць
  const inScope = new Set([...scope.schemas, "simetra"])
  const lostUnits = source.sqlUnits.filter(lost)
  const identities = new Set(
    lostUnits.filter((u) => u.class === "trigger").map((u) => u.identity)
  )
  // Кандидати — платформні тригери таблиці з генераторами втраченого; реєстр
  // називає й тригери, яких таблиця не має, тож лишаються лише фактично
  // вилучені
  const candidates = source.physical.tables.flatMap((t) =>
    platformTriggers(t)
      .filter((e) => lost(e))
      .map((e) => ({ table: t, entry: e }))
  )
  const triggers = candidates
    .map(({ table, entry }) => ({
      schema: table.schema,
      table: table.name,
      name: entry.trigger,
    }))
    .filter((t) => identities.has(`trigger:${t.schema}.${t.table}.${t.name}`))
  expect(triggers).toHaveLength(identities.size)
  // Функція ієрархії — у схемі таблиці, тож звірка бачить і її: прийом з нуля
  // впізнає її як платформну й не пише, а повертає її, як і тригери, лише
  // промоція
  const fnIdentities = new Set(
    lostUnits
      .filter((u) => u.class === "function" && inScope.has(u.schema))
      .map((u) => u.identity)
  )
  const functions = [
    ...new Map(
      candidates
        .map(({ entry }) => entry.function)
        .filter((f) => inScope.has(f.schema))
        .map((f) => [`${f.schema}.${f.name}`, f])
    ).values(),
  ].filter((f) => fnIdentities.has(`function:${f.schema}.${f.name}()`))
  expect(functions).toHaveLength(fnIdentities.size)
  // З грантів функції каталог несе лише відкликання в PUBLIC: `EXECUTE` для
  // PUBLIC є в `acldefault` будь-якої функції. Відкликання в ролей, яким
  // типові привілеї схеми нічого не дали, — no-op, і introspect його не бачить
  const grants = functions.map((f) =>
    lostUnits.find(
      (u) =>
        u.identity ===
        `grant:revoke:function:${f.schema}.${f.name}():public:execute`
    )
  )
  expect(grants.every((u) => u !== undefined)).toBe(true)
  return {
    schemas: [...inScope],
    triggers,
    functions,
    identities: [
      ...identities,
      ...fnIdentities,
      ...grants.map((u) => u!.identity),
    ],
  }
}

/** Кроки за текстом SQL: порядок кроків у плані тут не важить. */
const byText = <T extends { sql: string }>(list: readonly T[]) =>
  [...list].sort((a, b) => (a.sql < b.sql ? -1 : a.sql > b.sql ? 1 : 0))

/**
 * Кроки, що знімають утрачену механіку, — за змістом, а не за позицією.
 * Зняття тригера — `relaxation` з дозволом; функція тримає не інваріант, а
 * лише тіло тригера, тож її зняття — `catalogOnly` без дозволу.
 */
const lossSteps = (loss: Loss) =>
  byText([
    ...loss.triggers.map((t) => ({ sql: dropTrigger(t), class: "relaxation" })),
    ...loss.functions.map((f) => ({
      sql: dropFunction(f),
      class: "catalogOnly",
    })),
  ])

/** Кроки втрати, що просять дозволу. */
const permittedLossSteps = (loss: Loss) =>
  lossSteps(loss).filter((s) => s.class === "relaxation")

/**
 * Втрата механіки гучна: кроки, що знімають тригери механіки, — клас
 * `relaxation`, якому потрібен явний дозвіл, і без дозволу застосування
 * відмовляє. Класи й дозволи — ті самі чисті функції, що в `buildPlan` і
 * першій перевірці `executePlan`: тут вони звіряють клас кожного кроку
 * точно, а наскрізний прогін нижче лише підтверджує, що повний конвеєр
 * просить дозволу рівно на ці кроки.
 */
function expectLossNeedsPermission(trip: RoundTrip, loss: Loss): void {
  const steps = classifySteps(
    trip.comparison.plan.actions,
    trip.comparison.target.model,
    parse
  )
  expect(byText(steps.map((s) => ({ sql: s.sql, class: s.class })))).toEqual(
    lossSteps(loss)
  )
  const subject = { steps, drift: null, promotion: null }
  const ids = steps.filter((s) => s.class === "relaxation").map((s) => s.id)
  expect(requiredPermissions(subject)).toEqual(ids)
  expect(checkPermissions(subject, [])).toEqual([
    expect.objectContaining({
      code: "apply.permission-required",
      severity: "error",
      params: { items: ids.join(", ") },
    }),
  ])
  expect(checkPermissions(subject, ids)).toEqual([])
}

/** Тригери, функції та їхні ACL оракула без втраченої механіки. */
const withoutLost = (shape: OracleShape, loss: Loss): OracleShape => {
  const lost = new Set(
    loss.triggers.map((t) => `${t.schema}.${t.table} ${t.name}`)
  )
  const lostFunctions = new Set(
    loss.functions.map((f) => `${f.schema}.${f.name}()`)
  )
  return {
    ...shape,
    catalog: {
      ...shape.catalog,
      functions: shape.catalog.functions.filter(
        (f) => !lostFunctions.has(`${f.schema}.${f.name}(${f.arguments})`)
      ),
    },
    triggers: shape.triggers.filter((t) => !lost.has(`${t.table} ${t.name}`)),
    functions: shape.functions.filter((f) => !lostFunctions.has(f.name)),
    acls: shape.acls.filter(
      (a) => !a.object.startsWith("f:") || !lostFunctions.has(a.object.slice(2))
    ),
  }
}

/**
 * Повний конвеєр над ціллю: план повернутої моделі проходить доказ на копії,
 * а застосування без дозволів або нічого не має робити (без утрати), або
 * відмовляє рівно на кроках утрати. Так round-trip доводить не лише порожню
 * звірку, а й те, що інструмент `apply` прийме повернуту теку як є. Кроки
 * дозволу звіряються за SQL: ідентифікатори позиційні, а план артефакту —
 * не той, що в звірці, тож рівність ідентифікаторів не довела б, що дозволу
 * просять саме кроки втрати.
 *
 * Гілка `committed` (без утрати) стоїть поруч із гілкою відмови, бо
 * round-trip має довести обидва результати застосування. Але на корпусі фікстур
 * розгортання кожна фікстура втрачає механіку видів, тож гілку `committed` зараз не
 * виконує жоден тест: це не доведена гарантія, а місце для фікстури без
 * утрати.
 */
async function expectPlanAndApply(
  target: DbConnection,
  model: CompiledModel,
  loss: Loss
): Promise<void> {
  const outcome = await buildPlan(engine, dbs, model, { target }, [])
  expect({
    status: outcome.status,
    errors: errors(outcome.diagnostics),
  }).toEqual({ status: "planned", errors: [] })
  if (outcome.status !== "planned") throw new Error("plan refused")
  const artifact = outcome.artifact
  const permitted = new Set(artifact.requiredPermissions)
  expect(
    byText(
      artifact.steps
        .filter((s) => permitted.has(s.id))
        .map((s) => ({ sql: s.sql, class: s.class }))
    )
  ).toEqual(permittedLossSteps(loss))
  // Пункт дозволу поза кроками (дрейф, промоція) фільтр вище не побачив би
  const stepIds = new Set(artifact.steps.map((s) => s.id))
  expect(artifact.requiredPermissions.filter((id) => !stepIds.has(id))).toEqual(
    []
  )

  const applied = await executePlan(writer, target, artifact, {
    mode: "apply",
    planHash: artifact.planHash,
    allow: [],
    snapshot: canonicalSnapshot(model),
  })
  if (loss.triggers.length === 0) {
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
      params: { items: artifact.requiredPermissions.join(", ") },
    }),
  ])
}

/**
 * Розгортає скомпільовану теку в ціль і веде її ланцюжком §9. Без збереженої
 * теки (`existing` порожній) механіка видів — відома втрата, і вона гучна.
 * `endToEnd` веде повернуту модель ще й повним конвеєром плану й застосування.
 */
export async function deployedRoundTrip(
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
      if (loss.triggers.length > 0) expectLossNeedsPermission(trip, loss)
      if (endToEnd) await expectPlanAndApply(target, trip.model, loss)
      return trip
    }
  )
  expect(result.shadow).toEqual(withoutLost(result.target, loss))
  return { source, result }
}

export const kindsOf = (model: CompiledModel) =>
  [...new Set(model.objects.map((o) => o.kind))].sort()

/** Діагностики extract-у цілі з `sql`. */
export async function extractDiagnostics(
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
