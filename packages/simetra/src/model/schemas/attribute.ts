import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import {
  elementNameSchema,
  metadataIdSchema,
  physicalNameSchema,
} from "./identity"
import {
  defaultValueSchema,
  refineValueType,
  valueTypeShape,
} from "./value-type"

/**
 * Реквізит (а також вимір чи ресурс регістра). Унікальність імен у масиві й
 * стиль написання імені перевіряють пізніші стадії — схема лише описує форму.
 */
export const attributeSchema = z
  .strictObject({
    id: metadataIdSchema.optional(),
    name: elementNameSchema,
    physicalName: physicalNameSchema.optional(),
    title: localizedStringSchema.optional().meta({
      description: "Human-readable title of the attribute.",
    }),
    description: localizedStringSchema.optional().meta({
      description: "Description of the attribute.",
    }),
    ...valueTypeShape,
    required: z
      .boolean()
      .default(false)
      .meta({ description: "Whether a value is mandatory (NOT NULL)." }),
    indexed: z
      .boolean()
      .default(false)
      .meta({ description: "Whether the attribute is indexed." }),
    unique: z
      .boolean()
      .default(false)
      .meta({ description: "Whether values must be unique." }),
    defaultValue: defaultValueSchema
      .optional()
      .meta({ description: "Default value of the attribute." }),
  })
  .superRefine(refineValueType)

export type Attribute = z.infer<typeof attributeSchema>
