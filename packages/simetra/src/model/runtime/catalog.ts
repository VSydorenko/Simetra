import { z } from "zod"
import { metadataKindSchema } from "../schemas/metadata-kind"
import { metadataRefSchema } from "../schemas/metadata-ref"
import { DATABASE_PROVIDERS } from "../schemas/project"
import { LOGICAL_TYPES } from "../schemas/value-type"

/**
 * Base types a bound parameter is cast to. Без `character`: `$n::character`
 * — це `char(1)`, який мовчки обрізав би значення.
 */
export const CAST_TYPES = [
  "text",
  "uuid",
  "boolean",
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "date",
  "timestamp with time zone",
  "timestamp without time zone",
  "time without time zone",
  "interval",
  "character varying",
  "bytea",
  "json",
  "jsonb",
] as const

// Тип приведення потрапляє в SQL без лапок, тож форма закрита: базовий тип
// з переліку, можливо масив.
const CAST_TYPE = new RegExp(`^(?:${CAST_TYPES.join("|")})(?:\\[\\])?$`)

export const castTypeSchema = z.string().regex(CAST_TYPE)

export const qualifiedNameSchema = z.strictObject({
  schema: z.string(),
  name: z.string(),
})

export const runtimeAttributeSchema = z.strictObject({
  name: z.string(),
  column: z.string(),
  /** Лише для `type` і декодування; у SQL не йде. */
  pgType: z.string(),
  castType: castTypeSchema,
  type: z.enum([...LOGICAL_TYPES, "Raw"]),
  array: z.literal(true).optional(),
  required: z.boolean(),
  maxLength: z.int().min(1).optional(),
  precision: z.int().min(1).optional(),
  scale: z.int().min(0).optional(),
  insert: z.boolean(),
  update: z.boolean(),
  generated: z.literal(true).optional(),
  /** Значення `Ref` на перерахування: логічне ім'я й мітка бази. */
  enumValues: z
    .array(z.strictObject({ name: z.string(), label: z.string() }))
    .optional(),
  pair: z
    .strictObject({
      typeColumn: z.string(),
      targets: z.array(
        z.strictObject({ object: metadataRefSchema, label: z.string() })
      ),
    })
    .optional(),
})

export const runtimeConstraintSchema = z.strictObject({
  name: z.string(),
  kind: z.enum(["primaryKey", "unique", "check", "foreignKey"]),
  columns: z.array(z.string()),
})

export const runtimeSectionSchema = z.strictObject({
  name: z.string(),
  table: qualifiedNameSchema,
  key: z.string(),
  keyName: z.string(),
  parent: z.string(),
  parentName: z.string(),
  lineNumber: z.string(),
  lineNumberName: z.string(),
  attributes: z.array(runtimeAttributeSchema),
  constraints: z.array(runtimeConstraintSchema),
})

export const runtimeOperationTargetSchema = z.strictObject({
  function: qualifiedNameSchema,
  context: z.string(),
})

export const runtimeObjectSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: metadataKindSchema,
  kindLabel: z.string(),
  table: qualifiedNameSchema,
  key: z.string(),
  keyName: z.string(),
  versionColumn: z.string(),
  versionName: z.string(),
  scopeKindId: z.string().optional(),
  scopeColumn: z.string().optional(),
  attributes: z.array(runtimeAttributeSchema),
  tabularSections: z.array(runtimeSectionSchema),
  operations: z.strictObject({
    create: runtimeOperationTargetSchema.optional(),
    update: runtimeOperationTargetSchema.optional(),
    markDeletion: runtimeOperationTargetSchema.optional(),
    delete: runtimeOperationTargetSchema.optional(),
  }),
  constraints: z.array(runtimeConstraintSchema),
})

/** The runtime catalog: a projection of the compiled model (P4 spec §6.3). */
export const runtimeCatalogSchema = z.strictObject({
  format: z.literal(1),
  snapshotHash: z.string(),
  provider: z.enum(DATABASE_PROVIDERS),
  objects: z.array(runtimeObjectSchema),
})

/** A base cast type; `castTypeSchema` also accepts its array form. */
export type BaseCastType = (typeof CAST_TYPES)[number]
export type QualifiedName = z.infer<typeof qualifiedNameSchema>
export type RuntimeAttribute = z.infer<typeof runtimeAttributeSchema>
export type RuntimeConstraint = z.infer<typeof runtimeConstraintSchema>
export type RuntimeSection = z.infer<typeof runtimeSectionSchema>
export type RuntimeOperationTarget = z.infer<
  typeof runtimeOperationTargetSchema
>
export type RuntimeObject = z.infer<typeof runtimeObjectSchema>
export type RuntimeCatalog = z.infer<typeof runtimeCatalogSchema>
