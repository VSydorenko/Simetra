import type { CompiledModel } from "simetra/compiler"
import { diffCatalogModels, type CatalogDifference } from "simetra/model"
import { SUPABASE_SCHEMAS } from "./provider/supabase"
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
 * порожній, моделі й стан заповнення подань збігаються і перепис не дав
 * жодної помилки — інакше
 * «порожньо» приховало б втрати двигуна.
 */
export async function compareWithDesired(
  engine: SchemaEngine,
  target: DbConnection,
  desiredSql: string,
  scope: EngineScope
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
  if (outcome.status === "shadow-failed") return outcome

  const { plan, target: extractedTarget, desired } = outcome.value
  const differences = [
    ...diffCatalogModels(extractedTarget.model, desired.model),
    ...populationDifferences(extractedTarget, desired),
  ]
  const diagnostics = dedupe([
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

/**
 * Межа керування з моделі: схема за замовчуванням і схеми таблиць, енам-типів
 * та одиниць. Схеми провайдера не стають керованими, навіть коли одиниця
 * застосунку лежить у них (політика на `storage.objects`, тригер на
 * `auth.users`): такі об'єкти вже в межі за пресетом провайдера (§6.9), а
 * керована схема провайдера означала б відкликання його власних об'єктів.
 * Порожня схема одиниці (грант, типові привілеї) — не схема.
 */
export function engineScope(
  model: Pick<CompiledModel, "project" | "physical" | "sqlUnits">
): EngineScope {
  const provider = new Set(SUPABASE_SCHEMAS)
  const schemas = new Set([
    model.project.defaultSchema,
    ...model.physical.tables.map((table) => table.schema),
    ...model.physical.enumTypes.map((type) => type.schema),
    ...model.sqlUnits.map((unit) => unit.schema),
  ])
  return {
    schemas: [...schemas]
      .filter((schema) => schema !== "" && !provider.has(schema))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    provider: "supabase",
  }
}
