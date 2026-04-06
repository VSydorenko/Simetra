// PascalCase → snake_case: SalesOrder → sales_order
export function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
}

// Повна назва таблиці з prefix
export function tableName(prefix: string, objectName: string): string {
  const snake = toSnakeCase(objectName)
  return prefix ? `${prefix}${snake}` : snake
}

// Назва таблиці табличної частини: {parent}_{section}
export function tabularTableName(
  prefix: string,
  parentName: string,
  sectionName: string
): string {
  const parent = tableName(prefix, parentName)
  return `${parent}_${sectionName}`
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
