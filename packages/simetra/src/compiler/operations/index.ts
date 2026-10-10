export type { FileChange, OperationResult } from "./types"
export { applyChanges, changesBetween } from "./changes"
export {
  completeFiles,
  fixFiles,
  sqlDebtText,
  type CompletionOptions,
  type IdSource,
  type SchemaPathResolver,
} from "./fix"
export { createObject } from "./create"
export { addElement } from "./add"
export { renameElement } from "./rename"
export { deleteElement } from "./delete"
export { resolveTarget, type ResolvedTarget } from "./target"
export {
  addElementInput,
  containerTarget,
  conversionClass,
  createObjectInput,
  deleteInput,
  elementTarget,
  promoteInput,
  renameInput,
  type AddElementInput,
  type ContainerTarget,
  type ConversionClass,
  type CreateObjectInput,
  type DeleteInput,
  type ElementTarget,
  type PromoteInput,
  type RenameInput,
} from "./inputs"
export { promoteObject } from "./promote"
export type { PromoteResult, PromotionRecord } from "./promote/record"
