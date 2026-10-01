import type { z } from "zod"
import { KIND_REGISTRY } from "./kinds/registry"
import { projectSchema } from "./schemas/project"
import type { MetadataKind } from "./schemas/metadata-kind"

/** Ключі project.meta.json — у порядку оголошення схеми проєкту. */
export const PROJECT_KEY_ORDER: readonly string[] = Object.keys(
  projectSchema.shape
)

/** Мінімум внутрішнього опису Zod 4, потрібний обходу (публічний `.def`). */
interface SchemaDef {
  type: string
  innerType?: z.ZodType
  in?: z.ZodType
  getter?: () => z.ZodType
  shape?: Record<string, z.ZodType>
  element?: z.ZodType
  valueType?: z.ZodType
  options?: readonly z.ZodType[]
  discriminator?: string
}

const defOf = (schema: z.ZodType): SchemaDef => schema.def as SchemaDef

/** Знімає обгортки, що не змінюють форму об'єкта (optional, default, pipe…). */
function unwrap(schema: z.ZodType): z.ZodType {
  let current = schema
  for (;;) {
    const def = defOf(current)
    if (def.innerType !== undefined) current = def.innerType
    else if (def.type === "pipe" && def.in !== undefined) current = def.in
    else if (def.type === "lazy" && def.getter !== undefined)
      current = def.getter()
    else return current
  }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Варіант union, до якого належить об'єкт: за дискримінатором, інакше перший
 * варіант, чия схема приймає об'єкт. Файл із помилкою не приймає жоден
 * варіант — тоді береться варіант із найбільшим збігом ключів (за рівності —
 * перший), щоб порядок лишався детермінованим, а помилку показала валідація.
 */
function pickVariant(
  options: readonly z.ZodType[],
  discriminator: string | undefined,
  value: Record<string, unknown>
): z.ZodType | undefined {
  const unwrapped = options.map(unwrap)
  if (discriminator !== undefined) {
    const byTag = unwrapped.find((option) => {
      const field = defOf(option).shape?.[discriminator]
      return (
        field !== undefined && field.safeParse(value[discriminator]).success
      )
    })
    if (byTag !== undefined) return byTag
  }
  const accepting = options.find((option) => option.safeParse(value).success)
  if (accepting !== undefined) return unwrap(accepting)

  let best: z.ZodType | undefined
  let bestScore = -1
  for (const option of unwrapped) {
    const shape = defOf(option).shape
    const score =
      shape === undefined
        ? 0
        : Object.keys(value).filter((key) => Object.hasOwn(shape, key)).length
    if (score > bestScore) {
      best = option
      bestScore = score
    }
  }
  return best
}

/**
 * Канонічна форма значення на кожному рівні: ключі об'єкта — у порядку
 * оголошення його схеми, елементи масивів і значення `record` обходяться
 * тією ж схемою. Ключі `record` лишаються у вхідному порядку — це дані
 * автора (поля руху, перевизначення), а не частина схеми. Невідомі ключі не
 * губляться — вони йдуть після відомих у вхідному порядку, щоб форматер не
 * маскував помилку, яку покаже валідація. `topKeyOrder` — порядок верхнього
 * рівня з реєстру видів (шапка першою), решта виводиться зі схеми.
 */
function canonicalize(
  value: unknown,
  schema: z.ZodType | undefined,
  topKeyOrder?: readonly string[]
): unknown {
  if (schema === undefined) return value
  const node = unwrap(schema)
  const def = defOf(node)

  if (Array.isArray(value)) {
    const element = def.type === "array" ? def.element : undefined
    return value.map((item) => canonicalize(item, element))
  }
  if (!isPlainObject(value)) return value

  if (def.type === "union") {
    const variant = pickVariant(def.options ?? [], def.discriminator, value)
    return canonicalize(value, variant, topKeyOrder)
  }
  if (def.type === "record") {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = canonicalize(item, def.valueType)
    }
    return result
  }
  if (def.type !== "object" || def.shape === undefined) return value

  const shape = def.shape
  const keyOrder = topKeyOrder ?? Object.keys(shape)
  const ordered: Record<string, unknown> = {}
  for (const key of keyOrder) {
    if (Object.hasOwn(value, key)) {
      ordered[key] = canonicalize(value[key], shape[key])
    }
  }
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(ordered, key)) ordered[key] = item
  }
  return ordered
}

function serialize(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

function isKnownKind(kind: unknown): kind is MetadataKind {
  return typeof kind === "string" && Object.hasOwn(KIND_REGISTRY, kind)
}

/**
 * Канонічна форма файлу `.meta.json` (спека П2 §3): порядок ключів за схемою
 * виду на всіх рівнях,
 * відступ у два пробіли, завершальний перевід рядка. Файл невідомого виду
 * лишається в порядку входу — вид відхилить стадія 1, а не форматер.
 */
export function formatMetaFile(data: Record<string, unknown>): string {
  if (!isKnownKind(data.kind)) return serialize(data)
  const def = KIND_REGISTRY[data.kind]
  return serialize(canonicalize(data, def.schema, def.keyOrder))
}

/** Канонічна форма `project.meta.json`. */
export function formatProjectFile(data: Record<string, unknown>): string {
  return serialize(canonicalize(data, projectSchema, PROJECT_KEY_ORDER))
}
