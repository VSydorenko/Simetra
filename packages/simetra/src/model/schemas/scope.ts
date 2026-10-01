import { z } from "zod"
import {
  elementNameSchema,
  metadataIdSchema,
  physicalNameSchema,
} from "./identity"
import { localizedStringSchema } from "./localized-string"
import { metadataRefSchema } from "./metadata-ref"

/** Значення `scope` об'єкта, що явно виводить його зі скоупу. */
export const NO_SCOPE = "none"

/**
 * Вид скоупу проєкту (спека П2 §6). Корінь — об'єкт метаданих або зовнішня
 * таблиця; колонка зовнішнього кореня — фізична, бо логічного імені в чужої
 * таблиці немає.
 */
export const scopeKindSchema = z
  .object({
    id: metadataIdSchema.optional(),
    name: elementNameSchema,
    physicalName: physicalNameSchema.optional(),
    title: localizedStringSchema.optional().meta({
      description: "Human-readable title of the scope kind.",
    }),
    root: z
      .union([
        z.object({
          object: metadataRefSchema.meta({
            description: "Metadata object that is the scope root.",
          }),
        }),
        z.object({
          external: z
            .object({
              schema: z.string().min(1).meta({
                description: "PostgreSQL schema of the external root table.",
              }),
              table: z.string().min(1).meta({
                description: "Physical name of the external root table.",
              }),
              column: z.string().min(1).meta({
                description: "Physical key column of the external root table.",
              }),
            })
            .meta({ description: "Root table outside the metadata." }),
        }),
      ])
      .meta({
        description:
          "Root of the scope: a metadata object or an external table.",
      }),
    // Схема функції за відсутності — `defaultSchema` проєкту; підставляє стадія 3.
    setFunction: z
      .object({
        schema: z.string().min(1).optional().meta({
          description:
            "PostgreSQL schema of the function; defaultSchema when absent.",
        }),
        name: z
          .string()
          .min(1)
          .meta({ description: "Physical name of the function." }),
      })
      .meta({
        description:
          "SQL function that returns the set of scope values visible to the current user.",
      }),
    onRootDelete: z.enum(["restrict", "cascade"]).default("restrict").meta({
      description:
        "What happens to scoped rows when the scope root is deleted.",
    }),
  })
  .meta({ description: "Scope kind of the application (tenant dimension)." })

export type ScopeKind = z.infer<typeof scopeKindSchema>
