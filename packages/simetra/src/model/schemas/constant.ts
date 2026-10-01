import { z } from "zod"
import { objectHeaderShape } from "./object-header"
import { refineValueType, valueTypeShape } from "./value-type"

/** Константа — окремий об'єкт зі значенням довільного логічного типу. */
export const constantSchema = z
  .strictObject({
    ...objectHeaderShape,
    kind: z
      .literal("Constant")
      .meta({ description: "Metadata kind; always Constant." }),
    ...valueTypeShape,
    defaultValue: z
      .union([z.string(), z.number(), z.boolean()])
      .optional()
      .meta({ description: "Initial value of the constant." }),
  })
  .superRefine(refineValueType)

export type Constant = z.infer<typeof constantSchema>
