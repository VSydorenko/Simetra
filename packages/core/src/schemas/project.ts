import { z } from "zod"
import { localizedStringSchema } from "./localized-string"

/** BRD §7.3 — Project file */
export const projectSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.string().default("1.0"),
  name: z.string(),
  displayName: localizedStringSchema.optional(),
  defaultLocale: z.enum(["uk", "en"]).default("uk"),
  database: z
    .object({
      target: z.literal("postgresql").default("postgresql"),
      schema: z.string().default("public"),
      namingConvention: z.enum(["snake_case", "camelCase"]).default("snake_case"),
    })
    .default({}),
  generation: z
    .object({
      tablePrefix: z.string().default(""),
      enumStrategy: z.enum(["pgEnum", "lookupTable"]).default("pgEnum"),
      constantsStrategy: z
        .enum(["singleTable", "separateTables"])
        .default("singleTable"),
    })
    .default({}),
})

export type Project = z.infer<typeof projectSchema>
