import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import {
  metadataIdSchema,
  objectNameSchema,
  physicalNameSchema,
} from "./identity"
import { objectHeaderShape } from "./object-header"

export const enumValueSchema = z.object({
  id: metadataIdSchema.optional(),
  name: objectNameSchema,
  /** Фізична мітка значення в БД. */
  physicalName: physicalNameSchema.optional(),
  title: localizedStringSchema.optional(),
})

export type EnumValue = z.infer<typeof enumValueSchema>

/** Перелік. Порядок значень — порядок масиву, окремого поля порядку немає. */
export const enumerationSchema = z.object({
  ...objectHeaderShape,
  kind: z.literal("Enumeration"),

  values: z.array(enumValueSchema).default([]),
})

export type Enumeration = z.infer<typeof enumerationSchema>
