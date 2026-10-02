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
import { localize, type RuleCode } from "simetra/compiler"
import type { CatalogColumn, CatalogModel, CatalogTable } from "simetra/model"
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
  subject: Diagnostic["subject"]
): EngineDiagnostic {
  return {
    code,
    severity,
    message: localize({ code, params }, "en").message,
    ...(subject === undefined ? {} : { object: encodeId(subject) }),
  }
}

/**
 * `dangling_edge` на засіяній тіні — шум засіву (ребра до об'єктів
 * провайдера, яких тінь не відтворює), а не стан застосунку.
 */
function toEngineDiagnostics(
  diagnostics: readonly Diagnostic[]
): EngineDiagnostic[] {
  return diagnostics
    .filter((d) => d.code !== "dangling_edge")
    .map((d) =>
      engineDiagnostic(
        "engine.reported",
        { engineCode: d.code, detail: d.message },
        d.severity === "error" ? "error" : "warning",
        d.subject
      )
    )
}

function stringField(value: unknown): string {
  if (typeof value !== "string")
    throw new Error(`pg-delta fact field is not a string: ${String(value)}`)
  return value
}

/**
 * Модель каталогу з керованого виду двигуна. Поки що лише таблиці з
 * колонками (ім'я, тип, NOT NULL) і RLS таблиці; решту властивостей мапить
 * задача 4 за таблицею властивостей спайку.
 */
function modelOf(view: FactBase): CatalogModel {
  const tables: CatalogTable[] = []
  for (const fact of view.facts()) {
    const id = fact.id
    if (id.kind !== "table" || !("schema" in id) || view.isReferenceOnly(id))
      continue
    const columns = view
      .childrenOf(id)
      .flatMap((c) =>
        c.id.kind === "column" ? [{ name: c.id.name, payload: c.payload }] : []
      )
      .sort((a, b) => Number(a.payload._position) - Number(b.payload._position))
      .map((c): CatalogColumn => ({
        name: c.name,
        type: stringField(c.payload.type),
        notNull: c.payload.notNull === true,
      }))
    const rowSecurity = fact.payload.rowSecurity === true
    const forced = fact.payload.forceRowSecurity === true
    tables.push({
      schema: id.schema,
      name: id.name,
      rowLevelSecurity: !rowSecurity ? "off" : forced ? "forced" : "enabled",
      columns,
      uniques: [],
      checks: [],
      foreignKeys: [],
      indexes: [],
    })
  }
  tables.sort((a, b) => compare(a.schema, b.schema) || compare(a.name, b.name))
  return { tables, enumTypes: [], units: [] }
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
  return {
    model: modelOf(view),
    catalog: new PgDeltaCatalog(
      result.factBase,
      planOptions,
      scopeKeyOf(scope)
    ),
    diagnostics: toEngineDiagnostics(result.diagnostics),
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
        d.subject
      )
    )
  if (error instanceof SchemaFrontendError)
    return [
      engineDiagnostic(
        "engine.shadow-load-failed",
        { detail: error.message },
        "error",
        undefined
      ),
    ]
  return undefined
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
      try {
        let plan: EnginePlan
        const targetPool = new pg.Pool({ connectionString: target.url })
        const shadowPool = new pg.Pool({ connectionString: shadow.url })
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
            }
          )
          plan = toEnginePlan(result.plan)
        } catch (error) {
          const diagnostics = shadowFailure(error)
          if (diagnostics === undefined) throw error
          return { status: "shadow-failed", diagnostics }
        } finally {
          await targetPool.end()
          await shadowPool.end()
        }
        return { status: "loaded", value: await fn({ url: shadow.url }, plan) }
      } finally {
        await shadow.cleanup()
      }
    },
  }
}
