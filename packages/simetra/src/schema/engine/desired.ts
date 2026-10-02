import { localize, type CompiledModel, type SqlUnit } from "simetra/compiler"
import {
  diffCatalogModels,
  type CatalogDifference,
  type SqlUnitClass,
} from "simetra/model"
import { SUPABASE_EXTENSIONS, SUPABASE_SCHEMAS } from "./provider/supabase"
import type {
  DbConnection,
  EngineDiagnostic,
  EnginePlan,
  EngineScope,
  Extracted,
  SchemaEngine,
} from "./port"

export type DesiredComparison =
  | {
      status: "compared"
      /** Ціль → тінь бажаного стану. */
      plan: EnginePlan
      target: Extracted
      desired: Extracted
      differences: CatalogDifference[]
      diagnostics: EngineDiagnostic[]
      empty: boolean
    }
  | { status: "shadow-failed"; diagnostics: EngineDiagnostic[] }

/**
 * Одна діагностика може прийти і з цілі, і з тіні (перепис, дрейф): дублікат
 * за всіма полями не несе нової інформації.
 */
function dedupe(diagnostics: EngineDiagnostic[]): EngineDiagnostic[] {
  const seen = new Set<string>()
  return diagnostics.filter((d) => {
    const key = JSON.stringify([
      d.code,
      d.severity,
      d.message,
      d.object,
      d.engineCode,
    ])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Стан заповнення матеріалізованого подання — відмінність бази від бажаного
 * стану, коли подання є з обох боків: двигун і модель каталогу його не
 * бачать, тож без цього порівняння незаповнене подання проходило б мовчки.
 * Подання лише з одного боку вже дає відмінність одиниці.
 */
function populationDifferences(
  target: Extracted,
  desired: Extracted
): CatalogDifference[] {
  const both = new Set(
    target.model.units
      .filter((u) => u.class === "materializedView")
      .map((u) => u.identity)
      .filter((identity) =>
        desired.model.units.some((u) => u.identity === identity)
      )
  )
  const inTarget = new Set(target.unpopulated)
  const inDesired = new Set(desired.unpopulated)
  const populated = (unpopulated: ReadonlySet<string>, identity: string) =>
    unpopulated.has(identity) ? "not populated" : "populated"
  return [...both]
    .filter((identity) => inTarget.has(identity) !== inDesired.has(identity))
    .sort()
    .map((identity): CatalogDifference => ({
      path: `units.${identity}`,
      kind: "changed",
      detail: `materialized view is ${populated(inTarget, identity)} in the database, ${populated(inDesired, identity)} in the desired state`,
    }))
}

/**
 * Порівнює живу базу з бажаним станом через тінь двигуна: і ціль, і тінь
 * читаються тим самим extract у тій самій межі, тож різницю моделей і план
 * «ціль → тінь» видно разом. Порожнім порівняння вважається, лише коли план
 * порожній, моделі й стан заповнення подань збігаються, а ні межа, ні
 * перепис не дали жодної помилки — інакше
 * «порожньо» приховало б втрати двигуна.
 */
export async function compareWithDesired(
  engine: SchemaEngine,
  target: DbConnection,
  desiredSql: string,
  scope: EngineScope,
  /** Діагностики межі з `engineScope`: об'єкти моделі, яких звірка не бачить. */
  scopeDiagnostics: readonly EngineDiagnostic[]
): Promise<DesiredComparison> {
  const outcome = await engine.withDesiredShadow(
    target,
    desiredSql,
    scope,
    async (shadow, plan) => {
      const [targetExtracted, desired] = await Promise.all([
        engine.extract(target, scope),
        engine.extract(shadow, scope),
      ])
      return { plan, target: targetExtracted, desired }
    }
  )
  if (outcome.status === "shadow-failed")
    return {
      status: "shadow-failed",
      diagnostics: [...scopeDiagnostics, ...outcome.diagnostics],
    }

  const { plan, target: extractedTarget, desired } = outcome.value
  const differences = [
    ...diffCatalogModels(extractedTarget.model, desired.model),
    ...populationDifferences(extractedTarget, desired),
  ]
  const diagnostics = dedupe([
    ...scopeDiagnostics,
    ...outcome.diagnostics,
    ...extractedTarget.diagnostics,
    ...desired.diagnostics,
  ])
  return {
    status: "compared",
    plan,
    target: extractedTarget,
    desired,
    differences,
    diagnostics,
    empty:
      plan.empty &&
      differences.length === 0 &&
      !diagnostics.some((d) => d.severity === "error"),
  }
}

/** Межа керування моделі й об'єкти моделі, що лежать поза нею. */
export interface ModelScope {
  scope: EngineScope
  diagnostics: EngineDiagnostic[]
}

/**
 * Класи одиниць, які пресет провайдера пускає в межу в схемах провайдера
 * (§6.9): політики й тригери на таблицях провайдера. Членство в publication
 * схеми не має, тож перевірки не потребує.
 */
const PROVIDER_SURFACE: ReadonlySet<SqlUnitClass> = new Set([
  "policy",
  "trigger",
])

/** Схеми `IN SCHEMA` типових привілеїв за деревом розбору; порожньо — глобальні. */
function defaultPrivilegeSchemas(unit: SqlUnit): string[] {
  const tree = unit.tree as {
    AlterDefaultPrivilegesStmt?: { options?: unknown[] }
  }
  return (tree.AlterDefaultPrivilegesStmt?.options ?? []).flatMap((o) => {
    const element = (o as { DefElem?: { defname?: string; arg?: unknown } })
      .DefElem
    if (element?.defname !== "schemas") return []
    const arg = element.arg as { List?: { items?: unknown[] } } | undefined
    return (arg?.List?.items ?? [arg]).map(
      (n) => (n as { String?: { sval?: string } }).String?.sval ?? ""
    )
  })
}

function outOfScope(
  object: string,
  reason:
    "provider-schema" | "global-default-privileges" | "provider-extension",
  schema?: string
): EngineDiagnostic {
  const params = { object, reason, ...(schema === undefined ? {} : { schema }) }
  return {
    code: "engine.out-of-scope",
    severity: "error",
    message: localize({ code: "engine.out-of-scope", params }, "en").message,
  }
}

/**
 * Об'єкти моделі, яких двигун у межі не бачить: фільтр двигуна виключає їх і
 * з цілі, і з тіні, тож без діагностики звірка мовчки назвала б їх рівними.
 * Це об'єкти в схемі провайдера поза поверхнею пресету, типові привілеї без
 * `IN SCHEMA` (і з `IN SCHEMA` схеми провайдера) та розширення провайдера.
 */
function outOfScopeDiagnostics(
  model: Pick<CompiledModel, "physical" | "sqlUnits">
): EngineDiagnostic[] {
  const provider = new Set(SUPABASE_SCHEMAS)
  const extensions = new Set(SUPABASE_EXTENSIONS)
  const out: EngineDiagnostic[] = []
  for (const [kind, objects] of [
    ["table", model.physical.tables],
    ["enumType", model.physical.enumTypes],
  ] as const)
    for (const { schema, name } of objects)
      if (provider.has(schema))
        out.push(
          outOfScope(`${kind}:${schema}.${name}`, "provider-schema", schema)
        )
  for (const unit of model.sqlUnits) {
    if (unit.class === "extension") {
      if (extensions.has(unit.name))
        out.push(outOfScope(unit.identity, "provider-extension"))
    } else if (unit.class === "defaultPrivileges") {
      const schemas = defaultPrivilegeSchemas(unit)
      if (schemas.length === 0)
        out.push(outOfScope(unit.identity, "global-default-privileges"))
      for (const schema of schemas.filter((s) => provider.has(s)))
        out.push(outOfScope(unit.identity, "provider-schema", schema))
    } else if (provider.has(unit.schema) && !PROVIDER_SURFACE.has(unit.class))
      out.push(outOfScope(unit.identity, "provider-schema", unit.schema))
  }
  return out
}

/**
 * Межа керування з моделі: схема за замовчуванням і схеми таблиць, енам-типів
 * та одиниць. Схеми провайдера не стають керованими, навіть коли одиниця
 * застосунку лежить у них (політика на `storage.objects`, тригер на
 * `auth.users`): такі об'єкти вже в межі за пресетом провайдера (§6.9), а
 * керована схема провайдера означала б відкликання його власних об'єктів.
 * Порожня схема одиниці (грант, типові привілеї) — не схема. Об'єкти моделі,
 * яких межа не охоплює, — діагностики `engine.out-of-scope`.
 */
export function engineScope(
  model: Pick<CompiledModel, "project" | "physical" | "sqlUnits">
): ModelScope {
  const provider = new Set(SUPABASE_SCHEMAS)
  const schemas = new Set([
    model.project.defaultSchema,
    ...model.physical.tables.map((table) => table.schema),
    ...model.physical.enumTypes.map((type) => type.schema),
    ...model.sqlUnits.map((unit) => unit.schema),
  ])
  return {
    scope: {
      schemas: [...schemas]
        .filter((schema) => schema !== "" && !provider.has(schema))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      provider: "supabase",
    },
    diagnostics: outOfScopeDiagnostics(model),
  }
}
