export {
  COMPILER_RULES,
  diagnostic,
  sortDiagnostics,
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
export { readSqlUnits, type SqlSource, type SqlUnit } from "./sql/units"
export { loadSqlParser, type SqlParser } from "./sql/parse"
export {
  triggerFunctionSchema,
  unitPlacement,
  unitTarget,
  unitTargets,
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
export { canonicalSnapshot, canonicalize } from "./canonical"
export {
  addElement,
  addElementInput,
  applyChanges,
  changesBetween,
  completeFiles,
  containerTarget,
  createObject,
  createObjectInput,
  deleteElement,
  deleteInput,
  elementTarget,
  fixFiles,
  sqlDebtText,
  renameElement,
  renameInput,
  resolveTarget,
  type AddElementInput,
  type CompletionOptions,
  type ContainerTarget,
  type CreateObjectInput,
  type DeleteInput,
  type ElementTarget,
  type FileChange,
  type IdSource,
  type OperationResult,
  type RenameInput,
  type ResolvedTarget,
  type SchemaPathResolver,
} from "./operations"
export { explainObject, type Explanation } from "./explain"
