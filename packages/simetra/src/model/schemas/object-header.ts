import { z } from "zod"
import { localizedStringSchema } from "./localized-string"
import {
  metadataIdSchema,
  objectNameSchema,
  physicalNameSchema,
} from "./identity"

/**
 * Спільна «шапка» файлу об'єкта метаданих. `kind` кожен вид додає сам як
 * літерал. `id` і `physicalName` опційні у файлі: їх призначає інструментарій
 * при створенні, а не автор вручну.
 */
export const objectHeaderShape = {
  $schema: z.string().optional(),
  id: metadataIdSchema.optional(),
  name: objectNameSchema,
  physicalName: physicalNameSchema.optional(),
  /** PG-схема об'єкта; за відсутності діє `defaultSchema` проєкту. */
  schema: z.string().optional(),
  /**
   * Вид скоупу об'єкта або `none`. Обов'язковість за наявності видів скоупу
   * в проєкті — правило стадії, а не схеми: лише вона бачить проєкт.
   */
  scope: z.string().optional(),
  title: localizedStringSchema.optional(),
  description: localizedStringSchema.optional(),
}

/** Користувацькі перевизначення описів стандартних реквізитів. */
export const standardAttributeOverridesSchema = z
  .record(
    z.string(),
    z.object({ description: localizedStringSchema.optional() })
  )
  .optional()
  .default({})
