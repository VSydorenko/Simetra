import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { fieldTypeSchema } from "./field-type"
import { attributeRefTargetSchema } from "./metadata-ref"
import { isSqlReservedWord } from "./sql-reserved-words"
import {
  TECHNICAL_NAME_PATTERNS,
  STRING_LENGTH,
  NUMERIC_PRECISION,
  NUMERIC_SCALE,
} from "./technical-name"
import { createValidationMessage } from "../validation-message"

/** BRD §6.3 — Attribute (field) properties */
export const attributeSchema = z
  .object({
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
    type: fieldTypeSchema,
    required: z.boolean().default(false),
    indexed: z.boolean().default(false),
    unique: z.boolean().default(false),
    defaultValue: z.string().nullable().default(null),
    description: localizedStringSchema.optional(),
    /** Для типу String */
    length: z.number().int().positive().optional(),
    /** Для типу Numeric */
    precision: z.number().int().positive().optional(),
    /** Для типу Numeric */
    scale: z.number().int().nonnegative().optional(),
    /** Для типу Ref — single reference: цільовий об'єкт (лише Catalog, Document, Enumeration) */
    ref: attributeRefTargetSchema.optional(),
    /** Для типу Ref — polymorphic reference: дозволені цільові типи */
    allowedTypes: z.array(attributeRefTargetSchema).optional(),
  })
  .superRefine((attr, ctx) => {
    // Валідація type-specific полів
    if (attr.type === "String" && attr.length == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: createValidationMessage(
          "validation.field.stringLengthRequired",
          { defaultValue: STRING_LENGTH }
        ),
        path: ["length"],
      })
    }
    if (attr.type !== "String" && attr.length != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "length is only valid when type is String",
        path: ["length"],
      })
    }
    if (attr.type === "Numeric" && attr.precision == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: createValidationMessage(
          "validation.field.numericPrecisionRequired",
          { defaultValue: NUMERIC_PRECISION }
        ),
        path: ["precision"],
      })
    }
    if (attr.type !== "Numeric" && attr.precision != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "precision is only valid when type is Numeric",
        path: ["precision"],
      })
    }
    if (attr.type === "Numeric" && attr.scale == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: createValidationMessage(
          "validation.field.numericScaleRequired",
          { defaultValue: NUMERIC_SCALE }
        ),
        path: ["scale"],
      })
    }
    if (attr.type !== "Numeric" && attr.scale != null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "scale is only valid when type is Numeric",
        path: ["scale"],
      })
    }

    // Валідація ref/allowedTypes
    const hasRef = !!attr.ref
    const hasAllowedTypes = !!attr.allowedTypes && attr.allowedTypes.length > 0

    if (attr.type !== "Ref") {
      if (hasRef) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ref is only valid when type is Ref",
          path: ["ref"],
        })
      }
      if (hasAllowedTypes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "allowedTypes is only valid when type is Ref",
          path: ["allowedTypes"],
        })
      }
      return
    }

    if (hasRef && hasAllowedTypes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ref and allowedTypes are mutually exclusive",
        path: ["ref"],
      })
    }
    if (!hasRef && !hasAllowedTypes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: createValidationMessage("validation.field.refTargetRequired"),
        path: ["ref"],
      })
    }
  })

export type Attribute = z.infer<typeof attributeSchema>
