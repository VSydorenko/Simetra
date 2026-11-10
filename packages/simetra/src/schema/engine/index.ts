export type {
  DbConnection,
  EngineAction,
  EngineCatalog,
  EngineDiagnostic,
  EngineIdentity,
  EngineObjectRef,
  EnginePlan,
  EngineScope,
  EngineSetting,
  Extracted,
  LockedTable,
  SchemaEngine,
  ShadowOptions,
  ShadowOutcome,
} from "./port"
export {
  ENGINE_ACTION_VERBS,
  ENGINE_PREAMBLE_ALLOWED,
  ENGINE_TRANSACTIONALITIES,
} from "./port"
export {
  compareWithDesired,
  engineScope,
  type DesiredComparison,
  type ModelScope,
} from "./desired"
// Чисті функції й типи перепису та пресет провайдера: адаптер двигуна й
// читачі бази живуть у @simetrajs/designer (рішення Д5) і беруть їх звідси
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
  PROVIDER_LOCK_STATEMENTS,
  type ProviderLocks,
  type ProviderLockSource,
  type ProviderLockStatement,
  type ProviderSurface,
} from "./provider/supabase"
export {
  PROVIDER_BASE_EXTENSIONS,
  PROVIDER_EVENT_TRIGGERS,
  PROVIDER_EXPECTED_BLIND_FUNCTIONS,
  PROVIDER_INSTALLABLE_EXTENSIONS,
  PROVIDER_LOCKS,
  PROVIDER_PUBLIC_SCHEMA_GRANTS,
  PROVIDER_SHADOW_TEMPLATES,
  PROVIDER_UNMANAGED_EXTENSIONS,
  renderProviderSeed,
  PROVIDER_SURFACES,
  PROVIDER_SYSTEM_ROLES,
} from "./provider/presets"
