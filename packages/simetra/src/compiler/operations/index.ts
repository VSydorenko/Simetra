export type { FileChange, OperationResult } from "./types"
export { applyChanges } from "./changes"
export {
  fixFiles,
  type CompletionOptions,
  type IdSource,
  type SchemaPathResolver,
} from "./fix"
export { createObject } from "./create"
export { addElement } from "./add"
export { resolveTarget, type ResolvedTarget } from "./target"
export {
  addElementInput,
  containerTarget,
  createObjectInput,
  elementTarget,
  type AddElementInput,
  type ContainerTarget,
  type CreateObjectInput,
  type ElementTarget,
} from "./inputs"
