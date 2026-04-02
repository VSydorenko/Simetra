import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { tabularSectionSchema } from "./tabular-section"
import { metadataRefSchema } from "./metadata-ref"
import { isSqlReservedWord } from "./sql-reserved-words"

/** BRD §5.3 — Document */
export const documentSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("Document"),
  name: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only")
    .refine((n) => !isSqlReservedWord(n), { message: "Name is a SQL reserved word" }),
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
  attributes: z
    .array(attributeSchema)
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Attribute names must be unique" },
    )
    .default([]),
  tabularSections: z
    .array(tabularSectionSchema)
    .refine(
      (sections) => new Set(sections.map((s) => s.name)).size === sections.length,
      { message: "Tabular section names must be unique" },
    )
    .default([]),
})

export type Document = z.infer<typeof documentSchema>
