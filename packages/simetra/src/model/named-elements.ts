import type { z } from "zod"
import { unwrap } from "./format"

/**
 * Масиви іменованих елементів схеми (спека П2 §3): елемент — об'єкт з `id` і
 * `name`. Ключ масиву → схема елемента, у порядку оголошення схеми. Факт
 * виводиться зі схеми, а не з переліку: новий вид чи нова колекція приходять
 * разом зі своєю схемою, а операції (додавання, адресація) бачать їх одразу.
 */
export function namedCollections(
  schema: z.ZodType
): ReadonlyMap<string, z.ZodType> {
  const result = new Map<string, z.ZodType>()
  const node = unwrap(schema)
  if (node.def.type !== "object") return result
  const shape = (node as z.ZodObject).shape as Record<string, z.ZodType>
  for (const [key, field] of Object.entries(shape)) {
    const array = unwrap(field)
    if (array.def.type !== "array") continue
    const element = unwrap((array as z.ZodArray<z.ZodType>).element)
    if (element.def.type !== "object") continue
    const keys = (element as z.ZodObject).shape
    if (Object.hasOwn(keys, "id") && Object.hasOwn(keys, "name")) {
      result.set(key, element)
    }
  }
  return result
}
