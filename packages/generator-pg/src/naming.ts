import type { MetadataKind } from "@simetra/core"
import { physicalObjectName, physicalTabularName, toSnakeCase } from "@simetra/core"

// Re-export toSnakeCase від core для зворотної сумісності імпортів
export { toSnakeCase } from "@simetra/core"

// Повна назва таблиці з prefix та kind-prefix
export function tableName(prefix: string, kind: MetadataKind, objectName: string): string {
  const physical = physicalObjectName(kind, objectName)
  return prefix ? `${prefix}${physical}` : physical
}

// Назва таблиці табличної частини з kind-prefix
export function tabularTableName(
  prefix: string,
  kind: MetadataKind,
  parentName: string,
  sectionName: string
): string {
  const physical = physicalTabularName(kind, parentName, sectionName)
  return prefix ? `${prefix}${physical}` : physical
}

// Кваліфікована назва з schema
export function qualifiedName(schema: string, name: string): string {
  return schema === "public" ? name : `${schema}.${name}`
}

// Екранування SQL ідентифікаторів (table names, column names)
export function quoteIdentifier(name: string): string {
  // Ідентифікатори вже валідовані core-схемами (PascalCase/snake_case, Latin only)
  // Додаємо double quotes для безпеки
  return `"${name.replace(/"/g, '""')}"`
}

// Екранування SQL рядкових літералів
export function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''")
}
