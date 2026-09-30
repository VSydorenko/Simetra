import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import {
  elementNameSchema,
  metadataIdSchema,
  physicalNameSchema,
} from "./identity"
import { refineValueType, valueTypeShape } from "./value-type"

/**
 * Реквізит (а також вимір чи ресурс регістра). Унікальність імен у масиві й
 * стиль написання імені перевіряють пізніші стадії — схема лише описує форму.
 */
export const attributeSchema = z
  .object({
    id: metadataIdSchema.optional(),
    name: elementNameSchema,
    physicalName: physicalNameSchema.optional(),
    title: localizedStringSchema.optional(),
    description: localizedStringSchema.optional(),
    ...valueTypeShape,
    required: z.boolean().default(false),
    indexed: z.boolean().default(false),
    unique: z.boolean().default(false),
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .superRefine(refineValueType)

export type Attribute = z.infer<typeof attributeSchema>
