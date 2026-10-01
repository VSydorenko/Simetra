import { z } from "zod"
import { metadataKindSchema } from "./metadata-kind"
import { objectNameSchema } from "./identity"

/**
 * Посилання на інший об'єкт метаданих. Чи можна на цей вид посилатися —
 * факт реєстру видів і перевірка стадії 4, а не схеми.
 */
export const metadataRefSchema = z
  .object({
    kind: metadataKindSchema,
    name: objectNameSchema.meta({
      description: "Logical name of the referenced object.",
    }),
  })
  .meta({
    description:
      "Reference to a metadata object by kind and logical name; the compiler resolves it to an id.",
  })

export type MetadataRef = z.infer<typeof metadataRefSchema>
