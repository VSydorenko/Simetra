import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { tabularSectionSchema } from "./tabular-section"
import { metadataRefSchema } from "./metadata-ref"

/** BRD §5.3 — Document */
export const documentSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("Document"),
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only"),
  displayName: localizedStringSchema.optional(),

  // Type settings
  numberLength: z.number().int().positive().default(11),
  numberType: z.enum(["String", "Number"]).default("String"),
  autonumber: z.boolean().default(true),
  numberPeriodicity: z
    .enum(["None", "Year", "Quarter", "Month", "Day"])
    .default("Year"),
  posting: z.boolean().default(true),
  registerMovements: z.array(metadataRefSchema).default([]),

  // User-defined sub-objects
  attributes: z.array(attributeSchema).default([]),
  tabularSections: z.array(tabularSectionSchema).default([]),
})

export type Document = z.infer<typeof documentSchema>
