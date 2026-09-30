import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { tabularSectionSchema } from "./tabular-section"
import { metadataRefSchema } from "./metadata-ref"
import {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"

/** Довідник. */
export const catalogSchema = z.object({
  ...objectHeaderShape,
  kind: z.literal("Catalog"),

  // Нуль означає, що реквізиту (коду чи найменування) в довідника немає.
  codeLength: z.number().int().nonnegative().default(9),
  codeType: z.enum(["String", "Number"]).default("String"),
  descriptionLength: z.number().int().nonnegative().default(150),
  hierarchyType: z
    .enum(["None", "FoldersAndItems", "ItemsOnly"])
    .default("None"),
  owners: z.array(metadataRefSchema).default([]),
  autonumber: z.boolean().default(true),
  codeUnique: z.boolean().default(true),
  mainPresentation: z.enum(["Code", "Description"]).default("Description"),
  predefinedItems: z
    .array(
      z.object({
        name: z.string(),
        description: localizedStringSchema.optional(),
      })
    )
    .default([]),

  standardAttributeOverrides: standardAttributeOverridesSchema,

  attributes: z.array(attributeSchema).default([]),
  tabularSections: z.array(tabularSectionSchema).default([]),
})

export type Catalog = z.infer<typeof catalogSchema>
