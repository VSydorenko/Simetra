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

// Рядки ТЧ, які `update` видаляє явно: масив ТЧ — повна заміна, і без
// переліку викликач, що не назвав наявного рядка, видалив би його мовчки.
const deleteIdsSchema = z.record(
  z.string(),
  z.array(rowIdSchema).superRefine((ids, ctx) => {
    ids.forEach((id, i) => {
      if (ids.indexOf(id) !== i) {
        ctx.addIssue({ code: "custom", path: [i], message: "duplicate id" })
      }
    })
  })
)

/** One operation of a command, by logical names. */
export const operationSchema = z.discriminatedUnion("action", [
  // `id` обов'язковий, крім кореня скоупу: його id генерує T3; а
  // `creatorMember` — лише в кореня виду з творцем (спека П4 §6.13). Обидва
  // факти — у каталозі, тож їх перевіряє T3, а не схема.
  z.strictObject({
    action: z.literal("create"),
    object: metadataRefSchema,
    id: rowIdSchema.optional(),
    values: valuesSchema.optional(),
    tabularSections: tabularSectionsSchema.optional(),
    creatorMember: valuesSchema.optional(),
  }),
  z
    .strictObject({
      action: z.literal("update"),
      object: metadataRefSchema,
      id: rowIdSchema,
      expectedVersion: expectedVersionSchema,
      values: valuesSchema.optional(),
      tabularSections: tabularSectionsSchema.optional(),
      /**
       * Rows of a tabular section the update deletes, by row id. A section
       * array replaces the section as a whole, so every existing row must be
       * either in the array or here; the key is a section of `tabularSections`.
       */
      deleteIds: deleteIdsSchema.optional(),
    })
    .superRefine((op, ctx) => {
      for (const name of Object.keys(op.deleteIds ?? {})) {
        if (op.tabularSections?.[name] === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["deleteIds", name],
            message: "deleteIds names a section the update does not carry",
          })
        }
      }
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

/**
 * The most phases of one batch, and the most phases `ctx.run` may start in
 * one command transaction (P4-B spec §7.1).
 */
export const BATCH_MAX = 500

/** A batch: a non-empty ordered list of operations run in one transaction. */
export const batchSchema = z.array(operationSchema).min(1)

export type Batch = z.infer<typeof batchSchema>
