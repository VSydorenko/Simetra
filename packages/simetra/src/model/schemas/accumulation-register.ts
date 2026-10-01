import { z } from "zod"
import { attributeSchema } from "./attribute"
import {
  elementNameSchema,
  metadataIdSchema,
  physicalNameSchema,
} from "./identity"
import { localizedStringSchema } from "./localized-string"
import { metadataRefSchema } from "./metadata-ref"
import {
  objectHeaderShape,
  standardAttributeOverridesSchema,
} from "./object-header"
import { refineValueType, valueTypeShape } from "./value-type"

/**
 * Ресурс регістра накопичення. Ресурси сумуються в залишки й обороти, тож
 * форма вужча за реквізит: лише число з precision/scale — без length,
 * посилань, crossScope чи ознак індексу; строга схема відкидає їх як
 * невідомі ключі. Прапорця `required` немає: ресурс завжди NOT NULL, бо
 * значення дає кожен рух.
 */
export const resourceSchema = z
  .strictObject({
    id: metadataIdSchema.optional(),
    name: elementNameSchema,
    physicalName: physicalNameSchema.optional(),
    title: localizedStringSchema.optional().meta({
      description: "Human-readable title of the resource.",
    }),
    description: localizedStringSchema.optional().meta({
      description: "Description of the resource.",
    }),
    type: z.enum(["Integer", "Numeric"]).meta({
      description: "Logical value type; Integer or Numeric only.",
    }),
    precision: valueTypeShape.precision,
    scale: valueTypeShape.scale,
  })
  .superRefine(refineValueType)
  .meta({
    description: "Resource of an accumulation register: a summed number.",
  })

export type AccumulationResource = z.infer<typeof resourceSchema>

/** Регістр накопичення. */
export const accumulationRegisterSchema = z
  .strictObject({
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
      .strictObject({
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
    resources: z.array(resourceSchema).default([]).meta({
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
  })

export type AccumulationRegister = z.infer<typeof accumulationRegisterSchema>
