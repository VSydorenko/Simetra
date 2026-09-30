import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import {
  elementNameSchema,
  metadataIdSchema,
  physicalNameSchema,
} from "./identity"
import { standardAttributeOverridesSchema } from "./object-header"

/** Таблична частина об'єкта. */
export const tabularSectionSchema = z.object({
  id: metadataIdSchema.optional(),
  name: elementNameSchema,
  physicalName: physicalNameSchema.optional(),
  title: localizedStringSchema.optional(),
  standardAttributeOverrides: standardAttributeOverridesSchema,
  attributes: z.array(attributeSchema).default([]),
})

export type TabularSection = z.infer<typeof tabularSectionSchema>
