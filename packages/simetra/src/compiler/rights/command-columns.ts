import {
  KIND_REGISTRY,
  authorColumns,
  filePlatformColumns,
  keyColumn,
  predefinedNameColumn,
  serviceDateColumns,
  standardLogicalName,
  tabularParentColumn,
  userPlatformColumns,
  versionColumn,
  type AttributeCase,
  type PhysicalColumn,
  type ObjectTable,
  type StandardColumnDef,
} from "simetra/model"
import { findStandardColumn } from "../standard-column"
import type { ParsedObject } from "../stages/files"

/** Колонки поза грантами ролі команд — визначення реєстру (Р-B2-3). */
export interface CommandFixedColumns {
  insert: readonly StandardColumnDef[]
  update: readonly StandardColumnDef[]
}

/**
 * Факт ролі довідника `fixedColumns` (логічні імена) як визначення його
 * стандартних колонок: ім'я в стилі проєкту дає лише визначення реєстру.
 * Без факту — `undefined`. Законно відсутня лише колонка коду ролі
 * (`codeLength: 0`): її немає й у грантах, таку форму відмовляє
 * `languages.code-form`, а компіляція доходить до правила, а не падає. Будь-яке
 * інше невідоме ім'я — дефект реєстру.
 */
export function roleFixedColumns(
  object: Pick<ParsedObject, "kind" | "data">
): CommandFixedColumns | undefined {
  const kind = KIND_REGISTRY[object.kind]
  const fixed = kind.fixedColumns?.(object.data)
  if (fixed === undefined) return undefined
  const defs = kind.standardColumns(object.data)
  const code = kind.languageState?.(object.data)?.codeColumn
  const of = (names: readonly string[]) =>
    names.flatMap((name) => {
      const def = defs.find((d) => d.logicalName === name)
      if (def !== undefined) return [def]
      if (name === code) return []
      throw new Error(`internal: unknown role fixed column ${name}`)
    })
  return { insert: of(fixed.insert), update: of(fixed.update) }
}

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
      ...filePlatformColumns(),
    ].map((def) => standardLogicalName(def, attributeCase))
  )
}

/**
 * Колонки запису ролі команд у таблицю виду з `commandWrites` (спека П4
 * §6.2) — одне джерело і для поколонкового гранту, і для правила
 * шапки ефектів кастомної дії: дія не називає того, чого роль не змінить.
 * Колонку визначає походження, а не фізичне ім'я: ієрархічний `parent_id`
 * основної таблиці — зміст (перенесення між групами), а однойменна колонка
 * власника рядка ТЧ — ні. `base` — кандидати вставки до вилучення переходів;
 * `update` не чіпає ключа, скоупу, власника рядка ТЧ і платформних
 * реквізитів «Користувачів». `fixed` — колонки основної таблиці поза грантами
 * за фактом ролі довідника (Р-B2-3, `KindDefinition.fixedColumns`): окремо
 * для вставки й зміни, тож колонка зміни не мусить бути колонкою вставки.
 */
export function commandWriteColumns(
  table: ObjectTable,
  facts: {
    attributeCase: AttributeCase
    main: boolean
    users: boolean
    fixed: CommandFixedColumns | undefined
  }
): { base: PhysicalColumn[]; update: PhysicalColumn[] } {
  const platform = platformWrittenNames(facts.attributeCase)
  const candidates = table.columns.filter(
    (c) =>
      c.generated === undefined &&
      c.origin.copyOf === undefined &&
      !platform.has(c.origin.standard ?? "")
  )
  // `origin.standard` — ім'я в стилі проєкту, тож порівнюється ім'я визначення.
  const fixedOf = (defs: readonly StandardColumnDef[] | undefined) =>
    new Set(
      facts.main
        ? (defs ?? []).map((def) =>
            standardLogicalName(def, facts.attributeCase)
          )
        : []
    )
  const fixedInsert = fixedOf(facts.fixed?.insert)
  const fixedUpdate = fixedOf(facts.fixed?.update)
  const base = candidates.filter(
    (c) => !fixedInsert.has(c.origin.standard ?? "")
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
  const update = candidates.filter(
    (c) =>
      c !== key &&
      c.origin.scopeKindId === undefined &&
      !(section && c === parent) &&
      !usersFixed.has(c.origin.standard ?? "") &&
      !fixedUpdate.has(c.origin.standard ?? "")
  )
  return { base, update }
}
