import { z } from "zod"
import { attributeSchema } from "./attribute"
import { metadataRefSchema } from "./metadata-ref"
import {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"

/** Регістр накопичення. */
export const accumulationRegisterSchema = z
  .object({
    ...objectHeaderShape,
    kind: z.literal("AccumulationRegister"),

    registerType: z.enum(["Balance", "Turnover"]).default("Balance"),
    recorderTypes: z.array(metadataRefSchema).default([]),

    standardAttributeOverrides: standardAttributeOverridesSchema,

    // Ролі полів
    dimensions: z.array(attributeSchema).default([]),
    resources: z.array(attributeSchema).default([]),
    attributes: z.array(attributeSchema).default([]),
  })
  .superRefine((register, ctx) => {
    // Ресурси регістра накопичення сумуються, тож вони лише числові.
    register.resources.forEach((resource, index) => {
      if (resource.type !== "Integer" && resource.type !== "Numeric") {
        ctx.addIssue({
          code: "custom",
          message: "AccumulationRegister resources must be Integer or Numeric",
          path: ["resources", index, "type"],
          params: { rule: "register.resource-type" },
        })
      }
    })
  })

export type AccumulationRegister = z.infer<typeof accumulationRegisterSchema>
