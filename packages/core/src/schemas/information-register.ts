import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { metadataRefSchema } from "./metadata-ref"
import { isSqlReservedWord } from "./sql-reserved-words"
import { TECHNICAL_NAME_PATTERNS } from "./technical-name"

/** BRD §5.5 — Information Register */
export const informationRegisterSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("InformationRegister"),
  name: z
    .string()
    .regex(TECHNICAL_NAME_PATTERNS.PascalCase, "PascalCase, Latin only")
    .refine((n) => !isSqlReservedWord(n), {
      message: "Name is a SQL reserved word",
    }),
  displayName: localizedStringSchema.optional(),

  // Type settings
  periodicity: z
    .enum(["NonPeriodic", "Day", "Month", "Quarter", "Year"])
    .default("NonPeriodic"),
  writeMode: z
    .enum(["Independent", "RecorderSubordinate"])
    .default("Independent"),
  recorderTypes: z.array(metadataRefSchema).default([]),

  // Користувацькі перевизначення описів стандартних реквізитів
  standardAttributeOverrides: z
    .record(
      z.string(),
      z.object({ description: localizedStringSchema.optional() })
    )
    .optional()
    .default({}),

  // Field roles
  dimensions: z
    .array(attributeSchema)
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Dimension names must be unique" }
    )
    .default([]),
  resources: z
    .array(attributeSchema)
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Resource names must be unique" }
    )
    .default([]),
  attributes: z
    .array(attributeSchema)
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Attribute names must be unique" }
    )
    .default([]),
})

export type InformationRegister = z.infer<typeof informationRegisterSchema>
