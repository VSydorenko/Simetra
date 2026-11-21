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
import { SIGNAL_OUTBOX, type CatalogModel } from "simetra/model"
import {
  canonicalSnapshot,
  compile,
  loadSqlParser,
  platformInstall,
  platformTriggers,
  type CompiledModel,
  type PlatformTriggerFamily,
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
  folderReference,
  requiredPermissions,
  renderDesiredState,
  reverseGenerate,
  type DbConnection,
  type DesiredComparison,
  type EngineDiagnostic,
  type EngineScope,
  type ExecuteFacts,
  type Extracted,
  type SchemaEngine,
} from "simetra/schema"
import { createApplyDatabase, createPgDeltaEngine } from ".."
import {
  SCOPE_FUNCTIONS_FILE,
  readReferenceDomain,
  shadowAgeMinutes,
  shadowDatabaseNames,
  testDatabaseUrl,
  testProvider,
} from "../../../../simetra/test/support"
import { inTarget as loadTarget, outboxSql } from "../../__tests__/support/db"
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

export const errors = <T extends { severity: string }>(
  diagnostics: readonly T[]
) => diagnostics.filter((d) => d.severity === "error")

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
 * як `CustomTable`, і їхні спільні функції в `simetra` з грантами — лише
 * родини, які reverse упізнає за еталоном (`REFERENCED_FAMILIES`). Межа без
 * них — межа джерела без цих одиниць. `identities` — втрачені одиниці, які
 * звірка бачить відсутніми.
 */
interface Loss {
  schemas: string[]
  triggers: { schema: string; table: string; name: string }[]
  functions: { schema: string; name: string }[]
  identities: string[]
  /**
   * Функції форм платформи (множини скоупу, значень виміру), які прийом з нуля
   * повертає звичайними `SECURITY DEFINER`-функціями з `EXECUTE` для ролей
   * API: зв'язку з видом скоупу чи виміром зворотна генерація не знає, тож
   * компіляція повернутої теки відмовляє їм `sql.definer-caller-unchecked`
   * (платформна спека §6.7), доки їх не зв'язано чи не задекларовано. Тоді
   * ланцюжок закінчується на зворотній генерації (`refusedRoundTrip`, до #271).
   */
  definers: { schema: string; name: string }[]
}

const NO_LOSS = (scope: EngineScope): Loss => ({
  schemas: [...new Set([...scope.schemas, "simetra"])],
  triggers: [],
  functions: [],
  identities: [],
  definers: [],
})

const qualifiedName = (f: { schema: string; name: string }) =>
  `${f.schema}.${f.name}`

/** Відмова прийому — помилка класу ремонту з її ключем `{ code, schema, name }` (Р7). */
export interface Refusal {
  code: string
  schema?: string
  name?: string
  /** Одиниця, на якій відмова (`sql.kind-table-verbatim`). */
  identity?: string
}

// З фактами `EXECUTE` функція множини з викликачами `user`/`command` отримує
// декларацію без `check` — до Д5 це `sql.declaration-check-missing` (Р1);
// `sql.definer-caller-unchecked` лишилось би лише функціям без декларації
const definerRefusals = (definers: Loss["definers"]): Refusal[] =>
  definers.map((f) => ({
    code: "sql.declaration-check-missing",
    schema: f.schema,
    name: f.name,
  }))

/** Помилки прийому — рівно відмови `refusals`, решти немає. */
function expectRefusals(
  diagnostics: readonly {
    severity: string
    code: string
    params?: Record<string, unknown>
  }[],
  refusals: readonly Refusal[]
): void {
  expect(
    errors(diagnostics).map((d) => ({
      code: d.code,
      schema: d.params?.schema,
      name: d.params?.name,
      identity: d.params?.identity,
    }))
  ).toEqual(refusals)
}

/**
 * Витяг із фактами `EXECUTE` в одному знімку — як `introspect`: без фактів
 * зворотна генерація не пише декларацій definer-функцій.
 */
async function extractWithFacts(target: DbConnection, scope: EngineScope) {
  const { extracted, facts } = await engine.extractWithExecuteFacts(
    target,
    scope
  )
  expect(errors(extracted.diagnostics)).toEqual([])
  expect(facts.catalogChanged).toBe(false)
  expect(facts.crossCheckFailures).toEqual([])
  return { extracted, facts }
}

