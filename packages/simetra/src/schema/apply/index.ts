export { ApplyConnectionLost, ApplyDbError } from "./port"
export type { ApplyDatabase, ApplyTransaction } from "./port"
export {
  compareFingerprints,
  FINGERPRINT_SECTIONS,
  FINGERPRINT_VERSION,
  readFingerprint,
} from "./fingerprint"
export type {
  CatalogFingerprint,
  FingerprintComparison,
  FingerprintSection,
} from "./fingerprint"
export { desiredForApply, type ApplyDesired } from "./desired"
export {
  APPLY_STATE_FORMAT,
  applyStateOf,
  findApply,
  readApplyState,
  readAppliedPromotions,
  renderApplyState,
  writeApplyStateStatements,
  type ApplyRecord,
  type ApplyState,
  type ApplyStateObjects,
  type MarkerRecord,
} from "./state"
export { PLATFORM_VERSION } from "./version"
export { tableKey } from "./table-key"
export {
  coversMode,
  footprintTables,
  joinModes,
  LOCK_MODE_SQL,
  lockPrivileges,
  planFootprint,
  planLocks,
  readLockRights,
  stepFootprint,
  TABLE_LOCK_MODES,
  type FootprintModels,
  type ImplicitLock,
  type StepFootprint,
  type TableLock,
  type TableLockMode,
} from "./locks"
export {
  accessChanges,
  adoptedReplacements,
  canonicalRenames,
  classifyRemovals,
  foreignSequenceRefusals,
  promotionPermissionItems,
  preservationPlan,
  preservationQuery,
  promotionTransition,
  readAccessDependents,
  readEquivalenceObjects,
  readWritePath,
  renameIntent,
  stepConversions,
  unclassifiedRemovals,
  unrealizedRenames,
  withTempNames,
  type AccessChange,
  type CanonicalRename,
  type EquivalenceObject,
  type Removal,
  type RemovalCover,
  type PromotionInput,
  type RenameIntent,
  type TransitionVerdict,
  type WritePath,
} from "./promotion"
export {
  DEFAULT_APPLY_TIMEOUTS,
  executePlan,
  type ApplyTimeouts,
  type ExecutablePlan,
  type ExecuteOptions,
  type ExecuteOutcome,
} from "./execute"
export {
  checkPermissions,
  classifySteps,
  comparePermissionItems,
  DRIFT_PERMISSION,
  intentStep,
  lintSteps,
  requiredPermissions,
  STEP_CLASSES,
  type PermissionItem,
  type PermissionSubject,
  type PlanStep,
  type StepClass,
} from "./steps"
export {
  checkGuardCasts,
  readTypeChangeDependents,
  typeChangeRefusals,
  typeGuards,
  type GuardProblem,
  type GuardResult,
  type TypeChange,
  type TypeChangeDependent,
} from "./type-guard"
export {
  CANONICAL_NAME_KINDS,
  PLAN_FORMAT,
  parsePlan,
  planArtifactSchema,
  planFileName,
  serializePlan,
  stampPlan,
  verifyPlanHash,
  type ParsedPlan,
  type PlanArtifact,
  type PreservedTable,
  type PromotionSection,
  type SectionTable,
} from "./artifact"
export {
  DRIFT_REASONS,
  driftGate,
  type DriftReport,
  type DriftVerdict,
} from "./drift"
export {
  buildPlan,
  checkOwnerMembership,
  type OwnerRefusalCode,
  type PlanDatabases,
  type PlanOutcome,
} from "./plan"
