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
  censusDiagnostics,
  renderProviderSeed,
  unmodeledClasses,
  type CensusClass,
  type DbConnection,
  type EngineAction,
  type EngineCatalog,
  type EngineDiagnostic,
  type EngineIdentity,
  type EnginePlan,
  type EngineScope,
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
import { readRoutineVolatility } from "../routine-volatility"
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
      throw new ShadowServerError(error)
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
class PgDeltaCatalog implements EngineCatalog {
  readonly engine = ENGINE
  constructor(
    readonly factBase: FactBase,
    readonly planOptions: PlanOptions,
    readonly scopeKey: string
  ) {}
}

/** Межа як рядок: каталоги, витягнуті під різні межі, не порівнюються. */
function scopeKeyOf(scope: EngineScope): string {
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
 * `unmodeled_kind` двигуна — додатковий сигнал, не джерело (план E2a,
 * рішення 8): двигун пробує всю базу без межі, тож лишається попередженням
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
    default:
      return undefined
  }
}

const tableKey = (schema: string, name: string): string =>
  JSON.stringify([schema, name])

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
    transactionality: action.transactionality,
    newSegmentBefore: action.newSegmentBefore,
    lockedTables: lockedTablesOf(action, tables),
    lockClass: action.lockClass,
    dataLoss: action.dataLoss === "destructive",
    rewriteRisk: action.rewriteRisk,
  }
}

/** `source` — вихідний стан саме цього плану: проти нього рахуються `lockedTables`. */
function toEnginePlan(plan: Plan, source: FactBase): EnginePlan {
  const tables = existingTables(source)
  const actions = plan.actions.map((a) => toEngineAction(a, tables))
  return { actions, empty: actions.length === 0 }
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
    plan = toEnginePlan(result.plan, result.targetFactBase)
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
    diagnostics = [
      ...toEngineDiagnostics(result.loadDiagnostics, shadowCounted),
      ...toEngineDiagnostics(result.targetDiagnostics, targetCounted),
      ...toEngineDiagnostics(
        [...result.driftDiagnostics, ...(result.plan.diagnostics ?? [])],
        bothCounted
      ),
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
 * Тіло копії без її прибирання. Засів — так само, як бажана тінь у
 * `planAndRun`, і план засіву відкидається: лише `renderProviderSeed()` замало,
 * бо заглушки `auth.users` і `storage.objects` дає `seedAssumedSchemas`, а без
 * них тригер чи політика застосунку на поверхні провайдера не відтворилися б.
 * Стан цілі відтворює план двигуна «копія → ціль» з опціями копії, як `plan`
 * порту. Гейт відбитка `apply` вимкнено: копія жертовна, а точність її стану
 * перевіряє викликач.
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
      const failure = shadowFailure(error)
      if (failure === undefined) throw error
      return {
        status: "shadow-failed",
        diagnostics: failure.map((d) =>
          cloneFailed(
            `preparing the copy failed: ${String(d.params.detail)}`,
            d.engineCode,
            d.object
          )
        ),
      }
    }
    const seeded = asOwnCatalog((await extractFrom(clonePool, scope)).catalog)
    const plan = enginePlan(
      seeded.factBase,
      targetCatalog.factBase,
      seeded.planOptions
    )
    const report = await apply(plan, clonePool, { fingerprintGate: false })
    if (report.status !== "applied")
      return {
        status: "shadow-failed",
        diagnostics: [
          cloneFailed(
            // Текст помилки оператора стосується об'єкта, а не підключення
            report.error === undefined
              ? "the reproduction plan was not applied"
              : `\`${report.error.sql}\`: ${report.error.message}`,
            "apply_failed"
          ),
        ],
      }
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
 * Збій провізії називає сервер, на якому він стався: без `CREATEDB` —
 * відмова з адресою того сервера, інший збій окремого сервера тіні — його.
 */
async function provisionShadow(
  o: ShadowOptions
): Promise<Awaited<ReturnType<typeof provisionCoLocatedShadow>>> {
  try {
    return await provisionCoLocatedShadow((o.shadowBase ?? o.target).url)
  } catch (error) {
    if (isShadowProvisionError(error))
      throw new ShadowCreateRefusedError(o.shadowBase !== undefined)
    if (o.shadowBase !== undefined) throw new ShadowServerError(error)
    throw error
  }
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

    plan(source, target, scope) {
      const from = asOwnCatalog(source)
      const to = asOwnCatalog(target)
      const key = scopeKeyOf(scope)
      if (from.scopeKey !== key || to.scopeKey !== key)
        throw new Error("catalogs were extracted under a different scope")
      // Опції — з джерела: план змінює базу-джерело, тож її роль і
      // можливості визначають, що двигун має право планувати
      return toEnginePlan(
        enginePlan(from.factBase, to.factBase, from.planOptions),
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
