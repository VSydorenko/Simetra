// Base types
export { localizedStringSchema, type LocalizedString } from "./localized-string"
export { fieldTypeSchema, type FieldType } from "./field-type"
export { metadataKindSchema, type MetadataKind } from "./metadata-kind"
export {
  metadataRefSchema,
  type MetadataRef,
  referenceableKindSchema,
  type ReferenceableKind,
  attributeRefTargetSchema,
} from "./metadata-ref"
export { attributeSchema, type Attribute } from "./attribute"
export { tabularSectionSchema, type TabularSection } from "./tabular-section"
export { SQL_RESERVED_WORDS, isSqlReservedWord } from "./sql-reserved-words"
export {
  TECHNICAL_NAME_PATTERNS,
  STRING_LENGTH,
  NUMERIC_PRECISION,
  NUMERIC_SCALE,
  matchesTechnicalName,
  type TechnicalNameFormat,
} from "./technical-name"
export {
  KIND_PREFIX,
  toSnakeCase,
  physicalObjectName,
  physicalTabularName,
} from "./physical-naming"
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
export { enumerationSchema, type Enumeration } from "./enumeration"
export {
  informationRegisterSchema,
  type InformationRegister,
} from "./information-register"
export {
  accumulationRegisterSchema,
  type AccumulationRegister,
} from "./accumulation-register"
export {
  constantSchema,
  constantValueTypeSchema,
  constantsFileSchema,
  type Constant,
  type ConstantValueType,
  type ConstantsFile,
} from "./constant"
export { customTableSchema, type CustomTable } from "./custom-table"

// Forms (Phase 3)
export {
  formKindSchema,
  formSchema,
  formSupportedKinds,
  formLayoutElementSchema,
  toolbarItemSchema,
  commandBarItemSchema,
  formWidthSchema,
  type FormKind,
  type FormSchema,
  type FormSupportedKind,
  type FormLayoutElement,
  type FormFieldElement,
  type FormTabularSectionElement,
  type FormSeparatorElement,
  type FormLabelElement,
  type FormGroupElement,
  type FormColumnElement,
  type FormColumnsElement,
  type FormTabElement,
  type FormTabsElement,
  type FormAccordionElement,
  type ToolbarItem,
  type CommandBarItem,
  type FormWidth,
} from './form'

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
