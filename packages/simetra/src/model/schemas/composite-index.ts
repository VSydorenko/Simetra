import { z } from "zod"

/**
 * Складені індекси об'єкта чи його табличної частини. Назви — логічні імена
 * реквізитів і стандартних реквізитів тієї самої таблиці; носій скоупу
 * додає компілятор, тож у переліку його немає. Поле мають лише види з фактом
 * реєстру `compositeIndexes`: схема не приймає того, чого компілятор не
 * збудує.
 */
export const compositeIndexesSchema = z
  .array(
    z
      .strictObject({
        attributes: z
          .array(
            z.union([
              z.string().min(1),
              z.strictObject({
                name: z.string().min(1).meta({
                  description: "Logical name of the attribute.",
                }),
                order: z.literal("desc").meta({
                  description: "Descending order of this key part.",
                }),
              }),
            ])
          )
          .min(1)
          .meta({
            description:
              "Attributes and standard attributes of the same table in key order; a name, or { name, order: desc } for a descending part.",
          }),
      })
      .meta({
        description:
          "Non-unique btree index over attributes of the same table; the scope carrier is added first automatically.",
      })
  )
  .default([])

export type CompositeIndexes = z.infer<typeof compositeIndexesSchema>
