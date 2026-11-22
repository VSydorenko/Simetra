import { z } from "zod"
import { tableKey } from "./table-key"

/** Те, що потрібне від моделі чи знімка, щоб назвати таблиці об'єктів зі `storage`. */
export interface StorageFactsSource {
  objects: readonly { id: string; data: unknown }[]
  physical: {
    tables: readonly {
      schema: string
      name: string
      origin: { objectId?: string; tabularSectionId?: string; part?: string }
    }[]
  }
}

// Знімок marker пише платформа (`canonicalSnapshot`): читаємо лише `storage`
// об'єкта й походження таблиць, решта знімка тут не потрібна
const appliedSchema = z.object({
  objects: z.array(z.object({ id: z.string(), data: z.unknown() })),
  physical: z.object({
    tables: z.array(
      z.object({
        schema: z.string(),
        name: z.string(),
        origin: z.looseObject({
          objectId: z.string().optional(),
          tabularSectionId: z.string().optional(),
          part: z.string().optional(),
        }),
      })
    ),
  }),
})

/** Знімок marker у форму для `storageTables`; не канонічна форма — помилка платформи. */
export function appliedStorageSource(snapshot: unknown): StorageFactsSource {
  const parsed = appliedSchema.safeParse(snapshot)
  if (!parsed.success)
    throw new Error(
      `marker snapshot does not have the canonical form: ${parsed.error.message}`
    )
  return parsed.data
}

/**
 * Основні таблиці об'єктів, чия модель має `storage` (ключі `tableKey`).
 * Факт бере модель, а не назву колонки: звичайна колонка `file_size` у
 * власній таблиці чи атрибуті слід сховища не дає.
 */
export function storageTables(source: StorageFactsSource): Set<string> {
  const found = new Set<string>()
  for (const object of source.objects) {
    const data = object.data as { storage?: unknown } | null
    if (data === null || typeof data !== "object" || data.storage === undefined)
      continue
    const main = source.physical.tables.find(
      (t) =>
        t.origin.objectId === object.id &&
        t.origin.tabularSectionId === undefined &&
        t.origin.part === undefined
    )
    if (main !== undefined) found.add(tableKey(main.schema, main.name))
  }
  return found
}
