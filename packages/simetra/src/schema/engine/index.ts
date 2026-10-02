export type {
  DbConnection,
  EngineAction,
  EngineCatalog,
  EngineDiagnostic,
  EnginePlan,
  EngineScope,
  Extracted,
  SchemaEngine,
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
  SUPABASE_EVENT_TRIGGERS,
  SUPABASE_EXTENSIONS,
  SUPABASE_SCHEMAS,
} from "./provider/supabase"
