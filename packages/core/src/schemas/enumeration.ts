import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { isSqlReservedWord } from "./sql-reserved-words"

/** BRD §5.4 — Enumeration */
export const enumerationSchema = z.object({
  $schema: z.string().optional(),
  kind: z.literal("Enumeration"),
  name: z
    .string()
    .regex(/^[A-Z][A-Za-z0-9]*$/, "PascalCase, Latin only")
    .refine((n) => !isSqlReservedWord(n), { message: "Name is a SQL reserved word" }),
  displayName: localizedStringSchema.optional(),

  values: z
    .array(
      z.object({
        name: z.string(),
        displayName: localizedStringSchema.optional(),
        order: z.number().int().nonnegative().optional(),
      })
    )
    .default([]),
})

export type Enumeration = z.infer<typeof enumerationSchema>
