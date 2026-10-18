import { z } from "zod"
import { publicReadSchema } from "./public-read"
import { customActionsSchema } from "./rights"
import { attributeSchema, registerFieldSchema } from "./attribute"
import { physicalNameSchema } from "./identity"
import { metadataRefSchema } from "./metadata-ref"
import {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"

/** Регістр відомостей. */
export const informationRegisterSchema = z.strictObject({
  ...objectHeaderShape,
  kind: z.literal("InformationRegister").meta({
    description: "Metadata kind; always InformationRegister.",
  }),

  // Мітка виду — дискримінатор поліморфних пар і ідентифікатор об'єкта в
  // контракті прав; призначається раз, тож перейменування її не змінює.
  kindLabel: physicalNameSchema.optional().meta({
    description:
      "Physical kind label of the object. Assigned once at creation and never changed, so a rename keeps it.",
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

  publicRead: publicReadSchema,
  customActions: customActionsSchema,

  standardAttributeOverrides: standardAttributeOverridesSchema,

  // Ролі полів
  dimensions: z
    .array(registerFieldSchema)
    .default([])
    .meta({ description: "Dimensions: the key fields of a record." }),
  resources: z
    .array(registerFieldSchema)
    .default([])
    .meta({ description: "Resources: the value fields of a record." }),
  attributes: z
    .array(attributeSchema)
    .default([])
    .meta({ description: "Attributes: extra information of a record." }),
})

export type InformationRegister = z.infer<typeof informationRegisterSchema>
