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
