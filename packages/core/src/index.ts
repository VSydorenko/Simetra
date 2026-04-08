export * from "./schemas"
export {
  serializeMetadataObject,
  serializeProject,
  enrichSchemaUrl,
  enrichProjectSchemaUrl,
  buildConstantsSchemaUrl,
  buildFormSchemaUrl,
  serializeForm,
} from "./serialization"
export {
  findReferences,
  formatReference,
  KIND_TO_KEY,
  type FormattedReference,
  type Reference,
  type ReferenceKind,
} from "./find-references"
export {
  isPostingCompatible,
  type PostingCompatibilityResult,
} from "./posting-compatibility"
export {
  createValidationMessage,
  parseValidationMessage,
  formatValidationMessage,
  type ValidationMessageDescriptor,
  type ValidationMessageValues,
} from "./validation-message"

// Autoform — алгоритм автоформи
export { generateItemForm, generateListForm, resolveForm } from "./autoform"

// Metadata IO — shared parsing/serialization layer
export {
  parseMetadataFiles,
  buildProjectModelFromParsed,
  serializeToFiles,
  toKebabCase,
  KIND_TO_DIR,
  DIR_TO_KIND,
  type FileWarning,
  type FileEntry,
  type ParsedFiles,
  type ParsedObject,
  type ParsedForm,
  type BuildModelResult,
  type BuildModelOptions,
} from "./metadata-io"
