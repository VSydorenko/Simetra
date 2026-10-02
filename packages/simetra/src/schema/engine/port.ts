import type { RuleCode, Severity } from "simetra/compiler"
import type { CatalogModel } from "simetra/model"

/** Адреса бази; пул і його життя — справа адаптера. */
export interface DbConnection {
  url: string
}

/**
 * Межа керування (платформна спека §6.9): керовані схеми застосунку цілком
 * плюс об'єкти застосунку в чужих схемах за пресетом провайдера. Внутрішні
 * об'єкти провайдера й некеровані схеми — поза межею.
 */
export interface EngineScope {
  /** Схеми застосунку, якими порт керує цілком, зокрема їхні гранти й типові привілеї. */
  schemas: readonly string[]
  /** Пресет «об'єкти застосунку в чужих схемах» (§6.9). */
  provider: "supabase"
}

export interface EngineDiagnostic {
  code: RuleCode
  severity: Severity
  message: string
  /** Ідентичність об'єкта двигуна, якого стосується діагностика. */
  object?: string
  /**
   * Власний код двигуна (`unmodeled_drift`, `unmodeled_kind`, …): гейти й
   * перепис класів розпізнають його за полем, а не розбором тексту.
   */
  engineCode?: string
}

/**
 * Непрозорий каталог двигуна для `plan`: його вміст (факти й розв'язані опції
 * профілю) за межу порту не виходить, назовні — лише модель каталогу.
 */
export interface EngineCatalog {
  readonly engine: string
}

export interface Extracted {
  model: CatalogModel
  catalog: EngineCatalog
  diagnostics: EngineDiagnostic[]
}

/**
 * Дія плану у формі порту. Ціль дії видно лише разом із `consumes`: GRANT,
 * `ENABLE RLS`, `REPLICA IDENTITY` тощо не мають ні `produces`, ні `destroys`.
 */
export interface EngineAction {
  sql: string
  verb: "create" | "alter" | "drop"
  /** Ідентичності об'єктів у рядковій формі StableId двигуна. */
  produces: string[]
  consumes: string[]
  destroys: string[]
  /** Тризначна: потоку П3 потрібна межа коміту після дії, а не лише «так/ні». */
  transactionality: "transactional" | "nonTransactional" | "commitBoundaryAfter"
  lockClass: string
  dataLoss: boolean
  rewriteRisk: boolean
}

export interface EnginePlan {
  actions: EngineAction[]
  empty: boolean
}

export type ShadowOutcome<T> =
  | { status: "loaded"; value: T; diagnostics: EngineDiagnostic[] }
  | { status: "shadow-failed"; diagnostics: EngineDiagnostic[] }

export interface SchemaEngine {
  extract(db: DbConnection, scope: EngineScope): Promise<Extracted>
  /** Чисто, без бази: обидва каталоги несуть усе, що потрібно двигуну. */
  plan(
    source: EngineCatalog,
    target: EngineCatalog,
    scope: EngineScope
  ): EnginePlan
  /**
   * Створює тінь поруч із `target`, засіває її базовим станом провайдера й
   * завантажує `desiredSql`; `plan` у колбеку — «ціль → тінь».
   * Діагностики двигуна щодо завантаження, цілі й плану (зокрема
   * `unmodeled_drift`: оператор плану впаде на цілі) — у результаті. Тінь
   * прибирається завжди, зокрема при помилці; порожньої тіні порт не дає.
   */
  withDesiredShadow<T>(
    target: DbConnection,
    desiredSql: string,
    scope: EngineScope,
    fn: (shadow: DbConnection, plan: EnginePlan) => Promise<T>
  ): Promise<ShadowOutcome<T>>
}
