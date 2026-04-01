import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { fieldTypeSchema } from "./field-type"
import { metadataRefSchema } from "./metadata-ref"

/** BRD §6.3 — Attribute (field) properties */
export const attributeSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "Must be snake_case, Latin only"),
  displayName: localizedStringSchema.optional(),
  type: fieldTypeSchema,
  required: z.boolean().default(false),
  indexed: z.boolean().default(false),
  unique: z.boolean().default(false),
  defaultValue: z.string().nullable().default(null),
  description: localizedStringSchema.optional(),
  /** For String type */
  length: z.number().int().positive().optional(),
  /** For Numeric type */
  precision: z.number().int().positive().optional(),
  /** For Numeric type */
  scale: z.number().int().nonnegative().optional(),
  /** For reference types — target object name */
  ref: z.string().optional(),
  /** For AnyRef — allowed target types */
  allowedTypes: z.array(metadataRefSchema).optional(),
})

export type Attribute = z.infer<typeof attributeSchema>
