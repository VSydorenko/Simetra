import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import { ATTRIBUTE_CASES } from "./identity"

/** Файл проєкту: лише ідентичність і правила іменування застосунку. */
export const projectSchema = z.object({
  $schema: z.string().optional(),
  name: z.string(),
  title: localizedStringSchema.optional(),
  defaultLocale: z.enum(["uk", "en"]).default("uk"),
  defaultSchema: z.string().default("public"),
  naming: z
    .object({
      attributeCase: z.enum(ATTRIBUTE_CASES).default("camelCase"),
    })
    .default({ attributeCase: "camelCase" }),
})

export type Project = z.infer<typeof projectSchema>
