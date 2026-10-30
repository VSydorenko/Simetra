import {
  standardLogicalName,
  type AttributeCase,
  type PhysicalColumn,
  type StandardColumnDef,
} from "simetra/model"

/**
 * Колонка, яку можна впізнати за походженням: і фізичний знімок компілятора,
 * і розібраний знімок застосованої моделі (`schema/apply`).
 */
type StandardCarrier = { origin: { standard?: string } }

/**
 * Стандартна колонка таблиці за визначенням реєстру й стилем проєкту.
 * `origin.standard` несе логічне ім'я в стилі проєкту (`custom_role` у
 * `snake_case`), тож порівняння з camelCase-літералом у snake_case-проєкті
 * колонки не знаходить. Визначення береться з реєстру видів, а не літералом:
 * правило лінту тримає це в генераторах.
 */
export function findStandardColumn<C extends StandardCarrier>(
  table: { columns: readonly C[] },
  def: Pick<StandardColumnDef, "logicalName">,
  attributeCase: AttributeCase
): C | undefined {
  const name = standardLogicalName(def, attributeCase)
  return table.columns.find((c) => c.origin.standard === name)
}

/** Те саме, що `findStandardColumn`, але відсутня колонка — внутрішня помилка. */
export function standardColumn<C extends StandardCarrier>(
  table: { name: string; columns: readonly C[] },
  def: Pick<StandardColumnDef, "logicalName">,
  attributeCase: AttributeCase
): C {
  const found = findStandardColumn(table, def, attributeCase)
  if (found === undefined)
    throw new Error(
      `internal: missing standard column ${table.name}.${def.logicalName}`
    )
  return found
}

/** Колонка стандартна (виведена з реєстру), а не реквізит чи службова. */
export function isStandard(column: Pick<PhysicalColumn, "origin">): boolean {
  return column.origin.standard !== undefined
}

/**
 * Стандартна колонка, чиє логічне ім'я однакове в обох стилях (ключ `ref`,
 * власник рядка ТЧ `parent`): генератор, якому стиль проєкту не доходить,
 * шукає її без стилю. Однаковість перевіряється тут, а не припускається:
 * визначення зі стильозалежним ім'ям — внутрішня помилка, а не тихий промах
 * у snake_case-проєкті.
 */
export function findStyleFreeColumn<C extends StandardCarrier>(
  table: { columns: readonly C[] },
  def: Pick<StandardColumnDef, "logicalName">
): C | undefined {
  const camel = standardLogicalName(def, "camelCase")
  if (camel !== standardLogicalName(def, "snake_case"))
    throw new Error(
      `internal: standard column ${def.logicalName} depends on the attribute case`
    )
  return findStandardColumn(table, def, "camelCase")
}

/** Те саме, що `findStyleFreeColumn`, але відсутня колонка — внутрішня помилка. */
export function styleFreeColumn<C extends StandardCarrier>(
  table: { name: string; columns: readonly C[] },
  def: Pick<StandardColumnDef, "logicalName">
): C {
  const found = findStyleFreeColumn(table, def)
  if (found === undefined)
    throw new Error(
      `internal: missing standard column ${table.name}.${def.logicalName}`
    )
  return found
}
