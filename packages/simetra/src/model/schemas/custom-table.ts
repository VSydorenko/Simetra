import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { isSqlReservedWord } from "./sql-reserved-words"
import { TECHNICAL_NAME_PATTERNS } from "./technical-name"

/** BRD §5.9 — Custom Table */
export const customTableSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("CustomTable"),
  name: z
    .string()
    .regex(TECHNICAL_NAME_PATTERNS.PascalCase, "PascalCase, Latin only")
    .refine((n) => !isSqlReservedWord(n), {
      message: "Name is a SQL reserved word",
    }),
  displayName: localizedStringSchema.optional(),

  // Type settings
  autoAddPrimaryKey: z.boolean().default(true),

  // Користувацькі перевизначення описів стандартних реквізитів
  standardAttributeOverrides: z
    .record(
      z.string(),
      z.object({ description: localizedStringSchema.optional() })
    )
    .optional()
    .default({}),

  // User-defined sub-objects
  attributes: z
    .array(attributeSchema)
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Attribute names must be unique" }
    )
    .default([]),
})

export type CustomTable = z.infer<typeof customTableSchema>
