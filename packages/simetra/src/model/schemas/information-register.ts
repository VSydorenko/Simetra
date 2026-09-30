import { z } from "zod"
import { attributeSchema } from "./attribute"
import { metadataRefSchema } from "./metadata-ref"
import {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"

/** Регістр відомостей. */
export const informationRegisterSchema = z.object({
  ...objectHeaderShape,
  kind: z.literal("InformationRegister"),

  periodicity: z
    .enum(["NonPeriodic", "Day", "Month", "Quarter", "Year"])
    .default("NonPeriodic"),
  writeMode: z
    .enum(["Independent", "RecorderSubordinate"])
    .default("Independent"),
  recorderTypes: z.array(metadataRefSchema).default([]),

  standardAttributeOverrides: standardAttributeOverridesSchema,

  // Ролі полів
  dimensions: z.array(attributeSchema).default([]),
  resources: z.array(attributeSchema).default([]),
  attributes: z.array(attributeSchema).default([]),
})

export type InformationRegister = z.infer<typeof informationRegisterSchema>
