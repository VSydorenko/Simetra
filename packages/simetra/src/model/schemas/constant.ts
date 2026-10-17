import { z } from "zod"
import { publicReadSchema } from "./public-read"
import { objectHeaderShape } from "./object-header"
import {
  defaultValueSchema,
  refineValueType,
  valueTypeShape,
} from "./value-type"

/** Константа — окремий об'єкт зі значенням довільного логічного типу. */
export const constantSchema = z
  .strictObject({
    ...objectHeaderShape,
    kind: z
      .literal("Constant")
      .meta({ description: "Metadata kind; always Constant." }),
    publicRead: publicReadSchema,
    ...valueTypeShape,
    defaultValue: defaultValueSchema
      .optional()
      .meta({ description: "Initial value of the constant." }),
  })
  .superRefine(refineValueType)

export type Constant = z.infer<typeof constantSchema>
