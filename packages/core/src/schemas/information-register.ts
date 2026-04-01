import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { attributeSchema } from "./attribute"
import { metadataRefSchema } from "./metadata-ref"

/** BRD §5.5 — Information Register */
export const informationRegisterSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("InformationRegister"),
  name: z.string().regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only"),
  displayName: localizedStringSchema.optional(),

  // Type settings
  periodicity: z
    .enum(["NonPeriodic", "Day", "Month", "Quarter", "Year"])
    .default("NonPeriodic"),
  writeMode: z
    .enum(["Independent", "RecorderSubordinate"])
    .default("Independent"),
  recorderTypes: z.array(metadataRefSchema).default([]),

  // Field roles
  dimensions: z.array(attributeSchema).default([]),
  resources: z.array(attributeSchema).default([]),
  attributes: z.array(attributeSchema).default([]),
})

export type InformationRegister = z.infer<typeof informationRegisterSchema>
