import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { isSqlReservedWord } from "./sql-reserved-words"
import { TECHNICAL_NAME_PATTERNS } from "./technical-name"
import { createValidationMessage } from "../validation-message"

export const enumValueSchema = z.object({
  name: z
    .string()
    .min(1, createValidationMessage("validation.enumValue.nameRequired"))
    .regex(
      TECHNICAL_NAME_PATTERNS.PascalCase,
      createValidationMessage("validation.enumValue.namePascalCase"),
    ),
  displayName: localizedStringSchema.optional(),
  order: z.number().int().nonnegative().optional(),
})

export type EnumValue = z.infer<typeof enumValueSchema>

/** BRD §5.4 — Enumeration */
export const enumerationSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("Enumeration"),
  name: z
    .string()
    .regex(TECHNICAL_NAME_PATTERNS.PascalCase, "PascalCase, Latin only")
    .refine((n) => !isSqlReservedWord(n), {
      message: "Name is a SQL reserved word",
    }),
  displayName: localizedStringSchema.optional(),

  values: z.array(enumValueSchema).default([]),
})

export type Enumeration = z.infer<typeof enumerationSchema>
