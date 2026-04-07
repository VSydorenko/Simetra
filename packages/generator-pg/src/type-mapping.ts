import type { Attribute, StandardAttribute } from "@simetra/core"
import { escapeLiteral } from "./naming"

export interface ColumnDef {
  // Повний SQL тип (наприклад "varchar(150)" або "uuid")
  sqlType: string
  // Додаткові constraints (DEFAULT, NOT NULL, тощо)
  constraints: string[]
}

// Маппінг FieldType → PostgreSQL type (BRD §6.1)
export function mapFieldType(attr: {
  type: string
  length?: number
  precision?: number
  scale?: number
}): string {
  switch (attr.type) {
    case "UUID":
      return "uuid"
    case "String":
      return `varchar(${attr.length || 255})`
    case "Text":
      return "text"
    case "Integer":
      return "integer"
    case "Numeric": {
      const p = attr.precision || 15
      const s = attr.scale ?? 2
      return `numeric(${p}, ${s})`
    }
    case "Boolean":
      return "boolean"
    case "Date":
      return "date"
    case "DateTime":
      return "timestamptz"
    case "Binary":
      return "bytea"
    default:
      return "text"
  }
}

// Дефолтні constraints для стандартних реквізитів
const STANDARD_ATTR_DEFAULTS: Record<string, string[]> = {
  id: ["PRIMARY KEY", "DEFAULT gen_random_uuid()"],
  deletion_mark: ["DEFAULT false"],
  is_folder: ["DEFAULT false"],
  posted: ["DEFAULT false"],
  created_at: ["DEFAULT now()"],
  updated_at: ["DEFAULT now()"],
  active: ["DEFAULT true"],
  date: ["NOT NULL"],
}

// Побудувати колонки для Ref attribute
function refToColumn(
  ref: { kind: string; name: string } | undefined,
  allowedTypes: { kind: string; name: string }[] | undefined,
  resolveRefTable: (ref: { kind: string; name: string }) => string,
  resolveEnumType?: (ref: { kind: string; name: string }) => string | undefined
): ColumnDef {
  if (ref) {
    // Якщо ref вказує на Enumeration з pgEnum стратегією — використовуємо тип enum
    const enumType = resolveEnumType?.(ref)
    if (enumType) {
      return {
        sqlType: enumType,
        constraints: [],
      }
    }
    // Single ref → uuid (FK виноситься в окрему секцію ALTER TABLE)
    return {
      sqlType: "uuid",
      constraints: [],
    }
  }
  if (allowedTypes && allowedTypes.length > 0) {
    // Polymorphic ref: caller додає _type та _id колонки
    return {
      sqlType: "uuid",
      constraints: [],
    }
  }
  // Ref без цілі (не має трапитись, але обробимо)
  return { sqlType: "uuid", constraints: [] }
}

// Побудувати колонку для стандартного реквізиту
export function standardAttrToColumn(
  attr: StandardAttribute,
  resolveRefTable: (ref: { kind: string; name: string }) => string,
  resolveEnumType?: (ref: { kind: string; name: string }) => string | undefined
): ColumnDef {
  // Спеціальний тип Enum(Receipt,Expense) для movement_type
  if (attr.type.startsWith("Enum(")) {
    const values = attr.type.slice(5, -1).split(",")
    const check = values.map((v) => `'${escapeLiteral(v.trim())}'`).join(", ")
    return {
      sqlType: "varchar(20)",
      constraints: ["NOT NULL", `CHECK (${attr.name} IN (${check}))`],
    }
  }

  if (attr.type === "Ref") {
    return refToColumn(
      attr.ref,
      attr.allowedTypes,
      resolveRefTable,
      resolveEnumType
    )
  }

  const sqlType = mapFieldType(attr)
  const constraints = [...(STANDARD_ATTR_DEFAULTS[attr.name] ?? [])]

  return { sqlType, constraints }
}

// Побудувати колонку для кастомного реквізиту (Attribute)
export function attributeToColumn(
  attr: Attribute,
  resolveRefTable: (ref: { kind: string; name: string }) => string,
  resolveEnumType?: (ref: { kind: string; name: string }) => string | undefined
): ColumnDef {
  // Phase 1: base type
  let col: ColumnDef
  if (attr.type === "Ref") {
    col = refToColumn(attr.ref, attr.allowedTypes, resolveRefTable, resolveEnumType)
  } else {
    col = { sqlType: mapFieldType(attr), constraints: [] }
  }

  // Phase 2: epilogue — apply required/unique/default for all types
  if (attr.required) {
    col.constraints.push("NOT NULL")
  }
  if (attr.unique) {
    col.constraints.push("UNIQUE")
  }
  if (attr.defaultValue != null) {
    col.constraints.push(`DEFAULT '${escapeLiteral(String(attr.defaultValue))}'`)
  }
  if (attr.type === "Boolean" && attr.defaultValue == null) {
    col.constraints.push("DEFAULT false")
  }

  return col
}
