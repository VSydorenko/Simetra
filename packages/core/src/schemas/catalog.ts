import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { tabularSectionSchema } from "./tabular-section"
import { metadataRefSchema } from "./metadata-ref"

/** BRD §5.2 — Catalog */
export const catalogSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("Catalog"),
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only"),
  displayName: localizedStringSchema.optional(),

  // Type settings
  codeLength: z.number().int().positive().default(9),
  codeType: z.enum(["String", "Number"]).default("String"),
  descriptionLength: z.number().int().positive().default(150),
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

  // User-defined sub-objects
  attributes: z.array(attributeSchema).default([]),
  tabularSections: z.array(tabularSectionSchema).default([]),
})

export type Catalog = z.infer<typeof catalogSchema>
