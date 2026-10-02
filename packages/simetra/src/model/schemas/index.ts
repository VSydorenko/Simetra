// Base types
export { localizedStringSchema, type LocalizedString } from "./localized-string"
export {
  METADATA_KINDS,
  metadataKindSchema,
  type MetadataKind,
} from "./metadata-kind"
export { metadataRefSchema, type MetadataRef } from "./metadata-ref"
export { attributeSchema, type Attribute } from "./attribute"
export { tabularSectionSchema, type TabularSection } from "./tabular-section"
export {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"
export {
  metadataIdSchema,
  objectNameSchema,
  elementNameSchema,
  physicalNameSchema,
  MAX_PHYSICAL_NAME_BYTES,
  ATTRIBUTE_CASES,
  matchesAttributeCase,
  toSnakeCase,
  logicalObjectName,
  logicalElementName,
  type MetadataId,
  type AttributeCase,
} from "./identity"
export {
  LOGICAL_TYPES,
  valueTypeShape,
  refineValueType,
  type LogicalType,
  type ValueType,
} from "./value-type"
export { SCHEMA_RULES, type SchemaRule } from "./rules"
export { SQL_RESERVED_WORDS, isSqlReservedWord } from "./sql-reserved-words"

// Metadata types
export { catalogSchema, type Catalog } from "./catalog"
export { documentSchema, type Document, type MovementDecl } from "./document"
export {
  enumerationSchema,
  enumValueSchema,
  type Enumeration,
  type EnumValue,
} from "./enumeration"
export {
  informationRegisterSchema,
  type InformationRegister,
} from "./information-register"
export {
  accumulationRegisterSchema,
  resourceSchema,
  type AccumulationRegister,
  type AccumulationResource,
} from "./accumulation-register"
export { constantSchema, type Constant } from "./constant"
export {
  customTableSchema,
  customTableColumnSchema,
  type CustomTable,
  type CustomTableColumn,
  type Deferrable,
  type PgQualifiedName,
  type RowLevelSecurity,
} from "./custom-table"
export { NO_SCOPE, scopeKindSchema, type ScopeKind } from "./scope"
export { pgEnumSchema, type PgEnum } from "./pg-enum"

// Project
export { projectSchema, type Project } from "./project"