/** Помилки прийому — рівно відмови `definers`, решти немає. */
function expectRefusedDefiners(
  diagnostics: Parameters<typeof expectRefusals>[0],
  definers: Loss["definers"]
): void {
  expectRefusals(diagnostics, definerRefusals(definers))
}

/**
 * Послідовність версій і outbox сигналів компілятор видає завжди, тож межа з
 * метаданих завжди містить `simetra`, а застосована база їх має. Фікстури
 * класів — сирий SQL без платформного шару, тому ціль доповнюється так, як її
 * доповнило б перше застосування: інакше звірка бачила б їх як різницю, а не
 * як втрачену чи збережену одиницю. Ціль, розгорнута з бажаного стану, outbox
 * уже має — тоді його не створюємо вдруге.
 */
const withPlatformSequence = (target: DbConnection) =>
  withClient(target, async (c) => {
    await c.query("CREATE SCHEMA IF NOT EXISTS simetra")
    await c.query(
      "CREATE SEQUENCE IF NOT EXISTS simetra.row_version AS bigint MINVALUE 1 NO CYCLE CACHE 1"
    )
    const { rows } = await c.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [`${SIGNAL_OUTBOX.schema}.${SIGNAL_OUTBOX.name}`]
    )
    if (rows[0]?.present !== true) await c.query(await outboxOfProfile())
  })

/** Outbox сигналів профілю прогону — з бажаного стану порожнього проєкту. */
async function outboxOfProfile(): Promise<string> {
  const compiled = await compile(
    new Map([
      [
        "project.meta.json",
        JSON.stringify({
          name: "Outbox",
          database: { provider: testProvider() },
        }),
      ],
    ])
  )
  expect(errors(compiled.diagnostics)).toEqual([])
  return outboxSql(compiled.model!)
}

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
 * Еталон наявної теки для `reverseGenerate` — той самий шлях, що й в
 * `introspect` (`folderReference`): тінь з бажаним станом теки, без помилок.
 */
async function referenceOf(
  target: DbConnection,
  existing: ReadonlyMap<string, string>
): Promise<{ reference?: CatalogModel }> {
  const reference = await folderReference(
    engine,
    dbs.reader,
    { target },
    existing
  )
  // Без помилок, як і extract цілі: попередження двигуна (`frontend_warning`
  // засіву тіні з типовими привілеями) — справжній вивід, а не збій еталона
  expect(errors(reference.diagnostics)).toEqual([])
  return reference.catalog === undefined ? {} : { reference: reference.catalog }
}

/**
 * Повторний introspect у ту саму теку не змінює мітки виду: її призначено
 * раз. Мітки свідомо зсунуто від тих, що дало б доповнення, — інакше загублену
 * мітку непомітно відновило б саме доповнення. Зсуваються лише мітки, які
 * призначив перший прохід (у теці до нього, `before`, їх немає): мітка, що
 * вже була в теці, — вміст розгорнутої бази (`rights_any(…, '<мітка>')`,
 * подання `simetra.kind_labels`), тож зсунута — уже інша тека, яку прийом за
 * вмістом справедливо відмовляє. Що й вона лишається, звіряє та сама рівність.
 */
async function expectKindLabelsKept(
  target: DbConnection,
  extracted: Extracted,
  facts: ExecuteFacts,
  project: Project,
  before: ReadonlyMap<string, string>,
  files: ReadonlyMap<string, string>,
  definers: Loss["definers"]
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
    if (labels(before).has(path)) continue
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
    executeFacts: facts,
    ...(await referenceOf(target, existing)),
  })
  expectRefusedDefiners(again.diagnostics, definers)
  expect(labels(again.files)).toEqual(labels(existing))
}

/**
 * Прийом з нуля бази з функціями форм платформи (`Loss.definers`): ланцюжок
 * §9 закінчується на зворотній генерації — її помилки рівно відмови цих
 * функцій, а моделі з такою текою компілятор не дає. Повертає теку.
 * Тимчасово: іменовані функції множини, які кличуть політики, стануть формою
 * «функція політики» (ADR-0094, #271); тоді фікстури зі `scopeKinds` підуть
 * повним ланцюжком, а цю функцію буде видалено (умова записана в #271).
 */
async function refusedRoundTrip(
  target: DbConnection,
  extractScope: EngineScope,
  project: Project,
  loss: Loss
): Promise<Map<string, string>> {
  const { extracted, facts, files } = await refusedAdoption(
    target,
    extractScope,
    project,
    definerRefusals(loss.definers)
  )
  await expectKindLabelsKept(
    target,
    extracted,
    facts,
    project,
    new Map(),
    files,
    loss.definers
  )
  return files
}

