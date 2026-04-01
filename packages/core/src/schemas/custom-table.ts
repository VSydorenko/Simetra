import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"

/** BRD §5.9 — Custom Table */
export const customTableSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("CustomTable"),
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only"),
  displayName: localizedStringSchema.optional(),

  // Type settings
  autoAddPrimaryKey: z.boolean().default(true),

  // User-defined sub-objects
  attributes: z.array(attributeSchema).default([]),
})

export type CustomTable = z.infer<typeof customTableSchema>
