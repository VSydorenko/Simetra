import { z } from "zod"
import { metadataRefSchema } from "../schemas/metadata-ref"

/** Operations on an object that a command accepts (P4 spec §6.4). */
export const OBJECT_OPERATIONS = [
  "create",
  "update",
  "markDeletion",
  "delete",
] as const

export type ObjectOperation = (typeof OBJECT_OPERATIONS)[number]

/**
 * The object-module event an operation raises; `undefined` — none. Подію
 * визначає операція, а не дія контексту: на довідниках прав дія —
 * `administerRights` і для запису, і для видалення (Р-A3-2).
 */
export const OPERATION_EVENTS: Readonly<
  Record<ObjectOperation, "write" | undefined>
> = {
  create: "write",
  update: "write",
  markDeletion: "write",
  delete: undefined,
}

// `z.guid()`, а не `z.uuid()`: Postgres приймає UUID без RFC-варіанта.
const rowIdSchema = z.guid()
const expectedVersionSchema = z.int().min(1)
const valuesSchema = z.record(z.string(), z.unknown())
// Рядок ТЧ — логічні реквізити й ключ рядка; їх перевіряє T3 за каталогом.
const tabularSectionsSchema = z.record(
  z.string(),
  z.array(z.record(z.string(), z.unknown()))
)

/** One operation of a command, by logical names. */
export const operationSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("create"),
    object: metadataRefSchema,
    id: rowIdSchema,
    values: valuesSchema.optional(),
    tabularSections: tabularSectionsSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("update"),
    object: metadataRefSchema,
    id: rowIdSchema,
    expectedVersion: expectedVersionSchema,
    values: valuesSchema.optional(),
    tabularSections: tabularSectionsSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("markDeletion"),
    object: metadataRefSchema,
    id: rowIdSchema,
    expectedVersion: expectedVersionSchema,
    mark: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("delete"),
    object: metadataRefSchema,
    id: rowIdSchema,
    expectedVersion: expectedVersionSchema,
  }),
])

export type Operation = z.infer<typeof operationSchema>

/** A batch: a non-empty ordered list of operations run in one transaction. */
export const batchSchema = z.array(operationSchema).min(1)

export type Batch = z.infer<typeof batchSchema>
