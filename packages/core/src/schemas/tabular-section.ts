import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { isSqlReservedWord } from "./sql-reserved-words"
import { TECHNICAL_NAME_PATTERNS } from "./technical-name"

/** BRD §5.8 — Tabular section */
export const tabularSectionSchema = z.object({
  name: z
    .string()
    .regex(
      TECHNICAL_NAME_PATTERNS.snake_case,
      "Must be snake_case, Latin only",
    )
    .refine((n) => !isSqlReservedWord(n), {
      message: "Name is a SQL reserved word",
    }),
  displayName: localizedStringSchema.optional(),
  standardAttributeOverrides: z
    .record(
      z.string(),
      z.object({ description: localizedStringSchema.optional() })
    )
    .optional()
    .default({}),
  attributes: z
    .array(attributeSchema)
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Attribute names must be unique" }
    )
    .default([]),
})

export type TabularSection = z.infer<typeof tabularSectionSchema>
