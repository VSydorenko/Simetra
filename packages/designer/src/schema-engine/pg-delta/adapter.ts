import {
  apply,
  encodeId,
  plan as enginePlan,
  planSchemaFiles,
  isShadowProvisionError,
  provisionCoLocatedShadow,
  resolveProfile,
  SchemaFrontendError,
  ShadowLoadError,
  type Action,
  type Diagnostic,
  type FactBase,
  type Plan,
  type PlanOptions,
  type StableId,
} from "@supabase/pg-delta"
import { resolveView } from "@supabase/pg-delta/policy"
import pg from "pg"
import { loadSqlParser, localize, type RuleCode } from "simetra/compiler"
import {
  ENGINE_PREAMBLE_ALLOWED,
  censusDiagnostics,
  renderProviderSeed,
  tableKey,
  unmodeledClasses,
  type CensusClass,
  type DbConnection,
  type EngineAction,
  type EngineCatalog,
  type EngineDiagnostic,
  type EngineIdentity,
  type EngineObjectRef,
  type EnginePlan,
  type EngineScope,
  type EngineSetting,
  type Extracted,
  type LockedTable,
  type SchemaEngine,
  type ShadowOptions,
  type ShadowOutcome,
} from "simetra/schema"
import {
  readCensus,
  readUnmodeledProperties,
  readUnpopulatedViews,
} from "../census-read"
import {
  CENSUS_COVERAGE,
  censusClassOfFact,
  censusClassOfUnmodeledKind,
} from "./census-facts"
import { readExtensionComments } from "../extension-comments"
import { readOnlyQuery, readOnlyTransactionPool } from "../read-only"
import { closeSavepoint, savepointPool } from "../savepoint-pool"
import { readRoutineVolatility } from "../routine-volatility"
import { withColumnOrder } from "./column-order"
import { mapModel } from "./map-model"
import type { MappingIssue } from "./map-tables"
import { aclDefaultsOf, producedBy } from "./map-units"
import { scopeProfile } from "./policy"
import {
  ShadowCreateRefusedError,
  ShadowServerError,
  ShadowServerMismatchError,
} from "../errors"

const ENGINE = "pg-delta"

/**
 * Версія встановленого пакета двигуна. Пакет не експортує свій
 * `package.json`, а його `ENGINE_VERSION` — версія формату плану, не пакета;
 * рівність встановленому пакету тримає тест адаптера.
 */
const IDENTITY: EngineIdentity = { name: ENGINE, version: "1.0.0-alpha.56" }

/**
 * Секрети в дефініціях (наприклад, опції серверів) двигун редагує; той самий
 * режим, що й типовий у `planSchemaFiles`, інакше відбитки сторін розійдуться.
 */
const REDACT_SECRETS = true

/**
 * Пул адміністративної сесії тіні: завантаження бажаного стану пише. Читання
 * з нього — так само транзакціями `readOnlyQuery`.
 */
function writablePool(url: string): pg.Pool {
  const pool = new pg.Pool({ connectionString: url })
  // Помилка простого клієнта (рестарт сервера) не має валити процес: пул
  // закривається в `finally` виклику
  pool.on("error", () => {})
  return pool
}

/**
 * Тінь на іншому сервері допустима лише тієї самої мажорної версії: двигун
 * читає каталог версійно залежними запитами, і план «ціль → тінь» між
 * версіями показував би відмінності версій, а не стану.
 */
export function shadowServerRefusal(
  targetMajor: number,
  shadowMajor: number
): string | undefined {
  return targetMajor === shadowMajor
    ? undefined
    : `The shadow server runs PostgreSQL ${shadowMajor}, the target runs PostgreSQL ${targetMajor}; the shadow must run the same major version. Nothing changed.`
}

async function serverMajor(pool: pg.Pool): Promise<number> {
  const { rows } = await readOnlyQuery(pool, (client) =>
    client.query<{ major: number }>(
      "select current_setting('server_version_num')::int / 10000 as major"
    )
  )
  return rows[0]!.major
}

