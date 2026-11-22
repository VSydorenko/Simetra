import { z } from "zod"
import type { SchemaRule } from "./rules"

/**
 * Схема, яку платформа резервує за собою: у ній живе системний шар
 * (ідентичності, поточний користувач, довідник міток). Застосунок не може
 * класти туди власні об'єкти, інакше його імена зіткнулися б із платформними.
 */
export const PLATFORM_SCHEMA = "simetra"

/**
 * Tables of the apply state in the platform schema (P2 spec §8.6): the
 * marker, the ledger, the row version epoch row and the file-store binding
 * row (`storage_instance`, spec postgres profile §8.2). They live outside the
 * physical snapshot, so the compiler takes their names from here.
 */
export const PLATFORM_STATE_TABLES = [
  "marker",
  "ledger",
  "version_epoch",
  "storage_instance",
] as const

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
