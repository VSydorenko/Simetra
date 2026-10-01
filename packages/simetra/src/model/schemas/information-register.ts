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
  kind: z.literal("InformationRegister").meta({
    description: "Metadata kind; always InformationRegister.",
  }),

  periodicity: z
    .enum(["NonPeriodic", "Day", "Month", "Quarter", "Year"])
    .default("NonPeriodic")
    .meta({ description: "Period granularity of the register records." }),
  writeMode: z
    .enum(["Independent", "RecorderSubordinate"])
    .default("Independent")
    .meta({
      description:
        "Whether records are written independently or by a recorder document.",
    }),
  recorderTypes: z.array(metadataRefSchema).default([]).meta({
    description: "Document kinds allowed to write records of this register.",
  }),

  standardAttributeOverrides: standardAttributeOverridesSchema,

  // Ролі полів
  dimensions: z
    .array(attributeSchema)
    .default([])
    .meta({ description: "Dimensions: the key fields of a record." }),
  resources: z
    .array(attributeSchema)
    .default([])
    .meta({ description: "Resources: the value fields of a record." }),
  attributes: z
    .array(attributeSchema)
    .default([])
    .meta({ description: "Attributes: extra information of a record." }),
})

export type InformationRegister = z.infer<typeof informationRegisterSchema>
