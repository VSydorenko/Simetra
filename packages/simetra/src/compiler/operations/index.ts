export type { FileChange, OperationResult } from "./types"
export { applyChanges, changesBetween } from "./changes"
export {
  completeFiles,
  fixFiles,
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
  createObjectInput,
  deleteInput,
  elementTarget,
  renameInput,
  type AddElementInput,
  type ContainerTarget,
  type CreateObjectInput,
  type DeleteInput,
  type ElementTarget,
  type RenameInput,
} from "./inputs"
