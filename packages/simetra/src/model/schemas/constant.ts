import { z } from "zod"
import { publicReadSchema } from "./public-read"
import { physicalNameSchema } from "./identity"
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

    // Мітка виду — дискримінатор поліморфних пар і ідентифікатор об'єкта в
    // контракті прав; призначається раз, тож перейменування її не змінює.
    kindLabel: physicalNameSchema.optional().meta({
      description:
        "Physical kind label of the object. Assigned once at creation and never changed, so a rename keeps it.",
    }),
    publicRead: publicReadSchema,
    ...valueTypeShape,
    defaultValue: defaultValueSchema
      .optional()
      .meta({ description: "Initial value of the constant." }),
  })
  .superRefine(refineValueType)

export type Constant = z.infer<typeof constantSchema>