async function assertShadowServer(o: ShadowOptions): Promise<void> {
  if (o.shadowBase === undefined) return
  const target = readOnlyTransactionPool(o.target.url)
  const shadow = readOnlyTransactionPool(o.shadowBase.url)
  try {
    const targetMajor = await serverMajor(target)
    const shadowMajor = await serverMajor(shadow).catch((error: unknown) => {
      throw new ShadowServerError(error, true)
    })
    const refusal = shadowServerRefusal(targetMajor, shadowMajor)
    if (refusal !== undefined) throw new ShadowServerMismatchError(refusal)
  } finally {
    await target.end()
    await shadow.end()
  }
}

/**
 * Факти двигуна разом із розв'язаними під ціль опціями плану: `plan` двигуна
 * чистий, але політику, `capability` й ролі цілі розв'язує лише жива база.
 * Клас, а не голий об'єкт, — щоб `plan` порту відрізняв свій каталог від
 * чужого без приведення типів.
 */
export class PgDeltaCatalog implements EngineCatalog {
  readonly engine = ENGINE
  constructor(
    readonly factBase: FactBase,
    readonly planOptions: PlanOptions,
    readonly scopeKey: string
  ) {}
}

/** Межа як рядок: каталоги, витягнуті під різні межі, не порівнюються. */
export function scopeKeyOf(scope: EngineScope): string {
  return JSON.stringify([scope.provider, [...scope.schemas].sort()])
}

/** Англійський текст із каталогу `MESSAGES`, як у діагностик компілятора. */
function engineDiagnostic(
  code: RuleCode,
  params: Record<string, string>,
  severity: EngineDiagnostic["severity"],
  subject: Diagnostic["subject"],
  engineCode?: string
): EngineDiagnostic {
  return {
    code,
    severity,
    message: localize({ code, params }, "en").message,
    params,
    ...(subject === undefined ? {} : { object: encodeId(subject) }),
    ...(engineCode === undefined ? {} : { engineCode }),
  }
}

/**
 * Код і серйозність діагностики порту — наші: гейти вирішують за ними, а код
 * двигуна лише супроводжує їх у `engineCode`. Невідомий код двигуна — загальне
 * попередження `engine.diagnostic`; клас, що має наслідок для плану, отримує
 * власний код (`unmodeled_drift` — оператор плану впаде на цілі).
 *
 * `dangling_edge` на засіяній тіні — шум засіву (ребра до об'єктів
 * провайдера, яких тінь не відтворює), а не стан застосунку.
 */
function toEngineDiagnostics(
  diagnostics: readonly Diagnostic[],
  counted: ReadonlySet<CensusClass>
): EngineDiagnostic[] {
  return diagnostics
    .filter((d) => d.code !== "dangling_edge")
    .filter((d) => !countedByCensus(d, counted))
    .map((d) =>
      d.code === "unmodeled_drift"
        ? engineDiagnostic(
            "engine.unmodeled-drift",
            { detail: d.message },
            "error",
            d.subject,
            d.code
          )
        : engineDiagnostic(
            "engine.diagnostic",
            { engineCode: d.code, detail: d.message },
            "warning",
            d.subject,
            d.code
          )
    )
}

/**
 * `unmodeled_kind` двигуна — додатковий сигнал, не джерело (спека П2
 * §9): двигун пробує всю базу без межі, тож лишається попередженням
 * `engine.diagnostic`, а клас, який перепис уже назвав помилкою в межі,
 * вдруге не звучить.
 */
function countedByCensus(
  d: Diagnostic,
  counted: ReadonlySet<CensusClass>
): boolean {
  if (d.code !== "unmodeled_kind") return false
  const kind = d.context?.kind
  if (typeof kind !== "string") return false
  const censusClass = censusClassOfUnmodeledKind(kind)
  return censusClass !== undefined && counted.has(censusClass)
}

/** Керовані факти виду за класами перепису — друга сторона звірки лічильників. */
function factCensus(view: FactBase): Map<CensusClass, number> {
  const out = new Map<CensusClass, number>()
  for (const fact of view.facts()) {
    if (view.isReferenceOnly(fact.id)) continue
    const censusClass = censusClassOfFact(fact)
    if (censusClass !== undefined)
      out.set(censusClass, (out.get(censusClass) ?? 0) + 1)
  }
  return out
}

/**
 * Діагностика невираженої властивості. Серйозність — error: модель без цієї
 * властивості тихо назвала б базу рівною бажаному стану.
 */
function unrepresentableDiagnostic(issue: MappingIssue): EngineDiagnostic {
  return engineDiagnostic(
    "engine.unrepresentable",
    {
      object: encodeId(issue.object),
      property: issue.property,
      detail: issue.detail,
    },
    "error",
    issue.object
  )
}

