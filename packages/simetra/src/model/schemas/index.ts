// Base types
export { localizedStringSchema, type LocalizedString } from "./localized-string"
export {
  METADATA_KINDS,
  metadataKindSchema,
  type MetadataKind,
} from "./metadata-kind"
export { metadataRefSchema, type MetadataRef } from "./metadata-ref"
export {
  attributeSchema,
  catalogAttributeSchema,
  type Attribute,
  type CatalogAttribute,
} from "./attribute"
export { PLATFORM_SCHEMA, appSchemaNameSchema } from "./pg-schema"
export { tabularSectionSchema, type TabularSection } from "./tabular-section"
export {
  compositeIndexesSchema,
  type CompositeIndexes,
} from "./composite-index"
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
  UUID_TEXT,
  valueTypeShape,
  refineValueType,
  isScalarDefault,
  defaultMayRepeat,
  defaultViolatesValueChecks,
  type DefaultValue,
  type LogicalType,
  type ValueType,
} from "./value-type"
export { SCHEMA_RULES, type SchemaRule } from "./rules"

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
  accessDimensionSchema,
  accessMappingSchema,
  accessSchema,
  assignedOnSchema,
  assignmentSourceSchema,
  customActionSchema,
  customActionsSchema,
  extentSchema,
  grantEntryForm,
  grantEntrySchema,
  membershipSourceSchema,
  objectSelectorSchema,
  ownershipSchema,
  rightsCarrierSchema,
  rightsSetSchema,
  roleAssignedOnSchema,
  roleSchema,
  setGrantEntrySchema,
  sourceConditionSchema,
  type AccessDimension,
  type AccessMapping,
  type AssignedOn,
  type AssignmentSource,
  type CustomAction,
  type Extent,
  type GrantEntry,
  type MembershipSource,
  type ObjectSelector,
  type RightsCarrier,
  type SourceCondition,
  type RightsSet,
  type Role,
  type RoleAssignedOn,
  type SetGrantEntry,
} from "./rights"
export {
  customTableSchema,
  customTableColumnSchema,
  type CustomTable,
  type CustomTableColumn,
  type Deferrable,
  type PgQualifiedName,
  type RowLevelSecurity,
} from "./custom-table"
export {
  MEMBERSHIP_SET_FUNCTION,
  NO_SCOPE,
  scopeKindSchema,
  type ScopeKind,
} from "./scope"
export {
  PUBLIC_READ_PURPOSES,
  PUBLIC_READ_ROLES,
  publicReadSchema,
  type PublicReadRole,
} from "./public-read"
export { pgEnumSchema, type PgEnum } from "./pg-enum"
export {
  DELETE_EVENTS,
  SUBSCRIPTION_EVENTS,
  eventSubscriptionSchema,
  type EventSubscription,
  type SubscriptionEvent,
} from "./event-subscription"

// Debt ratchet of verbatim SQL
export { SQL_DEBT_FILE, sqlDebtSchema, type SqlDebt } from "./sql-debt"

// Project
export {
  projectSchema,
  DATABASE_PROVIDERS,
  COMMAND_SETTING,
  PLATFORM_ROLES,
  PLATFORM_SETTING_PREFIX,
  PROTECTED_SESSION_SETTINGS,
  PROVIDER_API_ROLES,
  PROVIDER_EVENT_SOURCES,
  PROVIDER_IDENTITY_SOURCES,
  PROVIDER_SCHEMAS,
  PROVIDER_SQL_TEXT_FUNCTIONS,
  SESSION_CLAIMS_SETTING,
  type ApiRolePurpose,
  type CommandContext,
  type DatabaseProvider,
  type GrantPurpose,
  type IdentityNameSource,
  type IdentitySource,
  type PlatformRolePurpose,
  type ProviderApiRoles,
  type ProviderEventSource,
  type Project,
  type RequestRolePurpose,
} from "./project"
