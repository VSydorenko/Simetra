import {
  KIND_REGISTRY,
  standardLogicalName,
  type LocalizedString,
  type LogicalType,
  type MetadataRef,
  type PhysicalTable,
  type StandardColumnDef,
  type TabularSection,
} from "simetra/model"
import type { CompiledModel, SourceObject } from "./compile"
import { standardElementId } from "./stages/identity"
import { registerSingletonOf } from "./stages/model"

/**
 * Типи значення колонки: логічні плюс дві форми `CustomTable`. Закритий
 * перелік, щоб відображення в TS було вичерпним на етапі компіляції, а не
 * мовчазним запасним варіантом.
 */
export type SourceType = LogicalType | "PgEnum" | "Raw"

/** Тип значення, спільний для реквізиту, константи й колонки `CustomTable`. */
export interface ValueSource {
  type: SourceType
  length?: number
  precision?: number
  scale?: number
  ref?: MetadataRef
  allowedTypes?: MetadataRef[]
  array?: boolean
  enum?: MetadataRef
  title?: LocalizedString
  description?: LocalizedString
}

/** Елемент з ідентичністю: реквізит, вимір, ресурс чи колонка `CustomTable`. */
export interface ElementSource extends ValueSource {
  id?: string
  name: string
}

/** Стандартні колонки (за логічним ім'ям у стилі проєкту) й елементи таблиці. */
export interface EntityContext {
  standard: ReadonlyMap<string, StandardColumnDef>
  elements: ReadonlyMap<string, ElementSource>
}

/**
 * Поле логічного типу сутності: одна колонка або поліморфна пара
 * `_type`, `_id` з одним походженням. Нуллабельність, генерованість і
 * значення за замовчуванням — з фізичного знімка першої колонки, тож поле не
 * розійдеться з DDL.
 */
export interface EntityField {
  name: string
  columns: [string] | [string, string]
  standard?: StandardColumnDef
  element?: ElementSource
  scopeKindId?: string
  notNull: boolean
  generated: boolean
  /** `DEFAULT` чи identity: значення дає база. */
  hasDefault: boolean
}

/** ТЧ об'єкта: з файлу чи стандартна (дельта «Ролей»). */
export interface EntitySection {
  id: string
  name: string
  title?: LocalizedString
  standard: ReadonlyMap<string, StandardColumnDef>
}

/** Основна таблиця об'єкта, її контекст полів і ТЧ. */
export interface ObjectEntity {
  main: PhysicalTable
  standard: ReadonlyMap<string, StandardColumnDef>
  elements: ReadonlyMap<string, ElementSource>
  sections: EntitySection[]
}

/**
 * Основна таблиця об'єкта з контекстом полів — один для кодогену й каталогу
 * рантайму, тож тип сутності й рядок рантайму читають ті самі визначення.
 * `undefined` — у об'єкта немає основної таблиці.
 */
export function objectEntity(
  model: CompiledModel,
  object: SourceObject
): ObjectEntity | undefined {
  const style = model.project.naming.attributeCase
  const def = KIND_REGISTRY[object.kind]
  // Основна таблиця — без `part` і без ТЧ; похідні таблиці регістрів
  // інтерфейсів не мають.
  const main = model.physical.tables.find(
    (table) =>
      table.origin.objectId === object.id &&
      table.origin.part === undefined &&
      table.origin.tabularSectionId === undefined
  )
  if (main === undefined) return undefined

  const data = object.data as {
    tabularSections?: TabularSection[]
  } & Record<string, unknown>

  const styled = (columns: readonly StandardColumnDef[]) =>
    new Map(
      columns.map((column) => [standardLogicalName(column, style), column])
    )
  const singleton = registerSingletonOf(object)
  const standard = styled([
    ...(singleton === undefined ? [] : [singleton]),
    ...def.standardColumns(object.data),
  ])
  const rowColumns = def.tabularSectionColumns?.(object.data) ?? []

  const elements = new Map<string, ElementSource>()
  const addElement = (element: ElementSource) => {
    if (element.id !== undefined) elements.set(element.id, element)
  }
  for (const field of def.columnFields) {
    for (const element of (data[field] ?? []) as ElementSource[]) {
      addElement(element)
    }
  }
  const fileSections =
    def.tabularSectionColumns === undefined ? [] : (data.tabularSections ?? [])
  for (const section of fileSections) {
    for (const attribute of section.attributes) addElement(attribute)
  }
  // Стандартна ТЧ (дельта «Ролей») — тим самим шляхом, що ТЧ з файлу:
  // колонки — стандартні колонки рядка виду й власні колонки ТЧ, id — як у
  // стадії 3.
  const sections: EntitySection[] = [
    ...fileSections.map((section) => ({
      id: section.id ?? "",
      name: section.name,
      title: section.title,
      standard: styled(rowColumns),
    })),
    ...(def.standardTabularSections?.(object.data) ?? []).map((section) => ({
      id: standardElementId(object.id, section),
      name: standardLogicalName(section, style),
      title: section.title,
      standard: styled([...rowColumns, ...section.columns()]),
    })),
  ]
  return { main, standard, elements, sections }
}

/**
 * Поля таблиці за `origin` колонок, у порядку таблиці: стандартна колонка —
 * за визначенням реєстру, реквізит — за id елемента, носій скоупу — за видом
 * скоупу (ім'я поля — ім'я виду), колонка без походження в метаданих — за
 * фізичним іменем. Ключ-одинак пропускається: службовий ключ рядка-одинака
 * (завжди `true`, значення дає DEFAULT) у скоупленій формі не існує, тож і
 * поля сутності не дає.
 */
export function entityFields(
  model: CompiledModel,
  table: PhysicalTable,
  context: EntityContext
): EntityField[] {
  const scopeNames = new Map(model.scopeKinds.map((k) => [k.id, k.name]))
  const keyOf = (index: number) => JSON.stringify(table.columns[index]!.origin)
  const fields: EntityField[] = []
  table.columns.forEach((column, index) => {
    const key = keyOf(index)
    // Поліморфне поле — пара колонок з одним походженням; поле одне.
    if (index > 0 && keyOf(index - 1) === key) return
    const next = table.columns[index + 1]
    const paired = next !== undefined && keyOf(index + 1) === key
    const { standard: standardName, elementId, scopeKindId } = column.origin
    const standard =
      standardName === undefined
        ? undefined
        : context.standard.get(standardName)
    const element =
      elementId === undefined ? undefined : context.elements.get(elementId)
    if (standard?.singleton === true) return
    // Ім'я виду з моделі без помилок завжди знайдеться; фізичне ім'я лише
    // страхує від напівмоделі.
    const name =
      standard !== undefined
        ? standardName!
        : element !== undefined
          ? element.name
          : scopeKindId !== undefined
            ? (scopeNames.get(scopeKindId) ?? column.name)
            : column.name
    fields.push({
      name,
      columns: paired ? [column.name, next.name] : [column.name],
      ...(standard === undefined ? {} : { standard }),
      ...(standard !== undefined || element === undefined ? {} : { element }),
      ...(scopeKindId === undefined ? {} : { scopeKindId }),
      notNull: column.notNull,
      generated: column.generated !== undefined,
      hasDefault: column.default !== undefined || column.identity !== undefined,
    })
  })
  return fields
}
