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
  // Схеми файлів строгі: невідомий ключ — помилка `file.unknown-key`, а не
  // мовчки відкинуте поле з одруківкою. Тож підказку редактора оголошено
  // явно — лише тут, у корені файлу.
  $schema: z.string().optional().meta({
    description: "Editor hint: path to the JSON Schema of this file.",
  }),
  id: metadataIdSchema.optional(),
  name: objectNameSchema.meta({
    description: "Logical object name in PascalCase.",
  }),
  physicalName: physicalNameSchema.optional(),
  /** PG-схема об'єкта; за відсутності діє `defaultSchema` проєкту. */
  schema: z.string().optional().meta({
    description:
      "PostgreSQL schema of the object; the project defaultSchema applies when absent.",
  }),
  /**
   * Вид скоупу об'єкта або `none`. Обов'язковість за наявності видів скоупу
   * в проєкті — правило стадії, а не схеми: лише вона бачить проєкт.
   */
  scope: z.string().optional().meta({
    description:
      "Scope kind of the object, or none to keep it outside any scope. Required when the project declares scope kinds.",
  }),
  title: localizedStringSchema.optional().meta({
    description: "Human-readable title of the object.",
  }),
  description: localizedStringSchema.optional().meta({
    description: "Description of the object.",
  }),
}

/** Користувацькі перевизначення описів стандартних реквізитів. */
export const standardAttributeOverridesSchema = z
  .record(
    z.string(),
    z.strictObject({
      description: localizedStringSchema.optional().meta({
        description: "Overridden description of the standard attribute.",
      }),
    })
  )
  .optional()
  .default({})
  .meta({
    description:
      "Custom descriptions of derived standard attributes, keyed by standard attribute name.",
  })
