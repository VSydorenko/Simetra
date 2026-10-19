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
  field: "physicalName" | "kindLabel" | "schema" | "assignedOn"
  effective?: (
    raw: Readonly<Record<string, unknown>>,
    ctx: AssignedOnceContext
  ) => string | undefined
}

/**
 * Контекст ефективного значення. Резолвери дає компілятор над станом, який
 * порівнюється: T0 не імпортує розв'язання посилань, а значення за id не
 * ламається перейменуванням.
 */
export interface AssignedOnceContext {
  defaultSchema: string
  materializes: boolean
  /** `id` виду скоупу проєкту за іменем; немає — ім'я не розв'язується. */
  resolveScopeKind: (name: string) => string | undefined
  /** `id` об'єкта за посиланням `{ kind, name }`. */
  resolveObject: (ref: { kind: string; name: string }) => string | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * Рівень ролі як ефективне значення: `global`/`everyUser` як є, вид скоупу й
 * контейнер — за `id`, щоб перейменування не було зміною рівня. Нерозв'язане
 * ім'я лишається іменем (`scope?:`/`container?:`), тож його зміна видна.
 */
function effectiveAssignedOn(
  raw: Readonly<Record<string, unknown>>,
  ctx: AssignedOnceContext
): string | undefined {
  const level = raw.assignedOn
  if (typeof level === "string") return level
  if (!isRecord(level)) return undefined
  if (typeof level.scopeKind === "string") {
    const id = ctx.resolveScopeKind(level.scopeKind)
    return id === undefined ? `scope?:${level.scopeKind}` : `scope:${id}`
  }
  const target = level.container
  if (
    isRecord(target) &&
    typeof target.kind === "string" &&
    typeof target.name === "string"
  ) {
    const id = ctx.resolveObject({ kind: target.kind, name: target.name })
    return id === undefined
      ? `container?:${target.kind}:${target.name}`
      : `container:${id}`
  }
  return undefined
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
  // Рівень ролі (Рх20): запис діє для кожного об'єкта, що має поле.
  { on: "object", field: "assignedOn", effective: effectiveAssignedOn },
]
