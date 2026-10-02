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
  type Fact,
  type FactBase,
  type Plan,
  type PlanOptions,
  type StableId,
} from "@supabase/pg-delta"
import { resolveView } from "@supabase/pg-delta/policy"
import pg from "pg"
import {
  loadSqlParser,
  localize,
  type RuleCode,
  type SqlParser,
} from "simetra/compiler"
import type {
  CatalogEnumType,
  CatalogModel,
  CatalogTable,
  CatalogUnit,
} from "simetra/model"
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
import { mapEnumType, mapTable, type MappingIssue } from "./map-tables"
import {
  classifyUnit,
  producedBy,
  unitStatements,
  type ProducedBy,
} from "./map-units"
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

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
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
  diagnostics: readonly Diagnostic[]
): EngineDiagnostic[] {
  return diagnostics
    .filter((d) => d.code !== "dangling_edge")
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

/** Дочірні факти таблиці, які мапить сама таблиця (`mapTable`). */
const TABLE_PARTS = new Set(["column", "default", "constraint", "index"])

/**
 * Класи фактів, текст яких модель тримає дослівно: кожен дає SQL-одиницю
 * (план E2a, рішення 6).
 */
const UNIT_KINDS = new Set([
  "acl",
  "defaultPrivilege",
  "function",
  "procedure",
  "aggregate",
  "trigger",
  "policy",
  "view",
  "materializedView",
  "sequence",
  "domain",
  "extension",
  "publicationRel",
  "publicationSchema",
])

/**
 * Модель каталогу з керованого виду двигуна: кожен керований факт стає полем
 * моделі, SQL-одиницею або діагностикою `engine.unrepresentable` — за
 * таблицею властивостей спайку E2a. Факти «лише для посилань» (об'єкти
 * провайдера) моделі не належать.
 */
function modelOf(
  view: FactBase,
  produced: ProducedBy,
  parse: SqlParser
): { model: CatalogModel; issues: MappingIssue[] } {
  const issues: MappingIssue[] = []
  const tables: CatalogTable[] = []
  const enumTypes: CatalogEnumType[] = []
  const units: CatalogUnit[] = []
  const sources = new Map<string, StableId>()
  const managed = (id: StableId) =>
    view.get(id) !== undefined && !view.isReferenceOnly(id)
  const modelTable = (schema: string, name: string) =>
    managed({ kind: "table", schema, name })
  const unit = (fact: Fact, statements: string[]) => {
    for (const sql of statements) {
      if (sql === "") continue
      const mapped = classifyUnit(fact.id, sql, parse, issues)
      if (mapped === undefined) continue
      // Дві пари з однією ідентичністю порівняння за ключем мовчки злило б
      const earlier = sources.get(mapped.identity)
      if (earlier !== undefined)
        issues.push({
          object: fact.id,
          property: "identity",
          detail: `${encodeId(earlier)} maps to the same unit ${mapped.identity}`,
        })
      sources.set(mapped.identity, fact.id)
      units.push(mapped)
    }
  }
  for (const fact of view.facts()) {
    const id = fact.id
    if (view.isReferenceOnly(id)) continue
    // Власник — ребро, а не payload; типового власника проєкція двигуна
    // прибирає, тож ребро, що лишилось, — інший власник, якого модель не має
    for (const edge of view.outgoingEdges(id))
      if (edge.kind === "owner")
        issues.push({
          object: id,
          property: "owner",
          detail: `owner ${encodeId(edge.to)} is not the default owner`,
        })
    const parent = fact.parent
    if (id.kind === "table") {
      tables.push(mapTable(view, fact, parse, issues))
      unit(fact, unitStatements(view, fact, produced, issues))
    } else if (TABLE_PARTS.has(id.kind)) {
      // Обмеження домену входить в одиницю домену (дія створення домену
      // створює і його обмеження); решта — частини таблиці моделі
      const ofTable =
        parent !== undefined &&
        (parent.kind === "table" ? managed(parent) : parent.kind === "column")
      const ofDomain = id.kind === "constraint" && parent?.kind === "domain"
      if (!ofTable && !ofDomain)
        issues.push({
          object: id,
          property: "parent",
          detail: `${id.kind} of ${parent === undefined ? "nothing" : encodeId(parent)} is not part of a model table`,
        })
    } else if (id.kind === "type") {
      const enumType = mapEnumType(fact, issues)
      if (enumType !== undefined) enumTypes.push(enumType)
    } else if (id.kind === "typeAttribute" || id.kind === "schema") {
      // Атрибут складеного типу вже названо діагностикою самого типу; схема
      // в моделі неявна — її створює рендер зі схем об'єктів
    } else if (id.kind === "comment") {
      const target = id.target
      const field =
        (target.kind === "table" && managed(target)) ||
        (target.kind === "column" && modelTable(target.schema, target.table))
      if (!field) unit(fact, unitStatements(view, fact, produced, issues))
    } else if (UNIT_KINDS.has(id.kind)) {
      unit(fact, unitStatements(view, fact, produced, issues))
    } else {
      issues.push({
        object: id,
        property: "kind",
        detail: `${id.kind} has no field or unit class in the catalog model`,
      })
    }
  }
  tables.sort((a, b) => compare(a.schema, b.schema) || compare(a.name, b.name))
  enumTypes.sort(
    (a, b) => compare(a.schema, b.schema) || compare(a.name, b.name)
  )
  units.sort((a, b) => compare(a.identity, b.identity))
  return { model: { tables, enumTypes, units }, issues }
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
    renames: "off",
    scope: "database",
    ...resolved,
    ...(targetRoles.length > 0
      ? { assumedRoles: [...(resolved.assumedRoles ?? []), ...targetRoles] }
      : {}),
    redactSecrets: REDACT_SECRETS,
  }
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
  const { model, issues } = modelOf(
    view,
    producedBy(result.factBase, view, planOptions),
    await loadSqlParser()
  )
  return {
    model,
    catalog: new PgDeltaCatalog(
      result.factBase,
      planOptions,
      scopeKeyOf(scope)
    ),
    diagnostics: [
      ...toEngineDiagnostics(result.diagnostics),
      ...issues.map(unrepresentableDiagnostic),
    ],
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
    diagnostics = [
      ...toEngineDiagnostics([
        ...result.loadDiagnostics,
        ...result.targetDiagnostics,
        ...result.driftDiagnostics,
        ...(result.plan.diagnostics ?? []),
      ]),
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
