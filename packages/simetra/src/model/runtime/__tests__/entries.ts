import { z } from "zod"
import {
  catalogEntryAttributeSchema,
  type CatalogEntry,
  type CatalogEntryAttribute,
  type CatalogEntrySection,
  type RuntimeAttribute,
  type RuntimeObject,
  type RuntimeSection,
} from "../catalog"

/**
 * Будівник записів каталогу для тестів T0: T0 не імпортує компілятор, тож
 * записи збираються тут, а не інлайн-JSON у кожному файлі. Типові значення
 * стабільні — тест перевизначає лише те, про що він: довідник зі скоупом,
 * пара, перерахування, лінивий `Text`, ТЧ з двома реквізитами.
 */

export const OBJECT_ID = "00000000-0000-4000-8000-000000000101"
export const SECTION_ID = "00000000-0000-4000-8000-000000000102"
export const SCOPE_KIND_ID = "00000000-0000-4000-8000-000000000103"
export const ORGANIZATION_ID = "00000000-0000-4000-8000-000000000104"

const PARENT_KEY = "task_lines_org_id_parent_id_fkey"

// Реквізити рантайму — первинні: спільна частина виводиться з них без
// `pgType`/`castType`, тож два каталоги не розходяться в типових значеннях.
const runtimeAttributes = (): RuntimeAttribute[] => [
  {
    name: "org",
    column: "org_id",
    pgType: "uuid",
    castType: "uuid",
    type: "Ref",
    required: true,
    insert: true,
    update: false,
    ref: { object: ORGANIZATION_ID, constraint: "task_org_id_fkey" },
  },
  {
    name: "title",
    column: "title",
    pgType: "character varying(100)",
    castType: "character varying",
    type: "String",
    required: true,
    maxLength: 100,
    insert: true,
    update: true,
  },
  {
    name: "status",
    column: "status",
    pgType: "text",
    castType: "text",
    type: "Ref",
    required: false,
    insert: true,
    update: true,
    enumValues: [
      { name: "Open", label: "open" },
      { name: "Closed", label: "closed" },
    ],
  },
  {
    name: "subject",
    column: "subject_id",
    pgType: "uuid",
    castType: "uuid",
    type: "Ref",
    required: false,
    insert: true,
    update: true,
    pair: {
      typeColumn: "subject_type",
      targets: [
        { object: { kind: "Catalog", name: "Project" }, label: "project" },
        { object: { kind: "Catalog", name: "Region" }, label: "region" },
      ],
    },
  },
  {
    name: "notes",
    column: "notes",
    pgType: "text",
    castType: "text",
    type: "Text",
    required: false,
    insert: true,
    update: true,
    load: "lazy",
  },
]

const runtimeSectionAttributes = (): RuntimeAttribute[] => [
  {
    name: "qty",
    column: "qty",
    pgType: "integer",
    castType: "integer",
    type: "Integer",
    required: true,
    insert: true,
    update: true,
  },
  {
    name: "comment",
    column: "comment",
    pgType: "text",
    castType: "text",
    type: "String",
    required: false,
    insert: true,
    update: true,
  },
]

// Не строга копія схеми спільної частини: розбір відкидає `pgType` і
// `castType`, а не відмовляє на них.
const sharedAttribute = z.object(catalogEntryAttributeSchema.shape)
const shared = (attribute: RuntimeAttribute): CatalogEntryAttribute =>
  sharedAttribute.parse(attribute)

const sectionBase = () => ({
  id: SECTION_ID,
  name: "lines",
  table: { schema: "public", name: "task_lines" },
  key: "id",
  keyName: "ref",
  parent: "parent_id",
  parentName: "parent",
  lineNumber: "line_number",
  lineNumberName: "lineNumber",
  parentConstraint: PARENT_KEY,
})

const objectBase = () => ({
  id: OBJECT_ID,
  name: "Task",
  kind: "Catalog" as const,
  kindLabel: "task",
  table: { schema: "public", name: "task" },
  key: "id",
  keyName: "ref",
  versionColumn: "version",
  versionName: "version",
  scopeKindId: SCOPE_KIND_ID,
  scopeColumn: "org_id",
})

/** An attribute of the shared catalog part; the default is a `String`. */
export const catalogEntryAttribute = (
  overrides: Partial<CatalogEntryAttribute> = {}
): CatalogEntryAttribute => ({
  ...shared(runtimeAttributes()[1]!),
  ...overrides,
})

/** A tabular section of the shared catalog part. */
export const catalogEntrySection = (
  overrides: Partial<CatalogEntrySection> = {}
): CatalogEntrySection => ({
  ...sectionBase(),
  attributes: runtimeSectionAttributes().map(shared),
  ...overrides,
})

/** A catalog object of the shared catalog part. */
export const catalogEntry = (
  overrides: Partial<CatalogEntry> = {}
): CatalogEntry => ({
  ...objectBase(),
  attributes: runtimeAttributes().map(shared),
  tabularSections: [catalogEntrySection()],
  ...overrides,
})

const runtimeSection = (): RuntimeSection => ({
  ...sectionBase(),
  attributes: runtimeSectionAttributes(),
  constraints: [
    {
      name: PARENT_KEY,
      kind: "foreignKey",
      columns: ["org_id", "parent_id"],
      references: ["org_id", "id"],
    },
  ],
})

/** A runtime catalog object: the shared part plus its runtime extensions. */
export const runtimeObject = (
  overrides: Partial<RuntimeObject> = {}
): RuntimeObject => ({
  ...objectBase(),
  attributes: runtimeAttributes(),
  tabularSections: [runtimeSection()],
  operations: {
    create: {
      function: { schema: "public", name: "task_save" },
      context: "write",
    },
    update: {
      function: { schema: "public", name: "task_save" },
      context: "write",
    },
  },
  constraints: [{ name: "task_pkey", kind: "primaryKey", columns: ["id"] }],
  ...overrides,
})
