import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { fieldTypeSchema } from "./field-type"
import { isSqlReservedWord } from "./sql-reserved-words"
import { TECHNICAL_NAME_PATTERNS } from "./technical-name"

/**
 * BRD §5.7 — Constants cannot use Ref as valueType because they lack
 * ref/allowedTypes fields to specify a target. If Ref-constants are
 * needed in the future, add ref field first (Phase 2).
 */
export const constantValueTypeSchema = fieldTypeSchema.exclude(["Ref"])

export type ConstantValueType = z.infer<typeof constantValueTypeSchema>

/** BRD §5.7 — Constant */
export const constantSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("Constant"),
  name: z
    .string()
    .regex(TECHNICAL_NAME_PATTERNS.PascalCase, "PascalCase, Latin only")
    .refine((n) => !isSqlReservedWord(n), {
      message: "Name is a SQL reserved word",
    }),
  displayName: localizedStringSchema.optional(),
  valueType: constantValueTypeSchema,
  defaultValue: z.unknown().optional(),
})

export type Constant = z.infer<typeof constantSchema>

/** BRD §7.6 — Constants file wrapper schema (for direct file parsing in Phase 2 DDL) */
export const constantsFileSchema = z.object({
  $schema: z.string().optional(),
  constants: z.array(constantSchema),
})

export type ConstantsFile = z.infer<typeof constantsFileSchema>
