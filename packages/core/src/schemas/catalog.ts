import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { tabularSectionSchema } from "./tabular-section"
import { metadataRefSchema } from "./metadata-ref"
import { isSqlReservedWord } from "./sql-reserved-words"

/** BRD §5.2 — Catalog */
export const catalogSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("Catalog"),
  name: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only")
    .refine((n) => !isSqlReservedWord(n), {
      message: "Name is a SQL reserved word",
    }),
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
  tabularSections: z
    .array(tabularSectionSchema)
    .refine(
      (sections) =>
        new Set(sections.map((s) => s.name)).size === sections.length,
      { message: "Tabular section names must be unique" }
    )
    .default([]),
})

export type Catalog = z.infer<typeof catalogSchema>