/**
 * Таблиця, яку адресує ідентичність: сама таблиця чи її підоб'єкт (поле
 * `table`). Структурно, а не з рядкової форми: та неоднозначна для імен із
 * крапкою.
 */
function tableOf(id: StableId): LockedTable | undefined {
  switch (id.kind) {
    case "table":
      return { schema: id.schema, name: id.name }
    case "column":
    case "constraint":
    case "default":
    case "policy":
    case "rule":
    case "trigger":
      return { schema: id.schema, name: id.table }
    // Зміна коментаря вживає лише ідентичність коментаря, а блокує таблицю
    // його об'єкта
    case "comment":
      return tableOf(id.target)
    default:
      return undefined
  }
}

/** Наявні таблиці вихідного стану: факти виду `table` — це `relkind` r/p. */
function existingTables(source: FactBase): ReadonlySet<string> {
  return new Set(
    source
      .facts()
      .flatMap((f) =>
        f.id.kind === "table" ? [tableKey(f.id.schema, f.id.name)] : []
      )
  )
}

/**
 * Наявні таблиці вихідного стану плану, які дія блокує. Лише `table:` не
 * вистачає: `ALTER COLUMN … SET NOT NULL`/`TYPE`/`SET DEFAULT` споживають лише
 * `column:…` чи `default:…`, а блокують усю таблицю. Поле `table` підоб'єкта
 * ще не означає таблицю: двигун так само адресує обмеження домену й підоб'єкти
 * сторонньої таблиці (батька `foreignTable:` дія над колонкою не несе), а
 * таблицю, яку створює сам план, до плану не заблокувати. Тож одне правило —
 * таблиця має бути у вихідному стані; знання про `relkind` лишається тут, а
 * раннер блокує список як є.
 */
