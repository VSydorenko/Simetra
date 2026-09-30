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
    /**
     * Контроль залишків в оболонці проведення (спека П2 §7): ресурси — логічні
     * імена ресурсів цього регістра, їхнє існування перевіряє стадія 2.
     */
    balanceControl: z.object({ resources: z.array(z.string()) }).optional(),

    standardAttributeOverrides: standardAttributeOverridesSchema,

    // Ролі полів
    dimensions: z.array(attributeSchema).default([]),
    resources: z.array(attributeSchema).default([]),
    attributes: z.array(attributeSchema).default([]),
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
