export {
  COMPILER_RULES,
  diagnostic,
  isRepairError,
  sortDiagnostics,
  valueAt,
  type CompilerRule,
  type Diagnostic,
  type DiagnosticParams,
  type Position,
  type Range,
  type RuleCode,
  type Severity,
} from "./diagnostics"
export {
  MESSAGES,
  localize,
  type Locale,
  type MessageEntry,
  type OutOfScopeReason,
} from "./messages"
export {
  compile,
  currentDebt,
  formPolicies,
  type CompileOptions,
  type CompileResult,
  type CompiledModel,
  type CompiledScopeKind,
  type SourceObject,
} from "./compile"
export { readProjectFile } from "./stages/files"
export { metadataRights } from "./pipeline"
export type { ResolvedReference } from "./stages/identity"
export type { CreationNode } from "./sql/dependencies"
export {
  grantRoles,
  hasFixedBody,
  isMovementQuery,
  platformFunctionSignatures,
  readSqlUnits,
  withoutLocations,
  FUNCTION_CLASSES,
  type SqlSource,
  type SqlUnit,
  type VerbatimUnit,
} from "./sql/units"
export {
  functionKey,
  identityKey,
  identityParts,
  keyIdentity,
  qualifiedName,
  splitIdentity,
  unitIdentity,
  unquoteIdent,
} from "./sql/identity"
export { loadSqlParser, relationNameText, type SqlParser } from "./sql/parse"
export { IDENTITY_TRIGGERS, platformSchemaGrants } from "./platform/units"
export {
  platformInstall,
  grantAtoms,
  type PlatformInstall,
} from "./platform/install"
export {
  platformRecogniser,
  type PlatformRecogniser,
  type PlatformReference,
  type RecognisedUnit,
} from "./platform/recogniser"
export { callersOfRole, executeGrants } from "./sql/execute-grants"
export { PUBLIC, grantFacts, type GrantFact } from "./sql/grant-facts"
export { guardArgsOf, type GuardArgs } from "./sql/guard-of"
export {
  AUTHOR_FUNCTION,
  authorTriggerName,
  authorUpdateTriggerName,
} from "./author-units"
export { hierarchyNames } from "./hierarchy-units"
export { languageStateNames } from "./language-state-units"
export {
  SHARED_TRIGGER_FUNCTIONS,
  platformTriggers,
  renderModelIndependentLayer,
  renderSharedTriggerFunctions,
  type PlatformTrigger,
  type PlatformTriggerFamily,
} from "./platform-triggers"
export { KEY_FUNCTION, keyTriggerNames } from "./key-units"
export {
  MECHANICS_FUNCTION,
  ROW_VERSION_COLUMN,
  ROW_VERSION_SEQUENCE,
  ROW_VERSION_SETTING,
  authorTableColumns,
  contentChangeCondition,
  mechanicsTables,
  mechanicsTriggerName,
  mechanicsUpdateTriggerName,
} from "./mechanics-units"
export {
  PLATFORM_BEFORE_ROW_LABELS,
  platformBeforeTriggerName,
  type PlatformBeforeRowLabel,
} from "./before-trigger-names"
export {
  carrierBackfillStatements,
  carrierFunctionNames,
  carrierTriggerNames,
  type CarrierBackfillStatement,
} from "./rights/carrier-units"
export {
  effectsFunctionName,
  effectsTriggerNames,
} from "./rights/effects-names"
export {
  grantTargetKeys,
  ownsTarget,
  platformGrantTargets,
} from "./function-execute"
export { closedShellProblem, extensionSchema } from "./sql/closed-forms"
export { isSecurityDefiner, isTriggerFunction } from "./sql/definer-reads"
export { FUNCTIONS_SCHEMA_FILE } from "./json-schema"
export { loadPlpgsqlParser, type PlpgsqlParser } from "./sql/plpgsql"
export {
  statementTargets,
  triggerFunctionCalls,
  unitPlacement,
  unitSubjectKeys,
  unitTarget,
  unitTargets,
  type UnitSubjectKey,
  type UnitTarget,
} from "./sql/unit-target"
// Вузли дерева розбору, яке віддає `SqlParser`: споживач розбору (адаптер
// двигуна в designer) бере їх звідси, а не тримає другий пін libpg-query
export type {
  Constraint,
  IndexElem,
  IndexStmt,
  Node,
  RangeVar,
} from "libpg-query"
export { mainTableOf, qualified } from "./contracts"
export { kindKeyColumns, type KindKey } from "./stages/model"
export { roleTableJoin, sourceConditions } from "./rights/functions"
export { rightsDomainRows } from "./rights/functions"
export { rightsGuardNames } from "./rights/guard-names"
export { effectiveHolderRows } from "./rights/holders"
export { fullAccessHolderRows } from "./rights/guard-units"
export {
  findStandardColumn,
  findStyleFreeColumn,
  isStandard,
  standardColumn,
  styleFreeColumn,
} from "./standard-column"
export { rightsLevelOf } from "./rights/system-catalogs"
export type {
  AssignmentSourceContract,
  Contracts,
  MembershipSourceContract,
  PostingContract,
  QualifiedName,
  RightsLevelKey,
  RegisterContract,
  ResourceMeasure,
  VirtualTableColumn,
  VirtualTableContract,
} from "./contracts"
export type { Presentation, PresentationBlock } from "./presentation"
export { emitEntityTypes } from "./codegen"
export {
  entityFields,
  type ElementSource,
  type EntityContext,
  type EntityField,
} from "./entity-fields"
export { buildRuntimeCatalog, kernelHashOf } from "./runtime-catalog"
export { buildClientCatalog } from "./client-catalog"
export { memberCheckFunctionName } from "./catalog-command/contracts"
export {
  canonicalSnapshot,
  canonicalize,
  serializeCanonical,
  sha256Hex,
} from "./canonical"
export {
  addElement,
  addElementInput,
  applyChanges,
  changesBetween,
  completeFiles,
  containerTarget,
  conversionClass,
  createObject,
  createObjectInput,
  declareFunction,
  declareFunctionInput,
  deleteElement,
  deleteInput,
  DATA_STEP_KINDS,
  derivePromotionFacts,
  elementTarget,
  fillCalls,
  fixFiles,
  modelFunctions,
  NOW_FUNCTIONS,
  PROMOTION_RECORD_FORMAT,
  promoteInput,
  promoteObject,
  promotionFileName,
  promotionMapping,
  promotionRecordHash,
  promotionRecordSchema,
  recordedFillKind,
  sqlDebtText,
  renameElement,
  renameInput,
  resolveTarget,
  uniqueDifferences,
  type AddElementInput,
  type CompletionOptions,
  type ContainerTarget,
  type ConversionClass,
  type CreateObjectInput,
  type DeclareFunctionInput,
  type DeleteInput,
  type DerivedFacts,
  type ElementTarget,
  type FieldDifference,
  type FileChange,
  type IdSource,
  type ModelFunctions,
  type OperationResult,
  type PromoteInput,
  type PromoteResult,
  type PromotionFacts,
  type PromotionMapping,
  type PromotionObject,
  type PromotionRecord,
  type RenameInput,
  type ResolvedTarget,
  type SchemaPathResolver,
  type UniqueShape,
} from "./operations"
export {
  explainFunction,
  explainObject,
  type Explanation,
  type FunctionExplanation,
} from "./explain"
