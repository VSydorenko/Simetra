import {
  elementNameSchema,
  logicalElementName,
  logicalObjectName,
  matchesAttributeCase,
  objectNameSchema,
  type AttributeCase,
} from "simetra/model"

/** Об'єкт чи колонка, якій потрібне логічне ім'я. */
export interface Nameable {
  key: string
  schema: string
  physical: string
  /** Ім'я з наявної теки: його обрав автор, і воно не змінюється. */
  preserved?: string
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Призначає імена без колізій над усією множиною (план E2b, рішення 4):
 * збережені імена займають простір першими, далі кандидати в порядку
 * `(schema, physical)`; група однакових кандидатів отримує `prefix`, а те, що
 * й після нього збігається, — числовий суфікс. `undefined` — похідне ім'я не
 * проходить схему імені (ухвала R8): вигадане ім'я сховало б, що прийом
 * таблиці потребує рішення автора.
 */
function assign(
  items: readonly Nameable[],
  base: (item: Nameable) => string,
  prefix: (item: Nameable, name: string) => string,
  valid: (name: string) => boolean
): Map<string, string | undefined> {
  const result = new Map<string, string | undefined>()
  const taken = new Set<string>()
  for (const item of items)
    if (item.preserved !== undefined) {
      result.set(item.key, item.preserved)
      taken.add(item.preserved)
    }
  const fresh = items
    .filter((item) => item.preserved === undefined)
    .sort(
      (a, b) => compare(a.schema, b.schema) || compare(a.physical, b.physical)
    )
  const counts = new Map<string, number>()
  for (const item of fresh)
    counts.set(base(item), (counts.get(base(item)) ?? 0) + 1)
  for (const item of fresh) {
    const own = base(item)
    if (!valid(own)) {
      result.set(item.key, undefined)
      continue
    }
    let candidate =
      counts.get(own) === 1 && !taken.has(own) ? own : prefix(item, own)
    if (!valid(candidate)) candidate = own
    let name = candidate
    for (let n = 2; taken.has(name); n++) name = `${candidate}${n}`
    taken.add(name)
    result.set(item.key, name)
  }
  return result
}

const isObjectName = (name: string) => objectNameSchema.safeParse(name).success

/**
 * Логічні імена об'єктів — PascalCase фізичного; колізія спершу бере
 * префікс схеми (`AppOrders`), далі числовий суфікс.
 */
export function objectNames(
  items: readonly Nameable[]
): Map<string, string | undefined> {
  return assign(
    items,
    (item) => logicalObjectName(item.physical),
    (item, name) => `${logicalObjectName(item.schema)}${name}`,
    isObjectName
  )
}

/** Логічні імена колонок однієї таблиці за стилем проєкту. */
export function columnNames(
  items: readonly Nameable[],
  style: AttributeCase
): Map<string, string | undefined> {
  return assign(
    items,
    (item) => logicalElementName(item.physical, style),
    (_item, name) => name,
    (name) =>
      elementNameSchema.safeParse(name).success &&
      matchesAttributeCase(name, style)
  )
}
