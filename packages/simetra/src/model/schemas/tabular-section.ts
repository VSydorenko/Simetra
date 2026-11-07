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
import type { SchemaRule } from "./rules"

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
  .superRefine((section, ctx) => {
    // Реквізит ТЧ лінивим не буває (Рд25): масив ТЧ — повна заміна, і рядок
    // без лінивого поля стер би його значення.
    section.attributes.forEach((attribute, index) => {
      if (attribute.load !== "lazy") return
      ctx.addIssue({
        code: "custom",
        message: "A tabular section attribute cannot be lazy",
        path: ["attributes", index, "load"],
        params: { rule: "attribute.lazy-not-allowed" satisfies SchemaRule },
      })
    })
  })
  .meta({ description: "Tabular section: a list of rows owned by an object." })

export type TabularSection = z.infer<typeof tabularSectionSchema>
