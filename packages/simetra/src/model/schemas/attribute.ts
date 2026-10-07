import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import {
  elementNameSchema,
  metadataIdSchema,
  physicalNameSchema,
} from "./identity"
import {
  defaultValueSchema,
  refineUnique,
  refineUniqueWithin,
  refineValueType,
  valueTypeShape,
} from "./value-type"

/**
 * Реквізит (а також вимір чи ресурс регістра). Унікальність імен у масиві й
 * стиль написання імені перевіряють пізніші стадії — схема лише описує форму.
 */
const attributeShape = {
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
    .union([z.boolean(), z.literal("ignoreCase")])
    .default(false)
    .meta({
      description:
        'Whether values must be unique; "ignoreCase" compares a scalar String or Text value case-insensitively.',
    }),
  defaultValue: defaultValueSchema
    .optional()
    .meta({ description: "Default value of the attribute." }),
}

export const attributeSchema = z
  .strictObject(attributeShape)
  .superRefine((value, ctx) => {
    refineValueType(value, ctx)
    refineUnique(value, ctx)
  })

/**
 * Власний реквізит довідника: лише тут має сенс `uniqueWithin` (власник і
 * батько — стандартні реквізити довідника). Місце за налаштуваннями довідника
 * (є власники, є ієрархія) перевіряє стадія 4.
 */
export const catalogAttributeSchema = z
  .strictObject({
    ...attributeShape,
    uniqueWithin: z.enum(["owner", "parent"]).optional().meta({
      description:
        "Narrows uniqueness to the owner or the parent of the object (needs unique; own attributes of an object whose kind has that standard attribute).",
    }),
  })
  .superRefine((value, ctx) => {
    refineValueType(value, ctx)
    refineUnique(value, ctx)
    refineUniqueWithin(value, ctx)
  })

export type Attribute = z.infer<typeof attributeSchema>
export type CatalogAttribute = z.infer<typeof catalogAttributeSchema>
