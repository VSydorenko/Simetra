import { z } from "zod"
import { attributeSchema } from "./attribute"
import {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"

// Тимчасово: повністю переписується в наступній задачі плану.
/** Довільна таблиця. */
export const customTableSchema = z.object({
  ...objectHeaderShape,
  kind: z.literal("CustomTable"),

  autoAddPrimaryKey: z.boolean().default(true),

  standardAttributeOverrides: standardAttributeOverridesSchema,

  attributes: z.array(attributeSchema).default([]),
})

export type CustomTable = z.infer<typeof customTableSchema>
