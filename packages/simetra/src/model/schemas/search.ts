import { z } from "zod"

/** Search modes: a prefix match (indexed) or a substring match (scope scan). */
export const SEARCH_MODES = ["startsWith", "contains"] as const

/** Default search mode of an object that declares `search` without `mode`. */
export const DEFAULT_SEARCH_MODE = "contains" satisfies SearchMode

export type SearchMode = (typeof SEARCH_MODES)[number]

/**
 * Поля пошуку об'єкта (спека П2 §5, «Поля пошуку»). Поле мають лише види з
 * фактом реєстру `search`: схема не приймає того, чого компілятор не збудує.
 * Відсутні `fields` — типові поля виду; що з ними робити, знає реєстр, а не
 * схема.
 */
export const searchSchema = z
  .strictObject({
    fields: z.array(z.string().min(1)).optional().meta({
      description:
        "Logical names of header attributes (standard and custom) to search by; omitted means the kind's default presentation fields.",
    }),
    mode: z.enum(SEARCH_MODES).optional().meta({
      description:
        "Search mode: startsWith (prefix, indexed) or contains (substring, scope scan); contains by default.",
    }),
  })
  .meta({ description: "Search fields and mode of the object." })

export type Search = z.infer<typeof searchSchema>
