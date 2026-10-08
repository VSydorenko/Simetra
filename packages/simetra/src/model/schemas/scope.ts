import { z } from "zod"
import { appSchemaNameSchema } from "./pg-schema"
import {
  elementNameSchema,
  metadataIdSchema,
  physicalNameSchema,
} from "./identity"
import { localizedStringSchema } from "./localized-string"
import { metadataRefSchema } from "./metadata-ref"

/** Значення `setFunction` виду скоупу: функцію множини генерує компілятор з членства. */
export const MEMBERSHIP_SET_FUNCTION = "membership"

/** Значення `scope` об'єкта, що явно виводить його зі скоупу. */
export const NO_SCOPE = "none"

/**
 * Вид скоупу проєкту (спека П2 §6). Корінь — об'єкт метаданих або зовнішня
 * таблиця; колонка зовнішнього кореня — фізична, бо логічного імені в чужої
 * таблиці немає.
 */
export const scopeKindSchema = z
  .strictObject({
    id: metadataIdSchema.optional(),
    name: elementNameSchema,
    physicalName: physicalNameSchema.optional(),
    title: localizedStringSchema.optional().meta({
      description: "Human-readable title of the scope kind.",
    }),
    root: z
      .union([
        z.strictObject({
          object: metadataRefSchema.meta({
            description: "Metadata object that is the scope root.",
          }),
        }),
        z.strictObject({
          external: z
            .strictObject({
              schema: appSchemaNameSchema.min(1).meta({
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
    // `membership` — функція, яку компілятор генерує з довідника членства
    // виду (спека користувачів §8): типовий випадок не вимагає дослівного SQL.
    setFunction: z
      .union([
        z
          .strictObject({
            schema: appSchemaNameSchema.min(1).optional().meta({
              description:
                "PostgreSQL schema of the function; defaultSchema when absent.",
            }),
            name: z
              .string()
              .min(1)
              .meta({ description: "Physical name of the function." }),
          })
          .meta({ description: "SQL function defined in a .sql file." }),
        z.literal(MEMBERSHIP_SET_FUNCTION).meta({
          description:
            "Generated from the membership catalog of this scope kind: the scope values where the current user is a member.",
        }),
      ])
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
