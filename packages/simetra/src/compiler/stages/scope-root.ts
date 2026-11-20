import { type CustomTable, type ScopeKind } from "simetra/model"
import { objectKey, type ParsedObject } from "./files"
import { isDeclaredTable } from "./model"

/**
 * Чи має таблиця одноколонковий FK з колонки `column` на ключ кореня виду. Одне
 * правило для кожного носія скоупу рядка, якого не тримає власна межа таблиці:
 * `scopeColumn` скоупленої `CustomTable` і `columns.scope` джерела призначень
 * над нескоупленою таблицею. Без FK колонка могла б нести довільний uuid, тобто
 * чужий тенант. FK може бути кілька — декларація обирає одну колонку, тож
 * досить одного збігу.
 */
export function hasRootForeignKey(
  table: CustomTable,
  column: string,
  kind: ScopeKind,
  byKey: ReadonlyMap<string, ParsedObject>
): boolean {
  return table.foreignKeys.some(({ columns, references }) => {
    if (columns.length !== 1 || columns[0] !== column) return false
    if ("external" in kind.root) {
      const { external } = kind.root
      return (
        "external" in references &&
        references.external.schema === external.schema &&
        references.external.table === external.table &&
        references.external.columns.length === 1 &&
        references.external.columns[0] === external.column
      )
    }
    const { object } = kind.root
    if (
      !("object" in references) ||
      references.object.kind !== object.kind ||
      references.object.name !== object.name
    ) {
      return false
    }
    if ("key" in references) return references.key === "ref"
    // Корінь — прийнята таблиця: ціль називає колонки, а ключ — її єдиний PK.
    const root = byKey.get(objectKey(object.kind, object.name))
    const primaryKey =
      root !== undefined && isDeclaredTable(root)
        ? (root.data as CustomTable).primaryKey?.columns
        : undefined
    return (
      "columns" in references &&
      references.columns.length === 1 &&
      primaryKey?.length === 1 &&
      references.columns[0] === primaryKey[0]
    )
  })
}
