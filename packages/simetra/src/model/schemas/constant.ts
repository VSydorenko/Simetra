import { z } from "zod"
import { objectHeaderShape } from "./object-header"
import { refineValueType, valueTypeShape } from "./value-type"

/** Константа — окремий об'єкт зі значенням довільного логічного типу. */
export const constantSchema = z
  .object({
    ...objectHeaderShape,
    kind: z.literal("Constant"),
    ...valueTypeShape,
    defaultValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .superRefine(refineValueType)

export type Constant = z.infer<typeof constantSchema>
