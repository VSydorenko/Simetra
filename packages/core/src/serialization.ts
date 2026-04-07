import type { MetadataObject } from "./schemas/project-model"
import type { Project } from "./schemas/project"
import type { MetadataKind } from "./schemas/metadata-kind"
import type { FormSchema } from "./schemas/form"

// MetadataKind → kebab-case slug for $schema URL
const KIND_SLUG: Record<MetadataKind, string> = {
  Catalog: "catalog",
  Document: "document",
  Enumeration: "enumeration",
  InformationRegister: "information-register",
  AccumulationRegister: "accumulation-register",
  Constant: "constant",
  CustomTable: "custom-table",
}

/**
 * Build $schema URL for a metadata object.
 * Convention: https://simetra.dev/schemas/v{schemaVersion}/{kind-kebab}.schema.json
 */
function normalizeVersion(version: string): string {
  const [major, minor] = version.split(".")
  // BRD §7.7: trailing .0 видаляється — "1.0" → "1", "1.1" → "1.1"
  return !minor || minor === "0" ? major : `${major}.${minor}`
}

function buildSchemaUrl(slug: string, schemaVersion: string): string {
  return `https://simetra.dev/schemas/v${normalizeVersion(schemaVersion)}/${slug}.schema.json`
}

/**
 * Enrich a metadata object with the canonical $schema URL.
 * Always overwrites $schema to prevent stale URLs after version bumps.
 */
export function enrichSchemaUrl<T extends MetadataObject>(
  obj: T,
  schemaVersion: string
): T {
  const slug = KIND_SLUG[obj.kind]
  return { ...obj, $schema: buildSchemaUrl(slug, schemaVersion) }
}

/**
 * Enrich a Project with the canonical $schema URL.
 */
export function enrichProjectSchemaUrl(
  project: Project,
  schemaVersion: string
): Project {
  return { ...project, $schema: buildSchemaUrl("project", schemaVersion) }
}

/**
 * Build $schema URL for the constants collection file.
 */
export function buildConstantsSchemaUrl(schemaVersion: string): string {
  return buildSchemaUrl("constants", schemaVersion)
}

// Порядок ключів для проєкту
const PROJECT_KEY_ORDER = [
  "$schema",
  "schemaVersion",
  "name",
  "displayName",
  "defaultLocale",
  "database",
  "generation",
  "deployment",
]

const DATABASE_KEY_ORDER = ["target", "schema"]
const GENERATION_KEY_ORDER = [
  "tablePrefix",
  "enumStrategy",
  "constantsStrategy",
]
const DEPLOYMENT_KEY_ORDER = ["target", "supabase"]
const DEPLOYMENT_SUPABASE_KEY_ORDER = ["projectRef"]

// Порядок ключів для кожного типу метаданих
const CATALOG_KEY_ORDER = [
  "$schema",
  "kind",
  "name",
  "displayName",
  "codeLength",
  "codeType",
  "descriptionLength",
  "hierarchyType",
  "owners",
  "autonumber",
  "codeUnique",
  "mainPresentation",
  "predefinedItems",
  "standardAttributeOverrides",
  "attributes",
  "tabularSections",
]

const DOCUMENT_KEY_ORDER = [
  "$schema",
  "kind",
  "name",
  "displayName",
  "numberLength",
  "numberType",
  "autonumber",
  "numberPeriodicity",
  "posting",
  "registerMovements",
  "standardAttributeOverrides",
  "attributes",
  "tabularSections",
]

const ENUMERATION_KEY_ORDER = [
  "$schema",
  "kind",
  "name",
  "displayName",
  "values",
]

const INFORMATION_REGISTER_KEY_ORDER = [
  "$schema",
  "kind",
  "name",
  "displayName",
  "periodicity",
  "writeMode",
  "recorderTypes",
  "standardAttributeOverrides",
  "dimensions",
  "resources",
  "attributes",
]

const ACCUMULATION_REGISTER_KEY_ORDER = [
  "$schema",
  "kind",
  "name",
  "displayName",
  "registerType",
  "recorderTypes",
  "standardAttributeOverrides",
  "dimensions",
  "resources",
  "attributes",
]

const CONSTANT_KEY_ORDER = [
  "$schema",
  "kind",
  "name",
  "displayName",
  "valueType",
  "defaultValue",
]

const CUSTOM_TABLE_KEY_ORDER = [
  "$schema",
  "kind",
  "name",
  "displayName",
  "autoAddPrimaryKey",
  "standardAttributeOverrides",
  "attributes",
]

const FORM_KEY_ORDER = [
  '$schema',
  'kind',
  'objectRef',
  'title',
  'width',
  'layout',
  'toolbar',
  'commandBar',
]

const ATTRIBUTE_KEY_ORDER = [
  "name",
  "displayName",
  "type",
  "required",
  "indexed",
  "unique",
  "defaultValue",
  "description",
  "length",
  "precision",
  "scale",
  "ref",
  "allowedTypes",
]

const TABULAR_SECTION_KEY_ORDER = [
  "name",
  "displayName",
  "standardAttributeOverrides",
  "attributes",
]
const METADATA_REF_KEY_ORDER = ["kind", "name"]
const LOCALIZED_STRING_KEY_ORDER = ["uk", "en"]

// Posting-related key orders (BRD §5.3.1)
const POSTING_KEY_ORDER = ["movements", "validations"]
const POSTING_MOVEMENT_KEY_ORDER = [
  "register",
  "movementType",
  "source",
  "condition",
  "mappings",
]
const POSTING_MAPPING_SET_KEY_ORDER = ["dimensions", "resources", "attributes"]
const POSTING_VALIDATION_KEY_ORDER = [
  "type",
  "register",
  "dimensions",
  "resource",
  "message",
  "applyTo",
]
const ENUM_VALUE_KEY_ORDER = ["name", "displayName", "order"]
const PREDEFINED_ITEM_KEY_ORDER = ["name", "description"]