/**
 * Прийом, який компілятор відмовляє: extract без помилок, а помилки
 * зворотної генерації — рівно `refusals` (класу ремонту). Моделі з такою
 * текою немає, тож ланцюжок §9 закінчується тут. Повертає витяг, теку,
 * діагностики й оракул цілі (тіні без моделі немає).
 */
export async function refusedAdoption(
  target: DbConnection,
  extractScope: EngineScope,
  project: Project,
  refusals: readonly Refusal[]
): Promise<{
  extracted: Extracted
  facts: ExecuteFacts
  files: Map<string, string>
  diagnostics: Awaited<ReturnType<typeof reverseGenerate>>["diagnostics"]
  target: OracleShape
}> {
  await withPlatformSequence(target)
  const { extracted, facts } = await extractWithFacts(target, extractScope)
  const reversed = await reverseGenerate(extracted.model, {
    project: { name: "RoundTrip", ...project },
    existing: new Map(),
    newId: () => randomUUID(),
    schemaPath,
    parse,
    executeFacts: facts,
  })
  expectRefusals(reversed.diagnostics, refusals)
  return {
    extracted,
    facts,
    files: new Map(reversed.files),
    diagnostics: reversed.diagnostics,
    target: await withClient(target, (c) =>
      readOracle(c, [...extractScope.schemas])
    ),
  }
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
  const { extracted, facts } = await extractWithFacts(target, extractScope)

  const reversed = await reverseGenerate(extracted.model, {
    project: { name: "RoundTrip", ...project },
    existing,
    newId: () => randomUUID(),
    schemaPath,
    parse,
    executeFacts: facts,
    ...(await referenceOf(target, existing)),
  })
  expectRefusedDefiners(reversed.diagnostics, loss.definers)
  await expectKindLabelsKept(
    target,
    extracted,
    facts,
    project,
    existing,
    reversed.files,
    loss.definers
  )

  return compiledTrip(target, extracted, reversed.files, loss)
}

/**
 * Друга половина ланцюжка §9: компіляція теки, рендер, звірка з ціллю й
 * оракул. Окремо, бо теку після мутацій (`chain`) веде той самий шлях.
 */
