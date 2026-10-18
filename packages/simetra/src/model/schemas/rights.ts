import { z } from "zod"
import { elementNameSchema, metadataIdSchema } from "./identity"

/**
 * Кастомна дія об'єкта (спека прав §3): елемент з `id` і `name`, але без
 * `physicalName` — у даних дію називає її UUID, а не ім'я. `dml` не
 * оголошується: компілятор виводить його з того, чи є що писати, тож
 * оголошення не може розійтися з ефектами. `title`/`description` відкладено
 * до плану зі споживачем (Р1a-23).
 */
export const customActionSchema = z.strictObject({
  // Як у реквізиту: обов'язковість id дає стадія 2.
  id: metadataIdSchema.optional(),
  name: elementNameSchema.meta({
    description:
      "Logical name of the custom action, camelCase like the standard action words; must not repeat a standard action of the kind.",
  }),
  requires: z.array(elementNameSchema).default([]).meta({
    description:
      "Actions a holder of this action must also hold: standard action words of the kind or names of custom actions of the same object.",
  }),
  effects: z
    .strictObject({
      header: z
        .union([z.literal("all"), z.array(elementNameSchema)])
        .optional()
        .meta({
          description:
            "Header columns the action writes: all, or logical names of attributes and standard attributes of the object.",
        }),
      tabularSections: z.boolean().optional().meta({
        description: "Whether the action writes the tabular section rows.",
      }),
    })
    .default({})
    .meta({
      description:
        "What the action writes itself; an action that writes anything is an update.",
    }),
})

export type CustomAction = z.infer<typeof customActionSchema>

/** Кастомні дії об'єкта — поле видів з контрактом прав. */
export const customActionsSchema = z
  .array(customActionSchema)
  .default([])
  .meta({
    description:
      "Custom actions of the object beyond the standard actions of its kind.",
  })

/**
 * Носій прав (Рх21): реквізит самого об'єкта або шлях з двох кроків —
 * посилання в межах скоупу й реквізит його цілі. Довших шляхів немає:
 * кожен крок — це з'єднання в політиці рядка, а один крок покриває
 * «коментар задачі належить виконавцю задачі».
 */
export const rightsCarrierSchema = z
  .union([elementNameSchema, z.tuple([elementNameSchema, elementNameSchema])])
  .meta({
    description:
      "An attribute of this object, or a path [attribute, attribute of its target]",
  })

export type RightsCarrier = z.infer<typeof rightsCarrierSchema>

/** Власники рядка (спека прав §4.2): порожній перелік — це відсутність поля. */
export const ownershipSchema = z.array(rightsCarrierSchema).min(1)
