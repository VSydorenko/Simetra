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
    kind: z.literal("AccumulationRegister").meta({
      description: "Metadata kind; always AccumulationRegister.",
    }),

    registerType: z.enum(["Balance", "Turnover"]).default("Balance").meta({
      description: "Balance keeps running totals; Turnover only accumulates.",
    }),
    recorderTypes: z.array(metadataRefSchema).default([]).meta({
      description: "Document kinds allowed to write records of this register.",
    }),
    /**
     * Контроль залишків в оболонці проведення (спека П2 §7): ресурси — логічні
     * імена ресурсів цього регістра, їхнє існування перевіряє стадія 2.
     */
    balanceControl: z
      .object({
        resources: z.array(z.string()).meta({
          description:
            "Logical names of resources whose balance is controlled.",
        }),
      })
      .optional()
      .meta({
        description:
          "Negative-balance control at posting; allowed only on a Balance register.",
      }),

    standardAttributeOverrides: standardAttributeOverridesSchema,

    // Ролі полів
    dimensions: z
      .array(attributeSchema)
      .default([])
      .meta({ description: "Dimensions: the key fields of a record." }),
    resources: z.array(attributeSchema).default([]).meta({
      description:
        "Resources: the summed value fields of a record; Integer or Numeric only.",
    }),
    attributes: z
      .array(attributeSchema)
      .default([])
      .meta({ description: "Attributes: extra information of a record." }),
  })
  .superRefine((register, ctx) => {
    // Від'ємний залишок має сенс лише там, де є залишки: оборотний регістр
    // лише накопичує обороти.
    if (
      register.balanceControl !== undefined &&
      register.registerType !== "Balance"
    ) {
      ctx.addIssue({
        code: "custom",
        message: "balanceControl is allowed only on a Balance register",
        path: ["balanceControl"],
        params: { rule: "register.balance-control-type" },
      })
    }
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
