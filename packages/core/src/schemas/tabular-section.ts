import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"

/** BRD §5.8 — Tabular section */
export const tabularSectionSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "Must be snake_case, Latin only"),
  displayName: localizedStringSchema.optional(),
  attributes: z.array(attributeSchema).default([]),
})

export type TabularSection = z.infer<typeof tabularSectionSchema>
