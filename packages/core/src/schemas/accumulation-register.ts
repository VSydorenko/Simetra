import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { metadataRefSchema } from "./metadata-ref"

/** BRD §5.6 — Accumulation Register */
export const accumulationRegisterSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("AccumulationRegister"),
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only"),
  displayName: localizedStringSchema.optional(),

  // Type settings
  registerType: z.enum(["Balance", "Turnover"]).default("Balance"),
  recorderTypes: z.array(metadataRefSchema).default([]),

  // Field roles
  dimensions: z.array(attributeSchema).default([]),
  /** Resources must be Numeric for accumulation registers */
  resources: z.array(attributeSchema).default([]),
  attributes: z.array(attributeSchema).default([]),
})

export type AccumulationRegister = z.infer<typeof accumulationRegisterSchema>
