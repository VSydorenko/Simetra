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
  ATTRIBUTE_CASES,
  matchesAttributeCase,
  toSnakeCase,
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
export {
  mappingExpressionSchema,
  type MappingExpression,
  conditionExpressionSchema,
  type ConditionExpression,
  registerKindSchema,
  type RegisterKind,
  registerRefSchema,
  type RegisterRef,
  movementMappingSetSchema,
  type MovementMappingSet,
  movementTypeSchema,
  type MovementType,
  movementSourceSchema,
  type MovementSource,
  postingMovementSchema,
  type PostingMovement,
  postingValidationSchema,
  type PostingValidation,
  postingSchema,
  type Posting,
} from "./posting"

// Metadata types
export { catalogSchema, type Catalog } from "./catalog"
export { documentSchema, type Document } from "./document"
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
  type AccumulationRegister,
} from "./accumulation-register"
export { constantSchema, type Constant } from "./constant"
export { customTableSchema, type CustomTable } from "./custom-table"

// Project
export { projectSchema, type Project } from "./project"

// Standard attributes
export {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
  type StandardAttribute,
  type StandardAttributeSettings,
} from "./standard-attributes"
