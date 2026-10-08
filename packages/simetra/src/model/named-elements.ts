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

/**
 * Поле, що призначається раз і далі не змінюється (спека промоції). Ефективне
 * значення — властивість запису, а не гілка в коді, що порівнює: без
 * `effective` береться значення поля як є.
 */
export interface AssignedOnceField {
  on: "object" | "element"
  field: "physicalName" | "kindLabel" | "schema"
  effective?: (
    raw: Readonly<Record<string, unknown>>,
    ctx: { defaultSchema: string; materializes: boolean }
  ) => string | undefined
}

export const ASSIGNED_ONCE: readonly AssignedOnceField[] = [
  { on: "object", field: "physicalName" },
  { on: "object", field: "kindLabel" },
  {
    // PG-схема має значення лише для видів, що матеріалізуються; явна `schema`
    // й успадкований `defaultSchema` дають те саме ефективне значення.
    on: "object",
    field: "schema",
    effective: (raw, ctx) =>
      ctx.materializes
        ? ((raw.schema as string | undefined) ?? ctx.defaultSchema)
        : undefined,
  },
  { on: "element", field: "physicalName" },
]
