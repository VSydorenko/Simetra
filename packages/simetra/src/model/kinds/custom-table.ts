import { customTableSchema, type CustomTable } from "../schemas/custom-table"
import {
  ATTRIBUTE_ROLES,
  valueTypeReferences,
  keyOrderOf,
  type FoundElementReference,
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
 * Кожне місце, де опис таблиці називає колонку логічним іменем. Ключі
 * індексу — за pointer на `column`: ключ-вираз колонки не називає, а pointer
 * поля лишає місце сусіднім властивостям ключа.
 */
function elementReferences(obj: unknown): FoundElementReference[] {
  const table = obj as CustomTable
  const found: FoundElementReference[] = []
  const own = (names: readonly string[], base: string) => {
    names.forEach((name, index) => {
      found.push({
        pointer: `${base}/${index}`,
        name,
        role: "customTable.column",
      })
    })
  }
  if (table.scopeColumn !== undefined) {
    found.push({
      pointer: "/scopeColumn",
      name: table.scopeColumn,
      role: "customTable.scopeColumn",
    })
  }
  if (table.primaryKey !== undefined) {
    own(table.primaryKey.columns, "/primaryKey/columns")
  }
  table.uniques.forEach((unique, i) => {
    own(unique.columns, `/uniques/${i}/columns`)
  })
  table.foreignKeys.forEach((foreignKey, i) => {
    const base = `/foreignKeys/${i}`
    own(foreignKey.columns, `${base}/columns`)
    const { references } = foreignKey
    if ("object" in references) {
      references.columns.forEach((name, index) => {
        found.push({
          pointer: `${base}/references/columns/${index}`,
          name,
          owner: references.object,
          role: "customTable.foreignKeyTarget",
        })
      })
    }
  })
  table.indexes.forEach((index, i) => {
    index.keys.forEach((key, k) => {
      if ("column" in key) {
        found.push({
          pointer: `/indexes/${i}/keys/${k}/column`,
          name: key.column,
          role: "customTable.column",
        })
      }
    })
    own(index.include, `/indexes/${i}/include`)
  })
  return found
}

/** Скалярна колонка типу uuid: логічного `UUID` або `Raw` з `pgType` uuid. */
export function isUuidColumn(column: CustomTable["columns"][number]): boolean {
  return (
    column.array !== true &&
    (column.type === "UUID" ||
      (column.type === "Raw" && column.pgType?.toLowerCase() === "uuid"))
  )
}

/**
 * Колонка єдиного PK прийнятої таблиці, якщо вона скалярна uuid. Не залежить
 * від `physicalName`, тож придатна й до призначення фізичних імен.
 */
export function singleUuidKeyColumn(
  table: CustomTable
): CustomTable["columns"][number] | undefined {
  const key = table.primaryKey?.columns
  if (key?.length !== 1) return undefined
  const column = table.columns.find((c) => c.name === key[0])
  return column !== undefined && isUuidColumn(column) ? column : undefined
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
  sqlModule: "debt",
  materializes: "table",
  scope: "required",
  declared: true,
  kindLabel: true,
  columnFields: ["columns"],
  valueElements: false,
  standardColumns: () => [],
  references,
  elementReferences,
}
