import { z } from "zod"
import { elementIdSchema } from "../schemas/element-id"
import { COMMAND_ERROR_CODES } from "./errors"
import { OBJECT_OPERATIONS, operationSchema } from "./operation"

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
