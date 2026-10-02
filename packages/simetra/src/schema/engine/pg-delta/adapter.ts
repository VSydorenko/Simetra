import {
  encodeId,
  plan as enginePlan,
  planSchemaFiles,
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
import type {
  DbConnection,
  EngineAction,
  EngineCatalog,
  EngineDiagnostic,
  EnginePlan,
  EngineScope,
  Extracted,
  SchemaEngine,
  ShadowOutcome,
} from "../port"
import {
  censusDiagnostics,
  readCensus,
  readUnmodeledProperties,
  readUnpopulatedViews,
  unmodeledClasses,
  type CensusClass,
} from "../census"
import {
  CENSUS_COVERAGE,
  censusClassOfFact,
  censusClassOfUnmodeledKind,
} from "./census-facts"
import { readExtensionComments } from "../extension-comments"
import { mapModel } from "./map-model"
import type { MappingIssue } from "./map-tables"
import { aclDefaultsOf, producedBy } from "./map-units"
import { scopeProfile } from "./policy"

const ENGINE = "pg-delta"

/**
 * Секрети в дефініціях (наприклад, опції серверів) двигун редагує; той самий
 * режим, що й типовий у `planSchemaFiles`, інакше відбитки сторін розійдуться.
 */
const REDACT_SECRETS = true

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
  const targetPool = new pg.Pool({ connectionString: target.url })
  const shadowPool = new pg.Pool({ connectionString: shadowUrl })
  let plan: EnginePlan
  let diagnostics: EngineDiagnostic[]
  try {
    const result = await planSchemaFiles(
      targetPool,
      shadowPool,
      [{ name: "desired.sql", sql: desiredSql }],
      {
        profile: scopeProfile(scope),
        seedAssumedSchemas: true,
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

export function createPgDeltaEngine(): SchemaEngine {
  return {
    async extract(db, scope) {
      const pool = new pg.Pool({ connectionString: db.url })
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
      target: DbConnection,
      desiredSql: string,
      scope: EngineScope,
      fn: (shadow: DbConnection, plan: EnginePlan) => Promise<T>
    ): Promise<ShadowOutcome<T>> {
      const shadow = await provisionCoLocatedShadow(target.url)
      let outcome: ShadowOutcome<T>
      try {
        outcome = await planAndRun(target, shadow.url, desiredSql, scope, fn)
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
