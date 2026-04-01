import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { fieldTypeSchema } from "./field-type"

/** BRD §5.7 — Constant */
export const constantSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("Constant"),
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only"),
  displayName: localizedStringSchema.optional(),
  valueType: fieldTypeSchema,
  defaultValue: z.unknown().optional(),
})

export type Constant = z.infer<typeof constantSchema>
