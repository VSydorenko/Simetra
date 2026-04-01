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
      namingConvention: z
        .enum(["snake_case", "camelCase"])
        .default("snake_case"),
    })
    .default(() => ({
      target: "postgresql" as const,
      schema: "public",
      namingConvention: "snake_case" as const,
    })),
  generation: z
    .object({
      tablePrefix: z.string().default(""),
      enumStrategy: z.enum(["pgEnum", "lookupTable"]).default("pgEnum"),
      constantsStrategy: z
        .enum(["singleTable", "separateTables"])
        .default("singleTable"),
    })
    .default(() => ({
      tablePrefix: "",
      enumStrategy: "pgEnum" as const,
      constantsStrategy: "singleTable" as const,
    })),
})

export type Project = z.infer<typeof projectSchema>
