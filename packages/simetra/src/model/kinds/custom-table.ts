import { customTableSchema, type CustomTable } from "../schemas/custom-table"
import {
  ATTRIBUTE_ROLES,
  valueTypeReferences,
  keyOrderOf,
  type FoundReference,
  type KindDefinition,
} from "./standard"

function references(obj: unknown): FoundReference[] {
  const table = obj as CustomTable
  const found: FoundReference[] = []
  table.columns.forEach((column, index) => {
    if (column.enum !== undefined) {
      found.push({
        pointer: `/columns/${index}/enum`,
        ref: column.enum,
        role: "customTable.pgEnum",
      })
    }
    // Колонка логічного типу посилається так само, як реквізит.
    found.push(
      ...valueTypeReferences(column, `/columns/${index}`, ATTRIBUTE_ROLES)
    )
  })
  table.foreignKeys.forEach((foreignKey, index) => {
    if ("object" in foreignKey.references) {
      found.push({
        pointer: `/foreignKeys/${index}/references/object`,
        ref: foreignKey.references.object,
        role: "customTable.foreignKey",
      })
    }
  })
  return found
}

/**
 * Прийнята таблиця описана повністю фізично: нічого похідного, тож
 * стандартних колонок немає (спека §4).
 */
export const customTableKind: KindDefinition = {
  kind: "CustomTable",
  dir: "custom-tables",
  schema: customTableSchema,
  keyOrder: keyOrderOf(customTableSchema),
  // Чи має ціль придатний ключ, перевіряє стадія 4, а не реєстр.
  referenceable: true,
  writePattern: "optimistic",
  actions: ["read", "create", "update", "delete"],
  materializes: "table",
  declared: true,
  columnFields: ["columns"],
  valueElements: false,
  standardColumns: () => [],
  references,
}
