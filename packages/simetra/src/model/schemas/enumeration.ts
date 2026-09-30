import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import {
  metadataIdSchema,
  objectNameSchema,
  physicalNameSchema,
} from "./identity"
import { objectHeaderShape } from "./object-header"
import type { SchemaRule } from "./rules"
import { NO_SCOPE } from "./scope"

export const enumValueSchema = z.object({
  id: metadataIdSchema.optional(),
  name: objectNameSchema,
  /** Фізична мітка значення в БД. */
  physicalName: physicalNameSchema.optional(),
  title: localizedStringSchema.optional(),
})

export type EnumValue = z.infer<typeof enumValueSchema>

/** Перелік. Порядок значень — порядок масиву, окремого поля порядку немає. */
export const enumerationSchema = z
  .object({
    ...objectHeaderShape,
    kind: z.literal("Enumeration"),

    values: z.array(enumValueSchema).default([]),
  })
  .superRefine((value, ctx) => {
    // Значення переліку не мають рядків даних, тож належати скоупу нічому;
    // поле лишено лише для явного `none`.
    if (value.scope !== undefined && value.scope !== NO_SCOPE) {
      ctx.addIssue({
        code: "custom",
        message: `Enumeration scope can only be "${NO_SCOPE}"`,
        path: ["scope"],
        params: { rule: "scope.not-allowed" satisfies SchemaRule },
      })
    }
  })

export type Enumeration = z.infer<typeof enumerationSchema>
