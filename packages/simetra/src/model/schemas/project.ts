import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import type { SchemaRule } from "./rules"
import { ATTRIBUTE_CASES } from "./identity"
import { NO_SCOPE, scopeKindSchema } from "./scope"

/** Файл проєкту: ідентичність, правила іменування й часовий пояс застосунку. */
export const projectSchema = z
  .strictObject({
    $schema: z.string().optional().meta({
      description: "Editor hint: path to the JSON Schema of this file.",
    }),
    name: z.string().meta({ description: "Application name." }),
    title: localizedStringSchema.optional().meta({
      description: "Human-readable title of the application.",
    }),
    defaultLocale: z
      .enum(["uk", "en"])
      .default("uk")
      .meta({ description: "Locale used when none is requested." }),
    defaultSchema: z.string().default("public").meta({
      description: "PostgreSQL schema for objects that declare none.",
    }),
    naming: z
      .strictObject({
        attributeCase: z.enum(ATTRIBUTE_CASES).default("camelCase").meta({
          description: "Casing style of logical attribute names.",
        }),
      })
      .default({ attributeCase: "camelCase" })
      .meta({ description: "Naming rules of the application." }),
    /**
     * IANA-пояс, у якому платформа визначає день, місяць, квартал і рік
     * моменту (спека П2 §3). Існування імені T0 перевірити не може — таблиці
     * поясів немає без Node API; хибний пояс відкине тінь при розгортанні.
     */
    timezone: z.string().min(1).default("UTC").meta({
      description:
        "IANA time zone in which the platform determines day, month, quarter and year.",
    }),
    scopeKinds: z.array(scopeKindSchema).default([]).meta({
      description:
        "Scope kinds of the application; leave empty for a single-tenant application.",
    }),
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
