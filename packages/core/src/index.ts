export * from "./schemas"
export {
  serializeMetadataObject,
  serializeProject,
  enrichSchemaUrl,
  enrichProjectSchemaUrl,
  buildConstantsSchemaUrl,
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