const METADATA_KEY_ORDERS: Record<string, string[]> = {
  Catalog: CATALOG_KEY_ORDER,
  Document: DOCUMENT_KEY_ORDER,
  Enumeration: ENUMERATION_KEY_ORDER,
  InformationRegister: INFORMATION_REGISTER_KEY_ORDER,
  AccumulationRegister: ACCUMULATION_REGISTER_KEY_ORDER,
  Constant: CONSTANT_KEY_ORDER,
  CustomTable: CUSTOM_TABLE_KEY_ORDER,
}

// Ключі, вкладені об'єкти яких потребують специфічного порядку
const NESTED_OBJECT_KEY_ORDERS: Record<string, string[]> = {
  displayName: LOCALIZED_STRING_KEY_ORDER,
  description: LOCALIZED_STRING_KEY_ORDER,
  database: DATABASE_KEY_ORDER,
  generation: GENERATION_KEY_ORDER,
  deployment: DEPLOYMENT_KEY_ORDER,
  supabase: DEPLOYMENT_SUPABASE_KEY_ORDER,
  ref: METADATA_REF_KEY_ORDER,
  objectRef: METADATA_REF_KEY_ORDER,
  posting: POSTING_KEY_ORDER,
  register: METADATA_REF_KEY_ORDER,
  mappings: POSTING_MAPPING_SET_KEY_ORDER,
  message: LOCALIZED_STRING_KEY_ORDER,
  title: LOCALIZED_STRING_KEY_ORDER,
}

// Ключі, масиви яких містять об'єкти зі специфічним порядком
const ARRAY_ITEM_KEY_ORDERS: Record<string, string[]> = {
  attributes: ATTRIBUTE_KEY_ORDER,
  dimensions: ATTRIBUTE_KEY_ORDER,
  resources: ATTRIBUTE_KEY_ORDER,
  tabularSections: TABULAR_SECTION_KEY_ORDER,
  owners: METADATA_REF_KEY_ORDER,
  registerMovements: METADATA_REF_KEY_ORDER,
  recorderTypes: METADATA_REF_KEY_ORDER,
  allowedTypes: METADATA_REF_KEY_ORDER,
  values: ENUM_VALUE_KEY_ORDER,
  predefinedItems: PREDEFINED_ITEM_KEY_ORDER,
  movements: POSTING_MOVEMENT_KEY_ORDER,
  validations: POSTING_VALIDATION_KEY_ORDER,
}

function orderKeys(
  obj: Record<string, unknown>,
  keyOrder: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of keyOrder) {
    if (key in obj && obj[key] !== undefined) {
      result[key] = obj[key]
    }
  }
  // Решта ключів (якщо є) — за порядком у вхідному об'єкті
  for (const key of Object.keys(obj)) {
    if (!(key in result) && obj[key] !== undefined) {
      result[key] = obj[key]
    }
  }
  return result
}

function canonicalizeValue(value: unknown, parentKey?: string): unknown {
  if (value === null || value === undefined) return value
  if (typeof value !== "object") return value

  if (Array.isArray(value)) {
    const itemKeyOrder = parentKey
      ? ARRAY_ITEM_KEY_ORDERS[parentKey]
      : undefined
    return value.map((item) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const record = item as Record<string, unknown>
        if (itemKeyOrder) {
          return canonicalizeObject(record, itemKeyOrder)
        }
        return record
      }
      return item
    })
  }

  const record = value as Record<string, unknown>

  // Вкладений об'єкт зі відомим порядком ключів
  if (parentKey && NESTED_OBJECT_KEY_ORDERS[parentKey]) {
    return canonicalizeObject(record, NESTED_OBJECT_KEY_ORDERS[parentKey])
  }

  return record
}

function canonicalizeObject(
  obj: Record<string, unknown>,
  keyOrder: string[]
): Record<string, unknown> {
  const ordered = orderKeys(obj, keyOrder)
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(ordered)) {
    result[key] = canonicalizeValue(value, key)
  }
  return result
}

/**
 * Серіалізує об'єкт метаданих у canonical JSON.
 * Ключі упорядковані за специфікацією, масиви зберігають порядок користувача.
 * Відступ: 2 пробіли. Trailing newline.
 */
export function serializeMetadataObject(obj: MetadataObject): string {
  const kind = obj.kind
  const keyOrder = METADATA_KEY_ORDERS[kind]
  if (!keyOrder) {
    throw new Error(`Unknown metadata kind: ${kind}`)
  }
  const canonical = canonicalizeObject(
    obj as unknown as Record<string, unknown>,
    keyOrder
  )
  return JSON.stringify(canonical, null, 2) + "\n"
}

/**
 * Серіалізує налаштування проєкту у canonical JSON.
 */
export function serializeProject(project: Project): string {
  const canonical = canonicalizeObject(
    project as unknown as Record<string, unknown>,
    PROJECT_KEY_ORDER
  )
  return JSON.stringify(canonical, null, 2) + "\n"
}

/**
 * Серіалізує форму у canonical JSON.
 */
export function serializeForm(form: FormSchema): string {
  const canonical = canonicalizeObject(
    form as unknown as Record<string, unknown>,
    FORM_KEY_ORDER,
  )
  return JSON.stringify(canonical, null, 2) + '\n'
}

/**
 * Build $schema URL для form файлу.
 */
export function buildFormSchemaUrl(schemaVersion: string): string {
  return buildSchemaUrl('form', schemaVersion)
}
