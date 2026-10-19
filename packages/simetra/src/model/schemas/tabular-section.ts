import { z } from "zod"
import { compositeIndexesSchema } from "./composite-index"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import {
  elementNameSchema,
  metadataIdSchema,
  physicalNameSchema,
} from "./identity"
import { standardAttributeOverridesSchema } from "./object-header"

/** Таблична частина об'єкта. */
export const tabularSectionSchema = z
  .strictObject({
    id: metadataIdSchema.optional(),
    name: elementNameSchema,
    physicalName: physicalNameSchema.optional(),
    title: localizedStringSchema.optional().meta({
      description: "Human-readable title of the tabular section.",
    }),
    standardAttributeOverrides: standardAttributeOverridesSchema,
    attributes: z
      .array(attributeSchema)
      .default([])
      .meta({ description: "Attributes of the section rows." }),
    indexes: compositeIndexesSchema.meta({
      description: "Composite indexes over the section rows.",
    }),
  })
  .meta({ description: "Tabular section: a list of rows owned by an object." })

export type TabularSection = z.infer<typeof tabularSectionSchema>
