import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import type { SchemaRule } from "./rules"
import { ATTRIBUTE_CASES } from "./identity"
import { NO_SCOPE, scopeKindSchema } from "./scope"

/** Файл проєкту: ідентичність, правила іменування й часовий пояс застосунку. */
export const projectSchema = z
  .object({
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
    /**
     * IANA-пояс, у якому платформа визначає день, місяць, квартал і рік
     * моменту (спека П2 §3). Існування імені T0 перевірити не може — таблиці
     * поясів немає без Node API; хибний пояс відкине тінь при розгортанні.
     */
    timezone: z.string().min(1).default("UTC"),
    scopeKinds: z.array(scopeKindSchema).default([]),
  })
  .superRefine((project, ctx) => {
    project.scopeKinds.forEach((kind, index) => {
      // `none` — значення `scope` об'єкта «поза скоупом»; вид з таким іменем
      // зробив би його неоднозначним.
      if (kind.name === NO_SCOPE) {
        ctx.addIssue({
          code: "custom",
          message: `Scope kind name "${NO_SCOPE}" is reserved`,
          path: ["scopeKinds", index, "name"],
          params: { rule: "scope.name-reserved" satisfies SchemaRule },
        })
      }
    })
  })

export type Project = z.infer<typeof projectSchema>
