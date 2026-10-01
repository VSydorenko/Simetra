import { z } from "zod"

/**
 * Стабільна ідентичність об'єкта чи реквізиту: ім'я можна змінювати, id — ні.
 * Лише нижній регістр (так генерує crypto.randomUUID): id порівнюються як
 * рядки, тож той самий UUID у іншому регістрі обійшов би перевірку дублів.
 */
export const metadataIdSchema = z
  .uuid({ version: "v4" })
  .refine((id) => id === id.toLowerCase(), {
    message: "UUID must be lowercase",
  })
  .meta({
    description:
      "Stable lowercase UUID v4 identity of the element. Assigned by tooling at creation and never reused; a rename keeps it.",
  })
export type MetadataId = string

/** Логічне ім'я об'єкта — PascalCase. */
export const objectNameSchema = z
  .string()
  .regex(/^[A-Z][A-Za-z0-9]*$/)
  .meta({
    description: "Logical object name in PascalCase.",
  })

/**
 * Логічне ім'я елемента (реквізиту тощо). Шаблон навмисно ширший за обидва
 * стилі: який саме стиль діє, залежить від налаштування застосунку, тож стиль
 * перевіряє окрема стадія (matchesAttributeCase), а не схема.
 */
export const elementNameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/)
  .meta({
    description:
      "Logical element name (attribute, section, column). The casing style is checked against the project naming setting.",
  })

/** Ліміт ідентифікатора PostgreSQL — 63 байти, а не символи. */
const MAX_PHYSICAL_NAME_BYTES = 63

export const physicalNameSchema = z
  .string()
  .min(1)
  .refine(
    (s) => new TextEncoder().encode(s).length <= MAX_PHYSICAL_NAME_BYTES,
    {
      message: "Physical name must be at most 63 bytes in UTF-8",
    }
  )
  .meta({
    description:
      "Physical database name. Assigned once at creation and never changed, so a rename emits no DDL. At most 63 bytes in UTF-8.",
  })

export const ATTRIBUTE_CASES = ["camelCase", "snake_case"] as const
export type AttributeCase = (typeof ATTRIBUTE_CASES)[number]

const ATTRIBUTE_CASE_PATTERNS: Record<AttributeCase, RegExp> = {
  camelCase: /^[a-z][A-Za-z0-9]*$/,
  snake_case: /^[a-z][a-z0-9_]*$/,
}

export function matchesAttributeCase(
  name: string,
  style: AttributeCase
): boolean {
  return ATTRIBUTE_CASE_PATTERNS[style].test(name)
}

/**
 * Перетворює PascalCase або camelCase ім'я у snake_case.
 * Приклади: SalesOrder → sales_order, CurrencyExchangeRates → currency_exchange_rates.
 */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase()
}
