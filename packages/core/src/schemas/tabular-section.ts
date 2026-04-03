import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { isSqlReservedWord } from "./sql-reserved-words"

/** BRD §5.8 — Tabular section */
export const tabularSectionSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "Must be snake_case, Latin only")
    .refine((n) => !isSqlReservedWord(n), {
      message: "Name is a SQL reserved word",
    }),
  displayName: localizedStringSchema.optional(),
  attributes: z
    .array(attributeSchema)
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Attribute names must be unique" }
    )
    .default([]),
})

export type TabularSection = z.infer<typeof tabularSectionSchema>
