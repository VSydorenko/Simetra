import type { MetadataKind } from "../schemas/metadata-kind"
import type { ValueType } from "../schemas/value-type"
import { quoteIdent } from "./pg-names"

/**
 * Логічний тип → рядок у формі `format_type()`: саме в такому вигляді
 * Postgres віддає тип із каталогу, тож знімок метаданих і знімок extract
 * порівнюються без нормалізації.
 */
export function pgTypeOf(
  value: ValueType,
  refTargetKind?: MetadataKind
): string {
  const base = baseType(value, refTargetKind)
  return value.array === true ? `${base}[]` : base
}

function baseType(value: ValueType, refTargetKind?: MetadataKind): string {
  switch (value.type) {
    case "UUID":
      return "uuid"
    case "String":
      return `character varying(${value.length})`
    case "Text":
      return "text"
    case "SmallInt":
      return "smallint"
    case "Integer":
      return "integer"
    case "BigInt":
      return "bigint"
    case "Numeric":
      // Без scale Postgres друкує `numeric(p,0)`, а не `numeric(p)`.
      return value.precision === undefined
        ? "numeric"
        : `numeric(${value.precision},${value.scale ?? 0})`
    case "Boolean":
      return "boolean"
    case "Date":
      return "date"
    case "DateTime":
      return "timestamp with time zone"
    case "Bytes":
      return "bytea"
    case "Json":
      return "jsonb"
    case "Ref":
      // Перелічення зберігається текстом (спека М15), решта видів — uuid.
      return refTargetKind === "Enumeration" ? "text" : "uuid"
  }
}

export function pgEnumTypeName(schema: string, physicalName: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(physicalName)}`
}

/** Result of reading a catalog column type back into the metadata model. */
export type ColumnTypeForm =
  | { form: "logical"; value: ValueType }
  | { form: "enum"; schema: string; name: string }
  | { form: "raw"; pgType: string }

const SCALAR_TYPES: Record<string, ValueType> = {
  uuid: { type: "UUID" },
  text: { type: "Text" },
  smallint: { type: "SmallInt" },
  integer: { type: "Integer" },
  bigint: { type: "BigInt" },
  boolean: { type: "Boolean" },
  date: { type: "Date" },
  "timestamp with time zone": { type: "DateTime" },
  bytea: { type: "Bytes" },
  jsonb: { type: "Json" },
  numeric: { type: "Numeric" },
}

const VARCHAR = /^character varying\((\d+)\)$/
const NUMERIC = /^numeric\((\d+),(\d+)\)$/

/** Розбір `schema.name` / `name` з лапками `"…"` (подвоєна `""` — лапка). */
function parseQualifiedName(text: string): string[] | undefined {
  const parts: string[] = []
  let i = 0
  for (;;) {
    let part = ""
    if (text[i] === '"') {
      i++
      for (;;) {
        if (i >= text.length) return undefined
        if (text[i] === '"') {
          if (text[i + 1] === '"') {
            part += '"'
            i += 2
            continue
          }
          i++
          break
        }
        part += text[i++]
      }
    } else {
      const start = i
      while (i < text.length && text[i] !== "." && text[i] !== '"') i++
      part = text.slice(start, i)
    }
    if (part === "") return undefined
    parts.push(part)
    if (i === text.length) return parts
    if (text[i] !== ".") return undefined
    i++
  }
}

function logicalBase(base: string): ValueType | undefined {
  const scalar = SCALAR_TYPES[base]
  if (scalar !== undefined) return { ...scalar }
  const varchar = VARCHAR.exec(base)
  if (varchar !== null) {
    const length = Number(varchar[1])
    return length > 0 ? { type: "String", length } : undefined
  }
  const numeric = NUMERIC.exec(base)
  if (numeric !== null) {
    const precision = Number(numeric[1])
    const scale = Number(numeric[2])
    if (precision <= 0) return undefined
    // `numeric(p,0)` — образ і `{precision: p}`, і `{precision: p, scale: 0}`;
    // береться коротша форма.
    return scale === 0
      ? { type: "Numeric", precision }
      : { type: "Numeric", precision, scale }
  }
  return undefined
}

/**
 * Inverse of `pgTypeOf`: reads a `format_type()` text back into a logical type.
 * Only an exact image of a logical type becomes `logical`
 * (`pgTypeOf(result.value) === formatType`); a type that is an enum from
 * `enumTypes` (`"schema.name"` entries) becomes the physical pair; anything
 * else is `raw`. A bare `uuid` is always `UUID` — an FK is described separately.
 */
export function logicalTypeOf(
  formatType: string,
  enumTypes: ReadonlySet<string>
): ColumnTypeForm {
  const array = formatType.endsWith("[]")
  const base = array ? formatType.slice(0, -2) : formatType
  const value = logicalBase(base)
  if (value !== undefined) {
    return {
      form: "logical",
      value: array ? { ...value, array: true } : value,
    }
  }
  // Масив енамів і багатовимірні масиви логічної форми не мають.
  const pair = array ? undefined : enumPair(base, enumTypes)
  return pair === undefined
    ? { form: "raw", pgType: formatType }
    : { form: "enum", ...pair }
}

/**
 * `format_type()` друкує тип без схеми, коли той у `search_path`, і з нею —
 * інакше; ім'я з лапками, якщо потребує. Тож приймаються обидві форми, а
 * неоднозначне нескваліфіковане ім'я (енам з однаковою назвою у кількох
 * схемах) не вгадується й лишається `raw`.
 */
function enumPair(
  base: string,
  enumTypes: ReadonlySet<string>
): { schema: string; name: string } | undefined {
  const parts = parseQualifiedName(base)
  if (parts === undefined) return undefined
  if (parts.length === 2) {
    const [schema, name] = parts as [string, string]
    return enumTypes.has(`${schema}.${name}`) ? { schema, name } : undefined
  }
  if (parts.length !== 1) return undefined
  const name = parts[0]!
  const matches = [...enumTypes].filter((q) => {
    const dot = q.indexOf(".")
    return q.slice(dot + 1) === name
  })
  if (matches.length !== 1) return undefined
  const dot = matches[0]!.indexOf(".")
  return { schema: matches[0]!.slice(0, dot), name }
}
