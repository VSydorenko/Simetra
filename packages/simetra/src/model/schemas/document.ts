import { z } from "zod"
import { attributeSchema } from "./attribute"
import { tabularSectionSchema } from "./tabular-section"
import { metadataRefSchema } from "./metadata-ref"
import { postingSchema } from "./posting"
import {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"

/** Документ. */
export const documentSchema = z.object({
  ...objectHeaderShape,
  kind: z.literal("Document"),

  numberLength: z.number().int().positive().default(11),
  numberType: z.enum(["String", "Number"]).default("String"),
  autonumber: z.boolean().default(true),
  numberPeriodicity: z
    .enum(["None", "Year", "Quarter", "Month", "Day"])
    .default("Year"),
  posting: postingSchema.optional(),
  registerMovements: z.array(metadataRefSchema).default([]),

  standardAttributeOverrides: standardAttributeOverridesSchema,

  attributes: z.array(attributeSchema).default([]),
  tabularSections: z.array(tabularSectionSchema).default([]),
})

export type Document = z.infer<typeof documentSchema>
