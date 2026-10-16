export {
  COMPILER_RULES,
  diagnostic,
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
  type CompileOptions,
  type CompileResult,
  type CompiledModel,
  type CompiledScopeKind,
  type SourceObject,
} from "./compile"
export type { ResolvedReference } from "./stages/identity"
export type { CreationNode } from "./sql/dependencies"
export {
  platformFunctionSignatures,
  readSqlUnits,
  withoutLocations,
  type SqlSource,
  type SqlUnit,
} from "./sql/units"
export { loadSqlParser, relationNameText, type SqlParser } from "./sql/parse"
export { platformSchemaGrants } from "./platform/units"
export { MECHANICS_FUNCTION, mechanicsTriggerName } from "./mechanics-units"
export {
  grantTargetKeys,
  ownsTarget,
  platformGrantTargets,
} from "./function-execute"
export { loadPlpgsqlParser, type PlpgsqlParser } from "./sql/plpgsql"
export {
  statementTargets,
  triggerFunctionSchema,
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
export type {
  Contracts,
  PostingContract,
  QualifiedName,
  RegisterContract,
  ResourceMeasure,
  VirtualTableColumn,
  VirtualTableContract,
} from "./contracts"
export type { Presentation, PresentationBlock } from "./presentation"
export { emitEntityTypes } from "./codegen"
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
export { explainObject, type Explanation } from "./explain"
