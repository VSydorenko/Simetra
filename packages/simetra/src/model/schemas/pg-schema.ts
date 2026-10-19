import { z } from "zod"
import type { SchemaRule } from "./rules"

/**
 * Схема, яку платформа резервує за собою: у ній живе системний шар
 * (ідентичності, поточний користувач, довідник міток). Застосунок не може
 * класти туди власні об'єкти, інакше його імена зіткнулися б із платформними.
 */
export const PLATFORM_SCHEMA = "simetra"

/**
 * Ім'я PostgreSQL-схеми, яку обирає застосунок. Єдине місце перевірки
 * резервування: поля схем, що несуть ім'я схеми застосунку, беруть цю схему,
 * а не повторюють порівняння.
 */
export const appSchemaNameSchema = z
  .string()
  .refine((schema) => schema !== PLATFORM_SCHEMA, {
    message: `Schema ${PLATFORM_SCHEMA} belongs to the platform`,
    params: { rule: "schema.reserved" satisfies SchemaRule },
  })
