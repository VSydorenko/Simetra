// Base types
export { localizedStringSchema, type LocalizedString } from "./localized-string"
export {
  primitiveFieldType,
  referenceFieldType,
  fieldTypeSchema,
  type PrimitiveFieldType,
  type ReferenceFieldType,
  type FieldType,
} from "./field-type"
export { metadataKindSchema, type MetadataKind } from "./metadata-kind"
export { metadataRefSchema, type MetadataRef } from "./metadata-ref"
export { attributeSchema, type Attribute } from "./attribute"
export { tabularSectionSchema, type TabularSection } from "./tabular-section"
export { SQL_RESERVED_WORDS, isSqlReservedWord } from "./sql-reserved-words"

// Metadata types
export { catalogSchema, type Catalog } from "./catalog"
export { documentSchema, type Document } from "./document"
export { enumerationSchema, type Enumeration } from "./enumeration"
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
export {
  metadataObjectSchema,
  projectModelSchema,
  type MetadataObject,
  type ProjectModel,
} from "./project-model"

// Standard attributes
export {
  getStandardAttributes,
  getTabularSectionStandardAttributes,
  type StandardAttribute,
  type StandardAttributeSettings,
} from "./standard-attributes"