function lockedTablesOf(
  action: Action,
  tables: ReadonlySet<string>
): LockedTable[] {
  const seen = new Set<string>()
  const out: LockedTable[] = []
  for (const id of [...action.consumes, ...action.destroys]) {
    const table = tableOf(id)
    if (table === undefined) continue
    const key = tableKey(table.schema, table.name)
    if (!tables.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(table)
  }
  return out
}

/**
 * Клас блокування дії. Для коментаря двигун дає «none», а Postgres бере
 * `SHARE UPDATE EXCLUSIVE` на таблиці коментованої таблиці чи колонки (на
 * обмеженні — слабше, тож це верхня межа). Без поправки слід плану не знав
 * би цього замка, і звірка сліду на доказі назвала б його прогалиною.
 */
function lockClassOf(action: Action): string {
  if (action.lockClass !== "none") return action.lockClass
  const comment = [
    ...action.produces,
    ...action.consumes,
    ...action.destroys,
  ].some((id) => id.kind === "comment" && tableOf(id) !== undefined)
  return comment ? "shareUpdateExclusive" : action.lockClass
}

/**
 * Створювані об'єкти структурно, тим самим правилом, що й `destroyedOf`: за
 * ними T2 розпізнає, що крок створює FK і яку таблицю той займе.
 */
function producedOf(action: Action): EngineObjectRef[] {
  return objectRefs(action.produces)
}

/**
 * Знищувані об'єкти структурно, з тих самих StableId, що й `tableOf`.
 * Об'єкти без схеми й імені (ролі, членства, гранти, коментарі) у перелік не
 * входять: за ними план не губить даних застосунку.
 */
function destroyedOf(action: Action): EngineObjectRef[] {
  return objectRefs(action.destroys)
}

/**
 * Вжиті об'єкти структурно, тим самим правилом, що й `destroyedOf`: T2
 * розпізнає, на чому дія несе `dataLoss`, без рядкової форми StableId.
 */
function consumedOf(action: Action): EngineObjectRef[] {
  return objectRefs(action.consumes)
}

function objectRefs(ids: readonly StableId[]): EngineObjectRef[] {
  return ids.flatMap((id): EngineObjectRef[] => {
    if (!("schema" in id) || !("name" in id)) return []
    if (typeof id.schema !== "string") return []
    const table = "table" in id && typeof id.table === "string" ? id.table : ""
    return [
      {
        kind: id.kind,
        schema: id.schema,
        ...(table === "" ? {} : { table }),
        name: id.name,
      },
    ]
  })
}

function toEngineAction(
  action: Action,
  tables: ReadonlySet<string>
): EngineAction {
  return {
    sql: action.sql,
    verb: action.verb,
    produces: action.produces.map(encodeId),
    consumes: action.consumes.map(encodeId),
    destroys: action.destroys.map(encodeId),
    produced: producedOf(action),
    destroyed: destroyedOf(action),
    consumed: consumedOf(action),
    transactionality: action.transactionality,
    newSegmentBefore: action.newSegmentBefore,
    lockedTables: lockedTablesOf(action, tables),
    lockClass: lockClassOf(action),
    dataLoss: action.dataLoss === "destructive",
    rewriteRisk: action.rewriteRisk,
  }
}

/**
 * Преамбула двигуна проти дозволеного переліку порту: виконавець виставляє
 * лише відоме, тож невідоме ім'я чи значення — помилка, а не тихе виконання.
 */
export function checkPreamble(
  settings: readonly EngineSetting[]
): EngineDiagnostic[] {
  return settings
    .filter((s) => ENGINE_PREAMBLE_ALLOWED[s.name] !== s.value)
    .map((s) =>
      engineDiagnostic(
        "engine.preamble-unknown",
        { name: s.name, value: s.value },
        "error",
        undefined
      )
    )
}

/**
 * `source` — вихідний стан саме цього плану: проти нього рахуються
 * `lockedTables`. `counted` — класи, які перепис бази вже назвав: з ними
 * діагностики плану фільтруються так само, як в інших шляхах.
 */
function toEnginePlan(
  plan: Plan,
  source: FactBase,
  counted: ReadonlySet<CensusClass> = new Set()
): EnginePlan {
  const tables = existingTables(source)
  const actions = plan.actions.map((a) => toEngineAction(a, tables))
  const preamble = plan.preamble.map(({ name, value }) => ({ name, value }))
  return {
    actions,
    empty: actions.length === 0,
    preamble,
    diagnostics: [
      ...checkPreamble(preamble),
      ...toEngineDiagnostics(plan.diagnostics ?? [], counted),
    ],
  }
}

function asOwnCatalog(catalog: EngineCatalog): PgDeltaCatalog {
  if (!(catalog instanceof PgDeltaCatalog))
    throw new Error(
      `catalog of engine "${catalog.engine}" cannot be planned by ${ENGINE}`
    )
  return catalog
}

/**
 * Сирі факти двигуна з каталогу порту. Лише для контракту покриття відбитка
 * (`fingerprint-coverage.ts`): ключі моделі двигуна знає тільки адаптер.
 */
export function engineFacts(catalog: EngineCatalog): FactBase {
  return asOwnCatalog(catalog).factBase
}

/**
 * Опції плану так само, як їх складає `planSchemaFiles`: план тіні й план
 * порту з тих самих каталогів мусять бути одним планом. Ролі цілі —
 * припущені, бо межа бази (scope `database`) ролями не керує.
 */
function planOptionsOf(resolved: PlanOptions, target: FactBase): PlanOptions {
  const targetRoles = target
    .facts()
    .flatMap((f) => (f.id.kind === "role" ? [f.id.name] : []))
  return {
    scope: "database",
    ...resolved,
    // Після розв'язаних опцій: перейменування вимкнені завжди, `physicalName`
    // стабільний (спека П2 §3), і профіль цього не перекриє
    renames: "off",
    ...(targetRoles.length > 0
      ? { assumedRoles: [...(resolved.assumedRoles ?? []), ...targetRoles] }
      : {}),
    redactSecrets: REDACT_SECRETS,
  }
}

/**
 * Роль сесії — типовий власник: проєкція двигуна прибирає ребро `owner` саме
 * до неї, і саме її ADP дають права новим об'єктам.
 */
async function currentRole(pool: pg.Pool): Promise<string> {
  const { rows } = await readOnlyQuery(pool, (client) =>
    client.query<{ role: string }>("select current_user as role")
  )
  return rows[0]!.role
}

async function extractFrom(
  pool: pg.Pool,
  scope: EngineScope
): Promise<Extracted> {
  const profile = await resolveProfile(pool, scopeProfile(scope), {
    redactSecrets: REDACT_SECRETS,
  })
  const result = await profile.extract(pool, { redactSecrets: REDACT_SECRETS })
  const planOptions = planOptionsOf(profile.planOptions, result.factBase)
  const view = resolveView(
    result.factBase,
    planOptions.policy,
    planOptions.capability,
    planOptions.baseline
  )
  const { model, issues } = mapModel(view, {
    produced: producedBy(result.factBase, view, planOptions),
    parse: await loadSqlParser(),
    defaults: aclDefaultsOf(view, await currentRole(pool)),
    extensionComments: await readExtensionComments(pool),
    volatility: await readRoutineVolatility(pool),
  })
  const census = await readOnlyQuery(pool, (client) =>
    readCensus(client, scope)
  )
  return {
    model,
    catalog: new PgDeltaCatalog(
      result.factBase,
      planOptions,
      scopeKeyOf(scope)
    ),
    diagnostics: [
      ...toEngineDiagnostics(
        result.diagnostics,
        unmodeledClasses(census, CENSUS_COVERAGE)
      ),
      ...issues.map(unrepresentableDiagnostic),
      ...censusDiagnostics(
        census,
        factCensus(view),
        CENSUS_COVERAGE,
        await readOnlyQuery(pool, (client) =>
          readUnmodeledProperties(client, scope)
        )
      ),
    ],
    unpopulated: await readOnlyQuery(pool, (client) =>
      readUnpopulatedViews(client, scope)
    ),
  }
}

/**
 * Витяг на клієнті відкритої транзакції застосування (спека промоції
 * §7.2): двигун читає в точці збереження під сторожем `savepointPool`.
 * Точку, яку двигун лишив відкритою (виняток між його `BEGIN` і
 * `ROLLBACK`), закриваємо самі, інакше транзакція раннера лишилась би в
 * підтранзакції. Збій закриття після винятку витягу не підміняє причину:
 * транзакцію однаково буде відкочено.
 */
export async function extractOnTransactionClient(
  client: pg.PoolClient,
  scope: EngineScope,
  trace?: string[]
): Promise<Extracted> {
  const pool = savepointPool(client, await loadSqlParser(), trace)
  let extracted: Extracted
  try {
    extracted = await extractFrom(pool, scope)
  } catch (error) {
    await closeSavepoint(pool).catch(() => {})
    throw error
  }
  await closeSavepoint(pool)
  return extracted
}

/** Помилки бажаного стану (засів, порожній SQL, завантаження) — не винятки, а результат. */
function shadowFailure(error: unknown): EngineDiagnostic[] | undefined {
  if (error instanceof ShadowLoadError)
    return error.details.map((d) =>
      engineDiagnostic(
        "engine.shadow-load-failed",
        { detail: d.message },
        "error",
        d.subject,
        d.code
      )
    )
  // Відмова фронтенду — не обов'язково збій завантаження: порожній SQL,
  // кластерний DDL (`create role`), прекчек розширень, збій засіву
  if (error instanceof SchemaFrontendError)
    return [
      engineDiagnostic(
        "engine.desired-rejected",
        { detail: error.message },
        "error",
        undefined
      ),
    ]
  return undefined
}

/**
 * Тіло тіні без її прибирання: план «ціль → тінь» і колбек. Діагностики
 * завантаження, цілі, дрейфу немодельованих об'єктів і самого плану
 * віддаються разом із результатом — `unmodeled_drift` означає, що оператор
 * плану впаде на цілі, і мовчати про це не можна.
 */
async function planAndRun<T>(
  target: DbConnection,
  shadowUrl: string,
  desiredSql: string,
  scope: EngineScope,
  fn: (shadow: DbConnection, plan: EnginePlan) => Promise<T>
): Promise<ShadowOutcome<T>> {
  const warnings: string[] = []
  const targetPool = readOnlyTransactionPool(target.url)
  const shadowPool = writablePool(shadowUrl)
  let plan: EnginePlan
  let diagnostics: EngineDiagnostic[]
  try {
    // Засів провайдера — окремим файлом перед бажаним станом: двигун вантажить
    // файли в порядку масиву, а засів припущених схем цілі йде ще раніше, тож
    // `extensions` уже існує. Базовий стан — з пресету, а не з цілі (спека
    // промоції §9.9): відмінність цілі від пресету має лишитися видимою.
    // Пересортування вимкнене: без `@supabase/pg-topo` його й так немає, а
    // бажаний стан уже впорядковано графом створення, тож опція описує
    // фактичну поведінку замість попередження в каналі діагностик
    const result = await planSchemaFiles(
      targetPool,
      shadowPool,
      [
        { name: "provider-seed.sql", sql: renderProviderSeed() },
        { name: "desired.sql", sql: desiredSql },
      ],
      {
        profile: scopeProfile(scope),
        seedAssumedSchemas: true,
        reorderOnFailure: false,
        renames: "off",
        redactSecrets: REDACT_SECRETS,
        onWarning: (message) => warnings.push(message),
      }
    )
    // Той самий фільтр `unmodeled_kind`, що в extract: клас, який перепис
    // бази-джерела діагностики вже назвав у межі, вдруге не звучить
    const counted = async (pool: pg.Pool) =>
      unmodeledClasses(
        await readOnlyQuery(pool, (client) => readCensus(client, scope)),
        CENSUS_COVERAGE
      )
    const [targetCounted, shadowCounted] = await Promise.all([
      counted(targetPool),
      counted(shadowPool),
    ])
    const bothCounted = new Set([...targetCounted, ...shadowCounted])
    plan = toEnginePlan(result.plan, result.targetFactBase, bothCounted)
    diagnostics = [
      ...toEngineDiagnostics(result.loadDiagnostics, shadowCounted),
      ...toEngineDiagnostics(result.targetDiagnostics, targetCounted),
      ...toEngineDiagnostics(result.driftDiagnostics, bothCounted),
      // Ті самі діагностики лежать і на `EnginePlan`, що йде в `fn`; у списку
      // результату вони лише тут, тож споживач, який бере список результату,
      // не бачить їх двічі
      ...plan.diagnostics,
      // Попередження фронтенду — проза без коду й суб'єкта
      ...warnings.map((message) =>
        engineDiagnostic(
          "engine.diagnostic",
          { engineCode: "frontend_warning", detail: message },
          "warning",
          undefined,
          "frontend_warning"
        )
      ),
    ]
  } catch (error) {
    const failure = shadowFailure(error)
    if (failure === undefined) throw error
    return { status: "shadow-failed", diagnostics: failure }
  } finally {
    await targetPool.end()
    await shadowPool.end()
  }
  return {
    status: "loaded",
    value: await fn({ url: shadowUrl }, plan),
    diagnostics,
  }
}

/**
 * Збій копії — окремий код, не `engine.shadow-load-failed`: причина в цілі чи
 * середовищі (розширення, засів провайдера, режим з'єднання тіні), а не в
 * метаданих, і порада інша.
 */
function cloneFailed(
  detail: string,
  engineCode?: string,
  object?: string
): EngineDiagnostic {
  return {
    ...engineDiagnostic(
      "engine.clone-failed",
      { detail },
      "error",
      undefined,
      engineCode
    ),
    ...(object === undefined ? {} : { object }),
  }
}

/**
 * Текст запобіжника двигуна, яким сортування дій відмовляє на циклі
 * (`src/plan/graph.ts` у `@supabase/pg-delta` 1.0.0-alpha.56). Класу чи коду
 * в цього винятку немає, тож розпізнаємо текст; оновлення двигуна мусить його
 * перевірити. Змінений текст дасть гучний червоний DB-тест засіву, а не тиху
 * хибну відмову.
 */
const ENGINE_CYCLE_MESSAGE = /^dependency cycle among \d+ actions/

/**
 * Збій засіву копії як діагностики копії; `undefined` — виняток не наш, його
 * кидають далі, як у `planAndRun`. Крім збоїв бажаного стану (`shadowFailure`),
 * результатом є цикл двигуна: план «ціль → засів» відкидаємо, але двигун будує
 * його повністю, і для цілі, де функція читає таблицю, що її викликає
 * (DEFAULT, вираз, CHECK домену), сортування дій падає циклом на `DROP`
 * функції й таблиці. Копії тоді немає — це безпечна відмова доказу, а не
 * виняток, що обірвав би `buildPlan`.
 */
export function seedFailure(error: unknown): EngineDiagnostic[] | undefined {
  if (error instanceof Error && ENGINE_CYCLE_MESSAGE.test(error.message))
    return [
      cloneFailed(`preparing the copy failed: ${error.message}`, "seed_failed"),
    ]
  return shadowFailure(error)?.map((d) =>
    cloneFailed(
      `preparing the copy failed: ${String(d.params.detail)}`,
      d.engineCode,
      d.object
    )
  )
}

/** Застосовує план відтворення до копії; збій — діагностика копії. */
async function reproduce(
  clonePool: pg.Pool,
  plan: Plan
): Promise<EngineDiagnostic | undefined> {
  const report = await apply(plan, clonePool, { fingerprintGate: false })
  if (report.status === "applied") return undefined
  return cloneFailed(
    // Текст помилки оператора стосується об'єкта, а не підключення
    `applying the target state failed: ${
      report.error === undefined
        ? "the plan was not applied"
        : `\`${report.error.sql}\`: ${report.error.message}`
    }`,
    "apply_failed"
  )
}

/**
 * Тіло копії без її прибирання. Засів — так само, як бажана тінь у
 * `planAndRun`, і план засіву відкидається: лише `renderProviderSeed()` замало,
 * бо заглушки `auth.users` і `storage.objects` дає `seedAssumedSchemas`, а без
 * них тригер чи політика застосунку на поверхні провайдера не відтворилися б.
 * Стан цілі відтворює план двигуна «копія → ціль» з опціями копії, як `plan`
 * порту, одним планом. Гейт відбитка `apply` вимкнено: копія жертовна, а
 * точність її стану перевіряє викликач.
 */
async function cloneAndRun<T>(
  target: DbConnection,
  cloneUrl: string,
  targetCatalog: PgDeltaCatalog,
  scope: EngineScope,
  fn: (clone: DbConnection) => Promise<T>
): Promise<ShadowOutcome<T>> {
  const targetPool = readOnlyTransactionPool(target.url)
  const clonePool = writablePool(cloneUrl)
  let diagnostics: EngineDiagnostic[]
  try {
    try {
      await planSchemaFiles(
        targetPool,
        clonePool,
        [{ name: "provider-seed.sql", sql: renderProviderSeed() }],
        {
          profile: scopeProfile(scope),
          seedAssumedSchemas: true,
          reorderOnFailure: false,
          renames: "off",
          redactSecrets: REDACT_SECRETS,
        }
      )
    } catch (error) {
      const failure = seedFailure(error)
      if (failure === undefined) throw error
      return { status: "shadow-failed", diagnostics: failure }
    }
    // Преамбулу цих планів не звіряємо з дозволеним переліком: їх виконує
    // `apply` самого двигуна, а не виконавець порту, тож перелік тут не діє;
    // плани же копіюються лише в жертовну копію й назовні не виходять.
    // Один план «засіяна копія → ціль»: типи цілі двигун створює в ньому ж,
    // а порядок колонок нових таблиць тримають ребра `withColumnOrder` — і для
    // колонки типу, створеного в тому самому плані. Двигун сам ставить
    // згенеровану колонку й колонку з пізнішою функцією виразу після решти, а
    // копія мусить мати порядок цілі, бо його звіряє доказ
    const seeded = asOwnCatalog((await extractFrom(clonePool, scope)).catalog)
    const plan = enginePlan(
      seeded.factBase,
      withColumnOrder(seeded.factBase, targetCatalog.factBase),
      seeded.planOptions
    )
    const failure = await reproduce(clonePool, plan)
    if (failure !== undefined)
      return { status: "shadow-failed", diagnostics: [failure] }
    // Той самий фільтр `unmodeled_kind`, що в `planAndRun`
    const counted = async (pool: pg.Pool) =>
      unmodeledClasses(
        await readOnlyQuery(pool, (client) => readCensus(client, scope)),
        CENSUS_COVERAGE
      )
    const [targetCounted, cloneCounted] = await Promise.all([
      counted(targetPool),
      counted(clonePool),
    ])
    diagnostics = toEngineDiagnostics(
      plan.diagnostics ?? [],
      new Set([...targetCounted, ...cloneCounted])
    )
  } finally {
    await targetPool.end()
    await clonePool.end()
  }
  return {
    status: "loaded",
    value: await fn({ url: cloneUrl }),
    diagnostics,
  }
}

/**
 * Виконує тіло над тінню й прибирає її завжди. Збій прибирання не має
 * затирати першопричину: вона перша в `errors`, а `cause` — збій прибирання,
 * який і перервав нормальний шлях.
 */
async function dropAfter<T>(
  shadow: { cleanup: () => Promise<void> },
  body: () => Promise<T>
): Promise<T> {
  let result: T
  try {
    result = await body()
  } catch (error) {
    try {
      await shadow.cleanup()
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "shadow run failed and the shadow could not be dropped",
        { cause: cleanupError }
      )
    }
    throw error
  }
  await shadow.cleanup()
  return result
}

/**
 * Провізія тіні — обидві її сесійні вимоги: `CREATE DATABASE` і підключення
 * до нової бази за іменем. Збій називає сервер, на якому він стався: без
 * `CREATEDB` — відмова з причиною, будь-який інший — `ShadowServerError` з
 * вимогою до режиму з'єднання. Сервер цілі вже прочитано до провізії (`plan`,
 * `diff`), тож збій тут — збій тіні, а не недосяжна ціль.
 */
async function provisionShadow(
  o: ShadowOptions
): Promise<Awaited<ReturnType<typeof provisionCoLocatedShadow>>> {
  const onShadowBase = o.shadowBase !== undefined
  let shadow: Awaited<ReturnType<typeof provisionCoLocatedShadow>>
  try {
    shadow = await provisionCoLocatedShadow((o.shadowBase ?? o.target).url)
  } catch (error) {
    if (isShadowProvisionError(error))
      throw new ShadowCreateRefusedError(onShadowBase)
    throw new ShadowServerError(error, onShadowBase)
  }
  // Пулер у режимі транзакцій може створити базу, але не пустити до неї за
  // іменем: перше підключення — частина провізії, а не роботи з тінню
  const probe = writablePool(shadow.url)
  try {
    await probe.query("select 1")
  } catch (error) {
    await probe.end()
    await shadow.cleanup()
    throw new ShadowServerError(error, onShadowBase)
  }
  await probe.end()
  return shadow
}

export function createPgDeltaEngine(): SchemaEngine {
  return {
    identity: IDENTITY,

    async extract(db, scope) {
      const pool = readOnlyTransactionPool(db.url)
      try {
        return await extractFrom(pool, scope)
      } finally {
        await pool.end()
      }
    },

    plan(source, target, scope, o) {
      const from = asOwnCatalog(source)
      const to = asOwnCatalog(target)
      const optionsFrom =
        o?.optionsFrom === undefined ? from : asOwnCatalog(o.optionsFrom)
      const key = scopeKeyOf(scope)
      if (
        from.scopeKey !== key ||
        to.scopeKey !== key ||
        optionsFrom.scopeKey !== key
      )
        throw new Error("catalogs were extracted under a different scope")
      // Опції — з бази, яку план змінить: за замовчуванням це джерело, а коли
      // план будують між копіями, — база, до якої його застосують, бо її
      // роль і можливості визначають, що двигун має право планувати
      return toEnginePlan(
        enginePlan(from.factBase, to.factBase, optionsFrom.planOptions),
        from.factBase
      )
    },

    async withDesiredShadow<T>(
      o: ShadowOptions,
      desiredSql: string,
      scope: EngineScope,
      fn: (shadow: DbConnection, plan: EnginePlan) => Promise<T>
    ): Promise<ShadowOutcome<T>> {
      await assertShadowServer(o)
      // Адміністративна сесія тіні — окремий пул двигуна з правом
      // `CREATE DATABASE`; сесія цілі лишається лише для читання
      const shadow = await provisionShadow(o)
      return dropAfter(shadow, () =>
        planAndRun(o.target, shadow.url, desiredSql, scope, fn)
      )
    },

    async withTargetClone<T>(
      o: ShadowOptions,
      target: Extracted,
      scope: EngineScope,
      fn: (clone: DbConnection) => Promise<T>
    ): Promise<ShadowOutcome<T>> {
      const catalog = asOwnCatalog(target.catalog)
      if (catalog.scopeKey !== scopeKeyOf(scope))
        throw new Error("catalogs were extracted under a different scope")
      await assertShadowServer(o)
      // Друга тінь тією самою провізією: копія пише, ціль лише читається
      const clone = await provisionShadow(o)
      return dropAfter(clone, () =>
        cloneAndRun(o.target, clone.url, catalog, scope, fn)
      )
    },
  }
}
