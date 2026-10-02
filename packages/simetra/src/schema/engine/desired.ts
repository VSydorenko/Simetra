import {
  loadSqlParser,
  localize,
  type CompiledModel,
  type OutOfScopeReason,
  type SqlParser,
} from "simetra/compiler"
import { diffCatalogModels, type CatalogDifference } from "simetra/model"
import {
  SUPABASE_EXTENSIONS,
  SUPABASE_SCHEMAS,
  SUPABASE_SURFACES,
} from "./provider/supabase"
import {
  triggerFunctionSchema,
  unitPlacement,
  unitTargets,
  type UnitTarget,
} from "./unit-target"
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

/** Glob пресету (`*`, `?`) у регулярний вираз на ціле ім'я. */
function globMatches(glob: string, name: string): boolean {
  const pattern = glob
    .split("")
    .map((c) =>
      c === "*"
        ? ".*"
        : c === "?"
          ? "."
          : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    )
    .join("")
  return new RegExp(`^${pattern}$`).test(name)
}

/** Чи пускає пресет провайдера одиницю класу `cls` на цю таблицю (§6.9). */
function onSurface(cls: "policy" | "trigger", target: UnitTarget): boolean {
  return SUPABASE_SURFACES.some(
    (surface) =>
      surface.schema === target.schema &&
      surface.classes.includes(cls) &&
      globMatches(surface.table, target.object ?? "")
  )
}

function outOfScope(
  object: string,
  reason: OutOfScopeReason,
  params: Record<string, string> = {}
): EngineDiagnostic {
  const all = { object, reason, ...params }
  return {
    code: "engine.out-of-scope",
    severity: "error",
    message: localize({ code: "engine.out-of-scope", params: all }, "en")
      .message,
  }
}

/**
 * Об'єкти моделі, яких двигун у межі не бачить: фільтр двигуна виключає їх і
 * з цілі, і з тіні, тож без діагностики звірка мовчки назвала б їх рівними.
 * Схему одиниці дає її структурована ціль — та сама, що й межі
 * (`engineScope`). Поза межею: об'єкти й цілі в схемі провайдера, крім
 * поверхні пресету (політики й тригери на його таблицях; тригер — лише з
 * функцією поза схемами провайдера, як у правилі двигуна), типові привілеї
 * без `IN SCHEMA` і розширення провайдера.
 */
function outOfScopeDiagnostics(
  model: Pick<CompiledModel, "physical" | "sqlUnits">,
  parse: SqlParser
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
          outOfScope(`${kind}:${schema}.${name}`, "provider-schema", { schema })
        )
  for (const unit of model.sqlUnits) {
    if (unit.class === "extension") {
      if (extensions.has(unit.name))
        out.push(outOfScope(unit.identity, "provider-extension"))
      continue
    }
    const targets = unitTargets(unit, parse)
    if (unit.class === "defaultPrivileges" && targets.length === 0) {
      out.push(outOfScope(unit.identity, "global-default-privileges"))
      continue
    }
    if (unit.class === "policy" || unit.class === "trigger") {
      const [target] = targets
      if (target === undefined || !provider.has(target.schema)) continue
      const fnSchema = triggerFunctionSchema(unit, parse)
      if (!onSurface(unit.class, target))
        out.push(
          outOfScope(unit.identity, "provider-surface", {
            class: unit.class,
            table: `${target.schema}.${target.object ?? ""}`,
          })
        )
      else if (fnSchema !== undefined && provider.has(fnSchema))
        out.push(
          outOfScope(unit.identity, "provider-trigger-function", {
            schema: fnSchema,
          })
        )
      continue
    }
    // Коментар на політиці поверхні — у межі (правило двигуна
    // `supabase.user-policy-surface-comment`); на колонці, тригері чи самій
    // таблиці провайдера — ні
    const outside = unitPlacement(unit, parse).filter(
      (t) =>
        provider.has(t.schema) &&
        !(
          unit.class === "comment" &&
          t.kind === "policy" &&
          onSurface("policy", t)
        )
    )
    for (const schema of new Set(outside.map((t) => t.schema)))
      out.push(outOfScope(unit.identity, "provider-schema", { schema }))
  }
  return out
}

/**
 * Межа керування з моделі: схема за замовчуванням, схеми таблиць, енам-типів
 * і одиниць, а для одиниці з ціллю (грант, коментар, типові привілеї,
 * членство в publication, політика, тригер) — схеми її цілей: інакше грант на
 * таблицю схеми, де модель більше нічого не має, фільтр двигуна мовчки
 * виключив би з обох боків звірки. Схеми провайдера не стають керованими,
 * навіть коли одиниця застосунку лежить у них (політика на `storage.objects`,
 * тригер на `auth.users`): такі об'єкти вже в межі за пресетом провайдера
 * (§6.9), а керована схема провайдера означала б відкликання його власних
 * об'єктів. Порожня схема — не схема. Об'єкти моделі, яких межа не охоплює,
 * — діагностики `engine.out-of-scope`. Асинхронна, бо цілі читає парсер
 * Postgres, який вантажиться один раз на процес.
 */
export async function engineScope(
  model: Pick<CompiledModel, "project" | "physical" | "sqlUnits">
): Promise<ModelScope> {
  const parse = await loadSqlParser()
  const provider = new Set(SUPABASE_SCHEMAS)
  const schemas = new Set([
    model.project.defaultSchema,
    ...model.physical.tables.map((table) => table.schema),
    ...model.physical.enumTypes.map((type) => type.schema),
    ...model.sqlUnits.flatMap((unit) =>
      unitPlacement(unit, parse).map((t) => t.schema)
    ),
  ])
  return {
    scope: {
      schemas: [...schemas]
        .filter((schema) => schema !== "" && !provider.has(schema))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      provider: "supabase",
    },
    diagnostics: outOfScopeDiagnostics(model, parse),
  }
}
