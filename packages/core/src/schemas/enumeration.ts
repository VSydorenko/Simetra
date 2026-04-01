import { z } from "zod"
import { localizedStringSchema } from "./localized-string"

/** BRD §5.4 — Enumeration */
export const enumerationSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("Enumeration"),
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only"),
  displayName: localizedStringSchema.optional(),

  values: z
    .array(
      z.object({
        name: z.string(),
        displayName: localizedStringSchema.optional(),
        order: z.number().int().nonnegative().optional(),
      })
    )
    .default([]),
})

export type Enumeration = z.infer<typeof enumerationSchema>
