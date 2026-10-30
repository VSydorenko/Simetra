import {
  authorColumns,
  keyColumn,
  predefinedNameColumn,
  serviceDateColumns,
  standardLogicalName,
  tabularParentColumn,
  userPlatformColumns,
  versionColumn,
  type AttributeCase,
  type PhysicalColumn,
  type PhysicalTable,
} from "simetra/model"
import { findStandardColumn } from "../standard-column"

/**
 * Колонки, яких роль команд не пише ніколи (спека П4 §6.2): механіку,
 * авторство й `predefined_name` пишуть значення за замовчуванням і тригери.
 * Імена — з визначень реєстру в стилі проєкту, як їх несе `origin.standard`.
 */
function platformWrittenNames(attributeCase: AttributeCase): Set<string> {
  return new Set(
    [
      versionColumn(),
      ...serviceDateColumns(),
      ...authorColumns(),
      predefinedNameColumn(),
    ].map((def) => standardLogicalName(def, attributeCase))
  )
}

/**
 * Колонки запису ролі команд у таблицю виду з `commandWrites` (спека П4
 * §6.2, Р-A1-11) — одне джерело і для поколонкового гранту, і для правила
 * шапки ефектів кастомної дії: дія не називає того, чого роль не змінить.
 * Колонку визначає походження, а не фізичне ім'я: ієрархічний `parent_id`
 * основної таблиці — зміст (перенесення між групами), а однойменна колонка
 * власника рядка ТЧ — ні. `base` — кандидати вставки до вилучення переходів;
 * `update` не чіпає ключа, скоупу, власника рядка ТЧ і платформних
 * реквізитів «Користувачів».
 */
export function commandWriteColumns(
  table: PhysicalTable,
  facts: { attributeCase: AttributeCase; main: boolean; users: boolean }
): { base: PhysicalColumn[]; update: PhysicalColumn[] } {
  const platform = platformWrittenNames(facts.attributeCase)
  const base = table.columns.filter(
    (c) =>
      c.generated === undefined &&
      c.origin.copyOf === undefined &&
      !platform.has(c.origin.standard ?? "")
  )
  const section = table.origin.tabularSectionId !== undefined
  const usersFixed = new Set(
    facts.users && facts.main
      ? userPlatformColumns().map((def) =>
          standardLogicalName(def, facts.attributeCase)
        )
      : []
  )
  // Ключ і власник рядка ТЧ — за визначенням реєстру в стилі проєкту.
  const key = findStandardColumn(table, keyColumn(false), facts.attributeCase)
  const parent = findStandardColumn(
    table,
    tabularParentColumn(),
    facts.attributeCase
  )
  const update = base.filter(
    (c) =>
      c !== key &&
      c.origin.scopeKindId === undefined &&
      !(section && c === parent) &&
      !usersFixed.has(c.origin.standard ?? "")
  )
  return { base, update }
}
