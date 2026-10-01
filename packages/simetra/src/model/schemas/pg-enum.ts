import { z } from "zod"
import { objectHeaderShape } from "./object-header"

/**
 * Прийнятий PG-енам. Значення — фізичні мітки типу без власної ідентичності,
 * тому порядок значущий (порядок у PG-енамі), а дублікати заборонені.
 */
export const pgEnumSchema = z
  .object({
    // Енам-тип живе в схемі, а не в скоупі: поля `scope` у нього немає.
    ...z.object(objectHeaderShape).omit({ scope: true }).shape,
    kind: z
      .literal("PgEnum")
      .meta({ description: "Metadata kind; always PgEnum." }),
    values: z.array(z.string().min(1)).min(1).meta({
      description:
        "Physical enum labels in database order; duplicates are not allowed.",
    }),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.values.forEach((label, index) => {
      if (seen.has(label)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate enum value "${label}"`,
          path: ["values", index],
          params: { rule: "pgEnum.value-duplicate" },
        })
      }
      seen.add(label)
    })
  })

export type PgEnum = z.infer<typeof pgEnumSchema>
