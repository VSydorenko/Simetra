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
export const scopeKindSchema = z.object({
  id: metadataIdSchema.optional(),
  name: elementNameSchema,
  physicalName: physicalNameSchema.optional(),
  title: localizedStringSchema.optional(),
  root: z.union([
    z.object({ object: metadataRefSchema }),
    z.object({
      external: z.object({
        schema: z.string().min(1),
        table: z.string().min(1),
        column: z.string().min(1),
      }),
    }),
  ]),
  // Схема функції за відсутності — `defaultSchema` проєкту; підставляє стадія 3.
  setFunction: z.object({
    schema: z.string().min(1).optional(),
    name: z.string().min(1),
  }),
  onRootDelete: z.enum(["restrict", "cascade"]).default("restrict"),
})

export type ScopeKind = z.infer<typeof scopeKindSchema>