async function compiledTrip(
  target: DbConnection,
  extracted: Extracted,
  files: ReadonlyMap<string, string>,
  loss: Loss
): Promise<RoundTrip> {
  const compiled = await compile(files)
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
 * Таблиці моделі без платформної установки (`platformInstall`): їх тека
 * застосунку не описує (ADR-0095), тож з ними звіряють теку, а не модель.
 */
export async function applicationTableKeys(
  model: CompiledModel
): Promise<string[]> {
  const install = await platformInstall(model.project.database.provider)
  const platform = new Set(install.tables.map((t) => `${t.schema}.${t.name}`))
  return tableKeys(model).filter((key) => !platform.has(key))
}

/**
 * Родини тригерів з еталоном без теки (план #286, Р2): шар, що не залежить
 * від моделі, — механіка рядка, авторство й незмінність ключа у формі без
 * `WHEN` змісту. Перелік записано тут явно, а не взято з еталона помічника,
 * інакше оракул збігався б з тим, що перевіряє.
 */
const REFERENCED_FAMILIES: ReadonlySet<PlatformTriggerFamily> = new Set([
  "mechanics",
  "author",
  "key",
])

/**
 * Механіка джерела, якої не буде після прийому з нуля: таблиця виду стає
 * `CustomTable`, а тригери родин з еталоном (`REFERENCED_FAMILIES`) і їхні
 * спільні функції в `simetra` reverse упізнає за вмістом як платформні й
 * не пише (спека промоції §9.2). Повертає їх лише промоція у вид. Родини,
 * вміст яких залежить від моделі видів (ієрархія тощо, Р3), еталона не
 * мають: вони йдуть у теку як SQL застосунку й не втрачаються — їх
 * перелічує `R3_UNITS` тесту корпусу.
 */
async function mechanicsLoss(source: CompiledModel): Promise<Loss> {
  const units = new Set(source.sqlUnits.map((u) => u.identity))
  // Кандидати — тригери родин з еталоном за реєстром; реєстр називає й
  // тригери, яких таблиця не має, тож лишаються лише фактичні одиниці джерела
  const candidates = source.physical.tables.flatMap((t) =>
    platformTriggers(t)
      .filter((e) => REFERENCED_FAMILIES.has(e.family) && !e.contentUpdate)
      .map((e) => ({ table: t, entry: e }))
  )
  const triggers = candidates
    .map(({ table, entry }) => ({
      schema: table.schema,
      table: table.name,
      name: entry.trigger,
    }))
    .filter((t) => units.has(`trigger:${t.schema}.${t.table}.${t.name}`))
  const functions = [
    ...new Map(
      candidates
        .map(({ entry }) => entry.function)
        .map((f) => [`${f.schema}.${f.name}`, f])
    ).values(),
  ].filter((f) => units.has(`function:${f.schema}.${f.name}()`))
  // З грантів функції каталог несе лише відкликання в PUBLIC: `EXECUTE` для
  // PUBLIC є в `acldefault` будь-якої функції. Відкликання в ролей, яким
  // типові привілеї схеми нічого не дали, — no-op, і introspect його не бачить
  const grants = functions.map(
    (f) => `grant:revoke:function:${f.schema}.${f.name}():public:execute`
  )
  expect(grants.filter((g) => !units.has(g))).toEqual([])
  const identities = [
    ...triggers.map((t) => `trigger:${t.schema}.${t.table}.${t.name}`),
    ...functions.map((f) => `function:${f.schema}.${f.name}()`),
    ...grants,
  ]
  const lost = new Set(identities)
  const { scope } = await engineScope({
    ...source,
    sqlUnits: source.sqlUnits.filter((u) => !lost.has(u.identity)),
  })
  // Межа після прийому з нуля завжди має `simetra` (послідовність версій), тож
  // спільні функції механіки (`simetra.touch()` тощо) звірка бачить, і їх
  // втрата — така сама, як тригерів таблиць
  const inScope = new Set([...scope.schemas, "simetra"])
  expect(functions.filter((f) => !inScope.has(f.schema))).toEqual([])
  // Функції форм платформи, названі проєктом: функція множини виду скоупу
  // (крім згенерованої з членства) і функція значень виміру.
  const { project } = source
  const named = [
    ...project.scopeKinds.flatMap((kind) =>
      typeof kind.setFunction === "object" ? [kind.setFunction] : []
    ),
    ...project.accessDimensions.flatMap((dimension) =>
      "function" in dimension.values ? [dimension.values.function] : []
    ),
  ].map((f) => ({ schema: f.schema ?? project.defaultSchema, name: f.name }))
  const definers = [
    ...new Map(
      named
        .filter((f) =>
          source.sqlUnits.some(
            (u) => u.identity === `function:${qualifiedName(f)}()`
          )
        )
        .map((f) => [qualifiedName(f), f])
    ).values(),
  ].sort((a, b) => (qualifiedName(a) < qualifiedName(b) ? -1 : 1))
  return {
    schemas: [...inScope],
    triggers,
    functions,
    identities,
    definers,
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

/**
 * Кроки втрати, що просять дозволу в повному конвеєрі. Ціль розгорнуто SQL,
 * а не застосуванням, тож marker немає й жоден об'єкт не власний: зняття
 * функції механіки — теж послаблення з дозволом (платформна спека §6.6).
 */
const permittedLossSteps = (loss: Loss) =>
  lossSteps(loss).map((s) => ({ ...s, class: "relaxation" }))

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

/**
 * Властивість класу фікстури (`ClassFixture.property`) над оракулом без
 * платформної установки (`platformInstall`): фікстура — сирий SQL у своїх
 * схемах, а таблицю, функції, тригери й політики outbox сигналів ціль має
 * від доповнення (`withPlatformSequence`). Порівняння цілі з тінню бачить
 * установку й далі — тут її не бачить лише проєкція класу.
 */
export async function classProperty(
  fixture: ClassFixture,
  shape: OracleShape
): Promise<unknown> {
  const install = await platformInstall(testProvider())
  const relations = new Set([
    ...install.tables.flatMap((t) => [
      `${t.schema}.${t.name}`,
      ...t.columns.flatMap((c) =>
        c.identity === undefined ? [] : [`${t.schema}.${c.identity.sequence}`]
      ),
    ]),
    ...install.units
      .filter((u) => u.class === "sequence")
      .map((u) => `${u.schema}.${u.name}`),
  ])
  const functions = new Set(
    install.units
      .filter((u) => u.class === "function")
      .map((u) => `${u.schema}.${u.name}`)
  )
  const members = new Set(
    install.units
      .filter((u) => u.class === "trigger" || u.class === "policy")
      .map((u) => u.identity.slice(u.identity.indexOf(":") + 1))
  )
  const fn = (signature: string) => functions.has(signature.split("(")[0]!)
  // Об'єкт ACL оракула: `<relkind>:<схема>.<ім'я>[.<колонка>]` чи `f:<сигнатура>`
  const aclOf = (object: string) => {
    const [kind, name] = [object.slice(0, 1), object.slice(2)]
    if (kind === "f") return fn(name)
    if (kind === "c")
      return relations.has(name.split(".").slice(0, 2).join("."))
    return relations.has(name)
  }
  return fixture.property({
    ...shape,
    catalog: {
      ...shape.catalog,
      tables: shape.catalog.tables.filter(
        (t) => !relations.has(`${t.schema}.${t.name}`)
      ),
      functions: shape.catalog.functions.filter(
        (f) => !functions.has(`${f.schema}.${f.name}`)
      ),
    },
    triggers: shape.triggers.filter(
      (t) => !members.has(`${t.table}.${t.name}`)
    ),
    policies: shape.policies.filter(
      (p) => !members.has(`${p.table}.${p.name}`)
    ),
    functions: shape.functions.filter((f) => !fn(f.name)),
    acls: shape.acls.filter((a) => !aclOf(a.object)),
    ownedBy: shape.ownedBy.filter((o) => !relations.has(o.sequence)),
  })
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
  if (loss.triggers.length === 0 && loss.functions.length === 0) {
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
  endToEnd: boolean,
  chain?: (adopted: Map<string, string>) => Promise<Map<string, string>>
): Promise<{
  source: CompiledModel
  result?: RoundTrip
  adopted?: Map<string, string>
}> {
  const original = await compile(files)
  expect(errors(original.diagnostics)).toEqual([])
  const source = original.model!
  const { scope } = await engineScope(source)
  const loss =
    existing.size === 0 ? await mechanicsLoss(source) : NO_LOSS(scope)
  const project = {
    name: source.project.name,
    defaultSchema: source.project.defaultSchema,
    attributeCase: source.project.naming.attributeCase,
    databaseProvider: source.project.database.provider,
  }
  if (loss.definers.length > 0) {
    // Теку з відмовами класу ремонту лагодять мутації `chain`; повна звірка
    // йде вже над теку після них (Д3, Р8), у тій самій цілі
    let result: RoundTrip | undefined
    const adopted = await inTarget(
      renderDesiredState(source).sql,
      scope,
      async (target) => {
        const kept = await refusedRoundTrip(target, scope, project, loss)
        if (chain === undefined) return kept
        const repaired = await chain(kept)
        const { extracted } = await extractWithFacts(target, scope)
        result = await compiledTrip(target, extracted, repaired, loss)
        if (endToEnd) await expectPlanAndApply(target, result.model, loss)
        return repaired
      }
    )
    return { source, adopted, ...(result === undefined ? {} : { result }) }
  }
  const result = await inTarget(
    renderDesiredState(source).sql,
    scope,
    async (target) => {
      const trip = await roundTripOf(target, scope, project, existing, loss)
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

/**
 * Параметр корпусу `scoped: false`: та сама фікстура без видів скоупу —
 * без `scopeKinds` проєкту, полів `scope` і `scopeColumn` об'єктів, FK у межах
 * тенанта (`scopedRef`) і файлу функцій множини.
 * Так прийом з нуля веде повний ланцюжок §9: функції множини, що після
 * прийому повертаються незв'язаними, відмовляє `sql.definer-caller-unchecked`
 * (платформна спека §6.7). Механіку скоупу в прийомі з нуля перевірить #271.
 */
export function unscoped(
  files: ReadonlyMap<string, string>
): Map<string, string> {
  const out = new Map<string, string>()
  for (const [path, text] of files) {
    if (path === SCOPE_FUNCTIONS_FILE) continue
    if (!path.endsWith(".meta.json")) {
      out.set(path, text)
      continue
    }
    const data = JSON.parse(text) as Record<string, unknown>
    if (path === "project.meta.json") delete data.scopeKinds
    else {
      delete data.scope
      delete data.scopeColumn
      // FK у межах тенанта (`scopedRef`) існує лише зі скоупом.
      if (Array.isArray(data.foreignKeys))
        data.foreignKeys = (
          data.foreignKeys as { references?: { key?: string } }[]
        ).filter((fk) => fk.references?.key !== "scopedRef")
    }
    out.set(path, JSON.stringify(data))
  }
  return out
}

/** Метадані об'єктів повернутої теки: вид, схема й фізичне ім'я таблиці. */
const metaOf = (files: ReadonlyMap<string, string>) =>
  [...files]
    .filter(
      ([path]) => path.endsWith(".meta.json") && path !== "project.meta.json"
    )
    .map(
      ([, text]) =>
        JSON.parse(text) as {
          kind: string
          schema?: string
          physicalName?: string
        }
    )

/** Види об'єктів повернутої теки (`*.meta.json`). */
export const kindsOfFiles = (files: ReadonlyMap<string, string>) =>
  [...new Set(metaOf(files).map((m) => m.kind))].sort()

/**
 * Таблиці `CustomTable` повернутої теки як `схема.ім'я`: зворотна генерація
 * лишає фізичні імена (спека П2 §9), тож кожна таблиця мусить їх назвати.
 */
export const tableKeysOfFiles = (
  files: ReadonlyMap<string, string>,
  defaultSchema: string
) =>
  metaOf(files)
    .filter((m) => m.kind === "CustomTable")
    .map((m) => {
      expect(m.physicalName).toBeDefined()
      return `${m.schema ?? defaultSchema}.${m.physicalName}`
    })
    .sort()

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

/**
 * Прийом над наявною текою еталонного домену: еталон теки — форма каталогу
 * її тіні (`folderReference`), тож згенеровані одиниці теки (політики,
 * функції команд, подання) — платформні. Реєструється з файлу кожного
 * профілю (`round-trip.db.test.ts`, `round-trip.supabase.db.test.ts`).
 */
export function describeReferenceDomain(): void {
  describe("over existing metadata: the reference domain survives the round trip", () => {
    it("reference domain", async () => {
      const files = readReferenceDomain(testProvider())
      const { source, result: trip } = await deployedRoundTrip(
        files,
        files,
        false
      )
      const result = trip!
      // Види 1С і платформний шар лишаються описаними власною текою
      expect(tableKeys(result.model)).toEqual(tableKeys(source))
      expect(kindsOf(result.model)).toEqual(kindsOf(source))
      expect(result.model.sqlUnits.map((u) => u.identity).sort()).toEqual(
        source.sqlUnits.map((u) => u.identity).sort()
      )
    })

    it("a label already in the folder, shifted, is content the database does not have", async () => {
      // Зворотний бік `expectKindLabelsKept`: мітка, яка вже була в теці, —
      // вміст розгорнутої бази (рядок подання `simetra.kind_labels`), тож
      // зсунута вона робить теку іншою за базу, і прийом за вмістом це
      // називає, а не ховає
      const files = readReferenceDomain(testProvider())
      const original = await compile(files)
      expect(errors(original.diagnostics)).toEqual([])
      const source = original.model!
      const { scope } = await engineScope(source)
      const path = "custom-tables/UserSettings/UserSettings.meta.json"
      const meta = JSON.parse(files.get(path)!) as { kindLabel?: unknown }
      expect(meta.kindLabel).toBe("user_settings")
      const shifted = new Map(files)
      shifted.set(
        path,
        JSON.stringify({ ...meta, kindLabel: "kept_user_settings" })
      )
      const refusals = await inTarget(
        renderDesiredState(source).sql,
        scope,
        async (target) => {
          const extracted = await engine.extract(target, scope)
          expect(errors(extracted.diagnostics)).toEqual([])
          const reversed = await reverseGenerate(extracted.model, {
            project: {
              name: source.project.name,
              defaultSchema: source.project.defaultSchema,
              attributeCase: source.project.naming.attributeCase,
              databaseProvider: source.project.database.provider,
            },
            existing: shifted,
            newId: () => randomUUID(),
            schemaPath,
            parse,
            ...(await referenceOf(target, shifted)),
          })
          expect(reversed.changes).toEqual([])
          return errors(reversed.diagnostics).map((d) => ({
            code: d.code,
            file: d.file,
          }))
        }
      )
      expect(refusals).toEqual([
        { code: "schema.reserved", file: "sql/simetra/kind_labels.sql" },
      ])
    })
  })
}
