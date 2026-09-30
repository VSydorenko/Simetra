import { z } from "zod"

/** Стабільна ідентичність об'єкта чи реквізиту: ім'я можна змінювати, id — ні. */
export const metadataIdSchema = z.uuid({ version: "v4" })
export type MetadataId = string

/** Логічне ім'я об'єкта — PascalCase. */
export const objectNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]*$/)

/**
 * Логічне ім'я елемента (реквізиту тощо). Шаблон навмисно ширший за обидва
 * стилі: який саме стиль діє, залежить від налаштування застосунку, тож стиль
 * перевіряє окрема стадія (matchesAttributeCase), а не схема.
 */
export const elementNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/)

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
