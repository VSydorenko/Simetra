import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { metadataRefSchema } from "./metadata-ref"
import { isSqlReservedWord } from "./sql-reserved-words"

/** BRD §5.6 — Accumulation Register */
export const accumulationRegisterSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("AccumulationRegister"),
  name: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only")
    .refine((n) => !isSqlReservedWord(n), { message: "Name is a SQL reserved word" }),
  displayName: localizedStringSchema.optional(),

  // Type settings
  registerType: z.enum(["Balance", "Turnover"]).default("Balance"),
  recorderTypes: z.array(metadataRefSchema).default([]),

  // Користувацькі перевизначення описів стандартних реквізитів
  standardAttributeOverrides: z
    .record(z.string(), z.object({ description: localizedStringSchema.optional() }))
    .optional()
    .default({}),

  // Field roles
  dimensions: z
    .array(attributeSchema)
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Dimension names must be unique" },
    )
    .default([]),
  /** Resources must be Numeric or Integer for accumulation registers */
  resources: z
    .array(attributeSchema)
    .refine(
      (attrs) => attrs.every((a) => a.type === "Integer" || a.type === "Numeric"),
      { message: "AccumulationRegister resources must be Numeric or Integer type" },
    )
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Resource names must be unique" },
    )
    .default([]),
  attributes: z
    .array(attributeSchema)
    .refine(
      (attrs) => new Set(attrs.map((a) => a.name)).size === attrs.length,
      { message: "Attribute names must be unique" },
    )
    .default([]),
})

export type AccumulationRegister = z.infer<typeof accumulationRegisterSchema>
