import {
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
  type EnginePlan,
  type EngineScope,
  type Extracted,
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
 * Секрети в дефініціях (наприклад, опції серверів) двигун редагує; той самий
 * режим, що й типовий у `planSchemaFiles`, інакше відбитки сторін розійдуться.
 */
const REDACT_SECRETS = true

/**
 * Пул сесій цілі: лише читання (спека designer §3.2). Не через `options`
 * конфігу: параметр `options` у рядку підключення перекрив би його, а рядок
 * приходить ззовні. Хук `onConnect` пулу виконується до того, як клієнт
 * отримає перший запит, а його збій закриває клієнт і стає помилкою запиту.
 * Цим самим пулом читається й тінь: extract нічого не пише.
 */
export function readOnlyPool(url: string): pg.Pool {
  return quietPool(url, async (client) => {
    await client.query("SET default_transaction_read_only = on")
  })
}

/** Пул адміністративної сесії тіні: завантаження бажаного стану пише. */
function writablePool(url: string): pg.Pool {
  return quietPool(url)
}

function quietPool(
  url: string,
  onConnect?: (client: pg.ClientBase) => Promise<void>
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: url,
    ...(onConnect === undefined ? {} : { onConnect }),
  })
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
  const { rows } = await pool.query<{ major: number }>(
    "select current_setting('server_version_num')::int / 10000 as major"
  )
  return rows[0]!.major
}

async function assertShadowServer(o: ShadowOptions): Promise<void> {
  if (o.shadowBase === undefined) return
  const target = readOnlyPool(o.target.url)
  const shadow = readOnlyPool(o.shadowBase.url)
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

function toEngineAction(action: Action): EngineAction {
  return {
    sql: action.sql,
    verb: action.verb,
    produces: action.produces.map(encodeId),
    consumes: action.consumes.map(encodeId),
    destroys: action.destroys.map(encodeId),
    transactionality: action.transactionality,
    lockClass: action.lockClass,
    dataLoss: action.dataLoss === "destructive",
    rewriteRisk: action.rewriteRisk,
  }
}

function toEnginePlan(plan: Plan): EnginePlan {
  const actions = plan.actions.map(toEngineAction)
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
  const { rows } = await pool.query<{ role: string }>(
    "select current_user as role"
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
  const census = await readCensus(pool, scope)
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
        await readUnmodeledProperties(pool, scope)
      ),
    ],
    unpopulated: await readUnpopulatedViews(pool, scope),
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
  const targetPool = readOnlyPool(target.url)
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
    plan = toEnginePlan(result.plan)
    // Той самий фільтр `unmodeled_kind`, що в extract: клас, який перепис
    // бази-джерела діагностики вже назвав у межі, вдруге не звучить
    const counted = async (pool: pg.Pool) =>
      unmodeledClasses(await readCensus(pool, scope), CENSUS_COVERAGE)
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
    async extract(db, scope) {
      const pool = readOnlyPool(db.url)
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
        enginePlan(from.factBase, to.factBase, from.planOptions)
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
      let outcome: ShadowOutcome<T>
      try {
        outcome = await planAndRun(o.target, shadow.url, desiredSql, scope, fn)
      } catch (error) {
        // Збій прибирання не має затирати першопричину: вона перша в `errors`,
        // а `cause` — збій прибирання, який і перервав нормальний шлях
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
      return outcome
    },
  }
}
