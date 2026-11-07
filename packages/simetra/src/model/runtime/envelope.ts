import { z } from "zod"
import { elementIdSchema } from "../schemas/element-id"
import { COMMAND_ERROR_CODES } from "./errors"
import { OBJECT_OPERATIONS, operationSchema } from "./operation"
import { queryFormSchema, readQuerySchema } from "./read"
import { INTEGER_TEXT } from "./values"

/**
 * Схеми форми передачі (спека П4-B §4.0): та сама операція, помилка й зміна,
 * що й у логічній формі, але об'єкт — UUID, ТЧ — id елемента, а імена —
 * фізичні колонки. Імена в даних перевіряє мапінг за каталогом, а не схема:
 * схема знає лише форму. Конверт — B1b-2.
 */

const wireObjectSchema = z.guid()

// Рядок ТЧ — фізичні колонки; ключ запису ТЧ — її id (рішення В4, В12), бо
// ім'я ТЧ змінює перейменування.
const wireTabularSectionsSchema = z.record(
  elementIdSchema,
  z.array(z.record(z.string(), z.unknown()))
)

// Варіанти беруться з логічної схеми, щоб дві форми не розійшлися полями:
// змінюються лише `object` і ключі ТЧ.
const [createSchema, updateSchema, markDeletionSchema, deleteSchema] =
  operationSchema.options

/** One operation of a command in wire form: object by UUID, physical columns. */
export const wireOperationSchema = z.discriminatedUnion("action", [
  createSchema.extend({
    object: wireObjectSchema,
    tabularSections: wireTabularSectionsSchema.optional(),
  }),
  updateSchema.extend({
    object: wireObjectSchema,
    tabularSections: wireTabularSectionsSchema.optional(),
  }),
  markDeletionSchema.extend({ object: wireObjectSchema }),
  deleteSchema.extend({ object: wireObjectSchema }),
])

export type WireOperation = z.infer<typeof wireOperationSchema>

/**
 * A command error in wire form: `object` by UUID; `path` and `attributes`
 * physical (`<column>` of the header, `<section id>.<column>` of a section,
 * a pair by its id column).
 */
export const wireCommandErrorSchema = z.strictObject({
  code: z.enum(COMMAND_ERROR_CODES),
  reason: z.string().optional(),
  object: wireObjectSchema.optional(),
  operation: z.enum(OBJECT_OPERATIONS).optional(),
  path: z.string().optional(),
  detail: z.string().optional(),
  currentVersion: z.int().optional(),
  kind: z.enum(["notNull", "unique", "check"]).optional(),
  attributes: z.array(z.string()).optional(),
  hashes: z
    .strictObject({ catalog: z.string(), applied: z.string().nullable() })
    .optional(),
  role: z.string().optional(),
})

export type WireCommandError = z.infer<typeof wireCommandErrorSchema>

/** One changed row in wire form: object by UUID. */
export const wireChangeSchema = z.strictObject({
  object: wireObjectSchema,
  scopeKind: z.string().optional(),
  scope: z.string().optional(),
  id: z.string(),
  version: z.int(),
  operation: z.enum(OBJECT_OPERATIONS),
})

export type WireChange = z.infer<typeof wireChangeSchema>

// Форми беруться з логічної схеми, як і варіанти операції: змінюються лише
// `object` і поля ТЧ, а імена у фільтрі, сортуванні й `include` — ті самі
// рядки, тепер фізичні колонки.
const [card, list, count, ownerLines, sectionList, sectionCount] =
  readQuerySchema.out.options

// Повтор id тут не перевіряється: після мапінгу його відхиляє логічна схема
// зі шляхом на дублі.
const wireSectionIdsSchema = z.array(elementIdSchema).min(1)

/**
 * A read query in wire form: the logical forms with the object by UUID,
 * physical columns in `where`, `orderBy` and `include`, and section ids in
 * `tabularSection` and `tabularSections`.
 */
export const wireReadQuerySchema = queryFormSchema([
  card.extend({
    object: wireObjectSchema,
    tabularSections: z
      .union([z.literal(true), wireSectionIdsSchema])
      .optional(),
  }),
  list.extend({ object: wireObjectSchema }),
  count.extend({ object: wireObjectSchema }),
  ownerLines.extend({
    object: wireObjectSchema,
    tabularSection: elementIdSchema,
  }),
  sectionList.extend({
    object: wireObjectSchema,
    tabularSection: elementIdSchema,
  }),
  sectionCount.extend({
    object: wireObjectSchema,
    tabularSection: elementIdSchema,
  }),
])

export type WireReadQuery = z.infer<typeof wireReadQuerySchema>

const wireRowSchema = z.record(z.string(), z.unknown())

/**
 * A read result in wire form: rows keyed by physical columns, `included`
 * keyed by the target object's UUID, `ownerVersion` as integer text (a
 * version, like the version column); or a count.
 */
export const wireReadResultSchema = z.union([
  z.strictObject({
    rows: z.array(wireRowSchema),
    included: z.record(wireObjectSchema, z.array(wireRowSchema)).optional(),
    ownerVersion: z.string().regex(INTEGER_TEXT).optional(),
  }),
  z.strictObject({
    count: z.int().min(0),
    capped: z.literal(true).optional(),
  }),
])

export type WireReadResult = z.infer<typeof wireReadResultSchema>
