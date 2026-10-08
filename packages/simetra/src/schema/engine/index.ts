export type {
  DbConnection,
  EngineAction,
  EngineCatalog,
  EngineDiagnostic,
  EnginePlan,
  EngineScope,
  Extracted,
  SchemaEngine,
  ShadowOptions,
  ShadowOutcome,
} from "./port"
export {
  compareWithDesired,
  engineScope,
  type DesiredComparison,
  type ModelScope,
} from "./desired"
// Чисті функції й типи перепису та пресет провайдера: адаптер двигуна й
// читачі бази живуть у @simetra/designer (рішення Д5) і беруть їх звідси
export {
  censusDiagnostics,
  reconcileCensus,
  unmodeledClasses,
  type CensusClass,
  type CensusCount,
  type ClassCoverage,
  type EngineCoverage,
  type PropertyCount,
} from "./census"
export { ALL_PRIVILEGES } from "./privileges"
export {
  renderProviderSeed,
  SUPABASE_BASE_EXTENSIONS,
  SUPABASE_EVENT_TRIGGERS,
  SUPABASE_EXTENSIONS,
  SUPABASE_PUBLIC_SCHEMA_GRANTS,
  SUPABASE_ROLES,
  SUPABASE_SCHEMAS,
  SUPABASE_SURFACES,
  type ProviderSurface,
} from "./provider/supabase"
